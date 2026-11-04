import { pullInfo } from './fixtures.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema, type PullTab } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
const mocks = vi.hoisted(() => ({ data: { tabs: [] as PullTab[], archived: [] as PullTab[], active: null, externalSelection: 0 }, mutate: vi.fn(), refresh: vi.fn(), save: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: mocks.save }));
vi.mock('../../../src/workspace/service.js', () => ({ mutateWorkspace: mocks.mutate, reconcileCommentRouting: vi.fn(), refreshAfterReply: mocks.refresh, flushSourceRefreshes: vi.fn() }));
import { authorizeControl, controlPath, registerControl } from '../../../src/workspace/control.js';
import { workspaceRoutes } from '../../../src/workspace/routes.js';
let dir: string;
let app: Hono<AppEnv>;
const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = 'https://github.com/owner/repo/pull/123/files';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rev-control-')); vi.stubEnv('REV_CONFIG_DIR', dir);
  mocks.data.tabs = []; mocks.data.archived = []; mocks.data.externalSelection = 0;
  mocks.mutate.mockReset().mockImplementation(async () => {
    if (!mocks.data.tabs.length) mocks.data.tabs.push(PullTabSchema.parse({ key: 'owner/repo#123', ref: { owner: 'owner', repo: 'repo', number: 123, url }, reviewId: null, repoRoot: null, info: null }));
  });
  app = new Hono<AppEnv>(); app.use('*', async (c, next) => { c.set('reviewId', 'review'); await next(); }); app.route('/api/workspace', workspaceRoutes);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const post = (body: unknown, token?: string) => app.request('/api/workspace/codex-open', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-rev-token': token } : {}) }, body: JSON.stringify(body) });
it('requires a local secret, stored only in an owner-readable connection file', async () => {
  const stop = registerControl(4183); const connection = JSON.parse(readFileSync(controlPath(), 'utf8'));
  expect(statSync(controlPath()).mode & 0o777).toBe(0o600);
  expect(authorizeControl(connection.token)).toBe(true); expect(authorizeControl('bad')).toBe(false);
  expect((await post({ url, threadId: chat })).status).toBe(401); expect(mocks.mutate).not.toHaveBeenCalled(); stop();
});
it('opens the correct PR and records its originating chat without waiting for GitHub', async () => {
  const stop = registerControl(4183); const { token } = JSON.parse(readFileSync(controlPath(), 'utf8'));
  const result = await post({ url, threadId: chat }, token);
  expect(result.status).toBe(200); expect(mocks.data.tabs[0].codexThreadId).toBe(chat);
  expect(mocks.data.externalSelection).toBe(1); stop();
});
it('rejects another chat trying to silently replace the original binding', async () => {
  const stop = registerControl(4183); const { token } = JSON.parse(readFileSync(controlPath(), 'utf8'));
  await post({ url, threadId: chat }, token); mocks.mutate.mockClear();
  expect((await post({ url, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, token)).status).toBe(409);
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.data.tabs[0].codexThreadId).toBe(chat); stop();
});
it('does not remove a newer server registration when the old server closes', () => {
  const oldStop = registerControl(4183); const newStop = registerControl(4184); oldStop();
  expect(JSON.parse(readFileSync(controlPath(), 'utf8')).port).toBe(4184); newStop();
});

it('opens another person’s PR without binding a Codex chat', async () => {
  const stop = registerControl(4183); const { token } = JSON.parse(readFileSync(controlPath(), 'utf8'));
  await mocks.mutate();
  mocks.data.tabs[0].viewer = 'alice'; mocks.data.tabs[0].info = pullInfo('bob');
  const response = await post({ url, threadId: chat }, token);
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ linked: false });
  expect(mocks.data.tabs[0].codexThreadId).toBeUndefined(); stop();
});

it('authenticates agent controls and enforces chat binding and comment revisions', async () => {
  const stop = registerControl(4183); const { token } = JSON.parse(readFileSync(controlPath(), 'utf8'));
  await post({ url, threadId: chat }, token);
  const tab = mocks.data.tabs[0]; tab.info = pullInfo(); tab.viewer = 'alice';
  tab.comments.push(ThreadMessageSchema.parse({ id: 'note', kind: 'review', destination: 'local', author: 'alice',
    body: 'Please simplify', date: '', revision: 2, codex: { threadId: chat, status: 'queued', mode: 'queue' } }));
  const request = (action: string, body: object, authenticated = true) => app.request(`/api/workspace/codex-${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-rev-token': token } : {}) },
    body: JSON.stringify({ url, threadId: chat, ...body }),
  });
  for (const action of ['comments', 'pickup', 'reply'])
    expect((await request(action, {}, false)).status).toBe(401);
  expect((await request('pickup', { commentId: 'note', revision: 1 })).status).toBe(400);
  expect((await request('pickup', { commentId: 'note', revision: 2, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status).toBe(400);
  expect((await request('pickup', { commentId: 'note', revision: 2 })).status).toBe(200);
  expect(tab.comments[0].agentStatus).toBe('processing');
  expect((await request('reply', { commentId: 'note', revision: 2, body: 'Done' })).status).toBe(200);
  expect(tab.comments[0].agentStatus).toBe('answered');
  expect(mocks.refresh).toHaveBeenCalledWith(tab);
  expect(await (await request('comments', {})).json()).toEqual({ comments: [] });
  stop();
});

it('uses isolated app settings for control discovery unless an explicit rev directory overrides them', () => {
  const isolated = join(dir, 'isolated');
  vi.stubEnv('GLASSBOX_CONFIG_DIR', isolated);
  expect(controlPath()).toBe(join(dir, 'connection.json'));
  vi.stubEnv('REV_CONFIG_DIR', undefined);
  expect(controlPath()).toBe(join(isolated, 'connection.json'));
  const stop = registerControl(4199);
  expect(JSON.parse(readFileSync(controlPath(), 'utf8')).port).toBe(4199);
  stop();
});

it('preserves normal discovery when an app-settings override is missing or blank', () => {
  vi.stubEnv('REV_CONFIG_DIR', undefined);
  for (const value of [undefined, '', '   ']) {
    vi.stubEnv('GLASSBOX_CONFIG_DIR', value);
    expect(controlPath()).toBe(join(homedir(), '.local/share/rev/connection.json'));
  }
});
