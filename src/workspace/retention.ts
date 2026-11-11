import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PullTab, ThreadMessage } from '../api/workspace.js';
import { getDataDir } from '../db/connection.js';
import { gitAsync } from './checkout.js';
import { checkoutBusy, closingTabs, withCheckoutLock, writeGitStorage } from './lifecycle.js';
import { cleanupObjectCaches, preserveBorrowedObjects } from './object-cache.js';
import { saveWorkspace, workspaceData } from './storage.js';

export const WORKSPACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function idle(tab: PullTab, cutoff: number): boolean {
  const data = workspaceData();
  // Metadata polling is not checkout activity; updatedAt is only a legacy fallback.
  return !closingTabs.has(tab) && tab.key !== data.active && !tab.loading && (tab.lastUsedAt || tab.updatedAt) <= cutoff
    && !tab.comments.some(message => message.kind === 'ai' && message.status === 'working')
    && !data.outbox.some(item => item.tab === tab.key);
}

export async function managedPath(area: 'workspaces' | 'agents' | 'checkout-recovery', name: string): Promise<string | null> {
  const dataDir = getDataDir();
  if (dataDir === null || name !== name.replaceAll(/[\\/]/g, '') || name === '.' || name === '..') return null;
  const root = join(dataDir, area, name);
  try {
    if (!(await lstat(root)).isDirectory()) return null;
    // Only remove a real child of this data directory, never symlinks to user repositories.
    if (await realpath(root) !== join(await realpath(dataDir), area, name)) return null;
    return await realpath(root);
  } catch { return null; }
}

export async function clean(root: string): Promise<boolean> {
  return !(await gitAsync(['status', '--porcelain', '--untracked-files=all', '--ignored'], root)).trim();
}

export async function safeHead(root: string, heads: string[]): Promise<boolean> {
  const head = (await gitAsync(['rev-parse', 'HEAD'], root)).trim();
  if (heads.includes(head)) return true;
  // A locally recorded remote branch can prove an old agent commit was published, without an API call.
  return Boolean((await gitAsync(['for-each-ref', '--format=%(refname)', `--contains=${head}`, 'refs/remotes/'], root)).trim());
}

async function removeAgent(tab: PullTab, message: ThreadMessage, cutoff: number): Promise<boolean> {
  if (message.kind !== 'ai' || message.status === 'working') return false;
  const updated = Math.max(message.workspaceUpdatedAt ?? 0, Date.parse(message.date) || 0);
  if (updated > cutoff) return false;
  const root = await managedPath('agents', message.id);
  if (root === null || (await lstat(root)).mtimeMs > cutoff) return false;
  const gitFile = await lstat(join(root, '.git'));
  if (!gitFile.isFile() || !(await clean(root))) return false;
  const safe = [message.workspaceSafeHead ?? '', tab.reviewedHead, tab.info?.headRefOid ?? ''];
  if (!(await safeHead(root, safe))) return false;
  // Let Git enforce clean/unlocked worktree rules and unregister the worktree; never force removal.
  const common = (await gitAsync(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).trim();
  const entries = (await gitAsync(['worktree', 'list', '--porcelain'], root)).split('\n\n');
  const entry = entries.find(value => value.split('\n').includes(`worktree ${root}`));
  if (entry === undefined || !entry.split('\n').includes('detached') || /\nlocked(?: |\n|$)/.test(entry)) return false;
  if (tab.comments.some(item => item.id === message.id && item.status === 'working') ||
    Math.max(message.workspaceUpdatedAt ?? 0, Date.parse(message.date) || 0) > cutoff) return false;
  await gitAsync(['--git-dir', common, 'worktree', 'remove', root], dirname(common));
  return true;
}

async function removeReview(tab: PullTab, cutoff: number, pinnedRoot?: string): Promise<boolean> {
  if (!idle(tab, cutoff) || checkoutBusy(tab.key)) return false;
  return withCheckoutLock(tab.key, async () => {
    const root = await managedPath('workspaces', `${tab.ref.owner}-${tab.ref.repo}-${tab.ref.number}`);
    if (root === null || (pinnedRoot !== undefined && await realpath(root) === await realpath(pinnedRoot))) return false;
    if (tab.repoRoot !== null && await realpath(tab.repoRoot) !== root) return false;
    if ((await lstat(root)).mtimeMs > cutoff || !(await lstat(join(root, '.git'))).isDirectory()) return false;
    if (!(await clean(root))) return false;
    if (await lstat(join(root, '.git', 'modules')).then(() => true, () => false)) return false;
    const worktrees = await gitAsync(['worktree', 'list', '--porcelain'], root);
    if (worktrees.split('\n').filter(line => line.startsWith('worktree ')).length > 1) return false;
    const refs = (await gitAsync(['for-each-ref', '--format=%(refname)'], root)).trim().split('\n');
    if (refs.some(ref => ref !== '' && !ref.startsWith('refs/glassbox/cache/') && !ref.startsWith('refs/remotes/'))) return false;
    const files = await readdir(root);
    // Failed imports may contain only an unfinished .git directory with no checked-out HEAD.
    const hasHead = await gitAsync(['rev-parse', '--verify', 'HEAD'], root).then(() => true, () => false);
    if (hasHead ? !(await safeHead(root, [tab.reviewedHead, tab.info?.headRefOid ?? '']))
      : !(files.length === 1 && files[0] === '.git')) return false;
    if (!(await clean(root))) return false;
    // Recheck after the asynchronous inspections: a user may have selected this PR meanwhile.
    const current = workspaceData();
    if (!idle(tab, cutoff) || [...current.tabs, ...current.archived].some(other =>
      other.loading || (other.key !== tab.key && checkoutBusy(other.key)) ||
      other.comments.some(message => message.kind === 'ai' && message.status === 'working'))) return false;
    await preserveBorrowedObjects(root);
    if (!idle(tab, cutoff)) return false;
    tab.checkoutEvicted = true;
    saveWorkspace();
    await rm(root, { recursive: true });
    return true;
  });
}

/** Expire disposable source only. The database, comments, attachments and tab history stay intact. */
export async function cleanupWorkspaces(now = Date.now(), pinnedRoot?: string): Promise<{ reviews: number; agents: number }> {
  return writeGitStorage(async () => {
    const data = workspaceData();
    const tabs = [...data.tabs, ...data.archived];
    const result = { reviews: 0, agents: 0 };
    const cutoff = now - WORKSPACE_RETENTION_MS;
    // Shared Git stores may be in use by any import or agent, including one in another PR.
    const busy = () => [...workspaceData().tabs, ...workspaceData().archived].some(tab => tab.loading || checkoutBusy(tab.key) ||
      tab.comments.some(message => message.kind === 'ai' && message.status === 'working'));
    if (busy()) return result;
    for (const tab of tabs) for (const message of tab.comments) {
      if (busy()) return result;
      try { if (await removeAgent(tab, message, cutoff)) result.agents++; }
      catch (error) { console.warn(`Kept agent workspace ${message.id}: ${String(error)}`); }
    }
    for (const tab of tabs) {
      if (busy()) return result;
      try { if (await removeReview(tab, cutoff, pinnedRoot)) result.reviews++; }
      catch (error) { console.warn(`Kept review workspace ${tab.key}: ${String(error)}`); }
    }
    await cleanupObjectCaches();
    return result;
  });
}

export function startWorkspaceCleanup(pinnedRoot?: string): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try { await cleanupWorkspaces(Date.now(), pinnedRoot); }
    catch (error) { console.warn(`Workspace cleanup failed: ${String(error)}`); }
    finally { running = false; }
  };
  void sweep();
  const timer = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => { clearInterval(timer); };
}
