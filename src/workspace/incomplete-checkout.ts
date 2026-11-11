import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { gitAsync } from './checkout.js';

/** Preserve unfinished source files, including unknown work, before retrying an initial checkout. */
export async function preserveIncompleteCheckout(root: string, data: string): Promise<string | null> {
  const owned = join(await realpath(data), 'workspaces', basename(root));
  const git = join(root, '.git');
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== owned
    || !(await lstat(git)).isDirectory() || await realpath(git) !== join(owned, '.git')) return null;
  for (const name of ['index', 'index.lock', 'modules', 'worktrees']) {
    const exists = await lstat(join(git, name)).then(() => true, (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) return null;
  }
  if (await gitAsync(['rev-parse', '--verify', 'HEAD'], root).then(() => true, () => false)) return null;
  if ((await gitAsync(['for-each-ref', '--format=%(refname)'], root)).trim()) return null;
  const recovery = join(await realpath(data), 'checkout-recovery');
  await mkdir(recovery, { recursive: true });
  if (!(await lstat(recovery)).isDirectory() || await realpath(recovery) !== recovery) return null;
  const group = join(recovery, basename(root));
  await mkdir(group, { recursive: true });
  if (!(await lstat(group)).isDirectory() || await realpath(group) !== group) return null;
  const backup = join(group, randomUUID());
  await mkdir(backup);
  // Leave Git objects in place: another legacy checkout may still borrow them.
  for (const entry of await readdir(root)) if (entry !== '.git') await rename(join(root, entry), join(backup, entry));
  console.warn(`Preserved incomplete review checkout at ${backup}; retrying source import.`);
  return backup;
}
