import { batch, signal } from 'kerfjs';

import {
  changeWorkspace,
  getWorkspace,
  type PullTab,
  type Workspace,
  type WorkspaceMutation,
} from '../../api/workspace.js';
import { showToast } from '../toast.js';
import { acknowledgeClose, closedTabs, forgetClose, pendingCloses, rememberClose } from './closedTabs.js';

export const workspace = signal<Workspace>({ tabs: [], active: null });
export const addingPull = signal(false);
export const workspaceLoaded = signal(false);
export const refreshingPulls = signal<ReadonlySet<string>>(new Set());
export const mergingPulls = signal<ReadonlySet<string>>(new Set());
export const closingPulls = signal<ReadonlySet<string>>(new Set());
export const reviewRetry = signal(0);
export const reviewSessionKey = (tab: PullTab): string => `${tab.key}:${tab.reviewId ?? ''}:${tab.reviewedBase}:${tab.reviewedHead}${tab.checkoutEvicted ? ':expired' : ''}`;
export const reviewLoadState = signal<{ key: string; status: 'loading' | 'ready' | 'error'; error: string | null }>({
  key: '', status: 'loading', error: null,
});
export function activeReviewReady(): boolean {
  const tab = activeTab();
  return tab !== undefined && !tab.checkoutEvicted && tab.reviewId !== null && reviewLoadState.value.key === reviewSessionKey(tab)
    && reviewLoadState.value.status === 'ready';
}
export function retainedTabs(): PullTab[] { return workspace.value.tabs; }
let mutationVersion = 0;
let closeVersion = 0;
function receive(state: Workspace, preserveSelection: boolean): void {
  workspaceLoaded.value = true;
  const local = workspace.value;
  const openedExternally = (state.externalSelection ?? 0) !== (local.externalSelection ?? 0);
  if (openedExternally) {
    addingPull.value = false;
    if (state.active !== null && !pendingCloses().includes(state.active)) forgetClose(state.active);
  }
  const tabs = state.tabs.filter(tab => !closedTabs.value.has(tab.key) && !pendingCloses().includes(tab.key));
  const selected = preserveSelection && !openedExternally ? local.active : state.active;
  workspace.value = { ...state,
    active: tabs.some(tab => tab.key === selected) ? selected : tabs.find(tab => tab.key === state.active)?.key ?? tabs.at(0)?.key ?? null,
    tabs: tabs.map(tab => ({ ...tab, view: local.tabs.find(item => item.key === tab.key)?.view ?? tab.view })),
  };
}
export function activeTab(): PullTab | undefined {
  return workspace.value.tabs.find((t) => t.key === workspace.value.active);
}
export async function refreshWorkspace(preserveSelection = true): Promise<void> {
  const version = mutationVersion;
  const closed = closeVersion;
  for (const key of pendingCloses()) {
    closedTabs.value = new Set([...closedTabs.value, key]);
    if (closingPulls.value.has(key)) continue;
    try { await changeWorkspace({ op: 'close', key }); acknowledgeClose(key); }
    catch { /* Keep the close hidden and retry on the next poll. */ }
  }
  const state = await getWorkspace();
  if (version !== mutationVersion || closed !== closeVersion) return;
  // Keep editors intact while background synchronization continues on the server.
  if (preserveSelection && (
    document.querySelector(
      '.pr-tab.dragging, .pr-title-input, .request-changes-form, .pr-description-editor',
    ) !== null ||
    [...document.querySelectorAll('textarea')].some((input) => input.value.length > 0 && !input.disabled)
  ))
    return;
  receive(state, preserveSelection);
}
function finishClose(key: string): void {
  closeVersion++;
  closingPulls.value = new Set([...closingPulls.value].filter(item => item !== key));
}
export async function mutate(input: WorkspaceMutation): Promise<boolean> {
  if (input.op === 'close') {
    if (closingPulls.value.has(input.key)) return false;
    const local = workspace.value;
    const tab = local.tabs.find(item => item.key === input.key);
    if (!tab) return false;
    batch(() => {
      rememberClose(input.key);
      closingPulls.value = new Set([...closingPulls.value, input.key]);
      const tabs = local.tabs.filter(item => item !== tab);
      workspace.value = { ...local, tabs, active: local.active === input.key ? tabs.at(0)?.key ?? null : local.active };
    });
  }
  if (input.op === 'merge') {
    if (mergingPulls.value.has(input.key)) return false;
    mergingPulls.value = new Set([...mergingPulls.value, input.key]);
  }
  const version = ++mutationVersion;
  const closed = closeVersion;
  try {
    const result = await changeWorkspace(input);
    const fresh = closed === closeVersion;
    if (input.op === 'close') { acknowledgeClose(input.key); finishClose(input.key); }
    if (input.op === 'open' && version === mutationVersion && result.active !== null) forgetClose(result.active);
    if (version === mutationVersion && fresh) receive(result, input.op !== 'open');
    else if (!fresh || input.op === 'close' || input.op === 'merge')
      void refreshWorkspace(version !== mutationVersion || input.op !== 'open').catch(() => {});
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    if (input.op === 'close') { finishClose(input.key); return true; }
    showToast(message);
    return false;
  } finally {
    if (input.op === 'merge') mergingPulls.value = new Set([...mergingPulls.value].filter(key => key !== input.key));
  }
}
export function setFileView(): void {
  const tab = activeTab();
  if (!tab || tab.view === 'file') return;
  tab.view = 'file';
  workspace.value = { ...workspace.value };
  void mutate({ op: 'view', key: tab.key, view: 'file' });
}
