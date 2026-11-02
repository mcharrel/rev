# rev

**rev** (formerly MyReview) is a local GitHub pull-request review app, built on [Glassbox](https://github.com/brianwestphal/glassbox). Keep several PRs open, read full-file unified diffs, navigate with the keyboard, and post comments to GitHub without leaving the app.

The `main` branch contains the current personal app, including its Git-graph icon. Legacy `glassbox` commands and data directories remain compatible. This fork is not the upstream `glassbox` npm package.

**For automatic Codex replies on macOS, enable Settings → Experimental → Connect to Codex, then quit and reopen Codex once.** rev handles setup and shows the connection status. No setup prompts or terminal configuration are needed. See [Codex feedback setup](#codex-feedback-setup).

## Install from source

Clone and install the macOS desktop app:

```sh
git clone https://github.com/mcharrel/rev.git && ./rev/install.sh --desktop
```

The script installs dependencies, builds rev into `~/Applications/rev.app`, sets up `~/.local/bin/rev`, and guides you through GitHub sign-in if needed. It adds the command directory to your Bash/Zsh configuration and prints separate next steps for reviewing PRs and connecting Codex. No `sudo` or global npm installation is needed. On Linux, or for a browser-only installation, omit `--desktop`.

You need Git to clone the repository. On macOS, the script uses an existing [Homebrew](https://brew.sh/) installation to install missing Node.js/npm and GitHub CLI dependencies. On Linux, or without Homebrew, install Node.js 22.12+, npm and [GitHub CLI](https://cli.github.com/) first; the installer checks these before building.

Start rev from a new terminal with `rev`, or run `~/.local/bin/rev` immediately. This starts the local app in your browser at `http://localhost:4183`. Use `rev serve --no-open` to run without opening a browser. The server binds only to your computer.

Keep the cloned directory: the command runs the build from that checkout. Rerunning the installer rebuilds it without changing review data or GitHub credentials. It refuses to overwrite an unrelated existing `rev` launcher; use `--bin-dir /another/directory` if needed. Run `./rev/install.sh --help` for the options, including `--no-auth` and `--no-path` for unattended installs.

Open a PR from another terminal or paste its URL into the app's **+** tab:

```sh
rev open https://github.com/OWNER/REPOSITORY/pull/123
```

Trailing GitHub URL fragments and query parameters are accepted. Opening a PR reuses the running app; source downloads and GitHub metadata load in the background. If no server is running, `rev open` starts one without opening a window; start `rev` first for the browser interface, or launch the installed desktop app. Review state and the comment outbox persist locally.

### macOS desktop details

The desktop build requires Xcode Command Line Tools; the script installs missing Rust through Homebrew when available. The first native build takes longer. Quit an existing rev desktop app before replacing it. `--app-dir /another/directory` changes the destination.

The native bundle includes Node and uses local ad-hoc signing, so no release signing keys are required. Upstream automatic updates are disabled for this source build; rerun the installer to update. The `rev` command continues to provide the standalone browser workspace; legacy native `glassbox` launchers remain available in the app bundle.

### GitHub accounts

Sign in to each account with `gh auth login`, then open **Settings → GitHub**. Choose your default GitHub account and add organization → account exceptions. rev selects credentials separately for each PR, including Git fetches, without switching the terminal’s active account. Settings stay in your private `~/.glassbox/config.json`; tokens remain managed by `gh`. Queued comments keep their original publishing identity and are held if you switch accounts.

Existing local organization mappings migrate from `~/.glassbox/workspace-config.json` when you save GitHub settings. For faster imports, that local file can still map repositories to existing checkouts:

```json
{
  "repositories": {
    "OWNER/REPOSITORY": "/path/to/your/local/checkout"
  }
}
```

**PR links on macOS:** GitHub also contains **Open PR links in rev**, enabled by default. On first desktop launch, approve macOS’s request to use **rev Links** as the default browser. It is a small URL router: direct GitHub PR links from Slack or other apps go to rev; other web links go to your previous browser. Links opened explicitly from inside rev still go to the browser. Disabling the setting restores your previous browser. If you dismiss the macOS prompt, use **Enable in macOS** in GitHub to finish setup. Browser-internal navigation and redirect/tracking links remain in the browser. Requires macOS 12 or later and the desktop build.

General contains Theme and Share rev. GitHub contains account and PR-link routing; Slack contains optional review reactions. Experimental and My company remain available; Plugins and Updates tabs are hidden. Claude Channel is a separate Claude Code MCP integration, not the Codex chat connection described below.

Existing local checkouts can speed up first imports. Every open PR tab refreshes GitHub status, reviewers, CI checks, description and comments in the background every five minutes. **Cmd/Ctrl+R** refreshes immediately and loads new source revisions; background refresh keeps the code snapshot stable while you read. Main-view comments publish to GitHub on every PR. On your own PRs, code threads you start stay local; replies in threads started by other people publish to GitHub. Code comments on other people’s PRs also publish to GitHub. Offline writes retry every five minutes. Disposable managed checkouts expire after two weeks without use or updates, with unpublished work preserved.

### Slack review reactions

In **Settings → Slack**, choose **Slack app (user OAuth token)** or **Claude Code (Slack plugin)**. Enable **React to PR reviews in Slack**, customize the approval/change-request emoji and test a reaction on a pasted Slack message link. Reactions are disabled by default; testing adds a real reaction and shows a confirmation only after Slack accepts it.

See [SLACK.md](SLACK.md) for both setup paths, permissions, privacy and troubleshooting. GitHub reviews stay successful even if a Slack reaction fails; **Retry Slack** retries only Slack.

### Deployment status

Merged PRs show deployment status grouped by service instead of CI checks. Each service lists staging datacenters first, then production, then federal (including federal staging); unclassified datacenters follow. Fully reached datacenters come first within each tier. Partial, deploying, missing and unknown states are distinct; hover over a row for environment and namespace details. Status refreshes every five minutes and with Cmd/Ctrl+R, without blocking the review.

Settings → **My company → Deployments** selects a local shell command or an HTTP GET endpoint and an explicit list of GitHub organizations. Tracking is disabled by default. Saving settings cancels old requests, clears old deployment results and refreshes matching merged tabs without blocking the settings dialog. Commands, endpoints and optional Authorization headers live only in the user's global config (`~/.glassbox/config.json`, mode 0600), never in project settings, review exports or the public repository. No company-specific provider configuration ships with the app.

For a command, print a text/Markdown deployment report to stdout. PR values are supplied as environment variables: `REV_PR_URL`, `REV_PR_OWNER`, `REV_PR_REPO`, `REV_PR_NUMBER`; `REV_SERVICES` contains suggested services separated by newlines (empty on the initial request). Quote variables in your command. The command runs from the local configuration directory with your environment; its output is never treated as shell code.

For an endpoint, use an HTTPS URL (HTTP is supported for localhost). URL-encoded placeholders are `{pr_url}`, `{owner}`, `{repo}`, `{number}`, and `{services}` (a JSON array). An optional Authorization header is stored locally. Redirects are not followed. For example: `https://deployments.example/status?pr={pr_url}&services={services}`.

Both sources accept service headings followed by a table:

```text
**example-service**
| Datacenter | Env | Namespace | Deployed |
| east.example | staging | app | (deployed) |
| west.example | prod | app | (ongoing) |
```

Statuses are `(deployed)`, `(ongoing)`, `(missing)`, or unknown. A service heading followed by `Not found` represents an empty result. If the source returns `Changed services found: ` followed by backtick-quoted service names (or `Here is the list of all impacted services detected:` followed by `- name` lines), rev retries once with those services. Each request has a 90-second timeout and a 1 MiB output limit. Source errors are shown without recording raw output or private connection details.

### GUIDE and LEARN

Choose a provider and model in Settings to generate review guidance. API keys belong in local settings or the OS keychain, never in Git. GUIDE and LEARN follow the visible code. Press **a**, then **i** to replace guidance with a fresh review (at most once per five minutes per PR).

## Codex feedback setup

On macOS, install the Codex desktop app in Applications, then:

1. Open **Settings → Experimental** in rev and tick **Connect to Codex**.
2. Quit and reopen Codex once if rev says a restart is needed. Reopen the chat that created your PR.
3. Wait for **Connected**. For an unlinked PR, select its original chat from **Chat for this PR** in the same settings section.

That is the complete setup. rev installs its connection helper, retains it across login, checks compatibility, and reports errors directly in Settings. It does not modify Codex's app bundle, model, permissions, chat history or native-tool authorization. Turning the option off stops forwarding immediately and restores the previous startup setting for the next Codex launch. Existing chats continue running. GitHub review works whether Codex is connected or not.

### Link the original chat

PRs opened with `rev open <PR URL>` from their originating Codex chat are linked automatically through `CODEX_THREAD_ID`. Existing links are preserved. PRs opened from Slack or a normal terminal have no implicit chat: choose the actual originating chat in Settings; rev never guesses or creates a separate agent. The picker lists chats already open in Codex. Other people's PRs cannot be linked.

For agent-driven workflows, run this after creating your draft PR:

```sh
rev open https://github.com/OWNER/REPOSITORY/pull/123
```

This is an agent workflow command, not a setup prompt for the user. Use `~/.local/bin/rev` if your shell resolves the unrelated system `rev` command first. You can also use the chat picker without running any command.

**Main-view comments publish to GitHub on every PR**, including your own, and never go to Codex. Their deletes sync with GitHub too. On **your own PRs**, code threads you start, your follow-ups in those threads, deletes, and Codex replies stay **local to rev**. Replies you write in code threads started by somebody else publish to **GitHub**, without involving Codex. Thread ownership follows the original comment, even when you reply to your own reply further down the thread. Linked comments are saved as `new comment: …`, with the PR URL and source location. With a working push connection, ordinary comments use the original chat's queue; a leading `[steer]` requests immediate steering of its active turn. On **other people’s PRs**, your code comments also publish to **GitHub only**, without Codex watching or answering them. Code comments wait until ownership is known; Main-view comments only need GitHub authentication. A private comment can never become public through a refresh, retry, or account change. Imported GitHub comments and old annotations do not trigger Codex; existing published comments remain on GitHub. rev never starts a separate comment agent.

### Connection and restarts

The checkbox installs a small, private desktop transport adapter and a login helper. The Codex desktop still starts and owns its official server, with all its original arguments and environment. rev connects over a local Unix socket; it never starts a second server against your chat or exposes a TCP listener. The helper and its runtime are copied outside the source checkout so moving rev's sources does not break Codex startup.

The app-server transport is experimental. Setup checks the installed version for the queue/steer methods rev needs. An incompatible version or conflicting custom launcher produces an actionable error without replacing that configuration. Failed setup restores previous startup settings. Existing older rev connections can be adopted without interrupting their running chats.

- **Codex closed:** local code comments wait in rev. Open Codex and the original chat; delivery resumes automatically.
- **Codex restarted:** the connection returns automatically. Reopen the originating chat so it is loaded; its PR association persists.
- **Connection unavailable after an update:** reopen Settings to check status. Turn Connect to Codex off and on to repair the setup, then restart Codex if requested.
- **Uncertain delivery:** check the chat before using Resend. rev does not duplicate a message whose acknowledgement was lost.

No human needs to copy a setup prompt. Settings reports transport readiness; individual comments separately show pending, picked-up and answered status.

### Replies without automatic delivery

You can tell the original chat: “Read my pending rev comments for `<PR URL>`, acknowledge each with `rev pickup`, address them, then answer with `rev reply`.” This works without the shared endpoint; it runs when you ask, rather than waking Codex automatically. Keep rev running and use the same linked chat.

Local code comments have a thin status band inside a neutral card:

- Gray (`#656C76`): pending pickup. Delivery to the chat alone does not change this.
- Yellow (`#D29922`): the agent acknowledged pickup and is working.
- Green (`#00B401`): the agent posted an answer into the comment thread.

The originating agent uses these commands, with `CODEX_THREAD_ID` unchanged:

```sh
# Read outstanding requests, including their IDs, revisions and source context.
rev comments https://github.com/OWNER/REPOSITORY/pull/123
# Acknowledge the returned revision before starting work.
rev pickup https://github.com/OWNER/REPOSITORY/pull/123 --comment COMMENT_ID --revision 1
# Post the answer and mark that request answered in one operation.
rev reply https://github.com/OWNER/REPOSITORY/pull/123 --comment COMMENT_ID --revision 1 --body-file reply.txt
```

Posted comments are read-only; use a follow-up to clarify. Resolved GitHub code threads appear folded at their source line; expand them to read, or find their text through search. A new agent reply checks for pushed commits. Rev refreshes the code while you are away from it, or shows an orange **Refresh** button while you are reading. Click it or press Cmd/Ctrl+R to refresh immediately. Unfinished code-comment drafts defer automatic refresh.

Incoming messages include these instructions. Pickup and reply are idempotent, restricted to the bound chat, and work even when incoming push delivery is unavailable. Revision checks still reject stale pickup/reply attempts for historical requests. A follow-up is a separate request with its own status. Already-posted answers remain visible. Replies appear as **Codex** below the original comment and stay local to rev. No separate chat or model is started.

## Keyboard navigation

| Shortcut | Action |
| --- | --- |
| `r` | Switch Main / File views |
| Tab / `f` | Next change not fully visible; continue to the next file |
| Shift+Tab / `g` | Previous change |
| `c` / `v` | Next / previous comment with source context |
| `d` | Delete the hovered comment, when permitted |
| Cmd/Ctrl+F | Toggle search focus while keeping matches |
| `n` / `m` | Next / previous match across files and comments |
| Escape | Close search without leaving fullscreen |
| Shift+G | Bottom of the file |
| Option+Tab | Next PR |
| Enter / Shift+Enter | Save comment / insert newline |
| Cmd/Ctrl+S | Copy GitHub link for the hovered line or file |
| Cmd/Ctrl+R | Refresh the current PR |
| Cmd/Ctrl+= / − / 0 | Zoom in / out / reset |

Panel sizes and per-PR reading positions are remembered. Source files come first, followed by YAML, tests, dependencies, and generated protos. [MY_GLASSBOX.md](MY_GLASSBOX.md) records the full customization history.

## Update and develop

```sh
cd rev
git pull --ff-only && ./install.sh --desktop
```

Omit `--desktop` for a browser-only installation. Restart the app after updating. To incorporate upstream changes, fetch the original project into an `upstream` remote and merge on a separate branch before updating `main`; personal changes do not prevent future upstream updates.

Run `npm test -- --maxWorkers=4`, `npm run lint`, and `npm run typecheck` before publishing changes. Never commit `.env`, review databases, local workspace mappings, Codex connection files, API tokens, or private PR content. The inherited Glassbox architecture documentation remains under [docs/](docs/).

MIT licensed. Original Glassbox by Brian Westphal; this fork retains its attribution and license.
