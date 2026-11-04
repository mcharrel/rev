import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../src/server.js', () => ({ startServer: vi.fn() }));
vi.mock('../../../src/db/connection.js', () => ({ setDataDir: vi.fn() }));
vi.mock('../../../src/db/queries.js', () => ({ createReview: vi.fn(), getLatestInProgressReview: vi.fn() }));
import { main } from '../../../src/rev.js';
import { controlPath } from '../../../src/workspace/control.js';

const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = 'https://github.com/example/project/pull/123';
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rev-agent-cli-'));
  vi.stubEnv('REV_CONFIG_DIR', dir); vi.stubEnv('CODEX_THREAD_ID', chat);
  writeFileSync(controlPath(), JSON.stringify({ port: 4183, token: 'a'.repeat(64) }));
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ comments: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock); vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
});
it('lists requests for the current chat without changing their status', async () => {
  await main(['comments', url]);
  expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4183/api/workspace/codex-comments');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url, threadId: chat });
  expect(console.log).toHaveBeenCalledWith(JSON.stringify({ comments: [] }, null, 2));
});
it('sends a revision-bound pickup and reply, including the local control credential', async () => {
  await main(['pickup', url, '--comment', 'note', '--revision', '2']);
  const [endpoint, request] = fetchMock.mock.calls[0];
  expect(endpoint).toBe('http://127.0.0.1:4183/api/workspace/codex-pickup');
  expect(request.headers['x-rev-token']).toBe('a'.repeat(64));
  expect(JSON.parse(request.body)).toEqual({ url, commentId: 'note', revision: 2, threadId: chat });
  const reply = join(dir, 'reply.txt'); writeFileSync(reply, 'Updated and verified.');
  await main(['reply', url, '--comment', 'note', '--revision', '2', '--body-file', reply]);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ revision: 2, body: 'Updated and verified.' });
});
it('rejects missing chat identity, invalid revisions, missing reply text and server errors', async () => {
  await expect(main(['pickup', url, '--comment', 'note', '--revision', '0'])).rejects.toThrow();
  await expect(main(['reply', url, '--comment', 'note'])).rejects.toThrow('body-file');
  vi.stubEnv('CODEX_THREAD_ID', '');
  await expect(main(['comments', url])).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  vi.stubEnv('CODEX_THREAD_ID', chat);
  fetchMock.mockResolvedValue(new Response('Comment was edited', { status: 400 }));
  await expect(main(['pickup', url, '--comment', 'note'])).rejects.toThrow('Comment was edited');
});

it('explains an unreachable connection without claiming pickup or retrying a reply', async () => {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'));
  await expect(main(['pickup', url, '--comment', 'note'])).rejects.toThrow('Cannot reach rev on port 4183. Open or restart rev');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(console.log).not.toHaveBeenCalled();
});
