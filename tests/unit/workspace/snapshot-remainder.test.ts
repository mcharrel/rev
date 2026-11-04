import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isSnapshotRemainder } from '../../../src/workspace/snapshot-remainder.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rev-remainder-')); roots.push(root);
  const repo = join(root, 'repo'), remainder = join(root, 'remainder'); mkdirSync(repo); mkdirSync(remainder);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'file'), 'published\n'); writeFileSync(join(repo, 'other'), 'other\n');
  symlinkSync('file', join(repo, 'link')); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'snapshot');
  return { repo, remainder, head: git(repo, 'rev-parse', 'HEAD') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('accepts empty, partial and complete unchanged remnants without reading symlink targets', async () => {
  const { repo, remainder, head } = fixture();
  expect(await isSnapshotRemainder(remainder, head, repo)).toBe(true);
  symlinkSync('file', join(remainder, 'link'));
  expect(await isSnapshotRemainder(remainder, head, repo)).toBe(true);
  writeFileSync(join(remainder, 'file'), 'published\n'); writeFileSync(join(remainder, 'other'), 'other\n');
  expect(await isSnapshotRemainder(remainder, head, repo)).toBe(true);
});
it.each(['modified', 'extra', 'mode', 'symlink', 'directory-link', 'unknown-revision'])('retains %s data rather than assuming it is disposable', async kind => {
  const { repo, remainder, head } = fixture();
  writeFileSync(join(remainder, 'file'), 'published\n');
  if (kind === 'modified') writeFileSync(join(remainder, 'file'), 'unpublished\n');
  if (kind === 'extra') writeFileSync(join(remainder, '.private-config'), 'personal');
  if (kind === 'mode') chmodSync(join(remainder, 'file'), 0o755);
  if (kind === 'symlink') symlinkSync('../repo/file', join(remainder, 'link'));
  if (kind === 'directory-link') symlinkSync(repo, join(remainder, 'dir'));
  expect(await isSnapshotRemainder(remainder, kind === 'unknown-revision' ? '' : head, repo)).toBe(false);
});
