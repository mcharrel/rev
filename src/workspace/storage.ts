import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { PullTabSchema, WorkspaceSchema } from '../api/workspace.js';
import { getDataDir } from '../db/connection.js';

export const OutboxItemSchema = z.object({
  id: z.string(),
  tab: z.string(),
  message: z.string(),
  operation: z.enum(['create', 'edit', 'delete']),
  nextAttempt: z.number().default(0),
  attempted: z.boolean().default(false),
});
export const PendingDeletionSchema = PullTabSchema.pick({ key: true, ref: true, reviewId: true, repoRoot: true }).extend({
  agents: z.array(z.string()),
});
export type PendingDeletion = z.infer<typeof PendingDeletionSchema>;
const DiskSchema = WorkspaceSchema.extend({
  outbox: z.array(OutboxItemSchema).default([]),
  archived: z.array(PullTabSchema).default([]),
  pendingDeletes: z.array(PendingDeletionSchema).optional(),
  hasOpenedPullRequest: z.boolean().optional(),
});
export type WorkspaceDisk = z.infer<typeof DiskSchema>;
let loaded: { path: string; data: WorkspaceDisk } | null = null;
export function workspaceData(): WorkspaceDisk {
  const root = getDataDir();
  if (root === null) throw new Error('Review storage is not initialized');
  const path = join(root, 'workspace.json');
  if (loaded?.path === path) return loaded.data;
  let data: WorkspaceDisk = {
    tabs: [],
    active: null,
    outbox: [],
    archived: [],
  };
  try {
    data = DiskSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  data.hasOpenedPullRequest ||= data.tabs.length > 0 || data.archived.length > 0;
  loaded = { path, data };
  return data;
}
export function saveWorkspace(): void {
  workspaceData();
  if (!loaded) return;
  loaded.data.hasOpenedPullRequest ||= loaded.data.tabs.length > 0 || loaded.data.archived.length > 0;
  const root = getDataDir();
  if (root === null) throw new Error('Storage unavailable');
  mkdirSync(root, { recursive: true });
  writeFileSync(`${loaded.path}.tmp`, JSON.stringify(loaded.data), {
    mode: 0o600,
  });
  renameSync(`${loaded.path}.tmp`, loaded.path);
}
