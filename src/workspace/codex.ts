import { canHandleCodexComment, commentDestination, type PullTab, type ThreadMessage } from '../api/workspace.js';
import { codexConnection, sendToCodex } from './codex-client.js';
import { codexEnabled } from './codex-settings.js';
import { closingTabs } from './lifecycle.js';
import { saveWorkspace, workspaceData } from './storage.js';

export function commentPrompt(tab: PullTab, message: ThreadMessage): string {
  const body = message.body.replace(/^\s*\[steer\]\s*/i, '');
  const location = message.path !== undefined ? `\nFile: ${message.path}${message.line != null ? `:${message.line} (${message.side ?? 'new'})` : ''}` : '';
  const command = `${tab.ref.url} --comment ${message.id} --revision ${message.revision ?? 1}`;
  return `new comment: ${body}\n\nPR: ${tab.ref.url}${location}\nrev comment: ${message.id}\n\nBefore starting work, acknowledge pickup:\nrev pickup ${command}\nAfter handling this comment, post a concise answer into its rev thread:\nrev reply ${command} --body-file <reply-file>\nPickup marks the comment as processing; the reply marks it answered. If the comment changed, run rev comments ${tab.ref.url} and use its latest revision. Keep CODEX_THREAD_ID unchanged. Use the existing chat context and normal verification/signing workflow.`;
}
export function queueCodexComment(tab: PullTab, message: ThreadMessage): void {
  if (closingTabs.has(tab) || !canHandleCodexComment(tab, message)) return;
  if (tab.codexThreadId === undefined || message.codex || message.deleted || message.kind === 'ai') return;
  message.codex = {
    threadId: tab.codexThreadId,
    mode: /^\s*\[steer\]/i.test(message.body) ? 'steer' : 'queue',
    status: 'queued',
  };
  saveWorkspace();
  void flushCodexComments();
}
/** Editing starts a new request; an answer to an older revision must not complete it. */
export function reviseComment(message: ThreadMessage, body: string): void {
  if (message.body === body) return;
  message.body = body;
  delete message.bodyHTML;
  if (message.destination === 'local' && message.kind === 'review') {
    message.revision = (message.revision ?? 1) + 1;
    message.agentStatus = 'pending';
    if (message.codex) message.codexRequested = true;
    delete message.codex;
  }
}
export function retryCodexComment(tab: PullTab, message: ThreadMessage): void {
  if (!canHandleCodexComment(tab, message)) throw new Error('Codex only handles your local comments in threads you started on your own PRs');
  if (!message.codex || message.codex.status !== 'uncertain') throw new Error('No uncertain delivery to retry');
  message.codex.status = 'queued';
  delete message.codex.error;
  saveWorkspace();
  void flushCodexComments();
}
/** Cancel stale deliveries without making historical private messages public. */
export function reconcileCodexComment(tab: PullTab, message: ThreadMessage): void {
  if (message.codex && message.destination === undefined) message.destination = 'local';
  if (commentDestination(tab, message) === null || canHandleCodexComment(tab, message)) return;
  delete message.codex;
  if (message.destination === 'local' && message.kind === 'review') message.codexRequested = false;
}
export function recoverCodexComments(): void {
  const data = workspaceData();
  for (const tab of data.tabs) for (const message of tab.comments) {
    reconcileCodexComment(tab, message);
    if (canHandleCodexComment(tab, message) && message.agentStatus === undefined) {
      message.agentStatus = tab.comments.some(reply => !reply.deleted && reply.kind === 'ai' && reply.status === 'done'
        && reply.parentKey === message.id && (reply.replyToRevision ?? 1) === (message.revision ?? 1)) ? 'answered' : 'pending';
    }
    if (message.codex?.status === 'sending') {
      message.codex.status = 'uncertain';
      message.codex.error = 'Delivery was interrupted. Check the Codex chat before resending.';
    }
  }
}
let flushing = false;
let flushAgain = false;
export async function flushCodexComments(): Promise<void> {
  if (!codexEnabled()) return;
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    const data = workspaceData();
    const connections = new Map<string, Awaited<ReturnType<typeof codexConnection>> | null>();
    // Steers bypass queued ordinary comments, including ones in another PR bound to this chat.
    const pending = data.tabs.flatMap(tab => tab.comments.map(message => ({ tab, message })))
      .filter(({ tab, message }) => canHandleCodexComment(tab, message) && message.codex?.status === 'queued' && message.codex.threadId === tab.codexThreadId)
      .sort((a, b) => Number(b.message.codex?.mode === 'steer') - Number(a.message.codex?.mode === 'steer'));
    for (const { tab, message } of pending) {
      const delivery = message.codex;
      if (!delivery || closingTabs.has(tab) || !data.tabs.includes(tab)) continue;
      let connection = connections.get(delivery.threadId);
      if (connection === undefined) {
        try { connection = await codexConnection(delivery.threadId); }
        catch (error) {
          connection = null;
          delivery.error = error instanceof Error ? error.message : 'Codex is unavailable';
        }
        connections.set(delivery.threadId, connection);
      }
      if (!connection) {
        delivery.error ??= 'Waiting for Codex. Open the originating chat.';
        continue;
      }
      if (!codexEnabled() || closingTabs.has(tab) || !data.tabs.includes(tab) || message.deleted || message.codex !== delivery || delivery.status !== 'queued' || !canHandleCodexComment(tab, message) || tab.codexThreadId !== delivery.threadId) continue;
      delete delivery.error;
      // Persist before dispatch: a lost acknowledgement must never cause an automatic duplicate.
      const stillSending = () => message.codex === delivery && delivery.status === 'sending';
      delivery.status = 'sending';
      saveWorkspace();
      try {
        await sendToCodex(connection, delivery.threadId, commentPrompt(tab, message), delivery.mode, (message.revision ?? 1) === 1 ? message.id : `${message.id}:${message.revision}`);
        if (stillSending()) delivery.status = 'sent';
      } catch {
        if (stillSending()) {
          delivery.status = 'uncertain';
          delivery.error = 'Delivery was not confirmed. Check the Codex chat before resending.';
        }
        connection.client.close();
        connections.set(delivery.threadId, null);
      }
      saveWorkspace();
    }
    for (const connection of connections.values()) connection?.client.close();
    saveWorkspace();
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; void flushCodexComments(); }
  }
}
