import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  canHandleCodexComment,
  codeCommentDestination,
  codeThreadRoot,
  commentDestination,
  isPullAuthor,
  type PullTab,
  PullTabSchema,
  reviewerStates,
  type ThreadMessage,
  type WorkspaceMutation,
} from '../api/workspace.js';
import {
  type Annotation,
  deleteAnnotation,
  getAnnotationById,
  getAnnotationsForReview,
  getReview,
  getReviewFile,
  updateAnnotation,
} from '../db/queries.js';
import { parseDiffData } from '../git/parseDiffData.js';
import { githubAccount } from './accounts.js';
import { ensureCheckout, importPull } from './checkout.js';
import { flushCodexComments, queueCodexComment, reconcileCodexComment, recoverCodexComments, retryCodexComment, reviseComment } from './codex.js';
import { finishDeletion, queueDeletion, retryDeletions } from './deletion.js';
import { cancelDeployment, refreshDeployment, stopDeployments } from './deployments.js';
import {
  github,
  loadComments,
  loadPull,
  localWorkspaceConfig,
  mutatePull,
  parsePullUrl,
  pullKey,
  RemoteCommentSchema,
  repoApi,
} from './github.js';
import { closingTabs } from './lifecycle.js';
import { mergePull } from './merge.js';
import { hasCodeFocus, notify } from './notifications.js';
import { startWorkspaceCleanup } from './retention.js';
import { cancelSlackReaction, cancelSlackReactions, queueSlackReaction, recoverSlackReactions, retrySlackReaction, stopSlackReactions } from './slack-reactions.js';
import { saveWorkspace, workspaceData } from './storage.js';

type SyncMode = 'initial' | 'refresh' | 'background' | 'auto';
const syncing = new Map<string, { mode: SyncMode; promise: Promise<void> }>();
const BACKGROUND_REFRESH_MS = 5 * 60 * 1000;
let flushing = false;
export function tabForReview(reviewId: string): PullTab | undefined {
  const data = workspaceData();
  return data.tabs.find((t) => t.reviewId === reviewId && !closingTabs.has(t));
}
function requireTab(key: string): PullTab {
  const tab = workspaceData().tabs.find((t) => t.key === key);
  if (!tab) throw new Error('PR tab not found');
  if (closingTabs.has(tab)) throw new Error('This PR tab is closing');
  return tab;
}
export function insertTab(tabs: PullTab[], tab: PullTab): void {
  const parent = tabs.findIndex(
    (t) =>
      tab.info !== null &&
      t.info !== null &&
      t.ref.owner === tab.ref.owner &&
      t.ref.repo === tab.ref.repo &&
      t.info.headRefName === tab.info.baseRefName,
  );
  const child = tabs.findIndex(
    (t) =>
      tab.info !== null &&
      t.info !== null &&
      t.ref.owner === tab.ref.owner &&
      t.ref.repo === tab.ref.repo &&
      t.info.baseRefName === tab.info.headRefName,
  );
  const own = tab.info?.author.login === tab.viewer;
  const firstOther = tabs.findIndex((t) => t.info?.author.login !== t.viewer);
  const index =
    parent >= 0 ? parent + 1 : child >= 0 ? child : own ? 0 : firstOther < 0 ? tabs.length : firstOther;
  tabs.splice(index, 0, tab);
}
function notifyChanges(before: PullTab['info'], tab: PullTab): void {
  const after = tab.info;
  if (!before || !after) return;
  const oldReviews = reviewerStates(before);
  for (const [name, state] of reviewerStates(after)) {
    if (state !== oldReviews.get(name))
      notify(after.title, `${name}: ${state.toLowerCase().replaceAll('_', ' ')}`);
  }
  if (before.mergeStateStatus !== 'CLEAN' && after.mergeStateStatus === 'CLEAN' && !after.isDraft)
    notify(after.title, 'Ready to merge');
  if (before.state !== 'MERGED' && after.state === 'MERGED') notify(after.title, 'PR merged');
}
export function syncTab(tab: PullTab, mode: SyncMode = 'initial'): Promise<void> {
  if (closingTabs.has(tab) || !workspaceData().tabs.includes(tab)) return Promise.resolve();
  const existing = syncing.get(tab.key);
  if (existing) {
    if (mode === 'refresh' && existing.mode !== 'refresh') {
      return existing.promise.then(() => {
        if (workspaceData().tabs.includes(tab)) return syncTab(tab, 'refresh');
      });
    }
    return existing.promise;
  }
  const promise = (mode === 'auto' ? applySourceRefresh(tab) : performSync(tab, mode)).finally(() => {
    if (syncing.get(tab.key)?.promise === promise) syncing.delete(tab.key);
    if (mode === 'background') void flushSourceRefreshes();
  });
  syncing.set(tab.key, { mode, promise });
  return promise;
}
async function performSync(tab: PullTab, mode: Exclude<SyncMode, 'auto'>): Promise<void> {
  const account = githubAccount(tab.ref);
  const background = mode === 'background';
  const refreshRequest = tab.sourceRefreshRequested;
  if (!background) tab.loading = true;
  // Migrate legacy activity before updating the metadata timestamp in the background.
  tab.lastUsedAt ||= tab.updatedAt;
  try {
    const before = tab.info;
    const [info, viewer] = await Promise.all([
      loadPull(tab.ref),
      tab.viewer && (!account || tab.viewer.toLowerCase() === account.toLowerCase())
        ? Promise.resolve({ login: tab.viewer })
        : github(tab.ref, 'user').then((v) => z.object({ login: z.string() }).parse(v)),
    ]);
    if (!workspaceData().tabs.includes(tab) || closingTabs.has(tab) || account !== githubAccount(tab.ref)) return;
    // A metadata read started before a submitted review must not erase its confirmed receipt.
    const newReviews = tab.info?.reviews.filter(review => before?.reviews.includes(review) !== true) ?? [];
    info.reviews.push(...newReviews.filter(review => !info.reviews.some(remote =>
      remote.author?.login.toLowerCase() === review.author?.login.toLowerCase() && remote.submittedAt === review.submittedAt &&
      (remote.state === review.state || remote.state === 'DISMISSED'))));
    // A read started before a successful merge cannot reopen the PR in the UI.
    if (tab.info?.state === 'MERGED' && info.state !== 'MERGED') {
      info.state = 'MERGED';
      info.mergedAt = tab.info.mergedAt;
    }
    tab.info = info;
    // Deployment lookup must never hold up metadata, comments, or the source view.
    void refreshDeployment(tab, mode !== 'initial');
    if (tab.viewer.toLowerCase() !== viewer.login.toLowerCase()) cancelSlackReaction(tab);
    tab.viewer = viewer.login;
    reconcileCommentRouting(tab);
    void flushOutbox();
    const directory = localWorkspaceConfig().slack;
    tab.slack = Object.fromEntries(
      [...reviewerStates(info).keys()]
        .filter((name) => name in directory)
        .map((name) => [name, directory[name]]),
    );
    if (!before) {
      const data = workspaceData();
      data.tabs = data.tabs.filter((t) => t !== tab);
      insertTab(data.tabs, tab);
    }
    notifyChanges(before, tab);
    tab.error = undefined;
    tab.updatedAt = Date.now();
    saveWorkspace();
    // Let code become usable independently of slow comment pagination.
    const results = await Promise.allSettled([
      syncComments(tab),
      (async () => {
        if (
          mode !== 'background' && (tab.reviewId === null || tab.checkoutEvicted ||
          ((mode === 'refresh' || tab.importLocalComments) &&
            (tab.reviewedHead !== info.headRefOid || tab.reviewedBase !== info.baseRefOid)))
        ) {
          // Open/select immediately; only source reuse must wait for an old checkout's cleanup.
          await finishDeletion(tab.key);
          if (closingTabs.has(tab) || !workspaceData().tabs.includes(tab)) return;
          await importPull(tab);
        }
        if (refreshRequest === tab.sourceRefreshRequested && tab.reviewedHead === info.headRefOid)
          delete tab.sourceRefreshRequested;
        saveWorkspace();
      })(),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (!closingTabs.has(tab) && tab.importLocalComments && tab.reviewId !== null) {
      for (const annotation of await getAnnotationsForReview(tab.reviewId)) {
        if (!tab.comments.some((message) => message.annotationId === annotation.id))
          await queueAnnotation(tab.reviewId, annotation, false);
      }
      tab.importLocalComments = false;
    }
  } catch (error) {
    tab.error = error instanceof Error ? error.message : 'Sync failed';
  } finally {
    if (!background) {
      tab.loading = false;
      tab.lastUsedAt = Date.now();
    }
    saveWorkspace();
  }
}
/** Reuse the fresh metadata; deferring source does not require another GitHub refresh. */
async function applySourceRefresh(tab: PullTab): Promise<void> {
  const request = tab.sourceRefreshRequested;
  try {
    await importPull(tab, () => !hasCodeFocus(tab.key) && !tab.checkoutEvicted);
    if (request === tab.sourceRefreshRequested && tab.reviewedHead === tab.info?.headRefOid)
      delete tab.sourceRefreshRequested;
    tab.error = undefined;
  } catch (error) {
    tab.error = error instanceof Error ? error.message : 'Could not refresh source';
  } finally {
    saveWorkspace();
  }
}
/** Agent answers check for pushed commits without replacing a focused source snapshot. */
export async function refreshAfterReply(tab: PullTab): Promise<void> {
  await syncing.get(tab.key)?.promise;
  if (tab.sourceRefreshRequested !== undefined) await syncTab(tab, 'background');
}
export async function flushSourceRefreshes(): Promise<void> {
  await Promise.all(workspaceData().tabs.filter(tab => tab.sourceRefreshRequested !== undefined
    && tab.info !== null && tab.reviewId !== null && tab.reviewedHead !== tab.info.headRefOid
    && !tab.checkoutEvicted && (tab.error === undefined || tab.error === '') && !closingTabs.has(tab) && !syncing.has(tab.key)
    && !hasCodeFocus(tab.key)).map(tab => syncTab(tab, 'auto')));
}
async function syncComments(tab: PullTab): Promise<void> {
  // Keep comments being published while this remote snapshot is in flight.
  const pendingIds = new Set(
    workspaceData()
      .outbox.filter((item) => item.tab === tab.key)
      .map((item) => item.message),
  );
  const knownRemoteIds = new Set(
    tab.comments.filter((message) => message.remoteId !== undefined).map((message) => message.remoteId),
  );
  const remote = await loadComments(tab);
  if (!workspaceData().tabs.includes(tab) || closingTabs.has(tab)) return;
  for (const item of workspaceData().outbox) if (item.tab === tab.key) pendingIds.add(item.message);
  for (const message of tab.comments)
    if (message.remoteId !== undefined && !knownRemoteIds.has(message.remoteId)) pendingIds.add(message.id);
  const local = tab.comments.filter(
    (m) => m.destination === 'local' || m.kind === 'ai' || pendingIds.has(m.id) || m.annotationId !== undefined || m.codex !== undefined,
  );
  tab.comments = [
    ...local,
    ...remote.filter((m) => !local.some((l) => (m.remoteId !== undefined && l.remoteId === m.remoteId) || l.id === m.id)),
  ];
  // Reconcile externally edited replies while retaining local annotation identity.
  for (const message of local) {
    const match = message.remoteId === undefined ? undefined : remote.find((r) => r.remoteId === message.remoteId);
    if (match?.kind === 'review') message.resolved = match.resolved;
    if (message.destination !== 'local' && !pendingIds.has(message.id) && message.remoteId !== undefined) {
      if (!match) {
        message.deleted = true;
        if (message.annotationId !== undefined) await deleteAnnotation(message.annotationId);
        continue;
      }
      const annotationId = message.annotationId;
      const line = message.line;
      const side = message.side;
      const body =
        message.fileComment === true
          ? match.body.replace(/^\[Line \d+\]\(https:\/\/github\.com\/[^\n]+\)\n\n/, '')
          : match.body;
      if (annotationId !== undefined && message.body !== body) {
        const annotation = await getAnnotationById(annotationId);
        if (annotation) await updateAnnotation(annotation.id, body, annotation.category);
      }
      Object.assign(message, match, {
        id: message.id,
        codex: message.codex,
        annotationId,
        body,
        bodyHTML: body === match.body ? match.bodyHTML : undefined,
        ...(annotationId !== undefined ? { line, side } : {}),
      });
    }
  }
  tab.commentsLoaded = true;
  reconcileCommentRouting(tab);
  saveWorkspace();
}
function needsInitialSync(tab: PullTab): boolean {
  return tab.info === null || tab.reviewId === null || !tab.viewer || !tab.commentsLoaded || tab.importLocalComments;
}
export function startWorkspace(pinnedRoot?: string): () => void {
  const data = workspaceData();
  for (const tab of [...data.archived]) discardTab(tab);
  retryDeletions();
  recoverCodexComments();
  recoverSlackReactions();
  for (const tab of [...data.tabs, ...data.archived]) {
    const account = githubAccount(tab.ref);
    if (account && account.toLowerCase() !== tab.viewer.toLowerCase()) tab.viewer = '';
    reconcileCommentRouting(tab);
    for (const message of tab.comments)
      if (message.kind === 'ai' && message.status === 'working') {
        message.status = 'error';
        message.error = 'The app restarted while the agent was working. Any local edits were preserved.';
      }
    tab.loading = false;
    if (!data.tabs.includes(tab)) continue;
    if (tab.deployment?.status === 'loading') tab.deployment.attemptedAt = 0;
    if (!needsInitialSync(tab)) void refreshDeployment(tab);
    if (tab.checkoutEvicted && tab.key !== data.active) continue;
    if (needsInitialSync(tab)) void syncTab(tab);
    else if (tab.key === data.active) void ensureCheckout(tab).catch(() => {});
  }
  saveWorkspace();
  const refreshTimer = setInterval(() => {
    retryDeletions();
    for (const tab of workspaceData().tabs) {
      const mode = needsInitialSync(tab) && !tab.checkoutEvicted ? 'initial' : 'background';
      void syncTab(tab, mode);
    }
  }, BACKGROUND_REFRESH_MS);
  refreshTimer.unref();
  // Pending writes have their own retry deadlines, independent of background reads.
  const timer = setInterval(() => {
    void flushOutbox();
    void flushCodexComments();
  }, 10_000);
  timer.unref();
  void flushOutbox();
  void flushCodexComments();
  const stopCleanup = startWorkspaceCleanup(pinnedRoot);
  return () => {
    clearInterval(refreshTimer);
    clearInterval(timer);
    stopCleanup();
    stopDeployments();
    stopSlackReactions();
  };
}
function enqueue(tab: PullTab, message: ThreadMessage, operation: 'create' | 'edit' | 'delete'): void {
  if (closingTabs.has(tab) || !workspaceData().tabs.includes(tab)) return;
  tab.lastUsedAt = Date.now();
  message.status = 'pending';
  if (tab.viewer && message.publishAs === undefined) message.publishAs = tab.viewer;
  const data = workspaceData();
  if (
    !data.outbox.some(
      (item) => item.tab === tab.key && item.message === message.id && item.operation === operation,
    )
  ) {
    data.outbox.push({
      id: randomUUID(),
      tab: tab.key,
      message: message.id,
      operation,
      nextAttempt: 0,
      attempted: false,
    });
  }
  reconcileCommentRouting(tab);
  saveWorkspace();
  void flushOutbox();
}
export function reconcileCommentRouting(tab: PullTab): void {
  const codeDestination = codeCommentDestination(tab);
  const data = workspaceData();
  if (codeDestination === 'github') delete tab.codexThreadId;
  // Establish queued authors before walking threads, regardless of stored comment order.
  for (const item of data.outbox) if (item.tab === tab.key && tab.viewer) {
    const message = tab.comments.find(candidate => candidate.id === item.message);
    if (message) message.publishAs ??= tab.viewer;
  }
  for (const message of tab.comments) {
    const queued = data.outbox.some(item => item.tab === tab.key && item.message === message.id);
    const destination = commentDestination(tab, message);
    // Routing corrections must never publish a conversation previously sent only to Codex.
    const privateHistory = message.destination === 'local' || message.codex !== undefined;
    if (privateHistory || (destination === 'local' &&
      (queued || message.kind === 'ai' || message.codex))) {
      message.destination = 'local';
      data.outbox = data.outbox.filter(item => item.tab !== tab.key || item.message !== message.id);
      if (message.kind !== 'ai') {
        message.status = 'done';
        delete message.error;
      }
    } else if (destination === 'github' && queued) message.destination = 'github';
    reconcileCodexComment(tab, message);
    if (canHandleCodexComment(tab, message) && message.codexRequested === true && !message.codex)
      queueCodexComment(tab, message);
  }
}
function canPublishComment(tab: PullTab, message: ThreadMessage): boolean {
  const author = message.publishAs ?? (message.remoteId === undefined && message.author !== 'You' ? message.author : undefined);
  return commentDestination(tab, message) === 'github' && message.destination !== 'local'
    && (author === undefined || author.toLowerCase() === tab.viewer.toLowerCase());
}

export function refreshAccountRouting(): void {
  cancelSlackReactions();
  for (const tab of workspaceData().tabs) {
    tab.viewer = '';
    for (const message of tab.comments) if (message.remoteId !== undefined) message.editable = false;
    // Let an older sync finish before replacing its identity and permissions.
    void syncTab(tab, 'background').finally(() => {
      if (!tab.viewer && workspaceData().tabs.includes(tab)) void syncTab(tab, 'background');
    });
  }
  saveWorkspace();
}
export async function queueAnnotation(
  reviewId: string,
  annotation: Annotation,
  forwardToCodex = true,
): Promise<void> {
  const tab = tabForReview(reviewId);
  if (!tab) return;
  const file = await getReviewFile(annotation.review_file_id);
  if (!file || file.review_id !== reviewId) throw new Error('Comment does not belong to this PR');
  const message: ThreadMessage = {
    id: randomUUID(),
    annotationId: annotation.id,
    body: annotation.content,
    author: tab.viewer || 'You',
    date: annotation.created_at,
    url: '',
    path: file.file_path,
    fileComment: !(
      parseDiffData(file.diff_data)?.hunks.some((hunk) =>
        hunk.lines.some(
          (line) => (annotation.side === 'old' ? line.oldNum : line.newNum) === annotation.line_number,
        ),
      ) ?? false
    ),
    line: annotation.line_number,
    side: annotation.side === 'old' ? 'old' : 'new',
    commit: tab.reviewedHead,
    kind: 'review',
    status: 'pending',
    editable: true,
    deleted: false,
    codexRequested: forwardToCodex,
  };
  tab.comments.push(message);
  enqueue(tab, message, 'create');
}
export function queueAnnotationChange(
  reviewId: string,
  id: string,
  operation: 'edit' | 'delete',
  content?: string,
): void {
  const tab = tabForReview(reviewId);
  const message = tab?.comments.find((m) => m.annotationId === id);
  if (!tab || !message) return;
  if (!message.editable) throw new Error('Only your comments can be changed');
  if (operation === 'delete') message.deleted = true;
  else reviseComment(message, content ?? message.body);
  enqueue(tab, message, Boolean(message.remoteId) || operation === 'delete' ? operation : 'create');
}
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const data = workspaceData();
    data.outbox = data.outbox.filter(item => data.tabs.some(tab => tab.key === item.tab));
    for (const tab of data.tabs) reconcileCommentRouting(tab);
    saveWorkspace();
    for (const item of [...data.outbox]) {
      if (!data.outbox.includes(item) || item.nextAttempt > Date.now()) continue;
      const tab = data.tabs.find((t) => t.key === item.tab && !closingTabs.has(t));
      const message = tab?.comments.find((m) => m.id === item.message);
      if (!tab || !message) continue;
      if (closingTabs.has(tab) || !data.tabs.includes(tab) || !data.outbox.includes(item) || !canPublishComment(tab, message)) continue;
      if (
        item.operation !== 'create' &&
        message.remoteId === undefined &&
        data.outbox.some((other) => other.message === item.message && other.operation === 'create')
      )
        continue;
      try {
        if (!tab.viewer) throw new Error('Waiting for GitHub authentication');
        message.publishAs ??= tab.viewer;
        const prefix = repoApi(tab.ref);
        const endpoint = message.kind === 'issue' ? 'issues/comments' : 'pulls/comments';
        const sentBody = message.body;
        if (item.operation === 'create' && message.remoteId === undefined) {
          if (message.deleted && !item.attempted) {
            data.outbox = data.outbox.filter((q) => q.message !== message.id);
            continue;
          }
          if (item.attempted) {
            // A prior timeout may have followed a successful POST. Look for its durable marker first.
            const kindPath =
              message.kind === 'issue'
                ? `issues/${tab.ref.number}/comments`
                : `pulls/${tab.ref.number}/comments`;
            for (let page = 1; ; page++) {
              const rows = z
                .array(RemoteCommentSchema)
                .parse(await github(tab.ref, `${prefix}/${kindPath}?per_page=100&page=${page}`));
              const existing = rows.find(
                (row) => row.body?.includes(`<!-- glassbox:${message.id} -->`) === true,
              );
              if (existing) {
                message.remoteId = existing.id;
                message.url = existing.html_url;
                break;
              }
              if (rows.length < 100) break;
            }
          }
          if (message.deleted && message.remoteId === undefined) {
            data.outbox = data.outbox.filter((q) => q.message !== message.id);
            continue;
          }
          if (message.remoteId === undefined) {
            if (closingTabs.has(tab) || !data.tabs.includes(tab) || !data.outbox.includes(item) || !canPublishComment(tab, message)) continue;
            item.attempted = true;
            saveWorkspace();
            const location =
              message.fileComment === true &&
              message.path !== undefined &&
              message.line !== null &&
              message.line !== undefined
                ? `[Line ${message.line}](https://github.com/${tab.ref.owner}/${tab.ref.repo}/blob/${message.side === 'old' ? tab.reviewedBase : message.commit}/${message.path.split('/').map(encodeURIComponent).join('/')}#L${message.line})\n\n`
                : '';
            const body = `${location}${sentBody}\n\n<!-- glassbox:${message.id} -->`;
            const payload =
              message.kind === 'issue'
                ? { body }
                : message.parentId !== undefined
                  ? { body, in_reply_to: message.parentId }
                  : {
                      body,
                      commit_id: message.commit,
                      path: message.path,
                      ...((message.line ?? 0) > 0 && message.fileComment !== true
                        ? {
                            line: message.line,
                            side: message.side === 'old' ? 'LEFT' : 'RIGHT',
                          }
                        : { subject_type: 'file' }),
                    };
            const remote = RemoteCommentSchema.parse(
              await github(
                tab.ref,
                `${prefix}/${message.kind === 'issue' ? 'issues' : 'pulls'}/${tab.ref.number}/comments`,
                'POST',
                payload,
              ),
            );
            message.remoteId = remote.id;
            message.url = remote.html_url;
          }
        } else if (item.operation === 'edit' && Boolean(message.remoteId)) {
          await github(tab.ref, `${prefix}/${endpoint}/${message.remoteId}`, 'PATCH', {
            body: `${sentBody}\n\n<!-- glassbox:${message.id} -->`,
          });
        } else if (item.operation === 'delete' && Boolean(message.remoteId)) {
          try {
            await github(tab.ref, `${prefix}/${endpoint}/${message.remoteId}`, 'DELETE');
          } catch (error) {
            if (!(error instanceof Error && error.message.startsWith('GitHub 404:'))) throw error;
          }
        }
        data.outbox = data.outbox.filter((q) => q.id !== item.id);
        message.status = 'synced';
        message.error = undefined;
        if (message.body !== sentBody && !message.deleted) enqueue(tab, message, 'edit');
      } catch (error) {
        message.status = 'error';
        message.error = error instanceof Error ? error.message : 'Offline';
        item.nextAttempt = Date.now() + 300_000;
      }
      saveWorkspace();
    }
  } finally {
    flushing = false;
  }
}
function discardTab(tab: PullTab): void {
  const data = workspaceData();
  closingTabs.add(tab);
  cancelDeployment(tab);
  cancelSlackReaction(tab);
  // Closing is a durable user decision; filesystem cleanup cannot roll it back.
  data.tabs = data.tabs.filter(item => item !== tab);
  data.archived = data.archived.filter(item => item !== tab);
  data.outbox = data.outbox.filter(item => item.tab !== tab.key);
  if (data.active === tab.key) data.active = data.tabs[0]?.key ?? null;
  syncing.delete(tab.key);
  queueDeletion(tab);
}
export async function mutateWorkspace(input: WorkspaceMutation, currentReviewId: string): Promise<void> {
  const data = workspaceData();
  if (input.op === 'open') {
    const ref = parsePullUrl(input.url);
    const archived = data.archived.find(t => t.key === pullKey(ref));
    if (archived) discardTab(archived);
    let tab = data.tabs.find((t) => t.key === pullKey(ref));
    if (!tab) {
      tab = PullTabSchema.parse({
        key: pullKey(ref),
        ref,
        reviewId: null,
        repoRoot: null,
        info: null,
        loading: true,
      });
      if (input.attachReviewId !== undefined) {
        if (input.attachReviewId !== currentReviewId) throw new Error('Can only attach the current review');
        const review = await getReview(currentReviewId);
        if (!review) throw new Error('Review not found');
        tab.reviewId = review.id;
        tab.repoRoot = review.repo_path;
        tab.reviewedHead = review.head_commit ?? '';
        tab.reviewedBase = review.mode.startsWith('range:') ? review.mode.slice(6).split('..')[0] : '';
        tab.importLocalComments = true;
      }
      data.tabs.unshift(tab);
    }
    data.active = tab.key;
    tab.lastUsedAt = Date.now();
    saveWorkspace();
    if (needsInitialSync(tab)) void syncTab(tab);
    else void ensureCheckout(tab).catch(() => {});
    return;
  }
  if (input.op === 'order') {
    const visible = data.tabs.filter(tab => !closingTabs.has(tab));
    if (
      new Set(input.keys).size !== visible.length ||
      input.keys.length !== visible.length ||
      input.keys.some((key) => !visible.some((t) => t.key === key))
    )
      throw new Error('Order must contain each PR exactly once');
    data.tabs = [...input.keys.map(requireTab), ...data.tabs.filter(tab => closingTabs.has(tab))];
    saveWorkspace();
    return;
  }
  if (input.op === 'close') {
    const tab = data.tabs.find(item => item.key === input.key);
    if (tab) {
      discardTab(tab);
      const next = data.tabs.find(item => item.key === data.active);
      if (next) void ensureCheckout(next).catch(() => {});
    }
    else { saveWorkspace(); retryDeletions(); }
    return;
  }
  const tab = requireTab(input.key);
  tab.lastUsedAt = Date.now();
  if (input.op === 'retry-slack') retrySlackReaction(tab);
  if (input.op === 'retry-codex') {
    const message = tab.comments.find(item => item.id === input.id && !item.deleted);
    if (!message) throw new Error('Comment not found');
    retryCodexComment(tab, message);
  }
  if (input.op === 'retry-agent') {
    const reply = tab.comments.find((message) => message.id === input.id && message.kind === 'ai');
    const original = tab.comments.find((message) => message.id === reply?.parentKey);
    if (reply?.status !== 'error' || !original) throw new Error('No failed agent job to retry');
    queueCodexComment(tab, original);
  }
  if (input.op === 'select') {
    data.active = tab.key;
    if (needsInitialSync(tab)) void syncTab(tab);
    else void ensureCheckout(tab).catch(() => {});
  }
  if (input.op === 'view') tab.view = input.view;
  if (input.op === 'refresh') {
    tab.loading = true;
    saveWorkspace();
    await syncTab(tab, 'refresh');
    tab.loading = false;
  }
  if (input.op === 'edit') {
    if (!isPullAuthor(tab)) throw new Error('Only the PR author can edit its title or description in rev');
    await github(tab.ref, `${repoApi(tab.ref)}/pulls/${tab.ref.number}`, 'PATCH', {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    if (tab.info) {
      if (input.title !== undefined) tab.info.title = input.title;
      if (input.body !== undefined) { tab.info.body = input.body; delete tab.info.bodyHTML; }
    }
  }
  if (input.op === 'merge') {
    const before = tab.info;
    await mergePull(tab, input.expectedHead, () => workspaceData().tabs.includes(tab) && !closingTabs.has(tab));
    notifyChanges(before, tab);
    void syncTab(tab, 'background');
  }
  if (input.op === 'action') {
    const receipt = await mutatePull(tab, input.action, input.body);
    tab.action = input.action;
    if (receipt) queueSlackReaction(tab, receipt);
    void syncTab(tab);
  }
  if (input.op === 'comment') {
    if (input.parentKey !== undefined && input.parentId !== undefined) throw new Error('Choose one comment thread');
    const parent =
      tab.comments.find(m => !m.deleted && (input.parentKey !== undefined ? m.id === input.parentKey
        : input.parentId !== undefined && m.remoteId === input.parentId));
    if ((input.parentId !== undefined || input.parentKey !== undefined) && !parent) throw new Error('Comment thread not found');
    if (parent?.kind === 'issue' || (parent?.kind === 'ai' && parent.path === undefined))
      throw new Error('Use the Main view composer to post a PR comment on GitHub');
    if (input.parentKey !== undefined && codeCommentDestination(tab) !== 'local') throw new Error('Local replies are only available on your own PRs');
    const root = parent && codeThreadRoot(tab, parent);
    if (parent && !root) throw new Error('Comment thread not found');
    const local = parent !== undefined && (parent.destination === 'local' || commentDestination(tab, parent) === 'local');
    if (parent && !local && root?.remoteId === undefined) throw new Error('This thread is not available on GitHub');
    const message: ThreadMessage = {
      id: randomUUID(),
      body: input.body,
      author: tab.viewer || 'You',
      date: new Date().toISOString(),
      url: '',
      kind: parent !== undefined ? 'review' : 'issue',
      destination: local ? 'local' : undefined,
      parentId: local ? undefined : root?.remoteId,
      parentKey: local ? parent.id : undefined,
      path: parent?.path,
      line: parent?.line,
      side: parent?.side,
      commit: parent?.commit,
      status: 'pending',
      editable: true,
      deleted: false,
      codexRequested: parent !== undefined,
    };
    tab.comments.push(message);
    enqueue(tab, message, 'create');
  }
  if (input.op === 'edit-comment') throw new Error('Posted comments cannot be edited. Add a reply instead.');
  if (input.op === 'delete-comment') {
    const message = tab.comments.find((m) => m.id === input.id);
    if (message?.editable !== true) throw new Error('Only your comments can be deleted');
    message.deleted = true;
    enqueue(
      tab,
      message,
      'delete',
    );
  }
  saveWorkspace();
}
export async function assertOwnAnnotation(reviewId: string, id: string): Promise<void> {
  const annotation = await getAnnotationById(id);
  const file = annotation && (await getReviewFile(annotation.review_file_id));
  if (!file || file.review_id !== reviewId) throw new Error('Comment not found in this review');
}
