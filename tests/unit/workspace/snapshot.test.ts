import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PullTabSchema } from '../../../src/api/workspace.js';

const mocks = vi.hoisted(() => ({ root: '', source: undefined as string | undefined, github: vi.fn() }));
vi.mock('../../../src/db/connection.js', () => ({ getDataDir: () => mocks.root }));
vi.mock('../../../src/db/queries.js', () => ({ createReview: async () => ({ id: 'review' }), addReviewFile: vi.fn(), updateReviewSource: vi.fn() }));
vi.mock('../../../src/review-update.js', () => ({ updateReviewDiffs: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/github.js', () => ({ githubToken: async () => 'fixture', github: mocks.github, repoApi: () => 'repos/example/project' }));
vi.mock('../../../src/workspace/repositories.js', () => ({ findLocalRepository: async () => mocks.source }));
import { importPull } from '../../../src/workspace/checkout.js';
import { repositoryCache } from '../../../src/workspace/object-cache.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).trim();
function commit(root: string) { git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'snapshot'); return git(root, 'rev-parse', 'HEAD'); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(['changes', 'empty'])('loads only changed blobs with full file context (%s), then refreshes and restores', async kind => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rev-snapshot-'))); roots.push(dir);
  mocks.root = join(dir, 'data'); const source = join(dir, 'source'); mkdirSync(source); git(source, 'init', '-q');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(source, 'unrelated.ts'), 'unrelated file never downloaded\n');
  writeFileSync(join(source, 'changed [x].ts'), 'context before\nbefore\ncontext after\n');
  writeFileSync(join(source, 'renamed.ts'), 'function same() {}\n'); writeFileSync(join(source, 'deleted.ts'), 'removed\n');
  const base = commit(source), untouched = git(source, 'rev-parse', 'HEAD:unrelated.ts');
  if (kind === 'changes') {
    writeFileSync(join(source, 'changed [x].ts'), 'context before\nafter\ncontext after\n');
    git(source, 'mv', 'renamed.ts', 'new name.ts'); rmSync(join(source, 'deleted.ts'));
    writeFileSync(join(source, 'binary'), Buffer.from([0, 255, 1])); symlinkSync('changed [x].ts', join(source, 'link'));
  }
  const head = commit(source);
  const tab = PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: '' }, viewer: 'alice', reviewId: null, repoRoot: null,
    info: { id: 'pr', number: 1, url: '', title: 'Example', body: '', author: { login: 'alice' }, state: 'OPEN', isDraft: false,
      baseRefName: 'main', headRefName: 'topic', baseRefOid: base, headRefOid: head, mergeable: 'MERGEABLE', mergedAt: null } });
  mocks.github.mockResolvedValue({ merge_base_commit: { sha: base } });
  mocks.source = undefined; const cache = await repositoryCache(tab.ref);
  git(cache, 'config', `url.file://${source}.insteadOf`, 'https://github.com/example/project.git');
  // Use a saved revision to avoid any GitHub metadata reads in the real Git path.
  tab.checkoutEvicted = true; tab.reviewId = 'review'; tab.reviewedBase = base; tab.reviewedHead = head;
  const { ensureCheckout } = await import('../../../src/workspace/checkout.js');
  await ensureCheckout(tab);
  const root = tab.repoRoot!;
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(root, 'unrelated.ts'))).toBe(false);
  expect(() => git(cache, 'cat-file', '-e', untouched)).toThrow();
  if (kind === 'changes') {
    expect(readFileSync(join(root, 'changed [x].ts'), 'utf8')).toBe('context before\nafter\ncontext after\n');
    expect(git(root, 'show', `${base}:deleted.ts`)).toBe('removed');
    expect(readFileSync(join(root, 'binary'))).toEqual(Buffer.from([0, 255, 1]));
    expect(git(root, 'diff', '--find-renames', '--name-status', base, head)).toContain('R100\trenamed.ts\tnew name.ts');
  }
  rmSync(root, { recursive: true }); tab.checkoutEvicted = true;
  await ensureCheckout(tab); expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(root, 'unrelated.ts'))).toBe(false);
  // A later source update must not lose local edits in already materialized files.
  if (kind === 'changes') {
    writeFileSync(join(root, 'changed [x].ts'), 'unsent edits\n');
    await expect(importPull(tab)).rejects.toThrow('local changes');
    expect(readFileSync(join(root, 'changed [x].ts'), 'utf8')).toBe('unsent edits\n');
  }
}, 20000);
