import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { preserveIncompleteCheckout } from '../../../src/workspace/incomplete-checkout.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'rev-incomplete-'))); roots.push(data);
  const root = join(data, 'workspaces', 'example-project-1'); mkdirSync(root, { recursive: true });
  git(root, 'init', '-q'); writeFileSync(join(root, 'file.ts'), '');
  return { data, root };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('preserves every byte of an incomplete checkout before allowing a fresh import', async () => {
  const { data, root } = fixture(); writeFileSync(join(root, 'notes'), 'unknown local work');
  const backup = await preserveIncompleteCheckout(root, data);
  expect(backup).toBeTruthy(); expect(readdirSync(root)).toEqual(['.git']);
  expect(readFileSync(join(backup!, 'file.ts'), 'utf8')).toBe('');
  expect(readFileSync(join(backup!, 'notes'), 'utf8')).toBe('unknown local work');
  expect(readFileSync(join(root, '.git/HEAD'), 'utf8')).toContain('ref:');
});
it.each(['index', 'index-lock', 'head', 'branch', 'modules', 'worktrees', 'root-link', 'git-link', 'recovery-link', 'group-link'])('does not relocate %s state', async kind => {
  const { data, root } = fixture();
  if (['index', 'head', 'branch'].includes(kind)) git(root, 'add', 'file.ts');
  if (kind === 'index-lock') writeFileSync(join(root, '.git/index.lock'), 'active import');
  if (kind === 'head' || kind === 'branch') {
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local work');
    if (kind === 'branch') { rmSync(join(root, '.git/index')); git(root, 'symbolic-ref', 'HEAD', 'refs/heads/unborn'); }
  }
  if (kind === 'modules' || kind === 'worktrees') mkdirSync(join(root, '.git', kind));
  if (kind.endsWith('-link')) {
    const outside = join(data, 'outside'); mkdirSync(outside);
    if (kind === 'root-link') { rmSync(root, { recursive: true }); symlinkSync(outside, root); }
    if (kind === 'git-link') { rmSync(join(root, '.git'), { recursive: true }); symlinkSync(outside, join(root, '.git')); }
    if (kind === 'recovery-link') symlinkSync(outside, join(data, 'checkout-recovery'));
    if (kind === 'group-link') { mkdirSync(join(data, 'checkout-recovery')); symlinkSync(outside, join(data, 'checkout-recovery', 'example-project-1')); }
  }
  expect(await preserveIncompleteCheckout(root, data)).toBeNull();
  expect(existsSync(root)).toBe(true);
  if (kind.endsWith('-link')) expect(readdirSync(join(data, 'outside'))).toEqual([]);
});
it('keeps shared Git objects at their original path while preserving unfinished source', async () => {
  const { data, root } = fixture();
  const source = join(data, 'source'); mkdirSync(source); git(source, 'init', '-q');
  writeFileSync(join(source, 'file.ts'), 'published\n'); git(source, 'add', '.');
  git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'snapshot');
  const head = git(source, 'rev-parse', 'HEAD'); git(root, 'fetch', source, head);
  const borrower = join(data, 'borrower'); mkdirSync(borrower); git(borrower, 'init', '-q');
  writeFileSync(join(borrower, '.git/objects/info/alternates'), join(root, '.git/objects') + '\n');
  expect(await preserveIncompleteCheckout(root, data)).not.toBeNull();
  expect(git(borrower, 'show', `${head}:file.ts`)).toBe('published');
});
