import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { setDataDir } from './db/connection.js';
import { createReview, getLatestInProgressReview } from './db/queries.js';
import { startServer } from './server.js';
import { CodexCommentSchema, CodexCommentsSchema, CodexReplySchema, ConnectionSchema, controlPath } from './workspace/control.js';
import { parsePullUrl } from './workspace/github.js';

async function openPull(url: string): Promise<void> {
  const ref = parsePullUrl(url);
  const threadId = process.env.CODEX_THREAD_ID;
  const opened = { linked: false };
  if (threadId !== undefined) z.uuid().parse(threadId);
  const request = async (): Promise<boolean> => {
    let connection: z.infer<typeof ConnectionSchema>;
    try { connection = ConnectionSchema.parse(JSON.parse(readFileSync(controlPath(), 'utf8'))); }
    catch { return false; }
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${connection.port}/api/workspace/codex-open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rev-token': connection.token },
        body: JSON.stringify({ url: ref.url, threadId }), signal: AbortSignal.timeout(5000),
      });
    } catch { return false; }
    if (!response.ok) throw new Error(`rev could not open the PR (${response.status}): ${await response.text()}`);
    opened.linked = z.object({ linked: z.boolean() }).parse(await response.json()).linked;
    return true;
  };
  if (!await request()) {
    const launcher = process.env.REV_DESKTOP_LAUNCHER;
    const child = launcher !== undefined ? spawn(launcher, [], { detached: true, stdio: 'ignore' })
      : spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--no-open'], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* The readiness check below reports startup failure. */ });
    child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (await request()) { ready = true; break; }
    }
    if (!ready) throw new Error('rev did not start. Run rev serve to see the startup error.');
  }
  console.log(`Opened ${ref.url}${opened.linked ? ' and linked the originating Codex chat' : ''}.`);
}
async function commentCommand(args: string[]): Promise<void> {
  const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const command = args[0];
  const common = { url: args[1], threadId: process.env.CODEX_THREAD_ID };
  const comment = { ...common, commentId: value('--comment'),
    revision: value('--revision') === undefined ? 1 : Number(value('--revision')) };
  const file = value('--body-file');
  if (command === 'reply' && (file === undefined || file === '')) throw new Error('Use rev reply <PR URL> --comment <ID> --revision <N> --body-file <FILE or ->');
  const input = command === 'comments' ? CodexCommentsSchema.parse(common)
    : command === 'pickup' ? CodexCommentSchema.parse(comment)
    : CodexReplySchema.parse({ ...comment, body: readFileSync(file === '-' ? 0 : file ?? '', 'utf8') });
  const connection = ConnectionSchema.parse(JSON.parse(readFileSync(controlPath(), 'utf8')));
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}/api/workspace/codex-${command}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rev-token': connection.token },
      body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
    });
  } catch (cause) {
    throw new Error(`Cannot reach rev on port ${connection.port}. Open or restart rev, then retry this command.`, { cause });
  }
  if (!response.ok) throw new Error(`rev ${command} failed: ${await response.text()}`);
  if (command === 'comments') console.log(JSON.stringify(await response.json(), null, 2));
  else console.log(command === 'pickup' ? 'Comment picked up in rev.' : 'Reply posted in rev; comment marked answered.');
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (['comments', 'pickup', 'reply'].includes(args[0])) { await commentCommand(args); return; }
  if (args[0] === 'open' && args[1]) { await openPull(args[1]); return; }
  if (args.length && args[0] !== 'serve') {
    console.log('rev serve [--no-open]\nrev open <GitHub PR URL>\nrev comments <PR URL>\nrev pickup <PR URL> --comment <ID> --revision <N>\nrev reply <PR URL> --comment <ID> --revision <N> --body-file <FILE or ->\n\nInside a Codex chat, rev open links comments to that chat automatically.');
    return;
  }
  const root = process.env.REV_DATA_DIR ?? join(homedir(), '.local', 'share', 'rev', 'workspace');
  mkdirSync(root, { recursive: true });
  setDataDir(root);
  const review = await getLatestInProgressReview(root, 'workspace') ?? await createReview(root, 'rev', 'workspace');
  await startServer(4183, review.id, root, { noOpen: args.includes('--no-open'), strictPort: true });
}
const entry = process.argv[1];
if (entry && existsSync(entry) && dirname(realpathSync(entry)) === dirname(fileURLToPath(import.meta.url))
  && /(?:^|\/)rev\.(?:js|ts)$/.test(realpathSync(entry))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'rev failed');
    process.exitCode = 1;
  });
}
