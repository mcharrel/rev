import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PullTabSchema } from '../../../src/api/workspace.js';

const mocks = vi.hoisted(() => ({ dataDir: '', file: vi.fn(), find: vi.fn(), github: vi.fn() }));
vi.mock('../../../src/db/connection.js', () => ({ getDataDir: () => mocks.dataDir }));
vi.mock('../../../src/db/queries.js', () => ({ createReview: async () => ({ id: 'review' }), addReviewFile: mocks.file, updateReviewSource: vi.fn() }));
vi.mock('../../../src/review-update.js', () => ({ updateReviewDiffs: vi.fn() }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => ({ tabs: [] }) }));
vi.mock('../../../src/workspace/github.js', () => ({ githubToken: async () => 'fixture', github: mocks.github, repoApi: () => 'repos/example/project' }));
vi.mock('../../../src/workspace/repositories.js', () => ({ findLocalRepository: mocks.find }));
import { repositoryCache } from '../../../src/workspace/object-cache.js';
import { importPull } from '../../../src/workspace/checkout.js';

it('shares independent snapshots across PRs without modifying or depending on the user clone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glassbox-import-test-'));
  try {
    const remote = join(root, 'remote'); const source = join(root, 'source');
    mkdirSync(remote); mkdirSync(source); mocks.dataDir = join(root, 'data');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(remote, 'init', '-q'); git(remote, 'config', 'user.name', 'Test'); git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(remote, 'file.ts'), 'before\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'base');
    const base = git(remote, 'rev-parse', 'HEAD');
    git(source, 'init', '-q'); git(source, 'fetch', remote, base); git(source, 'checkout', '--detach', base);
    writeFileSync(join(source, 'file.ts'), 'user work\n');
    writeFileSync(join(remote, 'file.ts'), 'after\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'change');
    const head = git(remote, 'rev-parse', 'HEAD');
    mocks.find.mockResolvedValue(source); mocks.github.mockResolvedValue({ merge_base_commit: { sha: base } });
    const tab = PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: '' }, reviewId: null, repoRoot: source,
      info: { id: 'PR1', number: 1, url: '', title: 'Example', body: '', author: { login: 'test' }, state: 'OPEN', isDraft: false,
        baseRefName: 'main', headRefName: 'topic', baseRefOid: base, headRefOid: head, mergeable: 'MERGEABLE', mergedAt: null } });
    const cache = await repositoryCache(tab.ref);
    git(cache, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/example/project.git');
    const sourceRefs = git(source, 'show-ref', '--head');
    const sourceConfig = readFileSync(join(source, '.git/config'), 'utf8');
    // Focus returns during the fetch: keep the old source snapshot until later.
    const canApply = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    mocks.file.mockClear();
    await importPull(tab, canApply);
    expect(tab.reviewId).toBeNull(); expect(mocks.file).not.toHaveBeenCalled();
    const checkout = join(mocks.dataDir, 'workspaces/example-project-1');
    const hooks = join(root, 'hooks'); mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\ntouch generated-local-file\n', { mode: 0o755 });
    git(checkout, 'config', 'core.hooksPath', hooks);
    await importPull(tab);
    expect(existsSync(join(checkout, 'generated-local-file'))).toBe(false);
    expect(tab.reviewId).toBe('review');
    expect(readFileSync(join(source, 'file.ts'), 'utf8')).toBe('user work\n');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(source, 'show-ref', '--head')).toBe(sourceRefs);
    expect(readFileSync(join(source, '.git/config'), 'utf8')).toBe(sourceConfig);
    expect(readFileSync(join(tab.repoRoot!, 'file.ts'), 'utf8')).toBe('after\n');
    expect(mocks.file).toHaveBeenCalledWith('review', 'file.ts', expect.stringContaining('after'));
    const second = PullTabSchema.parse({ ...tab, key: 'example/project#2', ref: { ...tab.ref, number: 2 }, reviewId: null, repoRoot: null });
    const third = PullTabSchema.parse({ ...second, key: 'example/project#3', ref: { ...tab.ref, number: 3 } });
    await Promise.all([importPull(second), importPull(third)]);
    expect(readFileSync(join(second.repoRoot!, '.git/objects/info/alternates'), 'utf8').trim()).toBe(join(cache, 'objects'));
    rmSync(tab.repoRoot!, { recursive: true }); rmSync(source, { recursive: true }); rmSync(remote, { recursive: true });
    expect(git(second.repoRoot!, 'show', 'HEAD:file.ts')).toBe('after');
    expect(git(third.repoRoot!, 'show', `${base}:file.ts`)).toBe('before');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

it('uses the exact remote merge base for cold snapshots without downloading a history window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glassbox-cold-import-'));
  try {
    mocks.file.mockClear(); mocks.find.mockResolvedValue(undefined);
    const remote = join(root, 'remote'); mkdirSync(remote);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(remote, 'init', '-q'); git(remote, 'config', 'user.name', 'Test'); git(remote, 'config', 'user.email', 'test@example.com');
    git(remote, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(remote, 'file.ts'), 'before\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'common ancestor');
    const ancestor = git(remote, 'rev-parse', 'HEAD');
    writeFileSync(join(remote, 'base-only.ts'), 'not part of the PR\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'base advanced');
    const target = git(remote, 'rev-parse', 'HEAD');
    git(remote, 'checkout', '--detach', ancestor);
    writeFileSync(join(remote, 'file.ts'), 'after\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'PR change');
    const head = git(remote, 'rev-parse', 'HEAD');
    mocks.dataDir = join(root, 'data');
    const checkout = join(mocks.dataDir, 'workspaces/example-project-1'); mkdirSync(checkout, { recursive: true });
    git(checkout, 'init', '-q');
    mocks.github.mockResolvedValue({ merge_base_commit: { sha: ancestor } });
    const tab = PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: '' }, reviewId: null, repoRoot: null,
      info: { id: 'PR1', number: 1, url: '', title: 'Example', body: '', author: { login: 'test' }, state: 'OPEN', isDraft: false,
        baseRefName: 'main', headRefName: 'topic', baseRefOid: target, headRefOid: head, mergeable: 'MERGEABLE', mergedAt: null } });
    const cache = await repositoryCache(tab.ref);
    git(cache, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/example/project.git');
    await importPull(tab);
    expect(tab.reviewedBase).toBe(ancestor);
    expect(mocks.file.mock.calls.map(call => call[1])).toEqual(['file.ts']);
    expect(readFileSync(join(checkout, '.git/shallow'), 'utf8').split('\n')).toContain(head);
    expect(mocks.github).toHaveBeenCalledWith(tab.ref, `repos/example/project/compare/${target}...${head}?per_page=1`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);
