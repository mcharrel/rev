import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { PullTabSchema } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({ data: { tabs: [], archived: [], outbox: [], active: null } as WorkspaceDisk,
  load: vi.fn(), import: vi.fn(), discard: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/accounts.js', () => ({ githubAccount: () => '' }));
vi.mock('../../../src/workspace/github.js', async original => ({
  ...await original<typeof import('../../../src/workspace/github.js')>(),
  loadPull: mocks.load, github: vi.fn().mockResolvedValue({ login: 'alice' }), loadComments: vi.fn().mockResolvedValue([]),
  localWorkspaceConfig: () => ({ slack: {}, accounts: {}, repositories: {} }),
}));
vi.mock('../../../src/workspace/checkout.js', () => ({ importPull: mocks.import, ensureCheckout: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/workspace/discard.js', () => ({ discardTabData: mocks.discard }));
vi.mock('../../../src/workspace/deployments.js', () => ({ refreshDeployment: vi.fn(), cancelDeployment: vi.fn() }));
vi.mock('../../../src/workspace/notifications.js', () => ({ notify: vi.fn() }));
import { registerControl } from '../../../src/workspace/control.js';
import { finishDeletion } from '../../../src/workspace/deletion.js';
import { withCheckoutLock } from '../../../src/workspace/lifecycle.js';
import { workspaceRoutes } from '../../../src/workspace/routes.js';
import { mutateWorkspace, syncTab } from '../../../src/workspace/service.js';

it.each([{ reopening: false, closeAgain: false }, { reopening: true, closeAgain: false }, { reopening: true, closeAgain: true }])('opens through the real CLI while another checkout is blocked ($reopening, close again: $closeAgain)', async ({ reopening, closeAgain }) => {
  const root = mkdtempSync(join(tmpdir(), 'rev-open-loading-'));
  vi.stubEnv('REV_CONFIG_DIR', root);
  const tab = (number: number) => PullTabSchema.parse({ key: `example/project#${number}`,
    ref: { owner: 'example', repo: 'project', number, url: `https://github.com/example/project/pull/${number}` },
    reviewId: null, repoRoot: null, info: null, viewer: 'alice' });
  const first = tab(1), second = tab(2);
  mocks.data = { tabs: reopening ? [first, second] : [first], archived: [], outbox: [], active: first.key };
  mocks.load.mockResolvedValue(pullInfo()); mocks.discard.mockResolvedValue(undefined);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  mocks.import.mockReset().mockImplementation(t => withCheckoutLock(t.key, async () => {
    if (t.key === first.key) await blocked;
  }));
  const loading = syncTab(first);
  await vi.waitFor(() => expect(mocks.import).toHaveBeenCalled());
  if (reopening) await mutateWorkspace({ op: 'close', key: second.key }, 'launch');
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', 'launch'); await next(); }).route('/api/workspace', workspaceRoutes);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server');
  const stop = registerControl(address.port);
  let opened = false;
  const request = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/rev.ts', 'open', second.ref.url], {
    env: { ...process.env, CODEX_THREAD_ID: undefined, GLASSBOX_CONFIG_DIR: root }, timeout: 10000,
  }).then(result => { opened = result.stdout.includes('Opened '); });
  try {
    await vi.waitFor(() => expect(opened).toBe(true), { timeout: 3000 });
    expect(first.loading).toBe(true);
    expect(mocks.data.active).toBe(second.key);
    expect(mocks.data.externalSelection).toBe(1);
    expect(mocks.data.tabs.find(t => t.key === second.key)?.reviewId).toBeNull();
    if (reopening) expect(mocks.import.mock.calls.map(([t]) => t.key)).not.toContain(second.key);
    if (closeAgain) await mutateWorkspace({ op: 'close', key: second.key }, 'launch');
  } finally {
    release(); await loading; await request;
    await finishDeletion(second.key);
    for (const t of mocks.data.tabs) await syncTab(t);
    stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
  expect(mocks.data.active).toBe(closeAgain ? first.key : second.key);
  expect(mocks.data.tabs.map(t => t.key).sort()).toEqual(closeAgain ? [first.key] : [first.key, second.key]);
  if (closeAgain) expect(mocks.import.mock.calls.map(([t]) => t.key)).not.toContain(second.key);
}, 15000);
