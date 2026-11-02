import { delegate, delegateCapture, effect } from 'kerfjs';

import { commentAgentStatus, commentDestination, isPullAuthor, type ThreadMessage } from '../../api/workspace.js';
import { codeCommentPlaceholder,CommentAuthor } from '../../components/commentAuthor.js';
import { IconCheck, IconCornerDownRight, IconTrash } from '../../icons.js';
import { renderGitHubMarkdown } from '../../utils/githubMarkdown.js';
import { refreshFind } from '../diff/find.js';
import { toElement } from '../dom.js';
import { reviewStore } from '../stores/index.js';
import { showToast } from '../toast.js';
import { commentAnchor } from './commentAnchor.js';
import { activeTab, mutate,retainedTabs } from './state.js';

export function codexStatus(message: ThreadMessage) {
  const status = commentAgentStatus(message);
  if (status === undefined) return null;
  const delivery = message.codex;
  return <div className="agent-status" role="status" title={delivery?.error ?? (!delivery ? 'No Codex chat linked yet' : '')}>
    {status === 'answered' ? 'Answered' : status === 'processing' ? 'Agent working' : 'Pending pickup'}
    {delivery && <> · <a href={`codex://threads/${delivery.threadId}`}>Codex</a></>}
    {status === 'pending' && delivery?.status === 'uncertain' && <>
      {' · Check chat before resending '}
      <button className="btn btn-xs" data-comment-action="retry-codex" data-message-id={message.id}>Resend</button>
    </>}
  </div>;
}
export function commentTime(date: string, now = Date.now()): string {
  const elapsed = now - Date.parse(date);
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function messageHtml(message: ThreadMessage) {
  const code = message.kind === 'review' || message.path !== undefined;
  const pending = message.destination !== 'local' && (message.status === 'pending' || message.status === 'error');
  return (
    <article
      className={`pr-message ${message.kind === 'ai' ? 'agent-message' : ''}`}
      data-message={message.id}
      data-key={message.id}
      data-code-comment={code ? 'true' : undefined}
      data-agent-status={commentAgentStatus(message)}
    >
      <div className="pr-message-meta">
        {pending && (
          <span
            className="comment-offline"
            title={message.error ?? (message.destination === 'github' ? 'Waiting to sync; retrying every five minutes' : 'Waiting to determine PR ownership')}
          >
            ☁
          </span>
        )}
        <CommentAuthor author={message.author} agent={message.kind === 'ai'} />
        <time dateTime={message.date} title={new Date(message.date).toLocaleString()}>{code ? commentTime(message.date) : new Date(message.date).toLocaleString()}</time>
        {message.destination === 'local' && <span className="comment-local-label">Local</span>}
        <span className="pr-message-actions">
          {message.destination !== 'local' && <button
            className="btn btn-xs comment-share"
            data-comment-action="share"
            title="Copy GitHub comment link"
            disabled={!message.url}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8" />
            </svg>
          </button>}
          {message.editable && (
            <button className="btn btn-xs btn-danger" data-comment-action="delete" title="Delete">
              <IconTrash />
            </button>
          )}
        </span>
      </div>
      <div className="pr-message-body github-markdown">{renderGitHubMarkdown(message.body, message.bodyHTML)}</div>
      {codexStatus(message)}
      {message.status === 'working' && <div className="agent-status">AI working…</div>}
      {Boolean(message.error) && (
        <div className="workspace-error">
          {message.error}
          {message.kind === 'ai' && (
            <button className="btn btn-xs" data-comment-action="retry">
              Retry
            </button>
          )}
        </div>
      )}
    </article>
  );
}
function resolvedThread(root: ThreadMessage, content: ReturnType<typeof messageHtml>, open: boolean) {
  return <details className="resolved-thread" data-resolved-thread={root.id} data-resolved-tab={activeTab()?.key} open={open}>
    <summary><IconCheck /><span>Resolved</span><span className="resolved-thread-author">{root.author}</span></summary>
    <div className="resolved-thread-content">{content}</div>
  </details>;
}
export function threadHtml(root: ThreadMessage, comments: ThreadMessage[], expanded = false) {
  const replies = comments.filter(
    (m) => !m.deleted && (m.parentKey === root.id || (root.remoteId !== undefined && m.parentId === root.remoteId)),
  );
  const content = <>
    {messageHtml(root)}
    <div className="code-thread-replies">{replies.map((reply) => <>
      {messageHtml(reply)}
      {comments.filter((child) => !child.deleted && child.parentKey === reply.id).map(messageHtml)}
    </>)}</div>
    {replyInput(root)}
  </>;
  return <div className={`pr-thread${root.kind === 'review' ? ' code-thread-card' : ''}`}
    data-agent-status={root.kind === 'review' ? commentAgentStatus(root) : undefined}
    data-comment-thread={root.id} data-key={root.id}>
    {root.kind === 'review' && root.resolved === true ? resolvedThread(root, content, expanded) : content}
  </div>;
}
function replyInput(root: ThreadMessage) {
  const tab = activeTab();
  const local = root.kind === 'review' && tab !== undefined && isPullAuthor(tab) && (root.destination === 'local' || commentDestination(tab, root) === 'local');
  if (!local && !(root.destination !== 'local' && root.kind === 'review' && root.remoteId !== undefined)) return null;
  return <details className="code-reply-disclosure" data-reply-composer={root.id}>
    <summary><IconCornerDownRight />Add reply…</summary>
    <div className="code-comment-composer">
      <CommentAuthor author={(tab?.viewer ?? '') || 'You'} />
      <textarea className="pr-reply-input" aria-label="Reply"
        data-parent-key={local ? root.id : undefined} data-reply-to={local ? undefined : root.remoteId}
        placeholder={codeCommentPlaceholder(tab, root)} />
      <span className="annotation-form-hint">Enter to reply · Shift+Enter for a new line</span>
    </div>
  </details>;
}
/** Retain disclosure state and unsent text only for threads still present in this file. */
export function preserveReplyComposers(view: Element): () => void {
  const composers = new Map([...view.querySelectorAll<HTMLDetailsElement>('[data-reply-composer]')]
    .map(element => [element.dataset.replyComposer, element]));
  return () => {
    for (const replacement of view.querySelectorAll<HTMLElement>('[data-reply-composer]')) {
      const composer = composers.get(replacement.dataset.replyComposer);
      if (composer) replacement.replaceWith(composer);
    }
  };
}
export function bindThreads(): void {
  const candidate = document.getElementById('diff-container');
  if (!candidate) return;
  const pane = candidate;
  const expanded = new Set<string>();
  const expansionKey = (tab: string, id: string) => JSON.stringify([tab, id]);
  let previousView: Element | null = null;
  let previous = '';
  function render(): void {
    const tab = activeTab();
    const view = pane.querySelector<HTMLElement>('.diff-view');
    if (!tab || !view || tab.reviewId !== reviewStore.state.value.reviewId
      || view.dataset.fileId !== reviewStore.state.value.currentFileId) return;
    const signature = JSON.stringify(tab.comments);
    if (view === previousView && signature === previous) return;
    if (pane.querySelector('textarea:focus')) return;
    previousView = view;
    previous = signature;
    // Preserve expansion even if a native details toggle has not fired yet.
    for (const details of pane.querySelectorAll<HTMLDetailsElement>('.resolved-thread')) {
      const id = details.dataset.resolvedThread;
      if (id === undefined || details.dataset.resolvedTab !== tab.key || !tab.comments.some(message => message.id === id && message.resolved === true)) continue;
      const key = expansionKey(tab.key, id);
      if (details.open) expanded.add(key); else expanded.delete(key);
    }
    // Keep the actual composer nodes so a refresh cannot discard an unfocused draft.
    const restoreComposers = preserveReplyComposers(view);
    // Unwrap local annotations before rebuilding their thread decoration.
    for (const card of pane.querySelectorAll('.local-code-thread')) card.replaceWith(...card.childNodes);
    for (const folded of pane.querySelectorAll('.local-resolved-thread')) {
      const content = folded.querySelector('.resolved-thread-content');
      if (content) folded.replaceWith(...content.childNodes);
    }
    pane
      .querySelectorAll(
        '.pr-inline-thread, .local-thread-details, .local-comment-header, .local-agent-status, .local-comment-share',
      )
      .forEach((el) => {
        el.remove();
      });
    for (const message of tab.comments) {
      if (!message.deleted || message.annotationId === undefined) continue;
      const item = pane.querySelector(`[data-annotation-id="${message.annotationId}"]`);
      const row = item?.closest('.annotation-row');
      item?.remove();
      if (row && !row.querySelector('.annotation-item')) row.remove();
    }
    const comments = tab.comments.filter((m) => !m.deleted);
    const roots = comments.filter(
      (m) => m.kind === 'review' && m.parentId === undefined && m.parentKey === undefined && m.path === view.dataset.filePath,
    );
    for (const root of roots) {
      const local =
        root.annotationId !== undefined
          ? pane.querySelector<HTMLElement>(`[data-annotation-id="${root.annotationId}"]`)
          : null;
      if (local) {
        local.dataset.commentThread = root.id;
        const agentStatus = commentAgentStatus(root);
        if (agentStatus) local.dataset.agentStatus = agentStatus;
        else delete local.dataset.agentStatus;
        const localText = local.querySelector('.annotation-text');
        if (localText && localText.textContent !== root.body) localText.textContent = root.body;
        const status = toElement(
          <div className="local-comment-header">
            <CommentAuthor author={root.author} />
            <time dateTime={root.date} title={new Date(root.date).toLocaleString()}>{commentTime(root.date)}</time>
            <span className="local-comment-status" title={root.destination === 'local' ? 'Only in rev' : root.error ?? 'Waiting to sync'}>
              {root.destination === 'local' ? 'Local' : root.status === 'synced' ? '' : '☁'}
            </span>
          </div>,
        );
        local.prepend(status);
        if (agentStatus) local.append(toElement(<div className="local-agent-status">{codexStatus(root)}</div>));
        const share = toElement(
          <button
            className="btn btn-xs local-comment-share"
            title="Copy GitHub comment link"
            disabled={!root.url}
          >
            ↗
          </button>,
        );
        share.addEventListener('click', (e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(root.url).then(() => {
            showToast('Comment link copied');
          });
        });
        if (root.destination !== 'local') local.querySelector('.annotation-actions')?.prepend(share);
        const replies = comments.filter(
          (m) => m.parentKey === root.id || (root.remoteId !== undefined && m.parentId === root.remoteId),
        );
        const details = toElement(
          <div className="local-thread-details">
            <div className="code-thread-replies">{replies.map((reply) => (
              <>
                {messageHtml(reply)}
                {comments.filter((child) => !child.deleted && child.parentKey === reply.id).map(messageHtml)}
              </>
            ))}</div>
            {replyInput(root)}
          </div>,
        );
        const card = toElement(<div className="code-thread-card local-code-thread" data-comment-thread={root.id} data-agent-status={agentStatus} />);
        local.before(card);
        card.append(local, details);
        delete local.dataset.commentThread;
        if (root.resolved === true) {
          const folded = toElement(resolvedThread(root, <></>, expanded.has(expansionKey(tab.key, root.id))));
          folded.classList.add('local-resolved-thread');
          local.before(folded);
          folded.querySelector('.resolved-thread-content')?.append(local, details);
        }
        continue;
      }
      const line = commentAnchor(view, root);
      // Outdated/unanchored remote comments belong to history, not the current code.
      if (!line) continue;
      const holder = toElement(
        <div className="annotation-row pr-inline-thread">{threadHtml(root, comments, expanded.has(expansionKey(tab.key, root.id)))}</div>,
      );
      (line.closest('.split-row') ?? line).after(holder);
    }
    restoreComposers();
    refreshFind();
  }
  effect(() => {
    const resolved = new Set(retainedTabs().flatMap(tab => tab.comments
      .filter(message => message.resolved === true && !message.deleted)
      .map(message => expansionKey(tab.key, message.id))));
    for (const key of expanded) if (!resolved.has(key)) expanded.delete(key);
    void reviewStore.state.value.currentFileId;
    render();
  });
  void delegateCapture<HTMLDetailsElement>(document.body, 'toggle', '.resolved-thread', (_event, element) => {
    if (!element.isConnected || element.dataset.resolvedTab === undefined || element.dataset.resolvedThread === undefined) return;
    const key = expansionKey(element.dataset.resolvedTab, element.dataset.resolvedThread);
    if (element.open) expanded.add(key); else expanded.delete(key);
  });
  void delegateCapture<HTMLDetailsElement>(pane, 'toggle', '.code-reply-disclosure', (_event, element) => {
    if (element.open && element.isConnected) element.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  });
  document.addEventListener('glassbox-diff-ready', () => {
    previousView = null;
    render();
  });
  document.addEventListener('glassbox-comment-saved', () => {
    previous = '';
    render();
  });
  void delegate(document.body, 'click', '[data-comment-action]', (event, element) => {
    event.stopPropagation();
    const item = element.closest<HTMLElement>('[data-message]');
    const tab = activeTab();
    const message = tab?.comments.find((m) => m.id === ((element as HTMLElement).dataset.messageId ?? item?.dataset.message));
    if (!tab || !message) return;
    if ((element as HTMLElement).dataset.commentAction === 'share')
      void navigator.clipboard.writeText(message.url).then(() => {
        showToast('Comment link copied');
      });
    else if ((element as HTMLElement).dataset.commentAction === 'retry-codex')
      void mutate({ op: 'retry-codex', key: tab.key, id: message.id });
    else if ((element as HTMLElement).dataset.commentAction === 'retry')
      void mutate({ op: 'retry-agent', key: tab.key, id: message.id });
    else {
      const button = element as HTMLButtonElement;
      if (button.disabled || !message.editable) return;
      button.disabled = true;
      void mutate({ op: 'delete-comment', key: tab.key, id: message.id }).finally(() => { button.disabled = false; });
    }
  });
  void delegate(document.body, 'keydown', '.pr-reply-input', (event, element) => {
    const e = event as KeyboardEvent;
    const input = element as HTMLTextAreaElement;
    const tab = activeTab();
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !tab || !input.value.trim() || input.disabled)
      return;
    e.preventDefault();
    input.disabled = true;
    void mutate({
      op: 'comment',
      key: tab.key,
      body: input.value,
      ...(input.dataset.parentKey !== undefined ? { parentKey: input.dataset.parentKey } : { parentId: Number(input.dataset.replyTo) }),
    })
      .then((ok) => {
        if (ok) {
          input.value = '';
          input.blur();
          const composer = input.closest('details');
          if (composer) composer.open = false;
          previous = '';
          render();
        }
      })
      .finally(() => {
        input.disabled = false;
      });
  });
}
