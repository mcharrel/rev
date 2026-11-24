import { gitAsync } from './checkout.js';
import { closingTabs, readGitStorage, withCheckoutLock } from './lifecycle.js';
import { repositoryCache } from './object-cache.js';
import { findLocalRepository } from './repositories.js';
import { loadSnapshotBlobs } from './snapshot.js';
import { workspaceData } from './storage.js';

/** An existing user clone supplies symbol-search candidates without downloading unrelated PR files. */
export async function sourceRepository(root: string): Promise<string | undefined> {
  try {
    const tab = workspaceData().tabs.find(item => item.repoRoot === root && !closingTabs.has(item));
    return tab ? await findLocalRepository(tab.ref) : undefined;
  } catch { return undefined; } // Standalone local reviews need no PR workspace.
}

/** Read an omitted file at the reviewed revision on demand, never from a possibly newer user checkout. */
export async function readWorkspaceSource(root: string, path: string): Promise<string | null> {
  if (!path || /[\0\r\n]/.test(path) || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return null;
  const tab = workspaceData().tabs.find(item => item.repoRoot === root && item.reviewedHead !== '' && !closingTabs.has(item));
  if (!tab) return null;
  return readGitStorage(() => withCheckoutLock(tab.key, async () => {
    if (closingTabs.has(tab) || !workspaceData().tabs.includes(tab)) return null;
    const tree = await gitAsync(['ls-tree', '-z', tab.reviewedHead, '--', path], root);
    const entry = /^100\d{3} blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
    if (!entry || entry[2] !== path) return null;
    const cache = await repositoryCache(tab.ref);
    await loadSnapshotBlobs(tab, cache, [entry[1]], await findLocalRepository(tab.ref));
    return gitAsync(['show', entry[1]], cache);
  }));
}
