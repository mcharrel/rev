import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { PullTab } from '../api/workspace.js';
import { getDataDir } from '../db/connection.js';
import { addReviewFile, createReview, updateReviewSource } from '../db/queries.js';
import { parseDiff } from '../git/parseDiff.js';
import { updateReviewDiffs } from '../review-update.js';
import { github, githubToken, repoApi } from './github.js';
import { preserveIncompleteCheckout } from './incomplete-checkout.js';
import { closingTabs, readGitStorage, withCheckoutLock } from './lifecycle.js';
import { attachObjectCache, repositoryCache } from './object-cache.js';
import { findLocalRepository } from './repositories.js';
import { saveWorkspace } from './storage.js';

const exec = promisify(execFile);
const fetches = new Map<string, Promise<string>>();
export async function gitAuthEnv(tab: Pick<PullTab, 'ref'>): Promise<NodeJS.ProcessEnv> {
  const token = await githubToken(tab.ref);
  return { ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
}
export async function gitAsync(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const run = async () => {
    try {
      // Review snapshots must not run user/repository hooks that generate files or background jobs.
      const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd, env: env ?? process.env, timeout: 180000, maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (error instanceof Error && 'killed' in error && error.killed === true)
        throw new Error(`Git ${args[0]} timed out after three minutes. Retry to continue loading the source.`, { cause: error });
      throw error;
    }
  };
  if (args[0] !== 'fetch') return run();
  // Imports sharing an object store must not race Git's shallow/FETCH_HEAD locks.
  const pending = (fetches.get(cwd) ?? Promise.resolve()).catch(() => {}).then(run);
  fetches.set(cwd, pending);
  try { return await pending; }
  finally { if (fetches.get(cwd) === pending) fetches.delete(cwd); }
}
async function remoteMergeBase(tab: PullTab): Promise<string> {
  const info = tab.info;
  if (!info) throw new Error('PR details are unavailable');
  const result = z.object({ merge_base_commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) })
    .parse(await github(tab.ref, `${repoApi(tab.ref)}/compare/${info.baseRefOid}...${info.headRefOid}?per_page=1`));
  return result.merge_base_commit.sha;
}
/** Import into a dedicated checkout; never switch the user's existing working tree. */
export async function importPull(tab: PullTab, canApply: () => boolean = () => true): Promise<void> {
  return readGitStorage(() => withCheckoutLock(tab.key, async () => { if (!closingTabs.has(tab) && canApply()) await prepareCheckout(tab, false, canApply); }));
}

const restoring = new Map<string, Promise<void>>();
/** Recreate the exact saved source snapshot without rewriting review files or annotations. */
export async function ensureCheckout(tab: PullTab): Promise<void> {
  if (!tab.checkoutEvicted || closingTabs.has(tab)) return;
  const existing = restoring.get(tab.key);
  if (existing) return existing;
  const pending = readGitStorage(() => withCheckoutLock(tab.key, async () => {
    if (!tab.checkoutEvicted || closingTabs.has(tab)) return;
    tab.loading = true;
    tab.error = undefined;
    tab.lastUsedAt = Date.now();
    saveWorkspace();
    try {
      await prepareCheckout(tab, true);
      tab.error = undefined;
    } catch (error) {
      tab.error = error instanceof Error ? error.message : 'Could not restore the review checkout';
      throw error;
    } finally { tab.loading = false; saveWorkspace(); }
  }));
  restoring.set(tab.key, pending);
  try { await pending; }
  finally { if (restoring.get(tab.key) === pending) restoring.delete(tab.key); }
}

async function prepareCheckout(tab: PullTab, restore: boolean, canApply: () => boolean = () => true): Promise<void> {
  const info = tab.info;
  if (!info) throw new Error('PR details are unavailable');
  const head = restore ? tab.reviewedHead : info.headRefOid;
  const target = restore ? tab.reviewedBase : info.baseRefOid;
  if (!head || !target) throw new Error('The saved PR revision is unavailable; refresh the PR');
  const data = getDataDir();
  if (data === null) throw new Error('Storage unavailable');
  const name = `${tab.ref.owner}-${tab.ref.repo}-${tab.ref.number}`;
  const root = join(data, 'workspaces', name);
  await mkdir(root, { recursive: true });
  const owned = join(await realpath(data), 'workspaces', name);
  const gitDir = await lstat(join(root, '.git')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== owned
    || (gitDir && (!gitDir.isDirectory() || await realpath(join(root, '.git')) !== join(owned, '.git'))))
    throw new Error('Review source must use an app-owned checkout');
  await gitAsync(['init', '--quiet'], root);
  const exclude = join(root, '.git', 'info', 'exclude');
  if (!(await readFile(exclude, 'utf8')).split('\n').includes('/.glassbox/'))
    await appendFile(exclude, '\n/.glassbox/\n');
  const source = await findLocalRepository(tab.ref);
  let base = target;
  if (!restore) {
    // A user clone can answer this read-only; never fetch into or pin refs in it.
    base = source === undefined ? await remoteMergeBase(tab)
      : await gitAsync(['merge-base', target, head], source).then(value => value.trim(), () => remoteMergeBase(tab));
  }
  const cache = await repositoryCache(tab.ref);
  const commits = [...new Set([base, head])];
  const missing = async () => (await Promise.all(commits.map(async sha =>
    await gitAsync(['cat-file', '-e', `${sha}^{commit}`], cache).then(() => null, () => sha)))).filter(sha => sha !== null);
  let needed = await missing();
  if (needed.length && source !== undefined) {
    // file:// honors depth=1 and copies snapshots instead of borrowing the user's object store.
    await gitAsync(['fetch', '--no-tags', '--depth=1', pathToFileURL(source).href,
      ...needed.map(sha => `${sha}:refs/glassbox/cache/${sha}`)], cache).catch(() => {});
    needed = await missing();
  }
  if (needed.length) await gitAsync(['fetch', '--no-tags', '--depth=1',
    `https://github.com/${tab.ref.owner}/${tab.ref.repo}.git`,
    ...needed.map(sha => `${sha}:refs/glassbox/cache/${sha}`)], cache, await gitAuthEnv(tab));
  await attachObjectCache(root, cache);
  // Retain older boundaries too: a refreshed checkout may still contain its previous snapshot.
  const shallow = join(root, '.git', 'shallow');
  const boundaries = await Promise.all([shallow, join(cache, 'shallow')].map(path => readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  })));
  const lines = [...new Set(boundaries.flatMap(value => value.split('\n').filter(Boolean)))];
  if (lines.length) await writeFile(shallow, `${lines.join('\n')}\n`);
  const dirty = await gitAsync(['status', '--porcelain'], root);
  if (dirty.trim()) {
    if (closingTabs.has(tab) || !canApply()) return;
    // A failed first checkout can leave source files without HEAD/index; preserve them before retrying.
    if (await preserveIncompleteCheckout(root, data) !== null) return prepareCheckout(tab, restore, canApply);
    throw new Error('The managed checkout has local changes; they were preserved.');
  }
  if (restore) {
    await gitAsync(['checkout', '--detach', head], root);
    tab.repoRoot = root;
    tab.checkoutEvicted = false;
    return;
  }
  const diff = await gitAsync(['diff', '--no-ext-diff', '--find-renames', base, info.headRefOid, '--'], root);
  if (closingTabs.has(tab) || !canApply()) return;
  await gitAsync(['checkout', '--detach', head], root);
  if (tab.reviewId === null) {
    const review = await createReview(
      root,
      tab.ref.repo,
      `range:${base}..${info.headRefOid}`,
      `${base}..${info.headRefOid}`,
      info.headRefOid,
    );
    for (const file of parseDiff(diff)) await addReviewFile(review.id, file.filePath, JSON.stringify(file));
    tab.reviewId = review.id;
  } else {
    await updateReviewDiffs(tab.reviewId, parseDiff(diff), info.headRefOid);
    await updateReviewSource(tab.reviewId, root, base, info.headRefOid);
  }
  tab.repoRoot = root;
  tab.reviewedHead = info.headRefOid;
  tab.reviewedBase = base;
  tab.checkoutEvicted = false;
  tab.lastUsedAt = Date.now();
}
