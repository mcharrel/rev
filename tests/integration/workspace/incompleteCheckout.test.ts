import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { setupTestDb, teardownTestDb } from '../../helpers/db.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({ root: '', source: '', db: vi.fn(), load: vi.fn(),
  data: { tabs: [], archived: [], active: null, outbox: [] } as WorkspaceDisk }));
vi.mock('../../../src/db/connection.js', () => ({ getDataDir: () => mocks.root, getDb: mocks.db }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/repositories.js', () => ({ findLocalRepository: async () => mocks.source }));
vi.mock('../../../src/workspace/accounts.js', () => ({ githubAccount: () => '' }));
vi.mock('../../../src/workspace/github.js', async original => ({
  ...await original<typeof import('../../../src/workspace/github.js')>(), loadPull: mocks.load,
  loadComments: vi.fn().mockResolvedValue([]), localWorkspaceConfig: () => ({ slack: {}, accounts: {}, repositories: {} }),
}));
vi.mock('../../../src/workspace/deployments.js', () => ({ refreshDeployment: vi.fn(), cancelDeployment: vi.fn() }));
vi.mock('../../../src/workspace/notifications.js', () => ({ notify: vi.fn() }));
import { getReviewFiles } from '../../../src/db/queries.js';
import { finishDeletion } from '../../../src/workspace/deletion.js';
import { workspaceRoutes } from '../../../src/workspace/routes.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(cwd: string) {
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}
beforeAll(async () => { mocks.db.mockResolvedValue(await setupTestDb()); });
afterAll(teardownTestDb);
beforeEach(() => {
  mocks.root = realpathSync(mkdtempSync(join(tmpdir(), 'rev-retry-checkout-')));
  mocks.data = { tabs: [], archived: [], active: null, outbox: [] };
  mocks.source = join(mocks.root, 'user-clone'); mkdirSync(mocks.source); git(mocks.source, 'init', '-q');
});
afterEach(() => { rmSync(mocks.root, { recursive: true, force: true }); });
it.each(['partial', 'unknown', 'staged'])('refreshes an incomplete %s snapshot without losing local data', async kind => {
  writeFileSync(join(mocks.source, 'file.ts'), 'before\n'); const base = commit(mocks.source);
  writeFileSync(join(mocks.source, 'file.ts'), 'after\n');
  writeFileSync(join(mocks.source, 'second.ts'), 'second\n'); const head = commit(mocks.source);
  const root = join(mocks.root, 'workspaces', 'example-project-1'); mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'file.ts'), ''); // An interrupted Git checkout leaves an incomplete file and no index/HEAD.
  if (kind === 'unknown') writeFileSync(join(root, 'notes'), 'keep unknown work');
  if (kind === 'staged') git(root, 'add', 'file.ts');
  const info = { ...pullInfo(), baseRefOid: base, headRefOid: head };
  const tab = PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: '' },
    reviewId: null, repoRoot: null, viewer: 'alice', info, error: 'The managed checkout has local changes; they were preserved.' });
  mocks.data.tabs = [tab]; mocks.data.active = tab.key; mocks.load.mockResolvedValue(info);
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', 'launch'); await next(); }).route('/workspace', workspaceRoutes);
  const refresh = () => app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'refresh', key: tab.key }) });
  expect((await refresh()).status).toBe(200);
  if (kind === 'staged') {
    expect(tab.error).toContain('local changes'); expect(tab.reviewId).toBeNull();
    expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe(''); expect(existsSync(join(root, '.git/index'))).toBe(true);
    expect(existsSync(join(mocks.root, 'checkout-recovery'))).toBe(false); return;
  }
  expect(tab.error).toBeUndefined(); expect(tab.loading).toBe(false); expect(tab.reviewId).not.toBeNull();
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head); expect(git(root, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe('after\n');
  expect((await getReviewFiles(tab.reviewId!)).map(f => f.file_path).sort()).toEqual(['file.ts', 'second.ts']);
  const recovery = join(mocks.root, 'checkout-recovery', 'example-project-1'); const backups = readdirSync(recovery);
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(recovery, backups[0], 'file.ts'), 'utf8')).toBe('');
  if (kind === 'unknown') expect(readFileSync(join(recovery, backups[0], 'notes'), 'utf8')).toBe('keep unknown work');
  const reviewId = tab.reviewId;
  await refresh(); expect(tab.reviewId).toBe(reviewId); expect(readdirSync(recovery)).toEqual(backups);
  writeFileSync(join(root, 'file.ts'), 'real local edits\n');
  writeFileSync(join(mocks.source, 'second.ts'), 'new revision\n'); info.headRefOid = commit(mocks.source);
  await refresh();
  expect(tab.error).toContain('local changes'); expect(tab.reviewedHead).toBe(head);
  expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe('real local edits\n'); expect(readdirSync(recovery)).toEqual(backups);
  const closed = await app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'close', key: tab.key }) });
  expect(closed.status).toBe(200); expect(mocks.data.tabs).toEqual([]);
  await finishDeletion(tab.key);
  expect(existsSync(root)).toBe(false); expect(existsSync(recovery)).toBe(false);
  expect(readFileSync(join(mocks.source, 'file.ts'), 'utf8')).toBe('after\n');
}, 15000);
