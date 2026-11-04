# 5. Annotations

Requirements for creating, managing, and categorizing line-level annotations.

## Functional Requirements

### 5.1 Annotation Creation

- **Click to annotate** — Users shall be able to click any diff line to open an annotation form. A click is defined as a mousedown followed by a mouseup without significant movement (≤5px). Dragging to select text shall not trigger annotation creation.
- **Annotation content** — Each annotation shall consist of:
  - Free-text content (the comment)
  - A category (from a fixed set)
  - The target line number
  - The target side (old or new)
- **Immediate save** — Annotations shall be saved immediately on form submission.

### 5.2 Annotation Categories

The system shall support seven annotation categories, each with specific semantics for AI tool consumption:

- **bug** — A code defect that needs fixing.
- **fix** — A specific fix that should be applied.
- **style** — A stylistic preference to apply to the indicated lines and similar patterns.
- **pattern-follow** — A good pattern to continue using in new code.
- **pattern-avoid** — An anti-pattern that should be refactored and avoided.
- **note** — Informational context for the AI to consider (may not require code changes).
- **remember** — A rule or preference to persist to the AI's long-term configuration (e.g., CLAUDE.md, .cursorrules).

### 5.3 Annotation Editing

- **Edit content** — Users shall be able to edit annotation content after creation (double-click or edit button).
- **Change category** — Users shall be able to change an annotation's category by clicking its category badge.
- **Delete** — Users shall be able to delete individual annotations.

### 5.4 Annotation Drag and Drop

- **Drag to move** — Users shall be able to drag annotations to a different line or side within the same file.
- **Visual feedback** — Drag targets shall provide visual feedback (highlight) during drag operations.

### 5.5 Stale Annotation Handling

- **Fuzzy migration** — When diffs are updated (e.g., on review resumption), the system shall attempt to migrate annotations to their new line positions using fuzzy matching.
- **Match radius** — Fuzzy matching shall check line content within a 10-line radius of the original position.
- **Stale marking** — Annotations that cannot be matched shall be marked as "stale" with a visual indicator: the annotation row is dimmed (`opacity: 0.7`) and gains an orange left border plus a faint orange background tint (see `src/client/styles/_annotations.scss`).
- **Individual keep** — Users shall be able to individually mark a stale annotation as "current" (keep it).
- **Batch delete** — Users shall be able to batch-delete all stale annotations for a review.
- **Batch keep** — Users shall be able to batch-keep all stale annotations for a review.

### 5.6 Annotation Display

- **Inline rendering** — Annotations shall be rendered inline, directly below their target diff line.
- **Display elements** — Each annotation shall display its category badge, content, and action controls (edit, delete, drag handle).
- **Sidebar counts** — The sidebar shall show annotation counts per file.

## Non-Functional Requirements

### 5.7 Persistence

- **Immediate persistence** — All annotations shall be persisted to the database immediately on creation or modification.
- **Survive restarts** — Annotations shall survive application restarts.

Personal fork: posted code comments use neutral bordered cards, author avatars and read-only text. Delete and Keep remain available; category, drag, attachment and edit controls are omitted. New comments are notes. Composers omit the redundant line label and explain whether the comment goes to the original agent or GitHub.

In the personal workspace, Enter saves and Shift+Enter inserts a newline. On an own PR, self-authored code threads remain local and the viewer’s follow-ups route to the originating Codex chat. Replies in another author’s code thread, other-PR code comments and all Main-view comments publish through the GitHub outbox with five-minute retries. No isolated comment agent is started. New agent replies check for pushed commits: refresh automatically away from code, otherwise show the orange topbar Refresh button. Unsaved drafts also defer automatic refresh. See [MY_GLASSBOX.md](../MY_GLASSBOX.md).

Personal GitHub workspace: remote inline threads require a current line anchor. Missing/outdated anchors are omitted rather than prepended to the file. Unified rows retain both original and new coordinates for old-side comment placement.

Resolved GitHub code threads fold by default at their current source anchor, with an expandable Resolved row. Manual expansion survives in-memory switches/refreshes; search opens folded matches. Reopened threads unfold. Hovering a deletable comment and pressing `d` invokes the same action as Delete, with typing/dialog/modifier/repeat guards.

Code comments use one soft light-gray (`#e6e8eb`) rounded card per conversation, with avatar-aligned sans-serif author/body text, compact relative timestamps (exact date on hover), indented unboxed replies and a blue Add reply… disclosure. New-comment composers share the card style. The root gray/yellow/green agent-status band spans the conversation; follow-up requests keep their own acknowledgement. Share/delete appear on hover or keyboard focus. Preserve resolved folding, comment navigation, search and unsent reply drafts through metadata refreshes. Main-view conversation styling and comment publication rules are unchanged.

### 5.8 Code Thread Ownership

Codex handles only the authenticated viewer's code requests in threads that viewer started on their own PR. Follow local `parentKey` and GitHub `parentId` chains to the original comment, including through agent replies. A self-authored intermediate reply does not change thread ownership. Missing/cyclic ancestry, unknown PR/viewer identity, another author's request, deleted roots and Main-view comments must not be delivered, listed, picked up or answered. Recheck after asynchronous connection lookup. Imported GitHub comments do not become new agent requests.

New replies in somebody else's GitHub code thread publish through the existing outbox, including on own PRs. The composer must describe that destination. Preserve previously private replies when correcting stale routing, discard their Codex delivery records and pending-pickup indicators, and never publish them retroactively. Private history remains private across refreshes, restarts and account changes.

## 5.9 Agent control isolation

Local agent controls use `REV_CONFIG_DIR` when explicitly set, otherwise the isolated `GLASSBOX_CONFIG_DIR`, otherwise the normal per-user rev directory. Smoke servers and their clients isolate both configuration roots and workspace storage so they cannot overwrite the running desktop’s authenticated connection. Failed connection attempts explain how to restore rev without claiming pickup or completion. Authentication, originating-chat checks, revision checks and reply deduplication remain mandatory.
