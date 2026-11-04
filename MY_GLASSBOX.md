# rev

[rev](https://github.com/mcharrel/rev) is my personal review workspace, based on upstream Glassbox 1.2.3. The fork's `main` follows upstream; the installed customizations live on `mc/local-customizations`. Upstream bug fixes can be merged or cherry-picked without giving up these preferences.

## Workspace and PR tabs

- A permanent resizable tab panel sits to the left of the mid panel. It starts at its compact minimum and shows bare PR numbers without a hashtag or status dot; expanding it shows titles. The active tab has a purple background. Unselected tab text shows draft (gray), open (green), merged (purple), and closed (red).
- Long-press and drag a tab to reorder it. Option+Tab / Option+Shift+Tab cycle PRs. Double-click an expanded title to edit the GitHub title only for my own PRs.
- The + immediately after the PR tabs opens a URL field. A GitHub PR URL may include `/files`, query parameters, or a fragment. Reopening a tracked PR selects the existing tab.
- A small `rev` link stays at the very bottom of the tab panel, below the scrolling PR list, and opens the fork's GitHub repository in the default browser.
- New own PRs appear above other people's PRs. Related stacked PRs are placed together, parent before child. Manual ordering persists.
- Each PR initially opens its Main view and remembers its last selected view. `r` switches Main and File views. The first visit to a text file reveals its first change with up to five preceding lines; returning to a file preserves its reading position, including the top of the file. Hidden/preloading views wait until visible before positioning.
- New PRs load GitHub metadata and conversations asynchronously. Existing PRs use their cached data at startup and when switching tabs; every open tab refreshes metadata and conversations in the background every five minutes. Cmd/Ctrl+R refreshes the selected PR immediately, including source changes.
- Closing a tab deletes its local review, comments, pending GitHub/Codex deliveries, guidance, attachments, exports, source checkout and cached reading state. Reopening starts fresh. Previously archived tabs are purged on startup. GitHub content and user-owned clones are unaffected. If a managed checkout contains unpublished work or an active agent, closing fails visibly and the tab remains open; it is never silently archived. Shared Git objects needed by other tabs are copied before their provider is deleted.

The desktop app, native menu, loading screens, and share link use the rev name. Existing `.glassbox` data, settings, bundle identity, and `glassbox` commands remain compatible; the local `myreview` command opens the saved PR workspace.

## Shared header and Main view

- Text links use `#4393F8`, including PR descriptions, comments and guidance; the link color is independent of syntax and action colors.

- The shared header shows the GitHub title, Share immediately to the left of the close-tab icon on the right. Share copies the active PR’s canonical GitHub link and shows “Link copied!” in a simple toast below Share after success. Settings stays at the far right of the topbar (the class/function breadcrumb bar showing “Top level”) and also opens with Cmd/Ctrl+,. The topbar stays available in Main/File views, while loading, and for files without an outline. Only my own PR titles are editable. Editing keeps the displayed font size, and clicking away immediately restores the normal title while saving. Added lines are blue, removed lines orange; totals exclude tests and generated protos and appear above the branch names. Show the PR branch first, followed by a separate `-> <base>` line only when the target is neither `prod` nor `main`.
- Use one compact purple dropdown. Own PRs show their current Draft, Ready for Review, or Close state. Other PRs show Review with Approve, Request code change, and Make explanations more human. The last choice submits a GitHub Request changes review with exactly: “Could you make the explanations (description, in-line comments) easier to digest for a human ?” Merged PRs replace the dropdown with a green, non-clickable Merged button. GitHub merge status is picked up by the five-minute background refresh or immediately on Cmd/Ctrl+R.
- Cmd/Ctrl+R refreshes the PR. New source revisions are fetched on explicit refresh, preserving annotations through Glassbox's re-anchoring logic. Repeated shortcuts during an in-flight refresh do not queue another full refresh.
- Main content is the PR description. Only my own PR descriptions are editable, by clicking rendered text (or “Add a description…” when empty). Whitespace, images, links, controls and text selection do not open the editor. Clicking outside the editor returns to rendered text. Changed text stays as an unsaved rendered draft with Save/Cancel available; click its text to continue editing. Unchanged editors close completely. Save or Cmd/Ctrl+Enter publishes the edit. Escape/Cancel discards it. The server also rejects edits to another author's PR.
- The mid panel contains reviewers, CI checks ordered failed/pending/succeeded, then the PR conversation with newest comments first, without visible section titles. Accessible section labels remain. Every section scrolls and its divider resizes. Merged PRs use the CI area for deployment status grouped by service, as described below.
- Reviewer names open Slack where a local mapping exists. The local mapping was imported from Doggo; company directory data and account mappings stay outside this repository in `~/.glassbox/workspace-config.json`.
- Desktop notifications report reviewer-state changes, readiness to merge, and merging. Initial loading does not generate notifications.

## Reading files

- Unified view is the default. Show full file context, without folding. Keep only the new line-number column in unified view.
- Hide both file-name bars and the bottom toolbar. Keep the sticky class/function breadcrumb.
- The mid-panel file list shows basenames, with paths on hover and no position numbers. No Filter files field or sorting buttons.
- Beside each filename, a diff-icon badge counts distinct change blocks alongside the comment count. Adjacent additions/removals form one block; unchanged lines separate blocks, just as in change navigation. No badge appears for files without text changes.
- Reading order is fixed: ordinary source files using Glassbox's AI narrative order, YAML, tests, dependency changes, generated protos. This is most important first, least important last.
- Tab / Shift+Tab and `f` / `g` advance/backtrack through changes that are not fully visible. Show ideally five lines of preceding context. Page through oversized changes with ten lines of overlap, then continue to the next file.
- Advancing out of a file hides it from the remaining-file list. Reverse navigation reveals it again. Reaching the end can leave the list empty without losing the traversal history.
- Shift+G goes to the bottom. The old `gg` shortcut is removed.
- `c` / `v` move to the next / previous comment thread that is not fully visible (Shift+C also goes backward), including replies. Show ten preceding source lines below the sticky breadcrumb, counting wrapped lines correctly; use the available context near the file start or in a small window. Page through long threads with ten lines of overlap. Across files, wait for the destination to render and reveal the first / last thread with the same context.
- Cmd/Ctrl+S copies a GitHub link for the source line or filename under the pointer.

## Search and definitions

- Cmd/Ctrl+F focuses search; pressing it again returns focus to the file while retaining the query, highlights, and current match, so `n` works immediately. Search covers all files in the PR and their comments, including GitHub conversations and AI thread replies. Matches in the current view are highlighted. `n` advances; `m` or Shift+N goes backward.
- One Escape closes search and clears highlights, even with the search field focused. It consumes the key so fullscreen remains active.
- Cmd/Ctrl+click navigates to a definition and searches the symbol name, highlighting occurrences for subsequent navigation. Local variables are resolved in their enclosing scope before the repository lookup.
- Identifier extraction reads across highlight spans, including one-letter identifiers. The repository definition scan allows up to 50,000 tracked files, with raw-file fallback and correct navigation history.

## Guidance

- GUIDE appears above LEARN at the bottom of the mid panel, outside the code. Hide their title badges and the Complete Review / Review History section.
- Show only notes anchored to lines currently visible in the code viewport. Guidance uses the code font size and retains its original colors.
- The divider above guidance controls its height and remembers it. GUIDE and LEARN stay together without an internal divider.
- AI context now carries explicit old/new source line numbers, including shortened hunks and supplemental files, instead of requiring the model to count diff rows. Existing cached guidance must be regenerated to use this improvement.

## Comments and background agents

- Click a line to open its comment box; clicking that same line again closes it. Enter or Cmd/Ctrl+Enter saves; Shift+Enter inserts a newline.
- Code comments use the code font and size on a neutral bordered surface, with an inset band for agent status. Posted comments are read-only; use a reply to follow up. Hide category, Attach file, Edit, and drag controls. Delete remains; Share copies the GitHub comment link once published.
- Main-view comments publish to GitHub on every PR, including my own, and never go to Codex. Code threads I start on my own PRs stay local, including my follow-ups, deletes and Codex answers. My replies in someone else’s code thread publish to GitHub and never reach Codex, even if I reply to my own earlier reply in that thread. Code comments on others’ PRs publish to GitHub only, with no Codex delivery or chat binding. A cloud marker indicates pending/failed GitHub synchronization; retries occur every five minutes. Stable markers reconcile ambiguous POST failures to avoid duplicate comments. Both kinds display alongside imported GitHub feedback.
- New local requests on my PRs go to the originating Codex chat when linked. Local threads support replies without GitHub IDs. The thread shows Local and a separate agent status; private messages have no GitHub share button.
- Codex uses the original chat’s model, permissions and context, following normal verification and signed-push rules. No isolated comment agents start automatically; GUIDE/LEARN retain their own model settings.
- Posted comments are read-only. Main-view deletes sync to GitHub; code-thread deletes follow PR ownership and authorship controls. Legacy local annotations are imported without treating them as fresh Codex requests. Unknown ownership holds code-comment writes locally; Main-view comments wait only for GitHub authentication. Previously queued GitHub writes in my own local code threads are canceled, without deleting already-public copies. Historical conversations already marked private remain private and are not republished by this correction. Private messages survive refresh/restart and cannot be published after changing accounts.

## Rendering fixes and contributions

- Changed and unchanged code lines share the same text alignment. Added/removed markers do not shift code indentation.
- Disable character-level change highlighting, retaining whole-line diff colors. Navigation uses an outline effect instead of replacing the red/green background.
- All contributions, including bug fixes and personal customizations, stay in `mcharrel/rev`. Do not open or update upstream contribution PRs. The earlier upstream PRs (#73–77) are closed; their fixes remain in this fork. Reading and pulling upstream updates is still allowed.

## Local data

PR tabs, cached metadata, comment queue and agent threads persist in `workspace.json` beside the active review database. Managed PR checkouts and agent worktrees live under that same local data directory. Tokens remain in GitHub CLI/OS credential storage and are never written to workspace state or repository remotes. Panel sizes and remaining-file progress are stored locally by the client.

## Workspace stability

- GUIDE and LEARN stay together in one scrolling section; only the divider above the combined section resizes it.
- All panel widths and section heights persist. Temporary hiding or limited space does not overwrite the chosen size. The title section cannot shrink below its content, including wrapped titles and action buttons.
- PR tabs switch within the same page. Files, AI guidance, loaded diff DOM, inline drafts, scroll positions, remaining-file lists, and navigation history remain in memory per PR. The first load stays asynchronous; metadata and comments refresh every five minutes without switching views or replacing the source snapshot; ordinary remote commits wait for Cmd/Ctrl+R; commits detected after agent answers follow the focus-aware refresh behavior below. Posting comments, edits, and review actions remains immediate, and offline comments still retry every five minutes. Explicit refresh or a changed reviewed revision invalidates the affected cached content.
- Remote inline comments appear only at a valid current source line, including old-side coordinates on unified context lines. Threads without a matching current line are hidden, with no fallback at the file top.

## Loading and input fixes

- The PR tab rail shrinks to the width of the longest compact PR ID, with small padding around it. Longer IDs increase that minimum so they remain readable.
- Newly opened PRs show a pending indicator until their own file list is available. Their file view, file names, and GUIDE/LEARN never display the previous PR. A cold file also shows a loading indicator instead of the previous file. Failed file-list loads offer Retry.
- Model selections discovered from the provider, including `gpt-5.5-pro`, persist across settings opens and app restarts. The fallback model catalog no longer silently substitutes GPT-4o. GPT-5.5, GPT-5.5 Pro, and their dated snapshots use the Responses API for analysis, with response storage disabled. Both model fixes remain in this fork.

## Review workflow polish

- Change-block counts show only the number, without a diff icon. When navigation has hidden every file, show “You reviewed all the files 👍”; empty or loading reviews do not count as finished.
- Dividers are one pixel normally and widen on hover/focus without moving the panels.
- Cmd/Ctrl+F works through both the desktop menu and a keyboard fallback; duplicate native/key events toggle only once. Repeated presses keep the query while moving focus between search and code.
- AI settings persist reasoning effort and agent access. GPT-5.5 offers Default, None, Low, Medium, High, and Extra high; Pro offers Default, Medium, High, and Extra high. Unsupported models retain their provider default.
- Agent replies contain two or three plain sentences about the result, with a commit link after a successful push. No incremental narration or long diff summary.
- Press `a` then `i` within 1.2 seconds to replace GUIDE/LEARN with a fresh review. It bypasses cached analysis, keeps human comments, and is limited to once per five minutes per PR, including after a restart. LEARN runs when enabled. Stale requests cannot restore discarded guidance.
- Import source code and remote comments independently. Reuse existing Git objects and negotiate missing objects through an existing repository, instead of downloading another shallow copy for every PR. First-time repository downloads still depend on repository size and the network.
- Suppress desktop notifications while a Glassbox window is visible and focused. Background windows still notify for reviewer/mergeability/merge changes.
- The native app icon uses my supplied dark rev Git-graph wordmark, preserved in `assets/app-icon.png`. Keep its existing rounded silhouette and transparency. `swift scripts/build-personal-icon.swift` crops the supplied transparent margin and scales the original artwork to 824 pixels wide, centered on a 1024-pixel transparent canvas, preserving its proportions and the established Dock size. An opaque dark rounded tile behind the translucent artwork prevents macOS from adding a pale outer frame; the canvas outside the tile remains transparent. Generate native icon sizes with `tauri icon assets/app-icon-macos.png`.

## GitHub request budget

- All open tabs, including inactive tabs and merged/closed PRs still in the tab list, refresh metadata and comments every five minutes. Removed tabs do not poll. Startup and switching open tabs use the cache immediately; reopening a removed PR starts fresh. The local client also checks its own server for import, comment, and agent progress; those local reads never contact GitHub.
- A normal background or explicit refresh uses two GraphQL requests for metadata and inline review threads, plus two REST requests for issue comments and submitted review bodies. Large collections and long threads require extra pagination requests; first-time account identification and source fetches add work.
- At four requests per refresh, the background budget is about 48 GitHub requests per hour per open PR, plus pagination, explicit actions and retries. Normal five-minute metadata polling does not fetch source. An agent answer also checks for pushed commits and can refresh the source as described below.
- New PRs and unfinished imports load immediately. Overlapping requests are coalesced; Cmd/Ctrl+R during a background read waits for one subsequent full refresh, including source changes. Failures retain cached data and retry at the next five-minute tick; closing the app stops polling.
- Comments, title/description edits, review actions, and agent pushes still contact GitHub when requested. Failed comment publication keeps its five-minute retry schedule.
- Reviewer, mergeability and merge changes are discovered within the next background refresh. Desktop notifications remain suppressed while the app is visible and focused.

## Import reliability and app zoom

- Workspace updates, adding PRs, and visibility reports do not depend on the selected review ID. An importing tab cannot block its own progress updates or prevent opening another PR. Non-JSON HTTP failures show a useful request/status message.
- Reuse matching local repositories found under Go workspaces and common source folders, validating their GitHub remotes (including SSH aliases). Optional explicit paths live in `~/.glassbox/workspace-config.json` under `repositories` keyed by `owner/repo`. Preserve the source checkout's files/index/branch and protect borrowed commits from garbage collection.
- Cold imports fetch the exact PR/base snapshots with depth 1, using GitHub's reported merge base. Do not guess with depth 100 or deepen by 1,000 commits. Completely new repositories still require downloading source snapshots; metadata and comments can display independently. Poll local import progress more frequently while an import is running; cached tabs poll GitHub only every five minutes.
- Cmd/Ctrl+= (or +) and Cmd/Ctrl+- zoom the entire desktop app, in 10% steps from 50% to 200%. Cmd/Ctrl+0 resets to 100%. The preference persists and applies to every PR; standard browser zoom remains unchanged when running outside the desktop shell.

## Workspace retention

- Automatically check on startup and hourly for PR checkouts and comment-agent worktrees inactive for 14 days. Selection, imports, edits and agent completion count as activity; local workspace polling and background GitHub metadata refresh do not. Background refresh never recreates an expired checkout.
- Remove only disposable directories created inside this review data directory’s `workspaces/` and `agents/`. Preserve the selected PR, running work, queued offline comments, dirty/untracked/ignored files, unpublished commits, user branches, locked worktrees and initialized submodules. Never delete my ordinary clones or the checkout hosting the running app.
- Shared Git providers stay while another checkout needs them; expired borrowers are removed first. Agent worktrees are unregistered with Git, without force.
- Keep PR tabs, comments, annotations, attachments and reading state. Selecting an expired PR shows loading while recreating its exact saved source revision; it does not refresh GitHub metadata or rewrite annotations. Cleanup makes no GitHub API requests.

## rev name, publication, and originating Codex chat

- Renamed the app and public repository to `rev` (formerly MyReview). Repository: https://github.com/mcharrel/rev. `main` is now the verified personal app; retain an `upstream` remote for future Glassbox updates. Legacy executable/data names stay compatible.
- Replaced the upstream README with source installation, GitHub account setup, keyboard navigation, updates and Codex integration instructions. The supplied app icon is intentionally public. Local credentials, connection files, workspace state and private PR data are excluded. Removed the inherited Hotsheet credential from the tracked tree; already-public upstream history is unchanged.
- `rev open <PR URL>` opens/selects a tab in the running app and captures `CODEX_THREAD_ID` when run from the originating Codex chat. External opens are reflected by the existing window without losing per-PR reading state. Existing chat bindings cannot be silently replaced.
- New local code comments are queued for that original chat as `new comment: ...` plus PR/source context. `[steer]` requests immediate steering. Only my code comments and my follow-ups in threads I started on my own PRs route to Codex, and these conversations never publish to GitHub. Imported comments and old annotations never dispatch automatically. No new isolated comment agents are started; GUIDE/LEARN still use the model settings.
- Delivery uses an existing shared Codex app server only when explicitly enabled. The desktop and rev must share the same server for live delivery. Private-stdio sessions leave comments visibly pending; no second agent is resumed as a fallback.
- Delivery state survives restarts. Ambiguous acknowledgements require checking the original chat before manually resending. The same chat can post answers back into the original rev thread with `rev reply <URL> --comment <ID> --revision <N> --body-file <FILE>`. Replies are local and attributed to Codex. Repeated identical submissions are deduplicated.

## GitHub Markdown and bot reports

GitHub descriptions and comments use GitHub-rendered HTML from the existing metadata/comment requests, with a sanitized local GitHub-flavored Markdown fallback for cached or pending content. Tables, task lists, nested lists, fenced code, images and expandable bot reports render as content. Raw Markdown remains the editing/publishing source, and edits invalidate stale rendered HTML. Links and disclosure toggles do not start editing; local polling preserves expanded reports. Search indexes displayed comment text and opens collapsed reports when navigating to a match. This adds no GitHub requests and preserves comment fonts/colors.

## Source installation

Use `git clone https://github.com/mcharrel/rev.git && ./rev/install.sh --desktop`. The recommended install and update commands include `--desktop` to build the native macOS app alongside the browser workspace, without release keys or upstream automatic updates. Omit the option for Linux or browser-only installs. The installer installs a user-local command, checks dependencies, and guides GitHub authentication. Rerun the script after pulling changes; existing review data and unrelated launchers are preserved.

## Deployment status

Merged PRs replace CI checks with separate service groups, each with one row per datacenter from the locally configured deployment source. Services sort by name. Within each service, datacenters sort staging, production, then federal (including federal staging), with unclassified datacenters last. Fully reached datacenters sort first within each tier. Namespace/environment targets are aggregated only within the same service and datacenter; mixed statuses are marked partial, with details on hover. Deploying, missing and unknown states remain distinct. Suggested services are queried automatically in one follow-up request. Status loads independently of PR content, is cached locally, refreshes every five minutes and on Cmd/Ctrl+R, and is canceled when a tab closes. Failed refreshes retain clearly marked last-known results; unavailable or empty reports never mean “not reached”.

Settings → **My company → Deployments** selects a local shell command or an HTTP GET endpoint and an explicit list of GitHub organizations. Tracking is disabled by default. Saving settings cancels old requests, clears old deployment results and refreshes matching merged tabs without blocking the settings dialog. Commands, endpoints and optional Authorization headers live only in the user's global config (`~/.glassbox/config.json`, mode 0600), never in project settings, review exports or the public repository. No company-specific provider configuration ships with the app.

## Local code comment status and appearance

- Code comments, replies and composers use neutral surfaces, subtle borders and rounded corners, with the code font and size. Purple code-comment backgrounds are removed. Author avatars appear left of names, including in composers. Posted comments are read-only; add a follow-up instead of editing. Timestamps, local scope and delete controls remain.
- An inset three-pixel left band is gray (`#656C76`) while pending pickup, yellow (`#D29922`) after explicit agent pickup, and green (`#00B401`) after an answer. A text label makes the state clear without relying on color. Transport delivery is not pickup.
- The originating chat runs `rev comments <URL>`, `rev pickup <URL> --comment <ID> --revision <N>` before work, then `rev reply <URL> --comment <ID> --revision <N> --body-file <FILE>`. Prompts include the commands. These authenticated local controls check the chat binding and never publish to GitHub.
- Posted requests cannot be edited. Historical revision checks still reject stale answers; retries are idempotent. Existing Codex answers are recognized on startup, and follow-ups retain independent status.

### Shared Codex connection

With shared-server mode enabled locally, rev connects directly to Codex’s Unix WebSocket. The desktop and rev must use the same server. Feedback uses the existing chat’s queue or active-turn steering, preserving its model, permissions and history; an unloaded chat remains pending. The adapter reads only the latest turn and never launches another agent. `REV_CODEX_SOCKET` optionally selects a custom local socket.

## Immutable comments and agent code refresh

- Posted comments cannot be edited, including through an older PR-workspace client. Add a reply to clarify a request. GitHub edits made outside rev still synchronize. Deletion remains available.
- Code comments and composers show the author avatar left of the name (a neutral icon for agents or unknown users). The inline composer omits the redundant line label. On own PRs its placeholder is “Leave a comment, agent will respond...”; on other PRs it is “Post a comment on GitHub...”.
- A new `rev reply` checks for pushed commits without blocking the reply. A read-only answer does not reload source. While any rev window is focused on that PR's code, a transparent orange-bordered **Refresh** button appears at the left of the topbar, before the scope dropdown. Clicking it or Cmd/Ctrl+R applies the pending source update.
- Leaving the code view, switching PRs, or moving focus to another app applies pending source updates automatically. Focus is checked again after fetching, before replacing source. Unsaved code-comment drafts also defer automatic refresh. Failed refreshes preserve the pending request and can be retried explicitly; expired checkouts are not recreated in the background. Closing a tab removes its pending refresh with the rest of its local state.

## Resolved GitHub threads and hover deletion

- Resolved GitHub code threads remain at their current source line, folded into a compact Resolved row. Expand it to read the original comment and replies. Expansion is remembered during in-memory file/tab switches and metadata refresh; reopening the thread on GitHub unfolds it. Unanchored historical threads remain hidden. Search can find folded content and expands its thread when navigating to a match.
- Hover a deletable comment or reply and press `d` to use its existing Delete action. The shortcut respects permissions, local/GitHub routing and offline retries, and ignores text inputs, dialogs, modifiers and held-key repeats. A folded summary is not a deletion target.

## First-install Codex guidance

- README and installer output explicitly distinguish PR review, chat linking, manual feedback handling and automatic delivery. The public installer does not install a Codex shared-server adapter. It prints a setup prompt and points to the README for compatibility, restart and manual fallback instructions. A successful PR link is not proof that push works.

## Simplified settings and PR link routing

- General keeps Theme, Long code lines and Share rev. Profile replaces experience/language controls with a default GitHub account, organization overrides and PR-link routing. Experimental keeps its controls; My company is unchanged. Plugins and Updates tabs are removed. Existing hidden preferences are retained.
- Account mappings stay in local global settings, never project files or exports. Each request and Git fetch selects its own `gh` account without `gh auth switch`. Saving accounts refreshes viewer permissions while retaining tabs and private comments. Queued public comments keep their publishing identity across account changes.
- On macOS, Open PR links in rev defaults on. The rev Links helper asks macOS to become the default browser once; setup is shown as pending until approved. Direct GitHub PR URLs open in rev, other URLs retain the previous browser, and disabling restores that browser. Explicit browser links inside rev bypass the router. Browser clicks never inherit a Codex chat ID, and cold starts preserve the last review workspace.

- **Codex setup from Settings:** Experimental → Connect to Codex installs and checks the persistent desktop-owned connection on macOS. One checkbox, then one Codex restart if needed; no setup prompts to paste. Live status distinguishes connected/restart/disabled. Existing own PRs can choose their originating loaded chat in Settings. Preserve history/model/permissions/native tools; disable stops forwarding and restores owned startup settings without closing chats.

- **Review decisions and Main comments:** Other PRs show Approved in green after approval, or Changes requested in yellow (#D29922) for either change-request action. Use the current viewer’s submitted review, retain the last accepted state on failure, and reconcile later GitHub changes. Main comments use neutral bordered cards; consecutive bot-only comments collapse into one expandable group, while human comments/replies stay visible. Bot bodies remain searchable.

- **Optional Slack review reactions:** Slack offers an off-by-default toggle with configurable `stamp-approved` and `request-changes` defaults. A Slack user token with search/read and reaction/write permissions is stored only in the OS keychain. Accepted GitHub reviews trigger exact-link Slack search and background reactions; both change-request options use the same emoji. Errors are separate from GitHub approval and can be retried. No automatic backfill or Slack polling. Closing tabs, changing accounts or saving settings cancels unfinished work.

- **Description editing continuity:** The Markdown editor shares the rendered description’s centered width, font family, size and line spacing, with no inset that shifts text. Clicking text starts the caret at that occurrence in the source; hidden link destinations and HTML metadata are skipped. The view keeps the clicked line near its previous screen position where layout allows. The editor grows with its contents and preserves drafts and ownership restrictions.

- **Separate GitHub and Slack settings:** Profile becomes two tabs. Slack has an exclusive Slack app / Claude Code connection choice and links to `SLACK.md`. Enabling reactions reveals a message-link test using the configured approval emoji, with a confirmation check below the input after Slack accepts it. Changes clear the old confirmation. Claude keeps its login and uses only tightly scoped Slack operations; existing reaction preferences remain off by default.
- **Claude Slack receipt compatibility:** Parse the content arrays returned by Claude's live tool hooks and the hosted Slack tool's exact success result for the requested emoji, preserving explicit failure checks and rejecting unstructured responses.
- **Settings tab alignment:** All tabs use equal icon dimensions and label line height. GitHub and Slack use their brand marks, matching the existing inactive and selected tab colors.

- **Paired Slack reactions:** Each review reaction and Settings test adds the configured emoji plus `rev`, deduplicating identical choices. Missing workspace emoji are skipped independently and silently on both connections; other failures retain retry/status behavior. Counts track messages with at least one confirmed reaction, including partial success; no reactions means no completion notification or false test confirmation.

- **PR refresh feedback:** Cmd/Ctrl+R shows a small spinning indicator immediately left of Share for the refresh request and file-list reload. Progress belongs to the PR, survives metadata polling and clears on completion or failure. Share shows “Link copied!” directly below its button for two seconds; preserve it during same-PR header updates and remove it when switching PRs.

- **Long code lines:** General settings lets me choose Wrap lines (default) or Scroll horizontally. The choice applies immediately and persists across PRs and app restarts. Horizontal scrolling moves the unified code pane together; wrapping fits long lines and tokens inside the pane without horizontal code scrolling, preserving indentation and source line numbers.

Closing a PR immediately removes its tab and selects another open PR (or the add-PR screen). Safe source checks and permanent deletion continue in the background without blocking navigation or reordering. Pending closes stay hidden through polls and other responses; completed deletion invalidates older snapshots. Retain only temporary rollback state and drafts until cleanup finishes. On failure, restore that tab with an error without stealing focus; on success, release all cached review data. Never bypass unpublished-source checks or archive closed tabs.

Code comments use one soft light-gray (`#e6e8eb`) rounded card per conversation, with avatar-aligned sans-serif author/body text, compact relative timestamps (exact date on hover), indented unboxed replies and a blue Add reply… disclosure. New-comment composers share the card style. The root gray/yellow/green agent-status band spans the conversation; follow-up requests keep their own acknowledgement. Share/delete appear on hover or keyboard focus. Preserve resolved folding, comment navigation, search and unsent reply drafts through metadata refreshes. Main-view conversation styling and comment publication rules are unchanged.

Own PRs offer Merge in the status dropdown, disabled for drafts and closed PRs. Show per-PR Merging… progress, suppress duplicate requests and switch to green Merged only after GitHub accepts the merge. Recheck the authenticated author, current state and merge readiness; require the displayed/reviewed head SHA so a newer push cannot be merged silently. Prefer a merge commit when enabled, otherwise squash, then rebase. Errors keep the prior state, and merge actions never trigger Slack review reactions. Older metadata responses cannot overwrite a confirmed merge.

### Independent Git storage for PR closing

- New PRs share a separate shallow repository cache, never another PR's checkout or a user clone. Local clones supply snapshots read-only.
- Closing older PRs retains shared object files and redirects borrowers atomically, without repacking Git history. Broken unrelated cache refs do not block closure.
- Keep the immediate UI close and unpublished-work protections. Collect caches after their last managed dependency disappears, including during the fourteen-day workspace sweep; never retain closed review records or workspaces.

### Code-thread authorship and Codex

- Determine the original author through local and GitHub reply chains before queueing, sending, listing, retrying, picking up or answering a Codex request. Missing/cyclic ancestry and unknown identity cannot grant access.
- Show the GitHub composer for replies to other reviewers on my own PRs. Clear obsolete Codex deliveries/status indicators without publishing any previously private replies; fresh replies follow the corrected route.

### Reliable cleanup after interrupted deletion

- Review Git commands do not run checkout hooks that generate personal files or background jobs.
- Retry interrupted cleanup only after checking all remaining files against the saved PR snapshot. Actual unpublished files, branches and unsafe paths remain protected. Retry transient deletion failures automatically.

- Closing a managed review also recognizes a complete imported index paired with an older HEAD. Verify the whole staged tree against the independent snapshot cache; keep actual unpublished edits and local branches protected.
