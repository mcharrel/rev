import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PullTab } from '../api/workspace.js';
import { gitAsync, gitAuthEnv } from './checkout.js';

const remote = (tab: PullTab) => `https://github.com/${tab.ref.owner}/${tab.ref.repo}.git`;
const localUpload = '--upload-pack=git -c uploadpack.allowFilter=true upload-pack';

async function missingObjects(objects: string[], cache: string): Promise<string[]> {
  if (objects.length === 0) return [];
  const result = await gitAsync(['cat-file', '--batch-check=%(objectname) %(objecttype)'], cache, undefined, objects.join('\n') + '\n');
  return result.split('\n').filter(line => line.endsWith(' missing')).map(line => line.split(' ')[0]);
}

/** Copy only commit/tree metadata; a shallow full fetch still downloads the entire monorepo. */
export async function loadSnapshotObjects(tab: PullTab, cache: string, commits: string[], source?: string): Promise<void> {
  let needed = await missingObjects([...new Set(commits)], cache);
  if (needed.length && source !== undefined) {
    const absent = new Set(await missingObjects(needed, source));
    const available = needed.filter(sha => !absent.has(sha));
    if (available.length) await gitAsync(['fetch', '--no-tags', '--no-auto-maintenance', '--depth=1', '--filter=blob:none', localUpload,
      pathToFileURL(source).href, ...available.map(sha => `${sha}:refs/glassbox/cache/${sha}`)], cache).catch(() => {});
    needed = await missingObjects(needed, cache);
  }
  if (needed.length) await gitAsync(['fetch', '--no-tags', '--no-auto-maintenance', '--depth=1', '--filter=blob:none', remote(tab),
    ...needed.map(sha => `${sha}:refs/glassbox/cache/${sha}`)], cache, await gitAuthEnv(tab));
}

/** Fetch changed blobs in batches and check out complete changed files, without unrelated source. */
export async function sparseSnapshot(tab: PullTab, root: string, cache: string, base: string, head: string, source?: string): Promise<void> {
  const raw = (await gitAsync(['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-abbrev', base, head], cache)).split('\0');
  const objects = new Set<string>(), paths = new Set<string>();
  for (let i = 0; i < raw.length - 1; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) [A-Z]$/.exec(raw[i]);
    if (!match) throw new Error('Invalid changed-file metadata');
    paths.add(raw[i + 1]);
    for (const [mode, sha] of [[match[1], match[3]], [match[2], match[4]]])
      if (/^(100|120)/.test(mode)) objects.add(sha);
  }
  await loadSnapshotBlobs(tab, cache, [...objects], source);
  // Literal non-cone patterns include filenames with glob metacharacters; an empty diff checks out nothing.
  const patterns = ['!/*', ...[...paths].map(path => '/' + path.replace(/[\\*?[\]#! ]/g, '\\$&'))];
  await writeFile(join(root, '.git', 'info', 'sparse-checkout'), patterns.join('\n') + '\n');
  await gitAsync(['config', 'core.sparseCheckout', 'true'], root);
  await gitAsync(['config', 'core.sparseCheckoutCone', 'false'], root);
}

/** Explicit wants plus refetch avoid negotiating away blobs missing from an existing shallow commit. */
export async function loadSnapshotBlobs(tab: PullTab, cache: string, objects: string[], source?: string): Promise<void> {
  const needed = await missingObjects(objects, cache);
  for (let i = 0; i < needed.length; i += 256) {
    let batch = needed.slice(i, i + 256);
    if (source !== undefined) {
      const absent = new Set(await missingObjects(batch, source));
      const available = batch.filter(sha => !absent.has(sha));
      if (available.length) await gitAsync(['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--refetch', '--filter=blob:none', localUpload,
        pathToFileURL(source).href, ...available], cache).catch(() => {});
      batch = await missingObjects(batch, cache);
    }
    if (batch.length) await gitAsync(['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--refetch', '--filter=blob:none',
      remote(tab), ...batch], cache, await gitAuthEnv(tab));
  }
}
