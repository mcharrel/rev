# 9. Data Storage

Requirements for data persistence, database schema, and data management.

## Functional Requirements

### 9.1 Database

- The system shall use PGLite (embedded PostgreSQL compiled to WASM) as the database engine.
- Database files shall be stored locally and **project-local**, under the review's data directory at `<repo>/.glassbox/data/reviews` (the data directory defaults to `<cwd>/.glassbox` and is overridable with `--data-dir`; see `src/cli.ts` → `setDataDir` in `src/db/connection.ts`). This is distinct from the **global config** directory `~/.glassbox` (§9.3), which holds machine-wide settings including AI configuration, company deployment sources and custom themes — the review database itself never lives under `~/.glassbox`.
- The database schema shall be initialized automatically on first use.
- Schema migrations shall be applied safely on startup without data loss.
- The application tables shall live in the `template1` database. PGLite ≤0.3.x used `template1` as its default working database; PGLite 0.4.0 changed the default to `postgres`. To keep existing on-disk data dirs readable across that upgrade, the connection explicitly pins `database: 'template1'` (see `src/db/connection.ts`) so the storage location is identical for both pre-0.4 and freshly created databases. A future PGLite upgrade must preserve this option (or perform a one-time `template1` → `postgres` data migration) or existing users' reviews will appear to vanish.

### 9.1a PostgreSQL Major-Version Upgrades

PGLite embeds a fixed PostgreSQL major and ships no `pg_upgrade`, so a data directory written by an older engine cannot be opened at all — the failure is total, and PGLite reports it as a bare `PGlite failed to initialize properly`, indistinguishable by message from real corruption. PGLite 0.5.0 moved the embedded engine from PostgreSQL 17 to 18, which every existing user's data directory predates.

- On an open failure, the system shall attempt a one-time major-version migration **before** the corruption-recovery path in §9.5, and shall skip it when the directory's major already matches the running engine.
- The migration shall read the on-disk major from `PG_VERSION` **without booting the cluster**, so the check costs nothing for directories that do not need it.
- The old engine shall be **downloaded on demand** (pinned version, verified against a `sha512` integrity hash) rather than shipped, and removed once the migration completes — shipping a second ~25 MB engine permanently would burden every user for a one-time, once-per-user operation.
- The migration shall write to a **staged sibling** directory and shall move it into the canonical location only after post-migration validation passes; the original directory shall never be modified in place.
- A copy of the original shall be retained alongside the upgraded database, taken **before** the old engine opens the directory (starting a cluster can write to it during recovery, so a later copy would not reflect what the user had). Exactly one copy shall be kept — the swap's own displaced copy is discarded so an upgrade does not double the on-disk cost.
- The migration shall tolerate **columns the current schema no longer declares**. A long-lived database accumulates columns from features that were later removed: the revert drops them from the DDL but `ALTER TABLE ADD COLUMN` is never undone on disk, so the old cluster still carries them. Because the transfer copies *source* columns, an unhandled one fails the whole migration and leaves the database unopenable. The system shall recreate such columns on the staged target, transfer them, verify them as part of full validation, and only then drop them — so the obsolete data is proven to have moved correctly before it is deliberately discarded, rather than skipped unverified. A *table* the current schema no longer has is out of scope and is left to the transfer to report; recreating one would resurrect a schema the app deliberately dropped.
- When the migration cannot complete, the system shall **fail to start with an actionable message** naming the source major and the blocking reason, and shall **not** fall through to the quarantine path in §9.5. The message shall report the reason without asserting a cause — an earlier version asserted "this most often means no network connection", which misdirected on the first real-world failure (a schema mismatch). Quarantining would leave an empty cluster at the canonical path and strand the user's history permanently, since no later launch would retry; failing loudly keeps the data in place and self-heals once the user is online.

- The retained copy shall be **surfaced to the user, not silently deleted**. Settings → General shall show a **Database backups** section listing each retained backup with its size on disk, when it was taken, and its absolute path, with a **Delete** action behind a confirmation. The section shall render only when a backup exists, so the overwhelming majority of users — who never upgrade across a Postgres major — never see it. This follows the same stance as §9.5: the app preserves the user's data and lets *them* decide when it is no longer needed.
- The delete action shall be scoped to backups. Only a `reviews.bak-<timestamp>` sibling may be removed; the live cluster, a staged `reviews.migrating-<timestamp>` directory, and the quarantined `reviews.unreadable-<timestamp>` directories from §9.5 shall all be refused.
- The quarantined directories from §9.5 shall be listed in their **own** section — "Preserved unreadable data" — with a **Reveal** action that opens the OS file manager and **no delete**. Keeping them separate is the requirement, not an implementation detail: a backup is redundant by construction (the migration validated every row reached the live cluster), whereas a quarantined directory is data Glassbox *failed* to read and may be the user's only copy. Presenting both with the same affordance would flatten a distinction the user needs in order to decide safely, so Glassbox points at the unreadable data and leaves removing it to them.

Implemented by `src/db/migrate-major.ts` (`migrateMajorIfNeeded`) over the `pglite-migrate` library, called from `getDb()`; the listing, deletion, and reveal by `src/db/backups.ts` behind `GET /api/db-backups`, `DELETE /api/db-backups/:name`, and `POST /api/db-backups/:name/reveal`, rendered by `src/client/settings/generalTab.tsx`. Covered by mocked unit tests plus a live PG17→PG18 round-trip (`npm run test:live`) and an e2e over the settings section.

### 9.2 Data Model

The system shall persist the following seven entities:

- **reviews** — Review sessions with repository path, name, mode, mode arguments, HEAD commit, status (in_progress/completed), and timestamps.
- **review_files** — Files within each review with file path, review status (pending/reviewed), and serialized diff data.
- **annotations** — Line-level annotations with file reference, line number, side, category, content, stale flag, and timestamps.
- **ai_analyses** — AI analysis run records with review reference, analysis type, status, progress, and error tracking.
- **ai_file_scores** — Per-file AI scores with analysis reference, sort order, aggregate score, dimension scores, rationale, and notes.
- **user_preferences** — Singleton record for UI preferences (sort mode, risk dimension, score visibility).
- **attachments** — Reviewer file attachments on an annotation (doc 25), referencing the owning annotation, with original filename, on-disk stored path, MIME type, size, and optional sha256. Bytes live on disk under `<dataDir>/attachments/`; this table holds the metadata.

### 9.3 Configuration Files

- Global AI configuration shall be stored in `~/.glassbox/config.json` with `0600` file permissions.
- The global config directory shall default to `~/.glassbox` but be overridable via the `GLASSBOX_CONFIG_DIR` environment variable, so automated runs (notably the e2e suite) can redirect global state — AI platform/keys, custom themes — to a disposable directory instead of mutating the developer's real config (GB-923).
- Project-specific settings shall be stored in `<repo>/.glassbox/settings.json`.
- Project-specific settings shall also be accessible via `GET /api/project-settings` and `PATCH /api/project-settings` API endpoints.
- API keys in the config file shall be stored with base64 encoding.

## Non-Functional Requirements

### 9.4 Data Locality

- All user data shall remain on the local machine. No data shall be transmitted to external services except AI API calls when explicitly opted in.
- No accounts, telemetry, or usage tracking shall be implemented.

### 9.5 Data Integrity

- Database operations shall use raw SQL queries (no ORM).
- Entity IDs shall be generated using `Date.now().toString(36) + Math.random().toString(36).slice(2, 10)`.
- The system shall not corrupt data on unexpected shutdown (PGLite handles WASM-level crash recovery).
- A data directory that cannot be opened shall never be deleted. "The engine could not open it" is not the same as "the bytes are worthless" — the same failure is produced by a half-written WAL, a file locked by another process, or a directory written by a different PostgreSQL major (§9.1a). The system shall move it aside to `reviews.unreadable-<timestamp>`, print that path, and start fresh; if it cannot be moved, the system shall rethrow rather than fall back to deleting.

### 9.6 Data Isolation

- Reviews from different repositories shall be isolated by `repo_path`.
- The instance lock file (`glassbox.lock`) shall prevent concurrent database access from multiple processes.

### 9.7 Managed Workspace Retention

The personal fork checks on startup and hourly for disposable PR checkouts and comment-agent worktrees unused for 14 days. Persist review use and agent completion timestamps; local polling must not refresh them. Remove only verified managed directories, preserving the selected PR, the server checkout, running operations, offline writes, local files/commits, user branches, locked worktrees, initialized submodules and the Git objects still needed by another checkout. Retain shared object bytes independently before removing a legacy provider; unregister agent worktrees through Git without force.

Age-based cleanup of open tabs preserves the database, comments, attachments and reading state. Reopening an expired checkout recreates its saved base/head without rewriting review records or refreshing GitHub metadata, and the client shows pending source until restoration finishes. Cleanup and import/restoration are serialized per PR, and selection/activity is rechecked before deletion. The sweep itself makes no GitHub requests.

Closing a PR tab is permanent local deletion, independent of the fourteen-day checkout expiry. Remove its review rows (including annotations, attachments and AI results), attachment bytes, exports, managed checkouts, comment queues, Codex bindings, client sessions, drafts and per-review reading preferences. Do not send queued comments after closing or accept late Codex replies. Reopening starts a new review. Purge legacy archived tabs at startup. Finish in-flight imports before deletion and preserve dependent Git objects in an independent cache so other tabs remain usable. Never repack borrowers or traverse their history when closing a tab. Keep user-owned clones and remote GitHub content intact. Close immediately regardless of PR state, unpublished app-owned files/commits or agent status. Persist removal before asynchronous cleanup; errors must never restore the tab. Keep only minimal cleanup identifiers in a private retry queue, retry at startup and every five minutes, and remove each record after cleanup. Filesystem safety checks still protect user-owned clones, symlink targets and shared dependencies; a failed cleanup stays separate from the closed UI. Pending network delivery is saved in the client and retried without restoring content. Only an explicit open may create a fresh tab; show it immediately, but defer creating its source until old cleanup can no longer delete the new checkout. Closing the launch tab or the final tab must still leave the empty workspace usable, including after restart; retain a workspace-initialized flag, with no closed-tab history after cleanup.

Company deployment configuration is stored under `companyDeployments` in the global config, never in project settings or workspace snapshots. It contains enabled state, organization scope, source type, command, endpoint and an optional Authorization header; file permissions are 0600. Missing or invalid configuration disables tracking. Workspace snapshots contain only results and sanitized status messages, not connection settings.

Slack review preferences store a `provider` choice (`token` or `claude`) alongside enabled state and emoji names in local global configuration. Older settings default to `token`. Slack app tokens stay in the OS keychain; Claude OAuth remains owned by Claude Code and is never copied into rev. Test message links and test confirmations are transient dialog state, not saved configuration.

### 9.8 Independent Git Object Cache

PR checkouts shall borrow snapshots from a dedicated app-owned bare cache per repository under `<dataDir>/git-cache/`, never from another PR checkout. Local user clones may supply snapshot bytes but must not gain refs or become a lifetime dependency of new checkouts. Fetch only the required head and exact merge-base snapshots, not a history window.

For legacy checkouts, preserve a closing provider's object files in a separate cache using hard links (copying when unavailable), then atomically redirect its borrowers. Preserve inherited alternate paths, including relative paths and multi-hop dependencies. Do not run `git repack`, and do not inspect unrelated borrower refs. A failed or interrupted migration must leave every published dependency usable and retain the original checkout until migration succeeds.

Imports may run concurrently; object relocation and cache collection must wait for imports and block new imports until finished. Collect caches only when no managed checkout references them, following the full alternate graph. Collect after closing or expiring source and during startup/hourly cleanup, including abandoned imports and unreferenced migration segments. Refuse unsafe symlink layouts; never delete user-owned clones. Shared Git bytes may outlive one PR only while another managed checkout depends on their store; closed reviews, tab records, comments and workspaces are still deleted.

Managed review Git operations disable hooks, preventing checkout side effects from creating ignored files or background jobs. If cleanup was already marked as evicted and lost its Git HEAD and index, closure may retry only after every remaining file, mode and symlink matches the recorded head snapshot in the independent cache. Missing snapshot files are expected after partial deletion; unknown or modified files, a surviving index, local branches and submodules still prevent deletion. Retry transient filesystem deletion failures before reporting failure.

Explicit Close discards app-owned source regardless of staged, unstaged, ignored or untracked content, local branches and unpublished commits. Conservative source disposal and automatic fourteen-day expiry retain their unpublished-work checks. Closure does not fetch from GitHub or change the remote PR.

Interrupted initial checkouts with source files but no HEAD, index, local refs, submodules or worktrees recover automatically: move its source files into a per-PR `checkout-recovery` folder before rebuilding source. Leave the original Git object directory in place so legacy borrowers stay usable. Preserve unknown files byte-for-byte; never reset or overwrite staged edits, established checkouts or external symlink targets. Recovery copies may contain unpublished work, so retain them until the PR is explicitly closed, when background cleanup removes them too. The server log records their location.
