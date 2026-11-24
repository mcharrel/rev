/**
 * GB-808 — the Sponsor button (and any external link) did nothing in the
 * Tauri desktop app. The link was a bare `<a target="_blank">`, but inside
 * the Tauri webview a `_blank` navigation never reaches a real browser, so
 * the click was silently dropped. The fix routes external links through the
 * server's `/open-external` endpoint (which shells out to the OS "open"
 * handler) when running under Tauri, while leaving the anchor's default
 * behavior untouched in a plain browser.
 *
 * These tests pin the JS half of that contract — `openExternalUrl()`:
 *   - in a plain browser (no `window.__TAURI__`) it returns `false`, so the
 *     caller does NOT `preventDefault()` and the anchor opens normally;
 *   - inside Tauri it POSTs to `/open-external` with the URL and returns
 *     `true`, so the caller suppresses the dead `_blank` navigation.
 *
 * The real network call + OS open aren't reachable from vitest, so we mock
 * the typed `openExternal` API caller and assert the dispatch decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../../../src/client/toast.js', () => ({ showToast: showToastMock }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const openExternalMock = vi.fn<(req: { url: string }) => Promise<{ ok: true }>>();
vi.mock('../../../src/api/system.js', async original => ({
  ...await original<typeof import('../../../src/api/system.js')>(),
  openExternal: (req: { url: string }) => openExternalMock(req),
}));

const { openExternalUrl } = await import('../../../src/client/tauri.js');

afterEach(() => {
  vi.unstubAllGlobals();
  openExternalMock.mockReset();
  showToastMock.mockReset();
});

describe('openExternalUrl (GB-808)', () => {
  it.each(['/history', '#section', 'javascript:alert(1)', 'file:///tmp/source'])('keeps internal/unsupported links out of the native opener (%s)', url => {
    vi.stubGlobal('window', { __TAURI__: {} });
    expect(openExternalUrl(url)).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
  it('returns false and does not dispatch when not running inside Tauri (no window)', () => {
    // Node test env: `window` is undefined. The helper must treat this as
    // "plain browser" rather than throwing a ReferenceError.
    expect(openExternalUrl('https://github.com/sponsors/brianwestphal')).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('returns false when window exists but has no __TAURI__ global', () => {
    vi.stubGlobal('window', {});
    expect(openExternalUrl('https://github.com/sponsors/brianwestphal')).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('POSTs to open-external with the url and returns true inside Tauri', () => {
    openExternalMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { __TAURI__: {} });

    const url = 'https://github.com/sponsors/brianwestphal';
    const handled = openExternalUrl(url);

    expect(handled).toBe(true);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith({ url });
  });

  it('still reports handled when the request rejects (caller already preventDefault-ed)', async () => {
    // Fire-and-forget: a rejected open must not flip the return value nor
    // surface as an unhandled rejection (the helper attaches a .catch).
    openExternalMock.mockRejectedValue(new Error('boom'));
    vi.stubGlobal('window', { __TAURI__: {} });

    expect(openExternalUrl('https://example.com')).toBe(true);
    expect(openExternalMock).toHaveBeenCalledWith({ url: 'https://example.com' });
    await tick();
    expect(showToastMock).toHaveBeenCalledWith('Could not open the link.');
  });
});

it('uses the native browser bypass so an explicit GitHub link cannot loop into rev', async () => {
  const invoke = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } });
  const url = 'https://github.com/example/repo/pull/1';
  expect(openExternalUrl(url)).toBe(true);
  await tick();
  expect(invoke).toHaveBeenCalledWith('open_link_in_browser', { url });
  expect(openExternalMock).not.toHaveBeenCalled();
});
it('uses the usual OS opener on native platforms without the PR router', async () => {
  const invoke = vi.fn().mockResolvedValue(false);
  openExternalMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } });
  expect(openExternalUrl('https://example.com')).toBe(true);
  await tick();
  expect(openExternalMock).toHaveBeenCalledWith({ url: 'https://example.com' });
});
it('reports native browser failure without falling back into the PR router', async () => {
  const invoke = vi.fn().mockRejectedValue(new Error('unavailable'));
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } });
  expect(openExternalUrl('https://github.com/example/repo/pull/1')).toBe(true);
  await tick();
  expect(openExternalMock).not.toHaveBeenCalled();
  expect(showToastMock).toHaveBeenCalledWith('Could not open the browser.');
});
