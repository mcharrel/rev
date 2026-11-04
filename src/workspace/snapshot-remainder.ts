import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { gitAsync } from './checkout.js';

/** An interrupted refresh can leave a complete imported index paired with the previous HEAD. */
export async function indexMatchesImportedSnapshot(root: string, cache: string): Promise<boolean> {
  try {
    // These index flags can hide local edits from git status; never use them as evidence of a clean snapshot.
    const files = await gitAsync(['ls-files', '-v', '-z'], root);
    if (files.split('\0').some(entry => /^[a-zS] /.test(entry))) return false;
    const tree = (await gitAsync(['write-tree'], root)).trim();
    const snapshots = await gitAsync(['for-each-ref', '--format=%(refname) %(objectname) %(tree)', 'refs/glassbox/cache/'], cache);
    return snapshots.split('\n').some(line => {
      const [ref, commit, snapshot] = line.split(' ');
      return ref === `refs/glassbox/cache/${commit}` && snapshot === tree;
    });
  } catch { return false; }
}

/** Prove that an interrupted deletion left only unchanged files from the saved snapshot. */
export async function isSnapshotRemainder(root: string, revision: string, repository: string): Promise<boolean> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) return false;
  const tree = await gitAsync(['ls-tree', '-rz', revision], repository);
  const entries = new Map<string, { mode: string; hash: string }>();
  for (const line of tree.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t'), [mode, type, hash] = line.slice(0, tab).split(' ');
    if (type === 'blob') entries.set(line.slice(tab + 1), { mode, hash });
  }
  const matches = async (directory: string, prefix = ''): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue;
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!await matches(path, `${name}/`)) return false;
        continue;
      }
      const saved = entries.get(name);
      if (!saved) return false;
      const stat = await lstat(path);
      const mode = stat.isSymbolicLink() ? '120000' : stat.isFile() ? (stat.mode & 0o111 ? '100755' : '100644') : '';
      if (mode !== saved.mode) return false;
      const link = mode === '120000' ? Buffer.from(await readlink(path)) : null;
      const hash = createHash(saved.hash.length === 64 ? 'sha256' : 'sha1');
      hash.update(`blob ${link?.length ?? stat.size}\0`);
      if (link) hash.update(link);
      else for await (const chunk of createReadStream(path)) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected snapshot file data');
        hash.update(chunk);
      }
      if (hash.digest('hex') !== saved.hash) return false;
    }
    return true;
  };
  return matches(root);
}
