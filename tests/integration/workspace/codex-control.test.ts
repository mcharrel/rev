import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema, type PullTab } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({ data: { tabs: [] as PullTab[], active: null }, refresh: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/service.js', () => ({ mutateWorkspace: vi.fn(), reconcileCommentRouting: vi.fn(), refreshAfterReply: mocks.refresh, flushSourceRefreshes: vi.fn() }));
import { controlPath, registerControl } from '../../../src/workspace/control.js';
import { workspaceRoutes } from '../../../src/workspace/routes.js';

it('keeps real CLI pickup and replies working after an isolated test process registers and exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rev-control-flow-'));
  const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const url = 'https://github.com/example/project/pull/123';
  const tab = PullTabSchema.parse({ key: 'example/project#123', ref: { owner: 'example', repo: 'project', number: 123, url },
    reviewId: null, repoRoot: null, info: pullInfo(), viewer: 'alice', codexThreadId: chat });
  tab.comments.push(ThreadMessageSchema.parse({ id: 'note', kind: 'review', destination: 'local', author: 'alice',
    body: 'Please simplify', date: '', revision: 2, codex: { threadId: chat, status: 'sent', mode: 'queue' } }));
  mocks.data.tabs = [tab];
  const app = new Hono<AppEnv>().route('/api/workspace', workspaceRoutes);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  let stop: (() => void) | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server');
    vi.stubEnv('REV_CONFIG_DIR', join(root, 'live'));
    stop = registerControl(address.port);
    const registered = readFileSync(controlPath(), 'utf8');
    // The second process dies without unregistering, as a killed smoke server does.
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import { registerControl } from './src/workspace/control.ts'; registerControl(4199);"], {
      env: { ...process.env, REV_CONFIG_DIR: undefined, GLASSBOX_CONFIG_DIR: join(root, 'test') },
    });
    expect(readFileSync(controlPath(), 'utf8')).toBe(registered);
    expect(JSON.parse(readFileSync(join(root, 'test/connection.json'), 'utf8')).port).toBe(4199);
    const command = (args: string[], thread = chat) => promisify(execFile)(process.execPath,
      ['--import', 'tsx', 'src/rev.ts', ...args], { env: { ...process.env, CODEX_THREAD_ID: thread } });
    expect(JSON.parse((await command(['comments', url])).stdout).comments).toMatchObject([{ id: 'note', status: 'pending' }]);
    await expect(command(['pickup', url, '--comment', 'note', '--revision', '1'])).rejects.toThrow('edited');
    await expect(command(['pickup', url, '--comment', 'note', '--revision', '2'], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).rejects.toThrow('originating');
    await command(['pickup', url, '--comment', 'note', '--revision', '2']);
    expect(tab.comments[0].agentStatus).toBe('processing');
    const answer = join(root, 'reply.txt'); writeFileSync(answer, 'Simplified and verified.');
    const reply = ['reply', url, '--comment', 'note', '--revision', '2', '--body-file', answer];
    await command(reply); await command(reply);
    expect(tab.comments[0].agentStatus).toBe('answered');
    expect(tab.comments.filter(comment => comment.kind === 'ai')).toMatchObject([{ body: 'Simplified and verified.', destination: 'local' }]);
    expect(tab.comments).toHaveLength(2);
    expect(JSON.parse((await command(['comments', url])).stdout).comments).toEqual([]);
  } finally {
    stop?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve(); }));
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 30000);
