import { expect, it } from 'vitest';
import { canHandleCodexComment, codeThreadRoot, commentAgentStatus, commentDestination, PullTabSchema, ThreadMessageSchema } from '../../../src/api/workspace.js';
import { pullInfo } from './fixtures.js';

const message = (id: string, changes = {}) => ThreadMessageSchema.parse({ id, author: 'alice', body: 'Feedback', date: '', kind: 'review', destination: 'local', codexRequested: true, ...changes });
const tab = (comments: ReturnType<typeof message>[]) => PullTabSchema.parse({ key: 'example/project#1', info: pullInfo('ALICE'), viewer: 'alice', ref: { owner: 'example', repo: 'project', number: 1, url: '' }, reviewId: null, repoRoot: null, comments });

it.each([false, true])('routes mixed nested threads by their original author, independent of order (reverse: %s)', reverse => {
  const mine = message('mine'), other = message('other', { author: 'bob', destination: undefined, remoteId: 10 });
  const ownReply = message('own-reply', { parentKey: mine.id });
  const answer = message('answer', { parentKey: ownReply.id, author: 'Codex', kind: 'ai' });
  const followup = message('followup', { parentKey: answer.id });
  const publicReply = message('public-reply', { parentId: 10, remoteId: 20 });
  const nestedPublic = message('nested-public', { parentId: 20 });
  const foreignReply = message('foreign-reply', { parentKey: mine.id, author: 'bob' });
  const t = tab([mine, other, ownReply, answer, followup, publicReply, nestedPublic, foreignReply]);
  if (reverse) t.comments.reverse();
  expect(t.comments.filter(m => canHandleCodexComment(t, m)).map(m => m.id).sort()).toEqual(['followup', 'mine', 'own-reply']);
  expect(commentDestination(t, nestedPublic)).toBe('github');
  expect(codeThreadRoot(t, followup)?.id).toBe('mine');
  expect(commentDestination(t, foreignReply)).toBe('local');
});
it('holds missing and cyclic ancestry without confusing a self-authored reply with a self-authored thread', () => {
  const orphan = message('orphan', { parentId: 10 });
  const a = message('a', { parentKey: 'b' }), b = message('b', { parentKey: 'a' });
  const t = tab([orphan, a, b]);
  for (const m of t.comments) {
    expect(canHandleCodexComment(t, m)).toBe(false); expect(commentDestination(t, m)).toBeNull();
  }
  t.comments.push(message('root', { author: 'bob', remoteId: 10, destination: undefined }));
  expect(commentDestination(t, orphan)).toBe('github'); expect(canHandleCodexComment(t, orphan)).toBe(false);
  t.comments.at(-1)!.author = 'alice';
  expect(canHandleCodexComment(t, orphan)).toBe(true);
});
it('requires both PR and message ownership and never treats a publishing account as a remote thread author', () => {
  const root = message('root', { author: 'bob', remoteId: 10, publishAs: 'alice' });
  const reply = message('reply', { parentId: 10 }); const t = tab([]); t.comments = [root, reply];
  expect(commentDestination(t, reply)).toBe('github'); expect(canHandleCodexComment(t, reply)).toBe(false);
  root.author = 'ALICE'; expect(canHandleCodexComment(t, reply)).toBe(true);
  t.info = null; expect(canHandleCodexComment(t, reply)).toBe(false); expect(commentDestination(t, reply)).toBeNull();
  t.info = pullInfo('alice'); t.viewer = ''; expect(canHandleCodexComment(t, reply)).toBe(false);
  t.viewer = 'bob'; expect(canHandleCodexComment(t, reply)).toBe(false);
  t.viewer = 'alice'; root.deleted = true; expect(canHandleCodexComment(t, reply)).toBe(false);
  root.deleted = false; reply.codexRequested = false; expect(canHandleCodexComment(t, reply)).toBe(false); expect(commentAgentStatus(reply)).toBeUndefined();
});
it('handles empty and single-comment threads and waits for identity of an unauthenticated local author', () => {
  const t = tab([]); expect(t.comments.filter(m => canHandleCodexComment(t, m))).toEqual([]);
  const m = message('root', { author: 'You' }); t.comments.push(m);
  expect(commentDestination(t, m)).toBeNull(); expect(canHandleCodexComment(t, m)).toBe(false);
  m.publishAs = 'alice'; expect(canHandleCodexComment(t, m)).toBe(true);
  m.kind = 'issue'; expect(commentDestination(t, m)).toBe('github'); expect(canHandleCodexComment(t, m)).toBe(false);
});
