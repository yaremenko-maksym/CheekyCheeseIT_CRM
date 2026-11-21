# Rationale — `eslint-mcp-first.md`

Rule: `.claude/rules/common/eslint-mcp-first.md`

## Provenance

Phase 2.5 of the ECC migration (2026-06-03) replaced a PostToolUse post-edit lint hook with a
lint-before-edit call to the `eslint` MCP server. The hook script was deleted in the Phase 6 hooks
cleanup the same day; it is no longer on disk and its registration is gone from `.claude/settings.json`.
The eslint MCP flow in the rule fully supersedes it.
Deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md`.

## Why the post-edit hook was replaced

The old flow: an agent wrote a file, the PostToolUse hook ran eslint (~1–3 s), and the errors were
injected into the next turn via `additionalContext`. Its problems:

- Feedback arrived after the edit, when the agent had already moved on.
- A hot loop on chunked edits: every Edit re-ran a full eslint pass on the same file, so N small
  edits cost N runs.
- The hook silently no-oped on web files in some configurations.
- It used cwd-anchored binary paths (the per-app `node_modules/.bin/eslint`), brittle when the
  agent's cwd was a worktree elsewhere.

The new flow: the agent reads the lint requirement before editing, calls the MCP with the target
path, sees the errors in its own context, and edits once with the fix already in. It wins on
latency, on flow, and on robustness: the MCP resolves the project-root flat config without guessing
the cwd.

## Rollback

The Phase 2.5 deliverable documents the rollback as re-adding the hook entry to the PostToolUse
matchers in `.claude/settings.json`. That is no longer enough on its own: the script the entry
registered was deleted in Phase 6, so a rollback must also restore the script from git history.
