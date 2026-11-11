import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema } from '../../../src/api/workspace.js';
const remote = vi.hoisted(() => ({ get: vi.fn(), change: vi.fn() }));
vi.mock('../../../src/api/workspace.js', async original => ({ ...(await original<typeof import('../../../src/api/workspace.js')>()), getWorkspace: remote.get, changeWorkspace: remote.change }));
vi.mock('../../../src/client/toast.js', () => ({ showToast: vi.fn() }));
const { workspace, mutate, refreshWorkspace, addingPull, closingPulls, mergingPulls, retainedTabs } = await import('../../../src/client/workspace/state.js');
const { closedTabs } = await import('../../../src/client/workspace/closedTabs.js');
const { showToast } = await import('../../../src/client/toast.js');
const tab = (key: string) => PullTabSchema.parse({ key, reviewId: key, repoRoot: '/', info: null, ref: { owner: 'a', repo: 'b', number: 1, url: '' } });
beforeEach(() => {
  closedTabs.value = new Set();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
  workspace.value = { tabs: [tab('a'), tab('b')], active: 'a' }; remote.get.mockReset(); remote.change.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
it('does not let a stale select response undo a newer local tab selection', async () => {
  let finish!: (value: typeof workspace.value) => void;
  remote.change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = structuredClone(workspace.value);
  const first = mutate({ op: 'select', key: 'a' });
  workspace.value = { ...workspace.value, active: 'b' };
  remote.change.mockResolvedValueOnce(workspace.value);
  await mutate({ op: 'select', key: 'b' });
  finish(old); await first;
  expect(workspace.value.active).toBe('b');
});
it('background refresh updates metadata without resetting the local selection or remembered view', async () => {
  const server = structuredClone(workspace.value);
  workspace.value = { ...workspace.value, active: 'b', tabs: workspace.value.tabs.map(t => ({ ...t, view: 'file' })) };
  server.tabs[1].updatedAt = 123;
  remote.get.mockResolvedValue(server);
  await refreshWorkspace();
  expect(workspace.value.active).toBe('b');
  expect(workspace.value.tabs[1].view).toBe('file');
  expect(workspace.value.tabs[1].updatedAt).toBe(123);
});
it('opening a new PR and closing the active PR still accept the resulting selection', async () => {
  remote.change.mockResolvedValueOnce({ tabs: [...workspace.value.tabs, tab('c')], active: 'c' });
  await mutate({ op: 'open', url: 'https://github.com/a/b/pull/1' });
  expect(workspace.value.active).toBe('c');
  remote.change.mockResolvedValueOnce({ tabs: workspace.value.tabs.filter(t => t.key !== 'c'), active: 'a' });
  await mutate({ op: 'close', key: 'c' });
  expect(workspace.value.active).toBe('a');
});
it('selects a PR opened externally without losing the stored view', async () => {
  const state = { ...structuredClone(workspace.value), active: 'b', externalSelection: 1 };
  addingPull.value = true;
  remote.get.mockResolvedValue(state);
  await refreshWorkspace(); expect(workspace.value.active).toBe('b'); expect(addingPull.value).toBe(false);
  workspace.value = { ...workspace.value, active: 'a' };
  await refreshWorkspace(); expect(workspace.value.active).toBe('a');
});
it('tracks closing separately for each PR and ignores repeated clicks while deletion runs', async () => {
  let finish!: (value: typeof workspace.value) => void;
  remote.change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const close = mutate({ op: 'close', key: 'a' });
  expect(closingPulls.value.has('a')).toBe(true);
  expect(closingPulls.value.has('b')).toBe(false);
  expect(await mutate({ op: 'close', key: 'a' })).toBe(false);
  expect(remote.change).toHaveBeenCalledOnce();
  workspace.value = { ...workspace.value, active: 'b' };
  finish({ tabs: [tab('b')], active: 'b' }); await close;
  expect(workspace.value.active).toBe('b'); expect(closingPulls.value.size).toBe(0);
});
it('keeps a failed close hidden and retries delivery during a later poll', async () => {
  const stale = structuredClone(workspace.value);
  remote.change.mockRejectedValueOnce(new Error('Server unavailable'));
  expect(await mutate({ op: 'close', key: 'a' })).toBe(true);
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']);
  expect(closingPulls.value.size).toBe(0);
  remote.change.mockResolvedValueOnce({ tabs: [tab('b')], active: 'b' });
  remote.get.mockResolvedValue(stale);
  await refreshWorkspace();
  expect(remote.change).toHaveBeenLastCalledWith({ op: 'close', key: 'a' });
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']);
});
it('refreshes a completed close after switching tabs instead of applying its older snapshot', async () => {
  let finish!: (value: typeof workspace.value) => void;
  remote.change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const close = mutate({ op: 'close', key: 'a' });
  workspace.value = { ...workspace.value, active: 'b' };
  remote.change.mockResolvedValueOnce(workspace.value);
  await mutate({ op: 'select', key: 'b' });
  remote.get.mockResolvedValueOnce({ tabs: [tab('b')], active: 'b' });
  finish({ tabs: [tab('b')], active: 'b' }); await close;
  await vi.waitFor(() => expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']));
  expect(workspace.value.active).toBe('b'); expect(closingPulls.value.size).toBe(0);
});


it('tracks merge progress per PR, ignores duplicates and refreshes after switching tabs', async () => {
  let finish!: (value: typeof workspace.value) => void;
  remote.change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const request = { op: 'merge' as const, key: 'a', expectedHead: 'a'.repeat(40) };
  const pending = mutate(request);
  expect(mergingPulls.value.has('a')).toBe(true); expect(mergingPulls.value.has('b')).toBe(false);
  expect(await mutate(request)).toBe(false); expect(remote.change).toHaveBeenCalledOnce();
  workspace.value = { ...workspace.value, active: 'b' };
  remote.change.mockResolvedValueOnce(workspace.value);
  await mutate({ op: 'select', key: 'b' });
  const refreshed = structuredClone(workspace.value); refreshed.tabs[0].action = 'merge';
  remote.get.mockResolvedValueOnce(refreshed);
  finish({ ...refreshed, active: 'a' }); expect(await pending).toBe(true);
  await vi.waitFor(() => expect(workspace.value.tabs[0].action).toBe('merge'));
  expect(workspace.value.active).toBe('b'); expect(mergingPulls.value.size).toBe(0);
});
it('releases merge progress on failure without changing the PR status', async () => {
  remote.change.mockRejectedValueOnce(new Error('GitHub 405: Required review missing'));
  expect(await mutate({ op: 'merge', key: 'a', expectedHead: 'a'.repeat(40) })).toBe(false);
  expect(mergingPulls.value.size).toBe(0); expect(workspace.value.tabs[0].action).not.toBe('merge');
  expect(showToast).toHaveBeenCalledWith('GitHub 405: Required review missing');
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
it('removes a tab synchronously and filters it out of polls and other mutation responses during cleanup', async () => {
  const original = structuredClone(workspace.value);
  const cleanup = deferred<typeof workspace.value>();
  remote.change.mockReturnValueOnce(cleanup.promise);
  const request = mutate({ op: 'close', key: 'a' });
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']);
  expect(workspace.value.active).toBe('b');
  expect(retainedTabs().map(t => t.key)).toEqual(['b']);
  remote.get.mockResolvedValue(original);
  await refreshWorkspace();
  remote.change.mockResolvedValueOnce(original);
  await mutate({ op: 'view', key: 'b', view: 'file' });
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']);
  expect(workspace.value.active).toBe('b');
  remote.get.mockResolvedValue({ tabs: [tab('b')], active: 'b' });
  cleanup.resolve({ tabs: [tab('b')], active: 'b' }); await request;
  expect(retainedTabs().map(t => t.key)).toEqual(['b']);
});
it('keeps closed tabs gone when an older poll completes after deletion', async () => {
  const original = structuredClone(workspace.value);
  const cleanup = deferred<typeof workspace.value>(), poll = deferred<typeof workspace.value>();
  remote.change.mockReturnValueOnce(cleanup.promise);
  const close = mutate({ op: 'close', key: 'a' });
  remote.get.mockReturnValueOnce(poll.promise);
  const refresh = refreshWorkspace();
  cleanup.resolve({ tabs: [tab('b')], active: 'b' }); await close;
  poll.resolve(original); await refresh;
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['b']);
});
it('closes all tabs immediately even when cleanup responses arrive in reverse order', async () => {
  const first = deferred<typeof workspace.value>(), second = deferred<typeof workspace.value>();
  remote.change.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = mutate({ op: 'close', key: 'a' }), b = mutate({ op: 'close', key: 'b' });
  expect(workspace.value).toMatchObject({ tabs: [], active: null });
  second.resolve({ tabs: [tab('a')], active: 'a' }); await b;
  expect(workspace.value.tabs).toEqual([]);
  remote.get.mockResolvedValue({ tabs: [], active: null });
  first.resolve({ tabs: [tab('b')], active: 'b' }); await a;
  await vi.waitFor(() => expect(retainedTabs()).toEqual([]));
  expect(workspace.value).toMatchObject({ tabs: [], active: null });
});
it('keeps all closed tabs gone when one request fails', async () => {
  workspace.value = { tabs: [tab('a'), tab('b'), tab('c')], active: 'a' };
  const first = deferred<typeof workspace.value>(), second = deferred<typeof workspace.value>();
  remote.change.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = mutate({ op: 'close', key: 'a' }), b = mutate({ op: 'close', key: 'b' });
  expect(workspace.value.active).toBe('c');
  second.resolve({ tabs: [tab('a'), tab('c')], active: 'a' }); await b;
  first.reject(new Error('Unpublished commits')); expect(await a).toBe(true);
  expect(workspace.value.tabs.map(t => t.key)).toEqual(['c']);
  expect(workspace.value.active).toBe('c');
  expect(retainedTabs().map(t => t.key)).toEqual(['c']);
});
it('keeps the last tab closed through a page reload and retries without retaining its data', async () => {
  workspace.value = { tabs: [tab('a')], active: 'a' };
  remote.change.mockRejectedValueOnce(new Error('Disk unavailable'));
  await mutate({ op: 'close', key: 'a' });
  expect(retainedTabs()).toEqual([]);
  // A new page has no in-memory tombstone, but still has the saved close intent.
  closedTabs.value = new Set();
  remote.change.mockRejectedValueOnce(new Error('Still unavailable'));
  remote.get.mockResolvedValue({ tabs: [tab('a')], active: 'a' });
  await refreshWorkspace();
  expect(workspace.value).toMatchObject({ tabs: [], active: null });
  remote.change.mockResolvedValueOnce({ tabs: [], active: null });
  remote.get.mockResolvedValue({ tabs: [], active: null });
  await refreshWorkspace();
  expect(localStorage.getItem('rev-pending-tab-closes')).toBe('[]');
  expect(retainedTabs()).toEqual([]);
});
it('accepts a newly opened PR even when its request straddles a completed close', async () => {
  const cleanup = deferred<typeof workspace.value>(), open = deferred<typeof workspace.value>();
  remote.change.mockReturnValueOnce(cleanup.promise).mockReturnValueOnce(open.promise);
  const close = mutate({ op: 'close', key: 'a' });
  const opening = mutate({ op: 'open', url: 'https://github.com/a/b/pull/1' });
  const fresh = { tabs: [tab('b'), { ...tab('a'), reviewId: 'new-a' }], active: 'a' };
  remote.get.mockResolvedValue(fresh);
  cleanup.resolve({ tabs: [tab('b')], active: 'b' }); await close;
  open.resolve(fresh); await opening;
  await vi.waitFor(() => expect(workspace.value.active).toBe('a'));
  expect(workspace.value.tabs.find(t => t.key === 'a')?.reviewId).toBe('new-a');
});


it.each(['description', 'comment'])('accepts an external PR link during loading without being blocked by a %s draft', async kind => {
  workspace.value.tabs[0].loading = true;
  vi.stubGlobal('document', { querySelector: () => kind === 'description' ? {} : null,
    querySelectorAll: () => kind === 'comment' ? [{ value: 'Unsent comment', disabled: false }] : [] });
  remote.get.mockResolvedValue({ ...structuredClone(workspace.value), active: 'b', externalSelection: 1 });
  await refreshWorkspace();
  expect(workspace.value.active).toBe('b');
  expect(workspace.value.tabs[0].loading).toBe(true);
});
it('keeps ordinary background refresh from disturbing an editor', async () => {
  vi.stubGlobal('document', { querySelector: () => ({}), querySelectorAll: () => [] });
  remote.get.mockResolvedValue({ ...structuredClone(workspace.value), active: 'b' });
  await refreshWorkspace();
  expect(workspace.value.active).toBe('a');
});
it('ignores an older external selection response arriving after a newer link', async () => {
  const old = deferred<typeof workspace.value>();
  remote.get.mockReturnValueOnce(old.promise);
  const refresh = refreshWorkspace();
  remote.get.mockResolvedValueOnce({ ...structuredClone(workspace.value), active: 'b', externalSelection: 2 });
  await refreshWorkspace();
  old.resolve({ ...structuredClone(workspace.value), active: 'a', externalSelection: 1 });
  await refresh;
  expect(workspace.value.active).toBe('b');
  expect(workspace.value.externalSelection).toBe(2);
});
