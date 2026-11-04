import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

export const ConnectionSchema = z.object({
  port: z.number().int().min(1).max(65535), token: z.string().length(64),
});
export const CodexOpenSchema = z.object({ url: z.string(), threadId: z.uuid().optional() });
export const CodexCommentSchema = z.object({
  url: z.string(), threadId: z.uuid(), commentId: z.string().min(1), revision: z.number().int().positive().default(1),
});
export const CodexReplySchema = CodexCommentSchema.extend({ body: z.string().trim().min(1).max(50000) });
export const CodexCommentsSchema = z.object({ url: z.string(), threadId: z.uuid() });
export const controlPath = () => {
  // Isolated app servers must not replace the desktop's agent-control registration.
  const isolated = (process.env.GLASSBOX_CONFIG_DIR?.trim() ?? '') !== '' ? process.env.GLASSBOX_CONFIG_DIR : undefined;
  return join(process.env.REV_CONFIG_DIR ?? isolated ?? join(homedir(), '.local', 'share', 'rev'), 'connection.json');
};
let token = '';
export function authorizeControl(value: string | undefined): boolean {
  return Boolean(token) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
export function registerControl(port: number): () => void {
  token = randomBytes(32).toString('hex');
  const path = controlPath();
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ port, token }), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  const registered = token;
  return () => {
    try {
      if (ConnectionSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).token === registered) rmSync(path);
    } catch { /* Another instance may already have replaced the registration. */ }
  };
}
