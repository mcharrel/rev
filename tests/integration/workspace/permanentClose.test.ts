import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PullTabSchema, ThreadMessageSchema } from '../../../src/api/workspace.js';

const mocks = vi.hoisted(() => ({ root: '', discard: vi.fn() }));
vi.mock('../../../src/db/connection.js', () => ({ getDataDir: () => mocks.root }));
vi.mock('../../../src/workspace/discard.js', () => ({ discardTabData: mocks.discard }));
afterEach(() => { rmSync(mocks.root, { recursive: true, force: true }); });

it('persists closure before cleanup, survives failure/restart, retries and forgets the cleanup record', async () => {
  mocks.root = mkdtempSync(join(tmpdir(), 'rev-permanent-close-'));
  vi.resetModules();
  const { workspaceData, saveWorkspace } = await import('../../../src/workspace/storage.js');
  const { queueDeletion, finishDeletion } = await import('../../../src/workspace/deletion.js');
  const tab = PullTabSchema.parse({ key: 'example/project#1', ref: { owner: 'example', repo: 'project', number: 1, url: '' },
    reviewId: 'review', repoRoot: '/test', info: null, codexThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    comments: [ThreadMessageSchema.parse({ id: 'job', body: 'private conversation', author: 'alice', kind: 'ai', status: 'working', date: '' })],
  });
  const data = workspaceData(); data.tabs = [tab]; data.active = tab.key;
  saveWorkspace();
  const fail = new Error('Temporary filesystem error');
  mocks.discard.mockRejectedValue(fail);
  data.tabs = []; data.active = null;
  queueDeletion(tab);
  // Disk already excludes the tab before the asynchronous deletion starts.
  const saved = JSON.parse(readFileSync(join(mocks.root, 'workspace.json'), 'utf8'));
  expect(saved.tabs).toEqual([]); expect(saved.active).toBeNull();
  expect(saved.hasOpenedPullRequest).toBe(true);
  expect(saved.pendingDeletes).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain('private conversation');
  expect(JSON.stringify(saved)).not.toContain(tab.codexThreadId);
  await expect(finishDeletion(tab.key)).rejects.toThrow(fail);
  expect(workspaceData().tabs).toEqual([]);
  vi.resetModules();
  const restarted = await import('../../../src/workspace/storage.js');
  const cleanup = await import('../../../src/workspace/deletion.js');
  expect(restarted.workspaceData().tabs).toEqual([]);
  expect(restarted.workspaceData().pendingDeletes).toHaveLength(1);
  mocks.discard.mockResolvedValue(undefined);
  cleanup.retryDeletions();
  await cleanup.finishDeletion(tab.key);
  expect(restarted.workspaceData().tabs).toEqual([]);
  expect(restarted.workspaceData().pendingDeletes).toEqual([]);
  expect(JSON.parse(readFileSync(join(mocks.root, 'workspace.json'), 'utf8')).pendingDeletes).toEqual([]);
});
