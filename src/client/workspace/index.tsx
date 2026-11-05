import { delegate, effect, morph, mount } from 'kerfjs';

import { commentDestination, isPullAuthor, type PullTab, reviewerStates } from '../../api/workspace.js';
import { parseDiffData } from '../../git/parseDiffData.js';
import { renderGitHubMarkdown } from '../../utils/githubMarkdown.js';
import { refreshFind } from '../diff/find.js';
import { restoreDiffScroll, saveDiffScroll } from '../diff/index.js';
import { asEl, asInput, asTextarea, toElement } from '../dom.js';
import { filePriority } from '../sidebar/readingOrder.js';
import { reviewStore } from '../stores/index.js';
import { openExternalUrl } from '../tauri.js';
import { showToast } from '../toast.js';
import { checks } from './checks.js';
import { initCommentDelete } from './commentDelete.js';
import { createCommentNavigator } from './commentNavigation.js';
import { conversation as conversationHtml } from './conversation.js';
import { clickedDescriptionText } from './description.js';
import { descriptionEditOffset, focusDescriptionEditor, previewDescriptionEditor, resizeDescriptionEditor } from './descriptionEditor.js';
import { pasteDescriptionLink } from './descriptionPaste.js';
import { startFreshReview } from './freshReview.js';
import { copyPullLink, pullHeader } from './header.js';
import { bindDivider } from './resize.js';
import { initSourceRefresh, refreshActivePull } from './sourceRefresh.js';
import { activeReviewReady, activeTab, addingPull, closingPulls, mergingPulls, mutate, refreshingPulls, refreshWorkspace, retainedTabs, reviewLoadState, reviewRetry, reviewSessionKey, workspace } from './state.js';
import { bindThreads } from './threads.js';

function lifecycle(tab: PullTab): string {
  return tab.info?.state === 'MERGED'
    ? 'merged'
    : tab.info?.state === 'CLOSED'
      ? 'closed'
      : tab.info?.isDraft === true
        ? 'draft'
        : 'open';
}
function title(tab: PullTab): string {
  return tab.info?.title ?? `${tab.ref.owner}/${tab.ref.repo} #${tab.ref.number}`;
}
function tabList() {
  const state = workspace.value;
  return (
    <>
      <div className="pr-tabs-list">
        {state.tabs.map((tab) => (
          <button
            className={`pr-tab ${lifecycle(tab)} ${state.active === tab.key && !addingPull.value ? 'selected' : ''}`}
            data-tab={tab.key}
            data-key={tab.key}
            title={title(tab)}
          >
            <span className="pr-tab-number">{tab.ref.number}</span>
            <span className="pr-tab-title">{title(tab)}</span>
          </button>
        ))}
      <button className="pr-add" data-workspace="add" title="Add PR">
        +
      </button>
      </div>
      <a className="pr-repo-link" href="https://github.com/mcharrel/rev" target="_blank" rel="noreferrer" aria-label="rev on GitHub">
        <span className="pr-repo-name">rev</span>
      </a>
    </>
  );
}
function totals() {
  let added = 0;
  let removed = 0;
  for (const file of reviewStore.state.value.files) {
    if ([2, 4].includes(filePriority(file))) continue;
    for (const hunk of parseDiffData(file.diff_data)?.hunks ?? [])
      for (const line of hunk.lines) {
        if (line.type === 'add') added++;
        else if (line.type === 'remove') removed++;
      }
  }
  return { added, removed };
}
function reviewers(tab: PullTab) {
  const states = tab.info ? reviewerStates(tab.info) : new Map<string, string>();
  return (
    <>
      {[...states]
        .filter(([name]) => name)
        .map(([name, state]) => (
          <div className="pr-reviewer" data-key={name}>
            <span className={state === 'APPROVED' ? 'review-approved' : 'review-pending'} title={state}>
              {state === 'APPROVED' ? '✓' : '●'}
            </span>
            {tab.slack[name] ? (
              <a href={tab.slack[name]} target="_blank" rel="noreferrer">
                {name}
              </a>
            ) : (
              <span>{name}</span>
            )}
          </div>
        ))}
    </>
  );
}
function switchTo(tab: PullTab): void {
  addingPull.value = false;
  workspace.value = { ...workspace.value, active: tab.key };
  void mutate({ op: 'select', key: tab.key });
}
export function initWorkspace(): void {
  initSourceRefresh();
  initCommentDelete();
  const body = document.querySelector('.review-body');
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const main = document.querySelector('.main-content');
  const oldHeader = document.querySelector<HTMLElement>('.sidebar-header');
  if (!body || !sidebar || !main || !oldHeader) return;
  const rail = toElement(<aside className="pr-tabs compact" aria-label="Pull requests"></aside>);
  const railDivider = toElement(
    <div
      className="workspace-divider vertical"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize PR tabs"
      tabIndex={0}
    ></div>,
  );
  body.prepend(rail, railDivider);
  mount(rail, tabList);
  // Hidden absolute labels remain measurable when the rail shows full titles.
  bindDivider(railDivider, rail, 'width', 'glassbox.tabsWidth', 24, 24, () =>
    Math.ceil(Math.max(0, ...[...rail.querySelectorAll('.pr-tab-number, .pr-repo-name')].map(label => label.getBoundingClientRect().width))) + 16);
  const headerDivider = toElement(
    <div
      className="workspace-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize PR header"
      tabIndex={0}
    ></div>,
  );
  oldHeader.after(headerDivider);
  bindDivider(headerDivider, oldHeader, 'height', 'glassbox.headerHeight', 130, 180, () => {
    const style = getComputedStyle(oldHeader);
    return [...oldHeader.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0)
      + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  });
  const mainSections = toElement(
    <div className="pr-main-sections">
      <section className="pr-reviewers" aria-label="Reviewers"></section>
      <div
        className="workspace-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize reviewers"
        tabIndex={0}
      ></div>
      <section className="pr-checks" aria-label="Checks"></section>
      <div
        className="workspace-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize CI checks"
        tabIndex={0}
      ></div>
      <section className="pr-conversation" aria-label="Comments">
        <textarea className="pr-comment-input" placeholder="Comment ..."></textarea>
        <div className="pr-conversation-list"></div>
      </section>
    </div>,
  );
  headerDivider.after(mainSections);
  const reviewerSection = asEl(mainSections.querySelector<HTMLElement>('.pr-reviewers'));
  const checksSection = asEl(mainSections.querySelector<HTMLElement>('.pr-checks'));
  const conversation = asEl(mainSections.querySelector<HTMLElement>('.pr-conversation-list'));
  bindDivider(
    reviewerSection.nextElementSibling as HTMLElement,
    reviewerSection,
    'height',
    'glassbox.reviewersHeight',
    55,
    120,
  );
  bindDivider(
    checksSection.nextElementSibling as HTMLElement,
    checksSection,
    'height',
    'glassbox.checksHeight',
    55,
    180,
  );
  const description = toElement(<section className="pr-description" aria-label="PR description"></section>);
  const add = toElement(
    <section className="pr-add-screen">
      <div>
        <h2>Open a pull request</h2>
        <input className="pr-url-input" placeholder="https://github.com/owner/repo/pull/123" />
        <button className="btn btn-primary" data-workspace="load">
          Open PR
        </button>
        <p className="pr-load-status"></p>
      </div>
    </section>,
  );
  main.append(description);
  const loading = toElement(<section className="pr-review-loading pr-loading-state" role="status" aria-live="polite"></section>);
  main.append(loading);
  mount(loading, () => {
    const tab = activeTab();
    const load = reviewLoadState.value;
    const error = tab?.error ?? (tab && load.key === reviewSessionKey(tab) && load.status === 'error' ? load.error : null);
    return error !== null
      ? <span>Couldn’t load this review: {error} <button className="btn" data-workspace="retry">Retry</button></span>
      : <><span className="analysis-spinner"></span> Loading PR #{tab?.ref.number}…</>;
  });
  body.append(add);
  let mountedHeader = false;
  effect(() => {
    const tab = activeTab();
    const adding = addingPull.value || workspace.value.tabs.length === 0;
    saveDiffScroll();
    // Gate visibility synchronously, before the selected session is restored.
    document.body.dataset.reviewPending = String(tab !== undefined && !activeReviewReady());
    document.body.dataset.workspaceView = adding ? 'add' : (tab?.view ?? 'file');
    if (tab?.view === 'file' && !adding) restoreDiffScroll();
    if (tab && !mountedHeader) {
      mountedHeader = true;
      mount(oldHeader, () => {
        const current = activeTab();
        return <div className="pr-header-content">{current ? pullHeader(current, activeReviewReady() ? totals() : null, refreshingPulls.value.has(current.key), closingPulls.value.has(current.key), mergingPulls.value.has(current.key)) : null}</div>;
      });
    }

  });
  mount(reviewerSection, () => {
    const tab = activeTab();
    return tab ? reviewers(tab) : <></>;
  });
  mount(checksSection, () => {
    const tab = activeTab();
    const label = tab?.info?.state === 'MERGED' ? 'Deployments' : 'CI checks';
    checksSection.setAttribute('aria-label', label);
    checksSection.nextElementSibling?.setAttribute('aria-label', `Resize ${label.toLowerCase()}`);
    return tab ? checks(tab) : <></>;
  });
  mount(conversation, () => {
    const tab = activeTab();
    const input = mainSections.querySelector<HTMLTextAreaElement>('.pr-comment-input');
    if (input) input.placeholder = tab && commentDestination(tab, { kind: 'issue' }) === 'github'
      ? 'Comment on GitHub ...' : 'Comment (waiting for GitHub authentication) ...';
    queueMicrotask(refreshFind);
    return (
      <>
        {tab && conversationHtml(tab)}
        {tab && !tab.commentsLoaded && <p>Loading comments…</p>}
      </>
    );
  });
  let editingDescription = false;
  let descriptionKey: string | undefined;
  const descriptionDrafts = new Map<string, Node[]>();
  effect(() => {
    const tab = activeTab();
    const keys = new Set(retainedTabs().filter(isPullAuthor).map(item => item.key));
    for (const key of descriptionDrafts.keys()) if (!keys.has(key)) descriptionDrafts.delete(key);
    if (descriptionKey !== tab?.key) {
      if (descriptionKey !== undefined && keys.has(descriptionKey) && editingDescription) {
        descriptionDrafts.set(descriptionKey, [...description.childNodes]);
        // Detach the draft so morphing the next PR cannot reuse and overwrite its nodes.
        description.replaceChildren();
      }
      descriptionKey = tab?.key;
      const draft = descriptionKey === undefined ? undefined : descriptionDrafts.get(descriptionKey);
      editingDescription = draft !== undefined;
      if (draft) description.replaceChildren(...draft);
    }
    if (!tab || !isPullAuthor(tab)) editingDescription = false;
    if (!editingDescription)
      morph(description,
        <section className="pr-description" aria-label="PR description">
          <div className="pr-description-body github-markdown">
            {tab?.info && !tab.info.body.trim()
              ? <p>{isPullAuthor(tab) ? 'Add a description…' : 'No description.'}</p>
              : renderGitHubMarkdown(tab?.info?.body ?? 'Loading description…', tab?.info?.bodyHTML)}
          </div>
        </section>,
      );
  });
  new ResizeObserver(() => {
    const textarea = description.querySelector<HTMLTextAreaElement>('.pr-description-editor textarea');
    if (textarea && description.clientWidth > 0) resizeDescriptionEditor(textarea);
  }).observe(description);
  // Pointerdown runs before tab/navigation clicks and cannot dismiss a just-opened editor.
  document.addEventListener('pointerdown', (event) => {
    const form = description.querySelector<HTMLElement>('.pr-description-editor');
    const textarea = form?.querySelector('textarea');
    if (event.button !== 0 || !(event.target instanceof Node) || !form || !textarea || form.contains(event.target)) return;
    if (textarea.value === textarea.defaultValue) form.querySelector<HTMLButtonElement>('[data-cancel]')?.click();
    else previewDescriptionEditor(textarea, description);
  });
  description.addEventListener('click', (event) => {
    const tab = activeTab();
    const text = description.querySelector<HTMLElement>('.pr-description-body');
    if (editingDescription || !tab?.info || !isPullAuthor(tab) || !text) return;
    const click = clickedDescriptionText(event, text);
    if (!click) return;
    const offset = descriptionEditOffset(tab.info.body, text, click);
    const previousScroll = description.scrollTop;
    editingDescription = true;
    const form = toElement(
      <div className="pr-description-editor">
        <textarea aria-label="PR description" spellCheck="true">{tab.info.body}</textarea>
        <button className="btn btn-primary" data-save>
          Save
        </button>
        <button className="btn" data-cancel>
          Cancel
        </button>
      </div>,
    );
    description.replaceChildren(form);
    const textarea = asTextarea(form.querySelector('textarea'));
    focusDescriptionEditor(textarea, description, offset, click.top, previousScroll);
    textarea.addEventListener('input', () => { resizeDescriptionEditor(textarea); });
    textarea.addEventListener('paste', (event) => { pasteDescriptionLink(event, textarea); });
    const finish = async (save: boolean) => {
      if (save && !(await mutate({ op: 'edit', key: tab.key, body: textarea.value }))) return;
      descriptionDrafts.delete(tab.key);
      if (descriptionKey === tab.key) editingDescription = false;
      workspace.value = { ...workspace.value };
    };
    asEl(form.querySelector('[data-save]')).addEventListener('click', (e) => {
      e.stopPropagation();
      void finish(true);
    });
    asEl(form.querySelector('[data-cancel]')).addEventListener('click', (e) => {
      e.stopPropagation();
      void finish(false);
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        void finish(e.key === 'Enter');
      }
    });
  });
  const editTitle = (tab: PullTab, target: Element | null = oldHeader.querySelector('h2')) => {
    if (!tab.info || tab.info.author.login !== tab.viewer || !target) return;
    const input = asInput(toElement(<input className="pr-title-input" value={title(tab)} />));
    input.style.font = getComputedStyle(target).font;
    target.replaceWith(input);
    input.focus();
    input.select();
    let saving = false;
    const save = async () => {
      if (saving) return;
      saving = true;
      const value = input.value.trim();
      input.replaceWith(target);
      if (value && value !== title(tab))
        await mutate({ op: 'edit', key: tab.key, title: value });
      target.textContent = title(workspace.value.tabs.find(t => t.key === tab.key) ?? tab);
      workspace.value = { ...workspace.value };
    };
    input.addEventListener('blur', () => {
      void save();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        saving = true;
        input.replaceWith(target);
        workspace.value = { ...workspace.value };
      }
    });
  };
  let tabClick: ReturnType<typeof setTimeout> | undefined;
  void delegate(rail, 'click', '[data-tab]', (event, element) => {
    if ((event.target as Element).closest('input')) return;
    const tab = workspace.value.tabs.find((t) => t.key === (element as HTMLElement).dataset.tab);
    clearTimeout(tabClick);
    if (tab) {
      if (rail.classList.contains('compact')) switchTo(tab);
      else tabClick = setTimeout(() => { switchTo(tab); }, 250);
    }
  });
  void delegate(rail, 'dblclick', '[data-tab]', (_event, element) => {
    clearTimeout(tabClick);
    if (rail.classList.contains('compact')) return;
    const tab = workspace.value.tabs.find((t) => t.key === (element as HTMLElement).dataset.tab);
    if (tab) editTitle(tab, element.querySelector('.pr-tab-title'));
  });
  bindTabReorder(rail);
  void delegate(document.body, 'click', '[data-workspace]', (_event, element) => {
    const action = (element as HTMLElement).dataset.workspace;
    const tab = activeTab();
    if (action === 'add') {
      addingPull.value = true;
      add.querySelector('input')?.focus();
    } else if (action === 'load') void loadPullInput(add);
    else if (action === 'retry' && tab) {
      reviewRetry.value++;
      if (tab.reviewId === null) void mutate({ op: 'refresh', key: tab.key });
    }
    else if (action === 'refresh') void refreshActivePull().catch((error: unknown) => { showToast(String(error)); });
    else if (action === 'settings') void import('../settings/dialog.js').then((m) => { m.showSettingsDialog(); });
    else if (action === 'share' && tab && !addingPull.value) void copyPullLink(tab, element);
    else if (action === 'title' && tab) editTitle(tab);
    else if (action === 'close' && tab) void mutate({ op: 'close', key: tab.key });
    else if (action === 'retry-slack' && tab) void mutate({ op: 'retry-slack', key: tab.key });
  });
  asInput(add.querySelector('input')).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void loadPullInput(add);
  });
  void delegate(oldHeader, 'change', '[data-pr-action]', (_event, element) => {
    if (!(element instanceof HTMLSelectElement)) return;
    const action = element.value;
    const tab = activeTab();
    if (!tab) return;
    // Keep the confirmed status until GitHub accepts the next action.
    element.value = isPullAuthor(tab) && tab.info
      ? (tab.info.state === 'CLOSED' ? 'close' : tab.info.isDraft ? 'draft' : 'ready') : '';
    oldHeader.querySelector('.request-changes-form')?.remove();
    if (action === 'merge') {
      const expectedHead = element.dataset.mergeHead;
      if (expectedHead !== undefined && expectedHead !== '') void mutate({ op: 'merge', key: tab.key, expectedHead });
    } else if (action === 'changes') {
      const box = toElement(
        <div className="request-changes-form">
          <textarea placeholder="Describe the changes needed…"></textarea>
          <button className="btn btn-primary">Request Changes</button>
        </div>,
      );
      oldHeader.querySelector('.request-changes-form')?.remove();
      oldHeader.append(box);
      asTextarea(box.querySelector('textarea')).focus();
      asEl(box.querySelector('button')).addEventListener('click', () => {
        void mutate({
          op: 'action',
          key: tab.key,
          action: 'changes',
          body: asTextarea(box.querySelector('textarea')).value,
        }).then((ok) => {
          if (ok) box.remove();
        });
      });
    } else if (action === 'draft' || action === 'ready' || action === 'close' || action === 'approve' || action === 'humanize')
      void mutate({ op: 'action', key: tab.key, action });
  });
  const commentInput = asTextarea(mainSections.querySelector<HTMLTextAreaElement>('.pr-comment-input'));
  commentInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const tab = activeTab();
    if (!tab || !commentInput.value.trim() || commentInput.disabled) return;
    const text = commentInput.value;
    commentInput.disabled = true;
    void mutate({ op: 'comment', key: tab.key, body: text })
      .then((ok) => {
        if (ok) commentInput.value = '';
      })
      .finally(() => {
        commentInput.disabled = false;
        commentInput.focus();
      });
  });
  void delegate(
    document.body,
    'click',
    '.pr-repo-link, .pr-reviewer a, .pr-check a, .pr-description a, .pr-message a',
    (event, element) => {
      const url = element.getAttribute('href');
      if (url !== null && openExternalUrl(url)) event.preventDefault();
    },
  );
  bindThreads();
  bindWorkspaceKeys();
  void refreshWorkspace().catch((error: unknown) => {
    showToast(String(error));
  });
  const poll = async () => {
    try { await refreshWorkspace(); } catch { /* Retry the local server on the next tick. */ }
    // Imports publish several stages; keep the UI responsive without polling GitHub.
    setTimeout(() => { void poll(); }, workspace.value.tabs.some(tab => tab.loading) ? 250 : 2000);
  };
  setTimeout(() => { void poll(); }, 250);
}
async function loadPullInput(container: HTMLElement): Promise<void> {
  const input = asInput(container.querySelector<HTMLInputElement>('input'));
  if (await mutate({ op: 'open', url: input.value })) {
    addingPull.value = false;
    input.value = '';
  }
}
function bindTabReorder(rail: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dragging: HTMLElement | null = null;
  let suppressClick = false;
  rail.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      }
    },
    true,
  );
  rail.addEventListener('pointerdown', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-tab]');
    if (!row) return;
    timer = setTimeout(() => {
      dragging = row;
      suppressClick = true;
      row.classList.add('dragging');
      rail.setPointerCapture(event.pointerId);
    }, 350);
  });
  rail.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-tab]');
    if (target && target !== dragging)
      target.insertAdjacentElement(
        event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2
          ? 'afterend'
          : 'beforebegin',
        dragging,
      );
  });
  const stop = () => {
    clearTimeout(timer);
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    void mutate({
      op: 'order',
      keys: [...rail.querySelectorAll<HTMLElement>('[data-tab]')].map((row) => row.dataset.tab ?? ''),
    });
  };
  rail.addEventListener('pointerup', stop);
  rail.addEventListener('pointercancel', stop);
  window.addEventListener('pointerup', stop);
}
function bindWorkspaceKeys(): void {
  let aiPrefix: { key: string; at: number } | null = null;
  const navigateComment = createCommentNavigator();
  let hovered: Element | null = null;
  document.addEventListener('pointermove', (event) => {
    hovered = event.target instanceof Element ? event.target : null;
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ',') {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]'))
        void import('../settings/dialog.js').then((m) => { m.showSettingsDialog(); });
      return;
    }
    const tab = activeTab();
    if (event.altKey && event.key === 'Tab') {
      event.preventDefault();
      const tabs = workspace.value.tabs;
      const index = tabs.findIndex((t) => t === tab);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (tabs.length > 0) switchTo(next);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (!event.repeat) void refreshActivePull().catch((error: unknown) => { showToast(String(error)); });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!tab?.info || !activeReviewReady()) return;
      const line = hovered?.closest<HTMLElement>('.diff-line');
      const row = hovered?.closest<HTMLElement>('.file-item');
      const file = row
        ? reviewStore.state.value.files.find((f) => f.id === row.dataset.fileId)?.file_path
        : document.querySelector<HTMLElement>('.diff-view')?.dataset.filePath;
      if (file !== undefined && (line || row)) {
        const sha =
          line?.dataset.side === 'old'
            ? tab.reviewedBase || tab.info.baseRefOid
            : tab.reviewedHead || tab.info.headRefOid;
        const record = reviewStore.state.value.files.find((f) => f.file_path === file);
        const path =
          line?.dataset.side === 'old' && record ? (parseDiffData(record.diff_data)?.oldPath ?? file) : file;
        const url = `https://github.com/${tab.ref.owner}/${tab.ref.repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line.dataset.line}` : ''}`;
        void navigator.clipboard.writeText(url).then(() => {
          showToast('GitHub link copied');
        });
      }
      return;
    }
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.target as Element).closest('input, textarea, select, [contenteditable="true"], dialog') ||
      document.querySelector('dialog[open]')
    )
      return;
    const fresh = event.key === 'i' && aiPrefix !== null && aiPrefix.key === tab?.key && Date.now() - aiPrefix.at < 1200;
    aiPrefix = event.key === 'a' && tab && !event.repeat ? { key: tab.key, at: Date.now() } : null;
    if (fresh && activeReviewReady() && !event.repeat) {
      event.preventDefault();
      void startFreshReview();
    }
    if (event.key === 'r' && tab) {
      event.preventDefault();
      tab.view = tab.view === 'main' ? 'file' : 'main';
      workspace.value = { ...workspace.value };
      void mutate({ op: 'view', key: tab.key, view: tab.view });
    }
    if ((event.key === 'c' || event.key === 'v' || event.key === 'C') && tab?.view === 'file' && activeReviewReady()) {
      event.preventDefault();
      const direction = event.key === 'c' ? 1 : -1;
      void navigateComment(direction);
    }
  });
}
