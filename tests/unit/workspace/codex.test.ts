import { pullInfo } from './fixtures.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema, type PullTab } from '../../../src/api/workspace.js';
const mocks = vi.hoisted(() => ({ enabled: true, data: { tabs: [] as PullTab[], archived: [] as PullTab[] }, connect: vi.fn(), send: vi.fn(), save: vi.fn(), close: vi.fn() }));
vi.mock('../../../src/workspace/codex-settings.js', () => ({ codexEnabled: () => mocks.enabled }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: mocks.save }));
vi.mock('../../../src/workspace/codex-client.js', () => ({ codexConnection: mocks.connect, sendToCodex: mocks.send }));
import { commentPrompt, flushCodexComments, queueCodexComment, recoverCodexComments, retryCodexComment, reviseComment } from '../../../src/workspace/codex.js';
const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const message = (body = 'Please simplify this') => ThreadMessageSchema.parse({ id: crypto.randomUUID(), body, author: 'alice', date: '', kind: 'review', destination: 'local', path: 'src/example.ts', line: 10, side: 'new' });
function tab() {
  return PullTabSchema.parse({ key: 'owner/repo#1', ref: { owner: 'owner', repo: 'repo', number: 1, url: 'https://github.com/owner/repo/pull/1' }, repoRoot: null, reviewId: null, info: pullInfo(), viewer: 'alice', codexThreadId: chat });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled = true;
  mocks.data.tabs = [tab()]; mocks.data.archived = [];
  mocks.connect.mockResolvedValue({ client: { close: mocks.close }, activeTurn: 'active' });
  mocks.send.mockResolvedValue(undefined);
});
it('does not start an agent or forward comments from an unlinked PR', () => {
  const t = mocks.data.tabs[0]; delete t.codexThreadId;
  const m = message(); t.comments.push(m); queueCodexComment(t, m);
  expect(m.codex).toBeUndefined(); expect(mocks.connect).not.toHaveBeenCalled();
});
it('captures the original chat and delivers once with PR and source context', async () => {
  const t = mocks.data.tabs[0]; const m = message(); t.comments.push(m);
  queueCodexComment(t, m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('sent'));
  queueCodexComment(t, m); await flushCodexComments();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0].slice(1)).toEqual([chat, commentPrompt(t, m), 'queue', m.id]);
  expect(commentPrompt(t, m)).toContain('new comment: Please simplify this');
  expect(commentPrompt(t, m)).toContain('src/example.ts:10 (new)');
  expect(mocks.close).toHaveBeenCalled();
});
it('delivers a steer before ordinary messages across PRs linked to one chat', async () => {
  const t = mocks.data.tabs[0];
  const ordinary = message(); ordinary.codex = { threadId: chat, status: 'queued', mode: 'queue' };
  const steer = message('[steer] Keep the existing API'); steer.codex = { threadId: chat, status: 'queued', mode: 'steer' };
  t.comments.push(ordinary, steer);
  await flushCodexComments();
  expect(mocks.send.mock.calls.map(call => call[3])).toEqual(['steer', 'queue']);
  expect(mocks.send.mock.calls[0][2]).toContain('new comment: Keep the existing API');
  expect(mocks.send.mock.calls[0][2]).not.toContain('[steer]');
});
it('keeps comments visibly pending when the compatible desktop connection is unavailable', async () => {
  mocks.connect.mockRejectedValue(new Error('Shared server unavailable'));
  const m = message(); mocks.data.tabs[0].comments.push(m); queueCodexComment(mocks.data.tabs[0], m);
  await vi.waitFor(() => expect(m.codex?.error).toBe('Shared server unavailable'));
  expect(m.codex?.status).toBe('queued'); expect(mocks.send).not.toHaveBeenCalled();
});
it('does not retry uncertain delivery automatically, including across app restarts', async () => {
  mocks.send.mockRejectedValue(new Error('Lost acknowledgement'));
  const m = message(); mocks.data.tabs[0].comments.push(m); queueCodexComment(mocks.data.tabs[0], m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('uncertain'));
  await flushCodexComments(); expect(mocks.send).toHaveBeenCalledTimes(1);
  m.codex!.status = 'sending'; recoverCodexComments(); expect(m.codex?.status).toBe('uncertain');
  mocks.send.mockResolvedValue(undefined); retryCodexComment(mocks.data.tabs[0], m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('sent'));
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
it('never delivers queued comments from closed tabs', async () => {
  const t = mocks.data.tabs[0]; const remote = message(); const deleted = message();
  deleted.deleted = true; deleted.codex = { threadId: chat, status: 'queued', mode: 'queue' };
  const pending = message(); pending.codex = { threadId: chat, status: 'queued', mode: 'queue' };
  t.comments.push(remote, deleted, pending); mocks.data.archived.push(t); mocks.data.tabs = [];
  await flushCodexComments(); expect(mocks.send).not.toHaveBeenCalled();
});

it.each(['bob', null])('never connects or sends on another or unidentified PR (%s)', async author => {
  const t = mocks.data.tabs[0]; t.info = author ? pullInfo(author) : null;
  const fresh = message(); t.comments.push(fresh); queueCodexComment(t, fresh);
  expect(fresh.codex).toBeUndefined();
  fresh.codex = { threadId: chat, status: 'queued', mode: 'queue' };
  await flushCodexComments();
  expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  fresh.codex.status = 'uncertain';
  expect(() => retryCodexComment(t, fresh)).toThrow('own PRs');
});
it('does not deliver public comments or a message whose chat binding changed', async () => {
  const t = mocks.data.tabs[0]; const m = message(); m.destination = 'github'; t.comments.push(m);
  queueCodexComment(t, m); expect(m.codex).toBeUndefined();
  m.codex = { threadId: chat, status: 'queued', mode: 'queue' }; await flushCodexComments();
  expect(mocks.connect).not.toHaveBeenCalled();
  m.destination = 'local'; delete t.codexThreadId; await flushCodexComments();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('never dispatches Main comments, including a legacy local comment queued before the routing fix', async () => {
  const t = mocks.data.tabs[0], m = message(); m.kind = 'issue'; delete m.path;
  t.comments.push(m); queueCodexComment(t, m);
  expect(m.codex).toBeUndefined();
  m.codex = { threadId: chat, status: 'queued', mode: 'queue' };
  await flushCodexComments(); expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  m.codex.status = 'uncertain'; expect(() => retryCodexComment(t, m)).toThrow('local comments');
});

it('does not confuse delivery with pickup, and resets the request when its text changes', async () => {
  const t = mocks.data.tabs[0], m = message(); t.comments.push(m); queueCodexComment(t, m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('sent'));
  expect(m.agentStatus).toBeUndefined();
  m.agentStatus = 'answered';
  reviseComment(m, m.body); expect(m.agentStatus).toBe('answered');
  reviseComment(m, 'Updated request');
  expect(m).toMatchObject({ revision: 2, agentStatus: 'pending', codexRequested: true });
  expect(m.codex).toBeUndefined();
  queueCodexComment(t, m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('sent'));
  expect(mocks.send.mock.calls[1][4]).toBe(`${m.id}:2`);
  expect(commentPrompt(t, m)).toContain('--revision 2');
  expect(commentPrompt(t, m)).toContain('rev pickup');
});
it('recovers existing answers without treating delivery or an old revision as answered', () => {
  const t = mocks.data.tabs[0], answered = message(), delivered = message(), edited = message(), failed = message();
  delivered.codex = { threadId: chat, status: 'sent', mode: 'queue' };
  edited.revision = 2;
  t.comments.push(answered, delivered, edited, failed,
    { ...message(), kind: 'ai', status: 'error', author: 'Previous agent', parentKey: failed.id },
    { ...message(), kind: 'ai', status: 'done', author: 'Previous agent', parentKey: answered.id },
    { ...message(), kind: 'ai', status: 'done', author: 'Codex', parentKey: edited.id });
  recoverCodexComments();
  expect(answered.agentStatus).toBe('answered');
  expect(delivered.agentStatus).toBe('pending');
  expect(edited.agentStatus).toBe('pending');
  expect(failed.agentStatus).toBe('pending');
});
it('does not send an obsolete revision if the request changes while connecting', async () => {
  let release!: (value: unknown) => void;
  mocks.connect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const t = mocks.data.tabs[0], m = message(); t.comments.push(m); queueCodexComment(t, m);
  reviseComment(m, 'Use this new requirement'); queueCodexComment(t, m);
  release({ client: { close: mocks.close }, activeTurn: 'active' });
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][2]).toContain('new comment: Use this new requirement');
  expect(mocks.send.mock.calls[0][4]).toBe(`${m.id}:2`);
});
it('does not turn an explicit pickup into uncertain delivery after a late transport failure', async () => {
  let rejectSend!: (reason: Error) => void;
  mocks.send.mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject; }));
  const t = mocks.data.tabs[0], m = message(); t.comments.push(m); queueCodexComment(t, m);
  await vi.waitFor(() => expect(m.codex?.status).toBe('sending'));
  m.codex!.status = 'sent'; m.agentStatus = 'processing';
  rejectSend(new Error('Connection lost'));
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(m.codex).toMatchObject({ status: 'sent' });
  expect(m.agentStatus).toBe('processing');
});

it('keeps feedback queued when disabled, including during an in-flight connection', async () => {
  const t = mocks.data.tabs[0]; const m = message(); t.comments.push(m);
  mocks.enabled = false; queueCodexComment(t, m); await flushCodexComments();
  expect(mocks.connect).not.toHaveBeenCalled(); expect(m.codex?.status).toBe('queued');
  mocks.enabled = true;
  mocks.connect.mockImplementationOnce(async () => { mocks.enabled = false; return { client: { close: mocks.close } }; });
  await flushCodexComments(); expect(mocks.send).not.toHaveBeenCalled(); expect(m.codex?.status).toBe('queued');
});

it('never queues, sends or retries replies in another author’s thread, including nested replies to yourself', async () => {
  const t = mocks.data.tabs[0], root = { ...message(), author: 'bob', remoteId: 10 };
  const parent = { ...message(), parentId: 10, remoteId: 11 };
  const reply = { ...message(), parentId: 11 };
  t.comments.push(reply, parent, root); queueCodexComment(t, reply);
  expect(reply.codex).toBeUndefined();
  reply.codex = { threadId: chat, status: 'queued', mode: 'steer' };
  await flushCodexComments(); expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  reply.codex.status = 'uncertain'; expect(() => retryCodexComment(t, reply)).toThrow('threads you started');
  recoverCodexComments(); expect(reply.codex).toBeUndefined(); expect(reply.codexRequested).toBe(false); expect(reply.destination).toBe('local');
});
it('rechecks thread ownership after connecting and rejects a legacy private request without publishing it', async () => {
  const t = mocks.data.tabs[0], root = message(), reply = { ...message(), parentKey: root.id };
  t.comments.push(root, reply);
  mocks.connect.mockImplementationOnce(async () => { root.author = 'bob'; return { client: { close: mocks.close } }; });
  queueCodexComment(t, reply);
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(mocks.send).not.toHaveBeenCalled();
  delete reply.destination;
  recoverCodexComments(); expect(reply.destination).toBe('local'); expect(reply.codex).toBeUndefined();
});
