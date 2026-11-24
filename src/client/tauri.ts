import { delegate } from 'kerfjs';

import { openExternal, OpenExternalReqSchema } from '../api/system.js';
import { asButton } from './dom.js';
import { showToast } from './toast.js';

interface TauriGlobal {
  core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: { listen: (name: string, cb: () => void) => Promise<() => void> | undefined };
}

/** Read the `window.__TAURI__` global (defined when running inside the
 *  Tauri shell, undefined in a plain browser). Centralized here so every
 *  caller doesn't repeat the cast-through-unknown pattern. */
export function getTauriGlobal(): TauriGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as Record<string, unknown>).__TAURI__ as TauriGlobal | undefined;
}

/** Convenience: returns the Tauri `invoke()` if available, otherwise `null`. */
export function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  return getTauriGlobal()?.core?.invoke ?? null;
}

/** Open a URL in the OS default browser, but only when running inside the
 *  Tauri shell.
 *
 *  Inside Tauri the frontend is a webview with no concept of a new tab, so an
 *  anchor's `target="_blank"` navigation silently does nothing — that's why
 *  the Sponsor link appeared dead in the desktop app. We route the URL to the
 *  local server's `/open-external` endpoint (which shells out to the OS "open"
 *  handler, the same path "reveal in finder" uses); the Node sidecar is a real
 *  local process in both the desktop and CLI cases, so this works without any
 *  native command.
 *
 *  Returns `true` if it handled the open (the caller should `preventDefault()`
 *  the originating click); `false` in a plain browser, where the anchor's
 *  default `target="_blank"` behavior opens a tab in the same browser and
 *  should be left alone. */
export function openExternalUrl(url: string): boolean {
  if (getTauriGlobal() === undefined) return false;
  if (!OpenExternalReqSchema.safeParse({ url }).success) return false;
  const invoke = getTauriInvoke();
  // Explicit GitHub/browser links inside rev bypass the system PR router.
  if (invoke && /^https?:\/\//i.test(url)) {
    void invoke('open_link_in_browser', { url }).then(handled => {
      if (handled !== true) return openExternal({ url });
    }).catch(() => { showToast('Could not open the browser.'); });
  } else openExternal({ url }).catch(() => { showToast('Could not open the link.'); });
  return true;
}

let bannerDelegatesBound = false;

export function showUpdateBanner(version: string): void {
  const banner = document.getElementById('update-banner');
  if (!banner) return;

  const label = document.getElementById('update-banner-label');
  if (label) label.textContent = `Update available: v${version}`;

  banner.style.display = 'flex';

  if (bannerDelegatesBound) return;
  bannerDelegatesBound = true;

  void delegate(banner, 'click', '#update-install-btn', (_e, btn) => {
    const installBtn = asButton(btn);
    void (async () => {
      installBtn.textContent = 'Installing...';
      installBtn.disabled = true;
      try {
        const invoke = getTauriInvoke();
        await invoke?.('install_update');
        if (label) label.textContent = 'Update installed! Restart the app to apply.';
        installBtn.style.display = 'none';
      } catch {
        installBtn.textContent = 'Install Failed';
        installBtn.disabled = false;
      }
    })();
  });

  void delegate(banner, 'click', '#update-banner-dismiss', () => {
    banner.style.display = 'none';
  });
}
