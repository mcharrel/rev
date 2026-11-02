import { pullInfo } from './fixtures.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema, type PullTab } from '../../../src/api/workspace.js';
const mocks = vi.hoisted(() => ({ data: { tabs: [] as PullTab[], archived: [] as PullTab[] }, save: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: mocks.save }));
import { listCodexComments, pickUpCodexComment, postCodexReply } from '../../../src/workspace/codex-reply.js';
const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { url: 'https://github.com/owner/repo/pull/1', commentId: 'comment', threadId: chat, body: 'Fixed and pushed the signed commit. The focused tests pass.' };
beforeEach(() => {
  const comment = ThreadMessageSchema.parse({ id: 'comment', body: 'Fix it', kind: 'review', destination: 'local', author: 'alice', date: '', path: 'src/file.ts', line: 10, side: 'new', annotationId: 'annotation', codex: { threadId: chat, status: 'queued', mode: 'queue' } });
  mocks.data.tabs = [PullTabSchema.parse({ key: 'owner/repo#1', ref: { owner: 'owner', repo: 'repo', number: 1, url: input.url }, repoRoot: null, reviewId: null, info: pullInfo(), viewer: 'alice', codexThreadId: chat, comments: [comment] })]; mocks.data.archived = [];
});
it('posts the original chat’s answer in the original comment thread and preserves its source anchor', () => {
  const id = postCodexReply(input); const comments = mocks.data.tabs[0].comments;
  expect(comments[1]).toMatchObject({ id, parentKey: 'comment', author: 'Codex', body: input.body, kind: 'ai', status: 'done', path: 'src/file.ts', line: 10, side: 'new', annotationId: 'annotation' });
  expect(comments[0].codex?.status).toBe('sent'); expect(comments[0].agentStatus).toBe('answered'); expect(comments[1].remoteId).toBeUndefined();
});
it('deduplicates identical retries without preventing a follow-up answer', () => {
  const first = postCodexReply(input); expect(postCodexReply(input)).toBe(first);
  expect(postCodexReply({ ...input, body: 'Added another regression test.' })).not.toBe(first);
  expect(mocks.data.tabs[0].comments).toHaveLength(3);
});
it('rejects another chat, wrong PR, deleted comment and remote-only comments', () => {
  expect(() => postCodexReply({ ...input, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toThrow('originating');
  expect(() => postCodexReply({ ...input, url: 'https://github.com/owner/repo/pull/2' })).toThrow('not found');
  delete mocks.data.tabs[0].comments[0].codex;
  expect(() => postCodexReply(input)).toThrow('originating');
  mocks.data.tabs[0].comments[0].deleted = true;
  expect(() => postCodexReply(input)).toThrow('not found');
});
it('rejects answers to deleted PR tabs', () => {
  mocks.data.archived = mocks.data.tabs; mocks.data.tabs = [];
  expect(() => postCodexReply(input)).toThrow('not found');
  expect(mocks.data.archived[0].comments).toHaveLength(1);
});

it.each(['bob', null])('rejects Codex replies on another or unidentified PR (%s)', author => {
  mocks.data.tabs[0].info = author ? pullInfo(author) : null;
  expect(() => postCodexReply(input)).toThrow('own PRs');
  expect(mocks.data.tabs[0].comments).toHaveLength(1);
});
it('rejects Codex replies to Main comments even when a legacy chat binding remains', () => {
  mocks.data.tabs[0].comments[0].kind = 'issue';
  expect(() => postCodexReply(input)).toThrow('local comments');
  expect(mocks.data.tabs[0].comments).toHaveLength(1);
});

it('lists only unfinished local code requests belonging to the originating chat', () => {
  expect(listCodexComments(input)).toMatchObject([{ id: 'comment', revision: 1, status: 'pending' }]);
  expect(listCodexComments(input)[0].prompt).toContain('rev pickup');
  pickUpCodexComment(input);
  expect(listCodexComments(input)[0].status).toBe('processing');
  postCodexReply(input);
  expect(listCodexComments(input)).toEqual([]);
  expect(() => listCodexComments({ ...input, threadId: 'other' })).toThrow('linked');
});
it('acknowledges pickup idempotently and never regresses an answered request', () => {
  pickUpCodexComment(input); pickUpCodexComment(input);
  const comment = mocks.data.tabs[0].comments[0];
  expect(comment.agentStatus).toBe('processing');
  expect(comment.codex?.status).toBe('sent');
  postCodexReply(input); pickUpCodexComment(input);
  expect(comment.agentStatus).toBe('answered');
});
it('rejects stale pickup and replies after an edit and deduplicates within each revision', () => {
  const first = postCodexReply(input);
  const comment = mocks.data.tabs[0].comments[0];
  comment.revision = 2; comment.agentStatus = 'pending';
  expect(() => pickUpCodexComment(input)).toThrow('edited');
  expect(() => postCodexReply(input)).toThrow('edited');
  expect(comment.agentStatus).toBe('pending');
  pickUpCodexComment({ ...input, revision: 2 });
  const second = postCodexReply({ ...input, revision: 2 });
  expect(second).not.toBe(first);
  expect(postCodexReply({ ...input, revision: 2 })).toBe(second);
  expect(comment.agentStatus).toBe('answered');
});
it('rejects pickup by another chat, deleted comments, public comments and Main comments', () => {
  expect(() => pickUpCodexComment({ ...input, threadId: 'other' })).toThrow('originating');
  const comment = mocks.data.tabs[0].comments[0];
  comment.destination = 'github';
  expect(() => pickUpCodexComment(input)).toThrow('local comments');
  comment.destination = 'local'; comment.kind = 'issue';
  expect(() => pickUpCodexComment(input)).toThrow('local comments');
  comment.deleted = true;
  expect(() => pickUpCodexComment(input)).toThrow('not found');
  expect(comment.agentStatus).toBeUndefined();
});
it('filters a mixed request list without losing eligible requests or exposing private Main messages', () => {
  const tab = mocks.data.tabs[0], original = tab.comments[0];
  const clone = (id: string, changes = {}) => ({ ...original, id, ...changes });
  tab.comments = [
    clone('public', { destination: 'github' }), clone('main', { kind: 'issue' }),
    clone('deleted', { deleted: true }), clone('answered', { agentStatus: 'answered' }),
    clone('unbound', { codex: undefined }), clone('working', { agentStatus: 'processing' }), original,
  ];
  expect(listCodexComments(input).map(item => item.id)).toEqual(['working', 'comment']);
  tab.info = null;
  expect(listCodexComments(input)).toEqual([]);
});

it('requests a source check for a new answer but not for a duplicate delivery', () => {
  const tab = mocks.data.tabs[0];
  postCodexReply(input);
  const request = tab.sourceRefreshRequested;
  expect(request).toEqual(expect.any(String));
  postCodexReply(input); expect(tab.sourceRefreshRequested).toBe(request);
  delete tab.sourceRefreshRequested;
  postCodexReply(input); expect(tab.sourceRefreshRequested).toBeUndefined();
  postCodexReply({ ...input, body: 'Pushed a follow-up fix.' });
  expect(tab.sourceRefreshRequested).toEqual(expect.any(String));
  expect(tab.sourceRefreshRequested).not.toBe(request);
});

it('rejects polling, pickup and answers for a stale request in another author’s thread', () => {
  const t = mocks.data.tabs[0], original = t.comments[0];
  original.parentId = 10;
  t.comments.push(ThreadMessageSchema.parse({ id: 'other', remoteId: 10, author: 'bob', kind: 'review', body: 'Review', date: '' }));
  expect(listCodexComments(input)).toEqual([]);
  expect(() => pickUpCodexComment(input)).toThrow('threads you started');
  expect(() => postCodexReply(input)).toThrow('threads you started');
  expect(original.agentStatus).toBeUndefined(); expect(t.comments).toHaveLength(2);
});
