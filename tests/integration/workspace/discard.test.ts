import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema } from '../../../src/api/workspace.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { setupTestDb, teardownTestDb } from '../../helpers/db.js';

const mocks = vi.hoisted(() => ({ root: '', db: vi.fn(), data: { tabs: [], archived: [], active: null, outbox: [] } as WorkspaceDisk }));
vi.mock('../../../src/db/connection.js', () => ({ getDataDir: () => mocks.root, getDb: mocks.db }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
import { createAnalysis } from '../../../src/db/ai-queries.js';
import { createAttachment } from '../../../src/db/attachment-queries.js';
import { addAnnotation, addReviewFile, createReview, getReview, getReviewFiles } from '../../../src/db/queries.js';
import { finishDeletion } from '../../../src/workspace/deletion.js';
import { discardTabData } from '../../../src/workspace/discard.js';
import { repositoryCache } from '../../../src/workspace/object-cache.js';
import { workspaceRoutes } from '../../../src/workspace/routes.js';
import type { AppEnv } from '../../../src/types.js';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(number = 1, root = join(mocks.root, 'workspaces', `example-project-${number}`)) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q'); writeFileSync(join(root, 'file.ts'), 'source\n'); git(root, 'add', 'file.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'source');
  const head = git(root, 'rev-parse', 'HEAD'), branch = git(root, 'branch', '--show-current');
  git(root, 'checkout', '--detach', head); git(root, 'branch', '-D', branch);
  const review = await createReview(root, 'project', `range:${head}..${head}`);
  const tab = PullTabSchema.parse({ key: `example/project#${number}`, ref: { owner: 'example', repo: 'project', number, url: '' },
    repoRoot: root, reviewId: review.id, info: null, reviewedHead: head, reviewedBase: head });
  mocks.data.tabs.push(tab); return tab;
}
beforeAll(async () => { mocks.db.mockResolvedValue(await setupTestDb()); });
afterAll(teardownTestDb);
beforeEach(() => { mocks.root = realpathSync(mkdtempSync(join(tmpdir(), 'rev-discard-'))); mocks.data = { tabs: [], archived: [], active: null, outbox: [] }; });
afterEach(() => { rmSync(mocks.root, { recursive: true, force: true }); });

it('deletes review files, annotations, attachment bytes, analysis and exports while preserving an attached user clone', async () => {
  const tab = await fixture(1, join(mocks.root, 'user-clone'));
  const file = await addReviewFile(tab.reviewId!, 'file.ts', '{}');
  const annotation = await addAnnotation(file.id, 1, 'new', 'note', 'private');
  const attachment = join(mocks.root, 'attachment'); writeFileSync(attachment, 'private bytes');
  await createAttachment({ annotationId: annotation.id, originalFilename: 'bytes', storedPath: attachment, mimeType: 'text/plain', size: 13, sha256: null });
  await createAnalysis(tab.reviewId!, 'narrative');
  const exports = join(tab.repoRoot!, '.glassbox'); mkdirSync(exports);
  for (const ext of ['md', 'json']) writeFileSync(join(exports, `review-${tab.reviewId}.${ext}`), 'private export');
  writeFileSync(join(exports, 'latest-review.md'), 'private latest');
  writeFileSync(join(exports, 'latest-review.json'), JSON.stringify({ review: { id: tab.reviewId } }));
  await discardTabData(tab);
  expect(await getReview(tab.reviewId!)).toBeUndefined(); expect(await getReviewFiles(tab.reviewId!)).toEqual([]);
  expect((await (await mocks.db()).query('SELECT * FROM ai_analyses WHERE review_id=$1', [tab.reviewId])).rows).toEqual([]);
  expect(existsSync(attachment)).toBe(false); expect(existsSync(join(exports, 'latest-review.md'))).toBe(false);
  expect(existsSync(join(exports, `review-${tab.reviewId}.json`))).toBe(false);
  expect(git(tab.repoRoot!, 'show', 'HEAD:file.ts')).toBe('source');
});
it('removes a clean checkout and its detached agent worktree immediately', async () => {
  const tab = await fixture();
  const root = join(mocks.root, 'agents', 'job');
  git(tab.repoRoot!, 'worktree', 'add', '--detach', root, tab.reviewedHead);
  tab.comments.push(ThreadMessageSchema.parse({ id: 'job', kind: 'ai', body: '', author: 'AI', date: '', status: 'done', workspaceSafeHead: tab.reviewedHead }));
  await discardTabData(tab);
  expect(existsSync(root)).toBe(false); expect(existsSync(tab.repoRoot!)).toBe(false);
  expect(await getReview(tab.reviewId!)).toBeUndefined();
});
it('retains borrowed Git objects without repacking even with a broken cache ref before deleting a provider so an open PR keeps working', async () => {
  const provider = await fixture();
  const borrower = await fixture(2); rmSync(borrower.repoRoot!, { recursive: true });
  git(mocks.root, 'clone', '--shared', provider.repoRoot!, borrower.repoRoot!);
  expect(existsSync(join(borrower.repoRoot!, '.git/objects/info/alternates'))).toBe(true);
  borrower.reviewedHead = provider.reviewedHead; borrower.reviewedBase = provider.reviewedBase;
  mkdirSync(join(borrower.repoRoot!, '.git/refs/glassbox/cache'), { recursive: true });
  writeFileSync(join(borrower.repoRoot!, '.git/refs/glassbox/cache/broken'), 'a'.repeat(40) + '\n');
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', provider.reviewId!); await next(); }).route('/workspace', workspaceRoutes);
  const response = await app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'close', key: provider.key }) });
  await finishDeletion(provider.key);
  expect(response.status).toBe(200);
  expect((await response.json()).tabs.map((tab: { key: string }) => tab.key)).toEqual([borrower.key]);
  expect(existsSync(provider.repoRoot!)).toBe(false);
  expect(readFileSync(join(borrower.repoRoot!, '.git/objects/info/alternates'), 'utf8')).toContain(join(mocks.root, 'git-cache/legacy-'));
  expect(git(borrower.repoRoot!, 'show', `${borrower.reviewedBase}:file.ts`)).toBe('source');
  expect(await getReview(borrower.reviewId!)).toBeDefined();
  await discardTabData(borrower);
  expect(readdirSync(join(mocks.root, 'git-cache'))).toEqual([]);
});
it.each(['dirty', 'untracked', 'commit', 'branch', 'symlink'])('refuses to silently discard %s work', async kind => {
  const tab = await fixture(), root = tab.repoRoot!;
  if (kind === 'dirty') writeFileSync(join(root, 'file.ts'), 'unpublished');
  if (kind === 'untracked') writeFileSync(join(root, 'notes.txt'), 'unpublished');
  if (kind === 'commit') {
    writeFileSync(join(root, 'file.ts'), 'unpublished'); git(root, 'add', 'file.ts');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local');
  }
  if (kind === 'branch') git(root, 'branch', 'user-work');
  if (kind === 'symlink') {
    const user = join(mocks.root, 'user'); git(mocks.root, 'clone', root, user); rmSync(root, { recursive: true }); symlinkSync(user, root);
  }
  await expect(discardTabData(tab)).rejects.toThrow();
  expect(existsSync(root)).toBe(true); expect(await getReview(tab.reviewId!)).toBeDefined();
});
it('deletes database data even if the managed checkout has already expired', async () => {
  const tab = await fixture(); rmSync(tab.repoRoot!, { recursive: true }); tab.checkoutEvicted = true;
  await discardTabData(tab); expect(await getReview(tab.reviewId!)).toBeUndefined();
});

it('discards generated review exports inside its owned checkout', async () => {
  const tab = await fixture();
  writeFileSync(join(tab.repoRoot!, '.git/info/exclude'), '/.glassbox/\n');
  mkdirSync(join(tab.repoRoot!, '.glassbox'));
  writeFileSync(join(tab.repoRoot!, '.glassbox', 'latest-review.md'), 'Generated review export');
  await discardTabData(tab);
  expect(existsSync(tab.repoRoot!)).toBe(false); expect(await getReview(tab.reviewId!)).toBeUndefined();
});

it.each(['missing-git', 'reinitialized-git'])('closes a partially removed snapshot through HTTP (%s)', async kind => {
  const tab = await fixture(), root = tab.repoRoot!;
  const cache = await repositoryCache(tab.ref);
  git(cache, 'fetch', root, `${tab.reviewedHead}:refs/glassbox/cache/${tab.reviewedHead}`);
  tab.checkoutEvicted = true;
  rmSync(join(root, '.git'), { recursive: true });
  if (kind === 'reinitialized-git') git(root, 'init', '-q');
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', tab.reviewId!); await next(); }).route('/workspace', workspaceRoutes);
  const response = await app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'close', key: tab.key }) });
  await finishDeletion(tab.key);
  expect(response.status).toBe(200); expect((await response.json()).tabs).toEqual([]);
  expect(existsSync(root)).toBe(false); expect(await getReview(tab.reviewId!)).toBeUndefined();
});
it.each(['no-marker', 'modified', 'extra', 'branch', 'staged'])('does not discard unproven interrupted work (%s)', async kind => {
  const tab = await fixture(), root = tab.repoRoot!;
  const cache = await repositoryCache(tab.ref);
  git(cache, 'fetch', root, `${tab.reviewedHead}:refs/glassbox/cache/${tab.reviewedHead}`);
  tab.checkoutEvicted = kind !== 'no-marker';
  rmSync(join(root, '.git'), { recursive: true }); git(root, 'init', '-q');
  if (kind === 'modified') writeFileSync(join(root, 'file.ts'), 'unpublished');
  if (kind === 'extra') writeFileSync(join(root, 'personal.txt'), 'personal');
  if (kind === 'staged') {
    writeFileSync(join(root, 'file.ts'), 'staged work'); git(root, 'add', 'file.ts');
    writeFileSync(join(root, 'file.ts'), 'source\n');
  }
  if (kind === 'branch') { git(root, 'fetch', cache, tab.reviewedHead); git(root, 'branch', 'saved', tab.reviewedHead); }
  await expect(discardTabData(tab)).rejects.toThrow();
  expect(existsSync(root)).toBe(true); expect(await getReview(tab.reviewId!)).toBeDefined();
});

it.each(['imported', 'rename', 'unstaged', 'staged', 'untracked', 'ignored', 'branch', 'unpublished-head', 'assume-unchanged', 'skip-worktree'])('closes and deletes app-owned source regardless of its local state (%s)', async kind => {
  const tab = await fixture(), root = tab.repoRoot!, old = tab.reviewedHead;
  const cache = await repositoryCache(tab.ref);
  if (kind === 'rename') git(root, 'mv', 'file.ts', 'renamed.ts');
  else writeFileSync(join(root, 'file.ts'), 'new published snapshot\n');
  writeFileSync(join(root, 'added.ts'), 'published addition\n'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'new snapshot');
  const imported = git(root, 'rev-parse', 'HEAD');
  git(cache, 'fetch', root, `${imported}:refs/glassbox/cache/${imported}`);
  // Interrupted refresh: index/files are newer than HEAD and the saved review revision.
  git(root, 'update-ref', '--no-deref', 'HEAD', old);
  if (kind === 'unstaged' || kind === 'staged') writeFileSync(join(root, 'file.ts'), 'unpublished edit');
  if (kind === 'staged') git(root, 'add', 'file.ts');
  if (kind === 'untracked' || kind === 'ignored') writeFileSync(join(root, 'private.txt'), 'personal');
  if (kind === 'ignored') writeFileSync(join(root, '.git/info/exclude'), 'private.txt\n');
  if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
    git(root, 'update-index', `--${kind}`, 'file.ts'); writeFileSync(join(root, 'file.ts'), 'hidden private edit');
  }
  if (kind === 'branch') git(root, 'branch', 'local-work');
  if (kind === 'unpublished-head') {
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unpublished history');
  }
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', tab.reviewId!); await next(); }).route('/workspace', workspaceRoutes);
  const response = await app.request('/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'close', key: tab.key }) });
  expect(response.status).toBe(200);
  expect(mocks.data.tabs).toEqual([]);
  await finishDeletion(tab.key);
  expect(existsSync(root)).toBe(false);
  expect(await getReview(tab.reviewId!)).toBeUndefined();
});
