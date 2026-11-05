import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateDiffCache } from '../../../src/client/diff/index.js';
import { PullTabSchema } from '../../../src/api/workspace.js';

const api = vi.hoisted(() => vi.fn());
const change = vi.hoisted(() => vi.fn());
vi.mock('../../../src/api/workspace.js', async original => ({ ...await original<typeof import('../../../src/api/workspace.js')>(), changeWorkspace: change }));
vi.mock('../../../src/api/_runner.js', () => ({ apiCall: api, OkResponseSchema: {} }));
vi.mock('../../../src/client/analysisEngine.js', () => ({ stopPolling: vi.fn(), resumePolling: vi.fn(), pollingGeneration: vi.fn(() => 0) }));
vi.mock('../../../src/client/diff/index.js', () => ({ invalidateDiffCache: vi.fn(), forgetReviewDiff: vi.fn() }));
vi.mock('../../../src/client/toast.js', () => ({ showToast: vi.fn() }));
vi.stubGlobal('document', { body: { dataset: { reviewId: 'a' } } });
const { reviewStore, aiStore, diffViewStore, editFormSignal } = await import('../../../src/client/stores/index.js');
const { workspace, reviewLoadState, reviewRetry, activeReviewReady, mutate } = await import('../../../src/client/workspace/state.js');
const { initReviewSessions } = await import('../../../src/client/workspace/reviewSessions.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const file = (id: string) => ({ id, file_path: `${id}.ts`, review_id: id[0], status: 'reviewed', diff_data: null, created_at: '' });
const tab = (id: string) => PullTabSchema.parse({ key: id, reviewId: id, reviewedHead: id,
  ref: { owner: 'example', repo: 'repo', number: id === 'a' ? 1 : 2, url: '' }, repoRoot: '/test', info: null, view: 'file' });
let dispose: (() => void) | undefined;
let scroll: { scrollTop: number; value: string };
beforeEach(() => {
  vi.mocked(invalidateDiffCache).mockClear();
  reviewLoadState.value = { key: '', status: 'loading', error: null };
  scroll = { scrollTop: 0, value: '' };
  const events = new EventTarget();
  vi.stubGlobal('document', { body: { dataset: { reviewId: 'a' } }, querySelector: () => scroll,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  vi.stubGlobal('window', { history: { replaceState: vi.fn() } });
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) });
  diffViewStore.actions.update({ wrapLines: false });
  reviewStore.actions.update({ reviewId: 'a', files: [file('a1'), file('a2')], currentFileId: 'a1', hiddenFileIds: new Set() });
  aiStore.actions.update({ fileNotes: { a1: { overview: '', lines: [{ line: 3, content: 'Guide A' }] } }, guidedNotes: {}, narrativeOrder: null });
  editFormSignal.value = null;
  workspace.value = { tabs: [tab('a'), tab('b')], active: 'a' };
  api.mockReset().mockImplementation(async (_schema, path, options) => path === '/files'
    ? { files: [file(options.reviewId + '1')], annotationCounts: {}, staleCounts: {} }
    : { scores: [{ reviewFileId: options.reviewId + '1', filePath: `${options.reviewId}1.ts`, sortOrder: 0, notes: { overview: '', lines: [{ line: 5, content: `Guide ${options.reviewId}` }] } }] });
});
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); });

describe('in-memory PR sessions', () => {
  it('keeps the current line layout when restoring cached or newly loaded PRs', async () => {
    dispose = initReviewSessions(); await tick();
    diffViewStore.actions.setWrapLines(true);
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(diffViewStore.state.value.wrapLines).toBe(true);
    diffViewStore.actions.setWrapLines(false);
    workspace.value = { ...workspace.value, active: 'a' }; await tick();
    expect(diffViewStore.state.value.wrapLines).toBe(false);
    diffViewStore.actions.setWrapLines(true);
    workspace.value = { tabs: [...workspace.value.tabs, tab('c')], active: 'c' }; await tick();
    expect(diffViewStore.state.value.wrapLines).toBe(true);
    workspace.value = { ...workspace.value, active: 'a' }; await tick();
    expect(diffViewStore.state.value.wrapLines).toBe(true);
  });
  it('discards a background PR’s cached notes when its fresh review starts', async () => {
    dispose = initReviewSessions(); await tick();
    document.dispatchEvent(new CustomEvent('glassbox-analysis-reset', { detail: { reviewId: 'b', types: ['narrative', 'guided'] } }));
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(aiStore.state.value.fileNotes).toEqual({});
    expect(aiStore.state.value.guidedNotes).toEqual({});
    expect(aiStore.state.value.narrativeAnalysis.status).toBe('running');
  });
  it('ignores old guidance responses that arrive after a fresh review reset', async () => {
    const replies: (() => void)[] = [];
    api.mockImplementation((_schema, path) => path === '/files'
      ? Promise.resolve({ files: [file('b1')], annotationCounts: {}, staleCounts: {} })
      : new Promise(resolve => replies.push(() => resolve({ status: 'completed', scores: [{ reviewFileId: 'b1', notes: { overview: 'Old guidance', lines: [] } }] }))));
    dispose = initReviewSessions(); await tick();
    document.dispatchEvent(new CustomEvent('glassbox-analysis-reset', { detail: { reviewId: 'b', types: ['narrative', 'guided'] } }));
    replies.forEach(resolve => resolve()); await tick();
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(aiStore.state.value.fileNotes).toEqual({});
    expect(aiStore.state.value.guidedNotes).toEqual({});
    expect(aiStore.state.value.narrativeAnalysis.status).toBe('running');
  });
  it('preloads once and restores files, guidance, hidden files, drafts and section scroll without fetching again', async () => {
    dispose = initReviewSessions(); await tick();
    expect(api).toHaveBeenCalledTimes(3);
    reviewStore.actions.update({ currentFileId: 'a2', hiddenFileIds: new Set(['a1']) });
    editFormSignal.value = { annotationId: null, formKey: '3:new', content: 'Draft A', category: 'bug' };
    scroll.scrollTop = 82; scroll.value = 'PR draft A';
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(reviewStore.state.value.reviewId).toBe('b');
    expect(reviewStore.state.value.currentFileId).toBe('b1');
    expect(aiStore.state.value.fileNotes.b1.lines[0].content).toBe('Guide b');
    expect(editFormSignal.value).toBeNull();
    scroll.scrollTop = 26; scroll.value = 'PR draft B';
    workspace.value = { ...workspace.value, active: 'a' }; await tick();
    expect(reviewStore.state.value.currentFileId).toBe('a2');
    expect([...reviewStore.state.value.hiddenFileIds]).toEqual(['a1']);
    expect(aiStore.state.value.fileNotes.a1.lines[0].content).toBe('Guide A');
    expect(editFormSignal.value?.content).toBe('Draft A');
    expect(scroll).toEqual({ scrollTop: 82, value: 'PR draft A' });
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(scroll).toEqual({ scrollTop: 26, value: 'PR draft B' });
    expect(api).toHaveBeenCalledTimes(3);
    expect(window.history.replaceState).toHaveBeenLastCalledWith(null, '', '/?reviewId=b');
  });

  it('keeps late background results in the right PR after switching away and back', async () => {
    const replies: (() => void)[] = [];
    api.mockImplementation((_schema, path) => new Promise(resolve => replies.push(() => resolve(path === '/files'
      ? { files: [file('b1')], annotationCounts: {}, staleCounts: {} }
      : { scores: [] }))));
    dispose = initReviewSessions(); await tick();
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(reviewStore.state.value.files).toEqual([]);
    workspace.value = { ...workspace.value, active: 'a' }; await tick();
    replies.forEach(resolve => resolve()); await tick();
    expect(reviewStore.state.value.files.map(file => file.id)).toEqual(['a1', 'a2']);
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(reviewStore.state.value.files.map(file => file.id)).toEqual(['b1']);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('clears the old PR while importing, preserves its draft, and waits for the new files', async () => {
    const pending = { ...tab('c'), reviewId: null, loading: true };
    const replies: (() => void)[] = [];
    dispose = initReviewSessions(); await tick();
    reviewStore.actions.update({ currentFileId: 'a2' });
    editFormSignal.value = { annotationId: null, formKey: '3:new', content: 'Keep this draft', category: 'bug' };
    workspace.value = { tabs: [...workspace.value.tabs, pending], active: pending.key };
    expect(activeReviewReady()).toBe(false); // Must gate the UI before the session microtask.
    await tick();
    expect(reviewStore.state.value.reviewId).toBe('');
    expect(document.body.dataset.reviewId).toBe('');
    expect(reviewStore.state.value.files).toEqual([]);
    expect(reviewStore.state.value.currentFileId).toBeNull();
    expect(editFormSignal.value).toBeNull();
    expect(aiStore.state.value.fileNotes).toEqual({});
    expect(api).toHaveBeenCalledTimes(3); // Never fetch the default review for a null ID.
    workspace.value = { ...workspace.value, active: 'a' }; await tick();
    expect(reviewStore.state.value.currentFileId).toBe('a2');
    expect(editFormSignal.value?.content).toBe('Keep this draft');
    workspace.value = { ...workspace.value, active: 'c' }; await tick();
    api.mockImplementation((_schema, path) => new Promise(resolve => replies.push(() => resolve(path === '/files'
      ? { files: [file('c1')], annotationCounts: {}, staleCounts: {} } : { scores: [] }))));
    workspace.value = { ...workspace.value, tabs: workspace.value.tabs.map(t => t.key === 'c' ? tab('c') : t) }; await tick();
    expect(activeReviewReady()).toBe(false);
    expect(reviewStore.state.value.files).toEqual([]);
    replies.forEach(resolve => resolve()); await tick();
    expect(activeReviewReady()).toBe(true);
    expect(reviewStore.state.value.files.map(file => file.id)).toEqual(['c1']);
  });

  it('keeps empty reviews empty and offers a retry after a failed file list', async () => {
    api.mockRejectedValue(new Error('Offline'));
    dispose = initReviewSessions(); await tick();
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(activeReviewReady()).toBe(false);
    expect(reviewLoadState.value.status).toBe('error');
    expect(reviewStore.state.value.files).toEqual([]);
    api.mockImplementation(async (_schema, path) => path === '/files'
      ? { files: [], annotationCounts: {}, staleCounts: {} } : { scores: [] });
    reviewRetry.value++; await tick();
    expect(activeReviewReady()).toBe(true);
    expect(reviewStore.state.value.currentFileId).toBeNull();
    expect(reviewStore.state.value.files).toEqual([]);
  });

  it('keeps different importing PRs separate and ignores background results while they load', async () => {
    const replies: (() => void)[] = [];
    api.mockImplementation((_schema, path) => new Promise(resolve => replies.push(() => resolve(path === '/files'
      ? { files: [file('b1')], annotationCounts: {}, staleCounts: {} } : { scores: [] }))));
    dispose = initReviewSessions(); await tick();
    const pending = ['c', 'd'].map(id => ({ ...tab(id), reviewId: null }));
    workspace.value = { tabs: [...workspace.value.tabs, ...pending], active: 'c' }; await tick();
    const firstKey = reviewLoadState.value.key;
    workspace.value = { ...workspace.value, active: 'd' }; await tick();
    expect(reviewLoadState.value.key).not.toBe(firstKey);
    replies.forEach(resolve => resolve()); await tick();
    expect(reviewStore.state.value.files).toEqual([]);
    expect(activeReviewReady()).toBe(false);
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(reviewStore.state.value.files.map(file => file.id)).toEqual(['b1']);
    expect(activeReviewReady()).toBe(true);
  });

  it('reloads changed revisions but not ordinary background workspace updates', async () => {
    dispose = initReviewSessions(); await tick();
    workspace.value = { ...workspace.value }; await tick();
    expect(api).toHaveBeenCalledTimes(3);
    expect(invalidateDiffCache).not.toHaveBeenCalled();
    workspace.value = { ...workspace.value, tabs: workspace.value.tabs.map(t => t.key === 'b' ? { ...t, reviewedHead: 'new-head' } : t) };
    await tick();
    expect(api).toHaveBeenCalledTimes(6);
    expect(invalidateDiffCache).toHaveBeenCalledExactlyOnceWith('b');
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    expect(activeReviewReady()).toBe(true);
    expect(reviewLoadState.value.key).toContain('new-head');
  });

  it('does not replace a typed draft while the first load completes', async () => {
    const replies: (() => void)[] = [];
    api.mockImplementation((_schema, path) => new Promise(resolve => replies.push(() => resolve(path === '/files'
      ? { files: [file('b1')], annotationCounts: {}, staleCounts: {} } : { scores: [] }))));
    dispose = initReviewSessions(); await tick();
    workspace.value = { ...workspace.value, active: 'b' }; await tick();
    scroll.value = 'Typing while loading'; scroll.scrollTop = 50;
    replies.forEach(resolve => resolve()); await tick();
    expect(scroll).toEqual({ value: 'Typing while loading', scrollTop: 50 });
  });
});

it('does not preload expired sources and waits for restoration without losing the previous reading state', async () => {
  workspace.value.tabs[1].checkoutEvicted = true;
  dispose = initReviewSessions(); await tick();
  expect(api).not.toHaveBeenCalled();
  reviewStore.actions.update({ currentFileId: 'a2', hiddenFileIds: new Set(['a1']) });
  workspace.value = { ...workspace.value, active: 'b' }; await tick();
  expect(activeReviewReady()).toBe(false); expect(api).not.toHaveBeenCalled();
  expect(reviewStore.state.value.files).toEqual([]);
  workspace.value = { ...workspace.value, tabs: workspace.value.tabs.map(t => ({ ...t, checkoutEvicted: false })) }; await tick();
  expect(activeReviewReady()).toBe(true); expect(reviewStore.state.value.files[0].id).toBe('b1');
  workspace.value = { ...workspace.value, active: 'a' }; await tick();
  expect(reviewStore.state.value.currentFileId).toBe('a2'); expect([...reviewStore.state.value.hiddenFileIds]).toEqual(['a1']);
});

it('forgets closed drafts and does not resurrect cached content when the PR reopens', async () => {
  dispose = initReviewSessions(); await tick();
  editFormSignal.value = { annotationId: null, formKey: '3:new', content: 'Discard this draft', category: 'bug' };
  workspace.value = { tabs: [tab('b')], active: 'b' }; await tick();
  workspace.value = { tabs: [tab('a'), tab('b')], active: 'a' }; await tick();
  expect(editFormSignal.value).toBeNull();
  expect(api.mock.calls.filter(call => call[1] === '/files' && call[2].reviewId === 'a')).toHaveLength(1);
});
it('clears the last closed review and ignores its late loading response', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  dispose = initReviewSessions(); await tick();
  workspace.value = { tabs: [], active: null }; await tick();
  expect(reviewStore.state.value.files).toEqual([]);
  expect(aiStore.state.value.fileNotes).toEqual({});
  expect(reviewStore.state.value.reviewId).toBe('');
  expect(editFormSignal.value).toBeNull();
  finish({ scores: [] }); await tick();
  expect(reviewStore.state.value.files).toEqual([]);
  expect(window.history.replaceState).toHaveBeenLastCalledWith(null, '', '/');
});

it.each([false, true])('discards closed drafts immediately and never restores them after a failed close (last tab: %s)', async last => {
  if (last) workspace.value = { tabs: [tab('a')], active: 'a' };
  dispose = initReviewSessions(); await tick();
  editFormSignal.value = { annotationId: null, formKey: '3:new', content: 'Discard on close', category: 'bug' };
  scroll.value = 'Main draft'; scroll.scrollTop = 42;
  let fail!: (error: Error) => void;
  change.mockImplementationOnce(() => new Promise((_yes, no) => { fail = no; }));
  const close = mutate({ op: 'close', key: 'a' }); await tick();
  expect(reviewStore.state.value.reviewId).toBe(last ? '' : 'b');
  expect(editFormSignal.value).toBeNull();
  fail(new Error('Server unavailable')); await close;
  expect(workspace.value.tabs.some(t => t.key === 'a')).toBe(false);
  workspace.value = { tabs: [tab('a'), ...workspace.value.tabs], active: 'a' }; await tick();
  expect(editFormSignal.value).toBeNull(); expect(scroll.value).toBe('');
});
