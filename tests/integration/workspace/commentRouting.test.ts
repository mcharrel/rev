import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { canHandleCodexComment, PullTabSchema, ThreadMessageSchema } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({
  data: { tabs: [], archived: [], active: null, outbox: [] } as WorkspaceDisk,
  github: vi.fn(), send: vi.fn(), connect: vi.fn(),
}));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/codex-settings.js', () => ({ codexEnabled: () => true }));
vi.mock('../../../src/workspace/codex-client.js', () => ({ sendToCodex: mocks.send, codexConnection: mocks.connect }));
vi.mock('../../../src/workspace/github.js', async original => ({ ...await original<typeof import('../../../src/workspace/github.js')>(), github: mocks.github }));
import { workspaceRoutes } from '../../../src/workspace/routes.js';
import { flushCodexComments, recoverCodexComments } from '../../../src/workspace/codex.js';
import { flushOutbox } from '../../../src/workspace/service.js';
const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', 'review'); await next(); }).route('/workspace', workspaceRoutes);
const comment = (id: string, changes = {}) => ThreadMessageSchema.parse({ id, kind: 'review', body: 'Review', author: 'alice', path: 'file.ts', line: 2, date: '', ...changes });
const post = (parent: { parentId?: number; parentKey?: string }) => app.request('/workspace', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'comment', key: 'example/project#1', body: 'My reply', ...parent }),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = { tabs: [PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: 'https://github.com/example/project/pull/1' },
    info: pullInfo(), viewer: 'alice', codexThreadId: chat, reviewId: 'review', repoRoot: null })], archived: [], active: 'example/project#1', outbox: [] };
  mocks.connect.mockResolvedValue({ client: { close: vi.fn() } }); mocks.send.mockResolvedValue(undefined);
  mocks.github.mockResolvedValue({ id: 100, body: 'My reply', user: { login: 'alice' }, created_at: '', html_url: 'https://github.com/example/project/pull/1#discussion_r100' });
});
it.each(['remote', 'stale-local-control', 'nested'])('publishes replies in another author’s thread through HTTP/outbox without Codex (%s)', async mode => {
  const t = mocks.data.tabs[0];
  t.comments.push(comment('other', { remoteId: 10, author: 'bob' }), comment('mine', { parentId: 10, remoteId: 20 }));
  const result = await post(mode === 'stale-local-control' ? { parentKey: 'other' } : { parentId: mode === 'nested' ? 20 : 10 });
  expect(result.status).toBe(200);
  await vi.waitFor(() => expect(mocks.data.outbox).toHaveLength(0)); await flushCodexComments();
  expect(mocks.github).toHaveBeenCalledExactlyOnceWith(t.ref, 'repos/example/project/pulls/1/comments', 'POST', { body: expect.stringContaining('My reply'), in_reply_to: 10 });
  expect(t.comments.at(-1)).toMatchObject({ destination: 'github', parentId: 10, remoteId: 100, status: 'synced' });
  expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('delivers follow-ups through an agent reply in my own thread, but never on another PR', async () => {
  const t = mocks.data.tabs[0];
  t.comments.push(comment('own', { destination: 'local' }), comment('answer', { destination: 'local', parentKey: 'own', kind: 'ai', author: 'Codex' }));
  expect((await post({ parentKey: 'answer' })).status).toBe(200);
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(canHandleCodexComment(t, t.comments.at(-1)!)).toBe(true); expect(mocks.github).not.toHaveBeenCalled();
  t.info = pullInfo('bob');
  expect((await post({ parentKey: 'answer' })).status).toBe(400);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('cancels historical private requests without publishing them when recovery and outbox reconciliation run', async () => {
  const t = mocks.data.tabs[0];
  const old = comment('old', { parentId: 10, destination: 'local', codexRequested: true, codex: { threadId: chat, mode: 'queue', status: 'queued' } });
  t.comments.push(old, comment('other', { remoteId: 10, author: 'bob' }));
  mocks.data.outbox.push({ id: 'queued', tab: t.key, message: old.id, operation: 'create', nextAttempt: 0, attempted: false });
  recoverCodexComments(); await flushOutbox(); await flushCodexComments();
  expect(old).toMatchObject({ destination: 'local', codexRequested: false }); expect(old.codex).toBeUndefined();
  expect(mocks.data.outbox).toEqual([]); expect(mocks.github).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('waits for ownership then routes queued own threads regardless of stored order', async () => {
  const t = mocks.data.tabs[0];
  t.viewer = '';
  t.comments = [comment('reply', { author: 'You', parentKey: 'root', codexRequested: true }),
    comment('root', { author: 'You', codexRequested: true })];
  mocks.data.outbox = t.comments.map(message => ({ id: message.id, tab: t.key, message: message.id, operation: 'create', nextAttempt: 0, attempted: false }));
  await flushOutbox(); await flushCodexComments();
  expect(mocks.data.outbox).toHaveLength(2);
  expect(mocks.github).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  t.viewer = 'alice';
  await flushOutbox();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(t.comments.every(message => message.destination === 'local' && canHandleCodexComment(t, message))).toBe(true);
  expect(mocks.data.outbox).toEqual([]); expect(mocks.github).not.toHaveBeenCalled();
});
