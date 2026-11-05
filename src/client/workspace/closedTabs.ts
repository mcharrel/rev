import { signal } from 'kerfjs';
import { z } from 'zod';

// Persist undelivered closes so a server outage or application restart cannot resurrect them.
const storageKey = 'rev-pending-tab-closes';
function read(): string[] {
  try { return z.array(z.string()).parse(JSON.parse(localStorage.getItem(storageKey) ?? '[]')); }
  catch { return []; }
}
export const closedTabs = signal<ReadonlySet<string>>(new Set());
export function pendingCloses(): string[] { return read(); }
export function rememberClose(key: string): void {
  closedTabs.value = new Set([...closedTabs.value, key]);
  try { localStorage.setItem(storageKey, JSON.stringify([...new Set([...read(), key])])); } catch { /* In-memory suppression still applies. */ }
}
export function acknowledgeClose(key: string): void {
  try { localStorage.setItem(storageKey, JSON.stringify(read().filter(item => item !== key))); } catch { /* Retry is idempotent. */ }
}
export function forgetClose(key: string): void {
  acknowledgeClose(key);
  closedTabs.value = new Set([...closedTabs.value].filter(item => item !== key));
}
