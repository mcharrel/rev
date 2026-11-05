import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { PullTabSchema, type WorkspaceMutation } from '../../../src/api/workspace.js';
import type { AppEnv } from '../../../src/types.js';
import type { WorkspaceDisk } from '../../../src/workspace/storage.js';
import { pullInfo } from '../../unit/workspace/fixtures.js';

const mocks = vi.hoisted(() => ({
  data: { tabs: [], archived: [], active: null, outbox: [] } as WorkspaceDisk,
  react: vi.fn(), load: vi.fn(), discard: vi.fn(),
}));
vi.mock('../../../src/workspace/accounts.js', () => ({ githubAccount: () => '', localWorkspaceConfig: () => ({ accounts: {}, slack: {}, repositories: {} }) }));
vi.mock('../../../src/workspace/storage.js', () => ({ workspaceData: () => mocks.data, saveWorkspace: vi.fn() }));
vi.mock('../../../src/workspace/slack-settings.js', () => ({ slackPreferences: () => ({ enabled: true, approvedEmoji: 'approved', changesEmoji: 'changes' }) }));
vi.mock('../../../src/workspace/slack-provider.js', () => ({ reactWithSlackProvider: mocks.react }));
vi.mock('../../../src/workspace/discard.js', () => ({ discardTabData: mocks.discard }));
vi.mock('../../../src/workspace/checkout.js', () => ({ importPull: vi.fn().mockResolvedValue(undefined), ensureCheckout: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/workspace/deployments.js', () => ({ refreshDeployment: vi.fn(), cancelDeployment: vi.fn(), stopDeployments: vi.fn() }));
vi.mock('../../../src/workspace/notifications.js', () => ({ notify: vi.fn() }));
vi.mock('../../../src/workspace/github.js', async original => ({
  ...await original<typeof import('../../../src/workspace/github.js')>(),
  loadPull: mocks.load, loadComments: vi.fn().mockResolvedValue([]),
  mutatePull: vi.fn().mockResolvedValue({ reviewer: 'alice', state: 'APPROVED' }),
}));
import { workspaceRoutes } from '../../../src/workspace/routes.js';
import { syncTab } from '../../../src/workspace/service.js';
import { stopSlackReactions } from '../../../src/workspace/slack-reactions.js';

afterEach(stopSlackReactions);
it('approves, switches and closes tabs through the API while Slack and GitHub reads are still pending', async () => {
  const tab = (number: number) => PullTabSchema.parse({
    key: `example/project#${number}`,
    ref: { owner: 'example', repo: 'project', number, url: `https://github.com/example/project/pull/${number}` },
    info: pullInfo('bob'), viewer: 'alice', reviewId: `review-${number}`, repoRoot: '/synthetic-checkout',
  });
  const first = tab(1), second = tab(2);
  mocks.data.tabs = [first, second]; mocks.data.active = first.key;
  const pendingReads: Array<() => void> = [];
  mocks.load.mockImplementation(() => new Promise(resolve => { pendingReads.push(() => resolve(pullInfo('bob'))); }));
  let finishSlack!: () => void;
  let slackSignal!: AbortSignal;
  mocks.react.mockImplementation((_settings, _url, _emoji, signal: AbortSignal) => new Promise<void>(resolve => {
    slackSignal = signal; finishSlack = resolve;
  }));
  const app = new Hono<AppEnv>().use('*', async (c, next) => { c.set('reviewId', 'review-1'); await next(); }).route('/workspace', workspaceRoutes);
  const request = (body: WorkspaceMutation) => app.request('/workspace', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  expect((await request({ op: 'action', key: first.key, action: 'approve' })).status).toBe(200);
  await vi.waitFor(() => expect(finishSlack).toBeDefined());
  const firstSync = syncTab(first), secondSync = syncTab(second, 'background');
  try {
    expect((await request({ op: 'select', key: second.key })).status).toBe(200);
    const closed = await request({ op: 'close', key: second.key });
    expect(closed.status).toBe(200);
    expect((await closed.json()).tabs.map((t: { key: string }) => t.key)).toEqual([first.key]);
    expect(first.slackReaction?.status).toBe('pending'); expect(slackSignal.aborted).toBe(false);
    expect((await request({ op: 'close', key: first.key })).status).toBe(200);
    expect(slackSignal.aborted).toBe(true); expect(mocks.data.tabs).toEqual([]);
    await vi.waitFor(() => expect(mocks.discard).toHaveBeenCalledTimes(2));
  } finally {
    pendingReads.forEach(finish => finish()); finishSlack();
    await Promise.all([firstSync, secondSync]);
  }
  expect((await (await app.request('/workspace')).json()).tabs).toEqual([]);
  expect(first.slackReaction).toBeUndefined();
});
