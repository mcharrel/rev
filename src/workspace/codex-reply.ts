import { randomUUID } from 'node:crypto';

import { canHandleCodexComment, commentAgentStatus, type ThreadMessage } from '../api/workspace.js';
import { commentPrompt } from './codex.js';
import { parsePullUrl, pullKey } from './github.js';
import { closingTabs } from './lifecycle.js';
import { saveWorkspace, workspaceData } from './storage.js';

type CommentInput = { url: string; threadId: string; commentId: string; revision?: number };

function boundComment(input: CommentInput) {
  const data = workspaceData();
  const key = pullKey(parsePullUrl(input.url));
  const tab = data.tabs.find(item => item.key === key && !closingTabs.has(item));
  const original = tab?.comments.find(item => item.id === input.commentId && !item.deleted && item.kind !== 'ai');
  if (!tab || !original) throw new Error('Comment not found in this PR');
  if (!canHandleCodexComment(tab, original))
    throw new Error('Codex only handles your local comments in threads you started on your own PRs');
  if (tab.codexThreadId !== input.threadId || original.codex?.threadId !== input.threadId)
    throw new Error('Only the originating Codex chat can answer this comment');
  if ((original.revision ?? 1) !== (input.revision ?? 1))
    throw new Error('The comment was edited. Read its latest revision before picking it up or answering.');
  return { tab, original, delivery: original.codex };
}

export function pickUpCodexComment(input: CommentInput): void {
  const { original, delivery } = boundComment(input);
  if (original.agentStatus !== 'answered') original.agentStatus = 'processing';
  delivery.status = 'sent';
  delete delivery.error;
  saveWorkspace();
}

export function listCodexComments(input: { url: string; threadId: string }) {
  const key = pullKey(parsePullUrl(input.url));
  const tab = workspaceData().tabs.find(item => item.key === key && !closingTabs.has(item));
  if (!tab || tab.codexThreadId !== input.threadId) throw new Error('PR is not linked to this Codex chat');
  return tab.comments.filter(message => !message.deleted && message.codex?.threadId === input.threadId
    && canHandleCodexComment(tab, message) && commentAgentStatus(message) !== undefined
    && commentAgentStatus(message) !== 'answered').map(message => ({
      id: message.id, revision: message.revision ?? 1, status: commentAgentStatus(message),
      body: message.body, path: message.path, line: message.line, side: message.side,
      prompt: commentPrompt(tab, message),
    }));
}

export function postCodexReply(input: CommentInput & { body: string }): string {
  const { tab, original, delivery } = boundComment(input);
  // Repeating the same reply after a lost acknowledgement must not duplicate it.
  const existing = tab.comments.find(item => item.kind === 'ai' && item.author === 'Codex'
    && item.parentKey === original.id && item.body === input.body && !item.deleted
    && (item.replyToRevision ?? 1) === (original.revision ?? 1));
  const reply: ThreadMessage = existing ?? {
    id: randomUUID(), parentKey: original.id, author: 'Codex', body: input.body,
    date: new Date().toISOString(), url: '', kind: 'ai', status: 'done', editable: false, deleted: false, destination: 'local',
    path: original.path, line: original.line, side: original.side, annotationId: original.annotationId,
    replyToRevision: original.revision ?? 1,
  };
  if (!existing) {
    tab.comments.push(reply);
    tab.sourceRefreshRequested = randomUUID();
  }
  original.agentStatus = 'answered';
  delivery.status = 'sent';
  delete delivery.error;
  tab.lastUsedAt = Date.now();
  saveWorkspace();
  return reply.id;
}
