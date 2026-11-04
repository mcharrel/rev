# Manual Test Plan

A handful of documented behaviors are not reliably automatable (they depend on
real OS share sheets, live Claude sessions, multi-touch/pointer gesture syncing,
or subjective visual judgement). They are verified by hand against a running
`glassbox` before a release. Each item here corresponds to a requirement unit
that is `waived` in `docs/testing/feature-coverage.json` with a pointer back to
this file — see `docs/testing/9-feature-coverage.md` for the coverage model.

When you add automated coverage for one of these, remove it here, flip its
`feature-coverage.json` entry from `waived` to `tests`, and note it in the
Automated Coverage Summary below.

## Share (doc 16)

- **16.4 Permanent share access** — Settings → General has a "Share Glassbox"
  link that is always available (never dismissed). Clicking it triggers the same
  share action as the toolbar (OS share sheet, or clipboard-copy fallback with a
  confirmation toast). *(The share action itself — `triggerShare` — is
  unit-tested; this item is the settings-link wiring.)*

## Claude channel (doc 17)

- **17.4 Completion-modal Send-to-Claude** — With the Claude channel enabled and
  connected, completing a review shows a "Send to Claude" button in the
  completion modal. Clicking it triggers Claude with "Read
  `.glassbox/latest-review.md` and apply the feedback." and shows a "Sent!"
  confirmation. The button is hidden when the channel is not connected. *(The
  channel trigger endpoint and status gating are integration-tested; this item is
  the modal-button wiring against a live Claude session.)*

## Image comparison (docs 24, 28)

- **FR-24.7 Synced zoom/pan across side-by-side panes** — In Side-by-Side image
  mode, zooming or panning one pane applies the same transform to the other pane.
  *(The zoom/pan geometry is unit-tested in `client/zoom.test.ts` /
  `client/lightboxZoom.test.ts`; this item is the two-pane sync wiring, which
  needs real pointer/wheel gestures.)*
- **FR-28.5 Zoom/pan within the A / B focus views** — In the single-side A or B
  focus mode, the toolbar zoom actions (in/out/fit/actual) and pointer zoom/pan
  work on the shown side. *(Same shared zoom code as above; this item is the
  focus-view wiring.)*

## Content plugins — management tab (doc 29, GB-1040)

**Most of this is now automated** by the committed `chromium-plugin` e2e
(`tests/e2e/plugin-manage.test.ts`, GB-1070) — see the Automated Coverage Summary.
It drives, against a real installed fixture plugin: the installed list + status
dot, the global enable/disable toggle (removing/restoring the plugin's UI
element), a `select` preference (render + save + persist-across-reload), the
config-layout group + Test-button → status-label round-trip, a diff-toolbar UI
element (render + click → toast), and the Available-to-install → Install → ready →
uninstall flow. The items below remain manual (the paths the e2e doesn't drive):

- **Per-project disable toggle + graying** — Unchecking "Enabled (this project)"
  disables the plugin for the current repo only (its diagrams stop rendering,
  falling back to the code block / text diff); re-checking restores it. Unchecking
  "Enabled (all projects)" greys out the per-project toggle (global precedence).
  *(The **global** enable/disable toggle is e2e-covered, GB-1070; the per-project
  scope + graying is the manual remainder.)*
- **Install-from-a-folder** — Typing a plugin folder path + Install adds it to the
  list (the field clears on success). Installing a folder with no `manifest.json`
  shows a clean "not a Glassbox plugin" error, not a crash. *(Bundled-plugin
  uninstall is e2e-covered, GB-1070; install-from-an-arbitrary-folder + the error
  case is the manual remainder.)*
- **Browse… native folder picker (GB-1048, desktop only)** — Under Tauri, a
  **Browse…** button next to the install field opens a native folder dialog and
  **fills the field** with the chosen path (it does not auto-install — the user
  then clicks **Install**). The dialog must not freeze the app.
- **Available to install — real system-dependency provisioning (GB-1069)** — The
  Available-to-install list + the **self-contained** install → ready → uninstall
  flow is e2e-covered (GB-1070). What stays manual is the **real** provisioning
  that needs a system dependency / network, against the actual built plugins:
  - **PlantUML** with a JRE present → Install fetches `plantuml.jar` from Maven
    automatically → ready (review a `.puml` in Rendered mode). With **no JRE**, it
    still fetches the jar but shows an instruction to install Java, then Install again.
  - **Mermaid** with `npm` present → Install runs `npm install` (downloading a
    Chromium — slow) → ready. With **no `npm`**, it installs the plugin but shows an
    instruction to install Node.js (or run the CLI `setup.mjs`), then Install again.
  - **image-codecs** self-contained install is fully e2e-covered.
- **Graphviz engine preference applies at render** — With Graphviz enabled, its row
  shows a **Layout engine** select; changing it and re-opening a `.dot` diagram in
  Rendered mode renders with the new engine. *(The **select preference render +
  auto-save + persist** is now e2e-covered, GB-1070; the engine-applied-**render**
  is separately unit-tested — this item is the end-to-end visual confirmation.)*
- **Plugin UI extensions — header / sidebar-footer / link + stateful controls (GB-1058/1068, doc 30)**
  — The **diff-toolbar button** render + click → toast + enable/disable show/hide is
  e2e-covered (GB-1070). What stays manual: a plugin registering a **`header`** or
  **`sidebar-footer`** element shows it in the main-content top bar / below the
  Complete–Reopen controls; a **`link`** element opens its URL in a new tab; and the
  **stateful controls (GB-1068)** — a **toggle** flips its off↔on face
  (highlighted when on), toasts the new state, and **persists** across a settings
  reopen (host-persisted per `stateKey`); a **`switch`** behaves the same; a
  **`segmented-control`** highlights the selected segment(s) per its selection mode
  (`exactly-one` keeps one selected, `zero-or-more` toggles each independently).
  Exercise these with a scratch plugin (e.g. a copy of
  `tests/fixtures/plugin/fixture-diagram/` with the element type under test) —
  shipped first-party plugins deliberately register no UI elements (the slots are
  global chrome; the graphviz demo button + Grid toggle were removed for this).
  *(The registration, `GET /api/plugins/ui`,
  and the `onAction`→`result.message` round-trip are unit/integration-tested —
  `plugins/loader.test.ts`, `plugins/configLayout.test.ts`,
  `api/plugins-routes.test.ts`; this item is the client slot rendering + click →
  toast, which needs the real UI — a committed e2e is gated on the fixture-plugin
  harness, GB-1043.)*
- **PlantUML plugin — local Java render (GB-1046, needs a JRE)** — Install the
  opt-in PlantUML plugin: `npm run build:plugins` then `node plugins/plantuml/setup.mjs`
  (checks Java, installs into `~/.glassbox/plugins/plantuml/`, downloads
  `plantuml.jar`). Review a diff containing a `.puml` file: it shows the **Code |
  Rendered** toggle (like an SVG); *Rendered* shows the diagram rendered by the
  local `java -jar plantuml.jar` subprocess. With Java or the jar **absent**, the
  file falls back to the plain code-block/text diff (no error). *(The renderer's
  fail-soft paths + SVG extraction are unit-tested, and `plugins/plantuml.test.ts`
  also has a **Java-gated live-render test** that runs the real `java -jar` path
  whenever a JRE + jar are present — set `PLANTUML_JAR`, or install via `setup.mjs`
  — and skips otherwise. Unlike the Apple FM path this is **not** a hardware gate
  (Java + a downloadable jar are provisionable in CI — and
  `.github/workflows/live-render.yml` does exactly that on demand). Run it with
  **`npm run test:live`**: it is gated on `GLASSBOX_LIVE_RENDER_TESTS` on top of
  the jar check, because spawning a JVM alongside the default suite's ~150
  concurrent files lost the CPU race and blew a 30s timeout. This manual item is
  the full in-viewer Code|Rendered experience.)*
- **Mermaid plugin — local headless-browser render (GB-1045, needs Chromium)** —
  Install the opt-in Mermaid plugin: `npm run build:plugins` then
  `node plugins/mermaid/setup.mjs` (installs into `~/.glassbox/plugins/mermaid/`
  and `npm install`s `@mermaid-js/mermaid-cli` + puppeteer there, downloading a
  Chromium). Review a diff containing a `.mmd`/`.mermaid` file: it shows the
  **Code | Rendered** toggle (like an SVG); *Rendered* shows the diagram rendered
  by the local `mmdc` subprocess. With `mmdc` **absent**, the file falls back to
  the plain code-block/text diff (no error). In locked-down/rootless environments
  where Chromium won't launch, point `MERMAID_PUPPETEER_CONFIG` at a JSON config
  (e.g. `{"args":["--no-sandbox"]}`). *(The renderer's fail-soft paths + SVG
  extraction + CLI-path resolution are unit-tested, and `plugins/mermaid.test.ts`
  also has a **browser-gated live-render test** that runs the real `mmdc` path
  whenever it's present — set `MERMAID_MMDC`, or install via `setup.mjs` — and
  skips otherwise. Like PlantUML and unlike the Apple FM path this is **not** a
  hardware gate (a headless browser is provisionable in CI — and
  `.github/workflows/live-render.yml` provisions one on demand) — verified live
  via headless Chromium. Run it with **`npm run test:live`**: it is gated on
  `GLASSBOX_LIVE_RENDER_TESTS` on top of the `mmdc` check, because launching
  Chromium alongside the default suite's ~150 concurrent files failed at browser
  *launch* (not on time, so its 60s timeout never helped). This manual item is
  the full in-viewer Code|Rendered experience.)*
- **Image-codecs plugin — WebP/AVIF ground-truth scoring (GB-1064)** — Install the
  opt-in image-codecs plugin: `npm run build:plugins` then
  `node plugins/image-codecs/setup.mjs` (copies the self-contained plugin into
  `~/.glassbox/plugins/image-codecs/`; no download). Launch a **ground-truth**
  review (`glassbox --ground-truth <manifest.json>`, doc 26) whose comparisons use
  **`.webp`** and/or **`.avif`** images. With the plugin **enabled**, each such pair
  shows a **perceptual difference score** badge and participates in
  most-different-first sorting / identical-hidden filtering — exactly like a
  PNG/JPEG pair. With the plugin **disabled** (or uninstalled), the same pairs show
  the images but **no score** (unscored, unsupported format) — nothing crashes.
  *(The decoders + the capability wiring are unit-tested against real WebP/AVIF
  fixtures — `plugins/image-codecs.test.ts` — and the built self-contained bundle
  was verified live decoding them; this manual item is the full in-app ground-truth
  scoring experience with the plugin toggled.)*
- **Plugin-rendered file — zoom + comparison modes (GB-1052)** — Review a diff
  containing a `.dot`/`.gv` file with the Graphviz plugin enabled and open the
  **Rendered** view. Confirm the image viewer's **zoom** (in/out/fit/actual +
  pointer) works and, for a modified file, the image-mode segmented control
  (Metadata · A · B · Side by Side · Difference · Slice) compares the two rendered
  diagrams. *(The core render path — the Code|Rendered toggle, the Rendered SVG
  served as `image/svg+xml`, and the artifact-path inline SVG — is now covered by
  the committed `chromium-plugin` e2e, GB-1043. What remains manual is the
  zoom/comparison-mode pointer interaction on a plugin-rendered file, which reuses
  the shared image-viewer gestures already in the manual plan above.)*

## Confirmation dialogs migrated to kerfjs/overlay (doc 33, GB-1160)

These three surfaces were migrated from hand-rolled `.modal-overlay` DOM to
kerfjs/overlay's `confirm()` / `overlay()` (native `<dialog>`, focus trap + focus
restore, Escape/backdrop dismiss). The `confirm()`/`overlay()` mechanism itself is
already e2e-covered (the theme-manager delete confirm in `themes.test.ts`; the
difftool session-ended overlay `#difftool-ended-overlay` in `difftool.test.ts`).
What remains manual is each surface's own wiring, because seeding its trigger
state isn't available in the demo e2e server:

- **Review history deletes (doc 1 FR-1.4)** — on `/history` with more than the
  current review present, "Delete this review", "Delete all completed", and
  "Delete ALL" each open a native danger-confirm; **Cancel** dismisses (no delete),
  **Delete** removes the row / reloads. Escape/backdrop dismiss. *(The demo server
  seeds only the current review, so no delete buttons render — hence manual.)*
- **Delete database backup (doc 9 §9.1a)** — Settings → the "Database backups"
  section (only shown when a pre-PG-upgrade backup exists) → **Delete** opens the
  native danger-confirm naming the backup; Delete removes it + toasts "Backup
  deleted", Cancel/Escape dismiss. *(Requires a retained pre-upgrade backup on
  disk, which the e2e environment never has.)*

## Windows desktop CLI (doc 10 §10.3 / §10.4 / §10.9)

Verified on a real Windows machine (the maintainer's Parallels Windows 11 VM)
against an installed build — the CI runner can't observe the desktop window.
Both items came from GitHub #59.

- **Install CLI from the welcome screen, then run it from PowerShell.** Launch
  the installed app with no arguments, click **Install CLI**, open a new
  PowerShell in a git repo and run `glassbox`. Expected: a review window opens.
  Before the fix the installed `glassbox.cmd` failed with "`…\Programs\glassbox\..\glassbox.exe` cannot be found" because the copied shim
  resolved the app relative to its own location; the installer now bakes the
  app directory into the copy, and a hand-copied shim falls back to
  `%LOCALAPPDATA%\Glassbox` / `%ProgramFiles%\Glassbox`.
- **Review-mode flags reach the sidecar.** In a git repo run
  `glassbox --commit <sha>` (and `glassbox --browser --commit <sha>`).
  Expected: the window (or browser tab) shows that commit's review, not the
  uncommitted changes. Before the fix the Tauri binary forwarded only an
  allowlist of flags to the sidecar it spawns, so every review-mode flag was
  dropped on Windows and Linux; `--browser` also died with "Unknown option"
  because the shim forwards its untouched `%*`.

## Automated Coverage Summary

- **Content-plugin render paths (doc 29 FR-29.2 / FR-29.13, GB-1043)** — the
  committed `chromium-plugin` Playwright project (`tests/e2e/plugin-render.test.ts`)
  boots a `--diff` server with a real fixture content plugin installed in an
  isolated `GLASSBOX_CONFIG_DIR` and a committed `.pr-notes/` note, asserting both
  integration points end-to-end: the **file-diff path** (a `.fdiag` file gets the
  Code|Rendered toggle; Rendered serves the plugin's SVG as `image/svg+xml`) and
  the **artifact path** (a review-note `.fdiag` artifact renders as an inline
  `data:image/svg+xml` `<img>`). Previously verified only by hand.
- **Content-plugin management tab (doc 29 FR-29.12/16/18/20, doc 30 FR-30.3/5, GB-1070)**
  — `tests/e2e/plugin-manage.test.ts` (same `chromium-plugin` server) drives the
  Settings → Plugins tab against a real installed fixture plugin: the installed
  list + active status dot; the **global enable/disable** toggle (removing +
  restoring the plugin's diff-toolbar UI element); a **`select` preference** (render
  + auto-save + persist across a full reload); the **config-layout** group +
  **Test-button → status-label** round-trip; a **diff-toolbar UI element** (render +
  click → toast); and the **Available-to-install → Install → ready → uninstall**
  flow (a self-contained opt-in fixture in `GLASSBOX_BUNDLED_PLUGINS_DIR`). This
  e2e caught + drove the fix for a real bug: the preference-change delegate's
  `asInput` threw on a `<select>`, so **no** select preference (including graphviz's
  `engine`) actually saved from the UI. Previously all manual.

## rev and originating Codex chat

- With a shared-server desktop session, create a draft PR in Codex and run `rev open <URL>` from that chat. Confirm the existing rev window selects the new PR, with its loading state and correct files.
- Add a normal comment while Codex is busy: it must enter that chat’s queue. Add `[steer]` feedback: it must reach the current turn immediately. When idle, either should start the next turn with existing settings. These checks require a compatible shared-server desktop; they cannot be verified against a private-stdio desktop.
- With the currently unsupported private-stdio desktop, confirm comments remain visibly pending and no isolated agent starts. Restart rev and check pending comments remain; GitHub sync should still work independently.
- Automated tests cover local state transitions, source context, no dispatch of imported/deleted comments, ambiguous acknowledgement recovery, server request methods, unloaded-chat refusal and external tab selection. No live messages or GitHub writes are made by these tests.

## Merged PR deployment layout

- On a merged PR with a configured deployment source, verify datacenters replace checks in the same resizable section, without a visible heading. Service names head separate groups. Each lists staging, production, then federal datacenters (including federal staging), followed by unclassified ones; reached rows appear first within each tier. Hovering exposes environment/namespace status. Switch to an open PR and confirm its CI checks return.
- API/subprocess integration, safe HTML rendering, aggregation, empty/error states, refresh timing and closed-tab cancellation have automated coverage. Native appearance and hover remain manual because browser/screen automation is disabled for this fork's local workflow.

- In Settings → My company → Deployments, save a local command and organization list, close/reopen the dialog and verify the values remain. Switch to endpoint mode, save an endpoint, then disable tracking; old datacenter results disappear. Other settings tabs should open without waiting for company settings. Provider values must remain local.


## rev comment and source-refresh experience

- Open an own-PR code composer: avatar precedes the name, no line label, placeholder “Leave a comment, agent will respond...”. On another PR the placeholder is “Post a comment on GitHub...”. Post and click the text: it remains selectable and never becomes an editor. Replies and delete controls still work.
- While viewing code, let the original agent push a change and post a reply. The code stays in place and an orange outlined Refresh button appears before Top level. Click it, or use Cmd/Ctrl+R, to load the changed code.
- Repeat, then switch to another app, another PR, or Main view: the pending change loads without a manual refresh. Return to code to see the update. An unfinished code-comment draft keeps its contents and defers the update until submitted or canceled.
- A reply without a new commit does not replace the source or show Refresh. Multiple rev windows protect the PR while any focused window reads its code.

Automated coverage: ownership-aware placeholders/avatar markup, immutable workspace/API mutations, pending/read-only replies, duplicate delivery, multi-tab/window focus, deferred import after focus returns, explicit refresh, expired checkouts, failed import retry and concurrent reply requests have unit/API coverage. Native focus appearance remains a manual check.

## Resolved threads and hover deletion

- Resolve a GitHub code thread and refresh rev: the thread is folded at its line, with a Resolved row. Expand it, switch files/tabs and refresh metadata: it stays expanded. Reopen it on GitHub and refresh: normal thread content returns. Unanchored old threads remain hidden.
- Search text in a folded reply and navigate to the match: the thread expands. Use comment navigation around a folded local annotation: it counts as one thread.
- Hover your comment or reply and press `d`: the same deletion as its button occurs. Hover someone else's non-deletable comment, a folded summary or empty code: nothing happens. Typing `d` into a composer/search, holding a modifier, or keeping the key held must not delete anything. Verify local own-PR comments remain local and public comments use the GitHub retry queue.

Automated coverage: thread/pagination/null-node mapping, private-content resolution sync, collapsed/expanded/reopened markup, nested navigation, fresh pointer hit-testing, permissions and keyboard guards. Native interaction remains manual under the no-browser-automation preference.

## First-install feedback guidance

- Installer completion should state that GitHub review works without Codex, while automatic replies require separate connection setup. Its example command and setup prompt use the actual command/checkout destinations, including spaces. It must not claim push is ready or change Codex configuration. The existing isolated installer tests exercise completion for successful installs and reruns.

## Description clicks and initial file position

- Open another author’s PR: clicking description text or surrounding space must never open an editor. On your own PR, click text to edit; margins, gaps between wrapped lines, images, links, disclosure controls and selection gestures must leave the description displayed. An empty own description offers “Add a description…”. Save/Cancel still work.
- Open a PR on Main and press `r`: the first change should already be visible with up to five preceding lines. Repeat before a slow file finishes loading. A different PR’s previous file must not be positioned.
- Scroll away, switch Main/File or PR tabs, and return: your position is preserved, even when at the top. First visits to other text files reveal their first change; files without changed blocks stay at the top. Tall first changes start at their beginning and `f` continues with overlap. Search or symbol navigation still reveals its explicit target.

Automated coverage: ownership rejection before GitHub writes, raw Markdown edits, text rectangles and WebKit fallback, empty content, hidden/loading/stale-file guards, remembered zero/nonzero scroll positions, context padding and long changes. Native interaction remains manual under the no-browser-automation preference.

## GitHub accounts and macOS PR links

- General shows only Theme and Share rev; GitHub contains account/organization rows and PR links. Plugins and Updates are absent; Experimental/company controls remain. Change the default and organization override, close/reopen Settings, and verify persistence. Invalid/missing logins must show an error. The terminal’s active `gh` account stays unchanged.
- Queue a public comment offline, change its account mapping, and reconnect: it must remain queued under the original identity, never publish as the new user. Existing private comments stay local. Switch back to release the queued comment. Verify viewer permissions refresh after mapping changes without unloading code.
- On macOS approve rev Links as default browser. Click a direct PR link in another app: it opens/selects that PR in rev. Non-PR links and explicit browser links from rev use the previous browser. Decline approval: GitHub reports pending and offers Enable in macOS. Disable: restore the old browser; if the OS refuses restoration, links still forward to that browser while the preference is off.
- Quit rev and open a PR link: the existing workspace and comments return, and the selected PR opens. The click must not attach an unrelated Codex chat. Test a URL with /files, query and fragment, and reject lookalike domains, user-info URLs and invalid PR numbers. Browser-internal navigation and redirects remain in the browser.

Automated coverage includes account selection/migration/validation, simultaneous credentials, stale requests, queued publishing identity, GitHub controls and async lifecycle, native compilation and synthetic URL matching. OS consent and external-app clicks remain manual under the no-UI-automation preference.

## Codex connection checkbox

- Fresh macOS install: tick Experimental → Connect to Codex. If Codex was already open, expect a restart message; quit/reopen it and reopen the original chat. Expect Connected, with unchanged model, permissions, history and native tools. No setup prompt or terminal command is required.
- Open an own PR without a chat link and pick its actual existing chat in Settings. Post a local code comment: it arrives there, pickup turns the band yellow, and reply turns it green. Other-PR comments and Main comments still use GitHub. Existing links cannot be silently replaced.
- Disable while a chat is active: the chat continues; new forwarding stops. Restart/login and check that the previous launcher is restored. Re-enable and verify recovery. Custom non-rev overrides must be preserved with an error.
- Check status after Codex closes/restarts, after closing Settings during setup, and after a desktop update. Native desktop authorization and external UI actions remain manual under the no-UI-automation preference.

Automated coverage: disposable filesystem/launch environment install-enable-disable-repeat-rollback transitions, quoted paths, old-helper adoption, malformed unrelated login files, capability rejection, original argument preservation, no history/resume calls, ownership and linkage races, Settings lifecycle. A fresh bundled adapter also passes an isolated official CLI/second-client Unix handshake and shutdown smoke check without creating a chat.

## Review status and Main comment presentation

- On another PR, submit an approval: expect green Approved. Request changes or more human explanations: expect yellow Changes requested. Cancel or fail a submission: the prior confirmed state remains. Refresh after a dismissal/account change and check the status reconciles. Merged stays green and disabled.
- Main comments have neutral borders/backgrounds. Adjacent bot comments share a collapsed row; human comments separate groups and remain visible. Expand a group and refresh: it remains open. Find inside a folded bot body expands the group and highlights its result; sharing/deleting still targets the individual message.

Automated coverage includes accepted/failed review transitions, metadata races and dismissal, viewer isolation, bot identity from issue/review responses, empty/all-filtered/single/mixed groups, shuffled input, nested human replies, stable group keys and retained searchable content. UI automation remains excluded by user preference.

## Optional Slack review reactions

- Slack defaults off with `stamp-approved` / `request-changes`; opening Settings or refreshing PRs never searches Slack. Connect a test workspace user token, customize both names and save. The token must not appear in API responses, global config or exports. Disconnect removes it from the system keychain and disables reactions.
- In a disposable Slack workspace, link a test PR in several messages (including a thread and a `/files` URL); include a different PR whose number shares the prefix. Approve: only the correct messages receive the approval emoji. Both change-request actions use the other emoji. GitHub success remains immediate even when Slack is unavailable or an emoji is missing. Retry Slack adds missing reactions without a second GitHub review.
- Close the tab, change accounts or disable the setting while work is pending: no further reactions. Already-sent reactions stay. Restart during a job: show a retryable interruption, do not resend automatically.

Automated coverage uses synthetic data for exact/misleading links, zero/filtered/multiple results, pagination, duplicate reactions, rate limits, safe authentication failures, keychain-only storage, defaults, UI lifecycle, accepted-only review hooks, cancellation and late-response races. No real Slack reactions are sent by tests. UI automation remains excluded by user preference.

## Description editing continuity

- On an own PR, click a word in the beginning, middle and end of its description. The editor should keep the centered text column, body font size/family/line spacing and start the caret at the clicked occurrence. Test repeated words, formatting, code, tables and text below long links. The clicked line should stay near its prior screen height where scroll bounds allow; raw Markdown may wrap differently.
- Resize the mid-panel while editing, type enough to add several wrapped lines, switch PRs and return: keep the draft, caret and usable scrolling. Save and Cancel retain their existing behavior. Another person’s PR, links, whitespace and drag selections must not open the editor.

Automated coverage checks source mapping for repeated text, links/definitions/images, hidden HTML, entities, code, tables, nested blocks, UTF-16 offsets, empty input and bounded fallback; synthetic geometry checks caret/scroll placement and late-layout guards. Pixel-level UI verification remains manual under the no-browser-automation preference.

- Click outside an unchanged description editor: return to the rendered description with no save controls. Change text and click outside: render that draft, retaining Save/Cancel without publishing. Reopen at a clicked word, switch PRs and return, and verify the draft survives. Save publishes; Cancel discards. Clicking inside the textarea or on Save/Cancel must not interfere.

## Slack connections and test control

- Settings tabs share one label baseline and equal icon sizes, including at app zoom levels and in narrow windows. GitHub and Slack show recognizable brand marks, inherit selected/inactive tab colors and retain keyboard focus rings.
- Open GitHub and Slack independently; account routing stays under GitHub. Slack's radio choices are exclusive, hide the token for Claude and link to `SLACK.md`. Select each provider, save, close and reopen. Existing token preferences migrate without enabling reactions.
- Enable reactions, paste a Slack message permalink and test. Verify one configured approval reaction on that message and a check with confirmation below the input. Test an unavailable emoji, malformed link, inaccessible message and disconnected Claude; none may show success. Change the URL/provider/emoji and verify the old success disappears. Repeated clicks while pending must not create concurrent tests; late responses after dialog closure must not update a reopened dialog.
- Claude: authenticate the official plugin using normal OAuth, verify model-service access, then test. Confirm no conversation resumes or file/shell tools run. A timeout must be visible and leave GitHub review state unchanged.

Automated coverage exercises synthetic API receipts, invalid URLs, exact-target guards, provider switching, settings isolation, pagination, failure and stale UI sequences. Real reaction writes require an explicitly chosen test message; browser automation remains excluded by user preference.

## PR title refresh and Share feedback

- In Main and File views, press Cmd/Ctrl+R: a small spinner appears immediately left of Share and lasts through refresh/file-list reload. Repeating the shortcut does not start a second request. Switch tabs during a refresh: only the refreshing PR shows progress, and failure releases it for retry.
- Click Share: “Link copied!” appears directly below that button, stays through same-PR metadata updates, then disappears after two seconds. Check narrow sidebar widths and app zoom. Switching PRs removes it, including if the clipboard write finishes late. Clipboard errors remain visible.

Automated coverage: header order, per-PR request lifecycle, polling, duplicate shortcuts, concurrent tab refreshes, failure/retry and clipboard completion races. Native placement and animation remain manual; this workflow does not use browser automation or screenshots.

## Code line layout (doc 4.4)

- General → Long code lines: choose Wrap lines while viewing a file with long statements, indentation, tabs and an unbroken token. All code fits the pane; new visual lines retain the original source line number and change color. Resize the mid panel and confirm split-mode rows stay aligned.
- Switch to Scroll horizontally: a horizontal gesture/scrollbar moves the unified diff together without individual line scrollers. Comments remain constrained to the pane width. Switch files/PRs, reopen Settings and restart the app; the choice persists. Search and comment navigation still target the correct source lines. Persistence and cached-PR transitions have unit coverage; visual layout remains a manual check.

## Closing tabs during background work

- Start a Slack review reaction, select another PR and close it. Close immediately removes the tab; other tabs and Share remain usable. It does not wait for Slack or remote metadata/comments. Legacy shared objects are retained in an independent cache without repacking.
- Switch tabs while a close is pending: the closing tab remains hidden until cleanup succeeds or fails. Repeated clicks do not start duplicate deletion. An unsafe checkout stays visible with an error and can be retried after its unpublished work is preserved.
- API integration and unit tests cover pending Slack/GitHub reads, late responses, close/reopen, source-operation safety, progress and retries. Visual checks remain manual under the no-UI-automation preference.

## Code conversation cards

- In Main/File views and light/dark themes, verify only code threads use one soft light-gray rounded card, sans-serif author/body, aligned avatars and relative timestamps with exact-date tooltips. Replies are indented without individual borders; new-comment composers match. Check a narrow pane, long words, Markdown, code blocks and large text zoom.
- For local requests, verify gray before pickup, yellow while working, green after an answer; the band spans the root conversation and follow-ups retain their own status. Share/delete appear on hover and keyboard focus, with hover-D still deleting only its target.
- Open Add reply…, type a draft, blur and refresh metadata. Preserve the draft and disclosure; Enter posts, Shift+Enter inserts a line, and successful posting closes the composer. Failed posting keeps the draft. Delete a root with replies and another thread at the same line: no orphan card or reply box remains.
- Fold/unfold a resolved thread, search a folded reply and use C/V navigation through long conversations. Preserve expansion on tab switches and include the entire card in visibility calculations.
- Browser automation and screenshots are disabled by the user's preference; layout checks remain manual. Automated thread markup, draft preservation, navigation and deletion checks run in the unit suite.

## Own-PR merge action

- On an own open PR, the status dropdown includes Merge. Draft and closed PRs show it disabled; other authors' PRs omit it, and merged PRs retain the green disabled Merged button.
- Use a disposable PR for any manual merge: confirm Merging… disables the dropdown while Share, tabs and other PRs remain usable, then the status becomes green Merged. Do not use a real work PR for test merges.
- New commits since the displayed/reviewed version must require refresh; rejected checks, review requirements, conflicts and authorization failures retain the confirmed status and show the error. Failed merges can be retried.
- Switching PR tabs during merge keeps the current selection and shows the result on returning. Merging sends no Slack review reactions. Simulated HTTP integration and unit tests cover these transitions; visual checks remain manual.

## Immediate PR closing

- Close the active tab during a slow checkout deletion: the tab disappears and the next PR appears immediately. Closing the final tab immediately shows the add-PR screen. Keep switching and reordering other tabs while cleanup runs.
- Reject deletion of a disposable fixture containing unpublished work: restore only its tab, keep the current selection, and show the reason. Return to it and verify unsent drafts and reading position survived. Retry after making its source disposable.
- Unit and HTTP integration tests cover delayed cleanup, simultaneous closes, older polls/responses, new opens, failures, cache release and tab reordering. Browser automation remains disabled by user preference.

- Real-Git tests now verify independent snapshot imports, legacy dependency migration and HTTP closure with broken borrower refs. They also verify object access after provider removal and final cache collection. The visual immediate-close behavior remains covered by the manual checks above.

## Code-thread ownership

- On your own PR, post a new code thread and follow up after a Codex reply: both requests reach the originating chat. Reply in a thread started by another reviewer: the composer says GitHub, the reply appears on GitHub and no Codex pickup/status appears. Replying to your own previous reply in that reviewer’s thread has the same GitHub behavior.
- Previously private replies misrouted to Codex stay local after upgrading; stale pickup indicators disappear and they are never published retroactively. Unit and HTTP integration tests cover routing, queue/recovery and pickup gates without posting real test comments.

- Interrupted close: after a partially deleted managed checkout is reopened, closing it succeeds if its remaining files exactly match its saved snapshot. Extra/edited files remain protected. Real-Git unit and HTTP tests cover this without accessing live PRs; imported snapshots also suppress checkout hooks.

- Stale-HEAD cleanup: a complete staged snapshot already present in rev’s imported cache closes through the normal API; arbitrary staged/unstaged edits remain protected. Synthetic unit and HTTP regression tests cover this without touching real PR data.
