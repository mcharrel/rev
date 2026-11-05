import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { PullTabSchema, WorkspaceSchema, type WorkspaceMutation } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({
  data: { tabs: [], archived: [], active: null, outbox: [] } as WorkspaceDisk,
  discard: vi.fn(), get: vi.fn(), change: vi.fn(),
}));
vi.mock('../../../src/api/workspace.js', async original => ({ ...await original<typeof import('../../../src/api/workspace.js')>(), getWorkspace: mocks.get, changeWorkspace: mocks.change }));
vi.mock('../../../src/client/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../../src/workspace/accounts.js', () => ({ githubAccount: () => '', localWorkspaceConfig: () => ({ accounts: {}, slack: {}, repositories: {} }) }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/discard.js', () => ({ discardTabData: mocks.discard }));
vi.mock('../../../src/workspace/checkout.js', () => ({ importPull: vi.fn(), ensureCheckout: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/workspace/deployments.js', () => ({ refreshDeployment: vi.fn(), cancelDeployment: vi.fn(), stopDeployments: vi.fn() }));
vi.mock('../../../src/workspace/slack-reactions.js', () => ({ cancelSlackReaction: vi.fn() }));
import { workspaceRoutes } from '../../../src/workspace/routes.js';
import { closedTabs } from '../../../src/client/workspace/closedTabs.js';
import { mutate, refreshWorkspace, retainedTabs, workspace } from '../../../src/client/workspace/state.js';

const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', 'review-1'); await next(); }).route('/workspace', workspaceRoutes);
const tab = (number: number) => PullTabSchema.parse({
  key: `example/project#${number}`,
  ref: { owner: 'example', repo: 'project', number, url: `https://github.com/example/project/pull/${number}` },
  info: pullInfo('alice'), viewer: 'alice', reviewId: `review-${number}`, repoRoot: '/synthetic-checkout', commentsLoaded: true,
});
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])('hides a tab immediately while real HTTP cleanup waits, keeps remaining tabs usable, and handles completion (failure: %s)', async failure => {
  closedTabs.value = new Set();
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
  mocks.data.pendingDeletes = [];
  mocks.data.tabs = [tab(1), tab(2), tab(3)]; mocks.data.active = mocks.data.tabs[0].key;
  workspace.value = WorkspaceSchema.parse(mocks.data);
  mocks.get.mockImplementation(async () => WorkspaceSchema.parse(await (await app.request('/workspace')).json()));
  mocks.change.mockImplementation(async (body: WorkspaceMutation) => {
    const response = await app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return WorkspaceSchema.parse(value);
  });
  let finish!: () => void, fail!: (error: Error) => void;
  mocks.discard.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  const close = mutate({ op: 'close', key: 'example/project#1' });
  expect(workspace.value.tabs.map(t => t.ref.number)).toEqual([2, 3]);
  expect(workspace.value.active).toBe('example/project#2');
  await vi.waitFor(() => expect(finish).toBeDefined());
  // Deletion is still pending on the server, but polls cannot restore its tab.
  expect(mocks.data.tabs).toHaveLength(2);
  expect(await close).toBe(true);
  await refreshWorkspace();
  expect(workspace.value.tabs.map(t => t.ref.number)).toEqual([2, 3]);
  workspace.value = { ...workspace.value, active: 'example/project#3' };
  expect(await mutate({ op: 'select', key: 'example/project#3' })).toBe(true);
  expect(await mutate({ op: 'order', keys: ['example/project#3', 'example/project#2'] })).toBe(true);
  expect(workspace.value.tabs.map(t => t.ref.number)).toEqual([3, 2]);
  expect(workspace.value.active).toBe('example/project#3');
  if (failure) fail(new Error('Unpublished source must be kept')); else finish();
  expect(await close).toBe(true);
  await refreshWorkspace();
  expect(workspace.value.active).toBe('example/project#3');
  expect(retainedTabs().some(t => t.ref.number === 1)).toBe(false);
  expect(mocks.data.tabs.some(t => t.ref.number === 1)).toBe(false);
  expect(mocks.data.archived).toEqual([]);
});
