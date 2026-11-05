import { type PullTab,PullTabSchema } from '../api/workspace.js';
import { discardTabData } from './discard.js';
import { waitForCheckouts, withCheckoutLock, writeGitStorage } from './lifecycle.js';
import { type PendingDeletion, saveWorkspace, workspaceData } from './storage.js';

const running = new Map<string, Promise<void>>();

function cleanup(job: PendingDeletion, source?: PullTab): Promise<void> {
  const existing = running.get(job.key);
  if (existing) return existing;
  const pending = (async () => {
    await waitForCheckouts();
    // A checkout already in flight can finish creating its review after Close was saved.
    if (source) { job.reviewId = source.reviewId; job.repoRoot = source.repoRoot; saveWorkspace(); }
    const tab = PullTabSchema.parse({ ...job, info: null, comments: job.agents.map(id => ({
      id, kind: 'ai', body: '', author: '', date: '', status: 'done',
    })) });
    await writeGitStorage(() => withCheckoutLock(job.key, () => discardTabData(tab, true)));
    const data = workspaceData();
    data.pendingDeletes = data.pendingDeletes?.filter(item => item !== job);
    saveWorkspace();
  })().finally(() => { running.delete(job.key); });
  running.set(job.key, pending);
  return pending;
}

function background(job: PendingDeletion, source?: PullTab): void {
  void cleanup(job, source).catch((error: unknown) => {
    console.warn(`Closed PR cleanup will retry: ${String(error)}`);
  });
}

/** Persist only the identifiers needed to delete files/rows, never closed comments or tab content. */
export function queueDeletion(tab: PullTab): void {
  const data = workspaceData();
  const jobs = data.pendingDeletes ??= [];
  let job = jobs.find(item => item.key === tab.key);
  if (!job) {
    job = { key: tab.key, ref: tab.ref, reviewId: tab.reviewId, repoRoot: tab.repoRoot,
      agents: tab.comments.filter(message => message.kind === 'ai').map(message => message.id) };
    jobs.push(job);
  }
  saveWorkspace();
  background(job, tab);
}

export function retryDeletions(): void {
  for (const job of workspaceData().pendingDeletes ?? []) background(job);
}

/** Explicit reopening starts fresh, after old cleanup can no longer touch the new checkout. */
export async function finishDeletion(key: string): Promise<void> {
  const job = workspaceData().pendingDeletes?.find(item => item.key === key);
  if (job) await cleanup(job);
}
