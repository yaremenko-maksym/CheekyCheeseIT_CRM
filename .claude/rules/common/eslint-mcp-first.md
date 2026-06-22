---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Use the `eslint` MCP for code linting (replaces post-edit hook feedback)

Status: active as of Phase 2.5 (2026-06-03). Supersedes
`.claude/hooks/eslint-feedback.sh` (deprecated, removed from
`.claude/settings.json` live registration).

## When this rule applies

Before suggesting an Edit / Write to any `.ts` or `.tsx` file under
`apps/**` or `packages/**`, run lint via the `eslint` MCP server.

## How to call

```
mcp__eslint__lint-files
  files: ["apps/api/src/<your-path>"]
```

(For `apps/web`: `apps/web/app/<your-path>`. The MCP picks up the right
flat-config from `apps/api/eslint.config.mjs` or
`apps/web/eslint.config.mjs` automatically based on the file path.)

If the MCP returns errors → fix in the same suggestion. Do not push a
suggested patch that you know fails lint.

If clean → proceed with the Edit/Write.

## Why we replaced the post-edit hook

Old flow:

1. Coder/AutoTest writes a file.
2. PostToolUse hook fires `eslint-feedback.sh`.
3. eslint runs (~1-3s).
4. Errors injected into context via `additionalContext`.
5. Next agent turn sees them and (maybe) fixes them.

Problems:

- Feedback arrived AFTER the edit, after the agent had moved on mentally.
- Hot loop on chunked edits: every Edit triggered a full eslint pass on
  the same file. Network of small edits = N eslint runs.
- The hook quietly no-oped on web files in some configurations.
- Used cwd-anchored binary paths (`apps/web/node_modules/.bin/eslint`) —
  brittle when the agent's cwd was a worktree under `/tmp/`.

New flow:

1. Agent reads the lint requirement BEFORE editing.
2. Calls eslint MCP with the target file path.
3. Sees errors in agent context, decides on fix strategy.
4. Edits once with the fix already incorporated.

This is a strict win on latency, on cognitive flow, and on robustness
(MCP picks up project-root-relative config without cwd guessing).

## Fallback

If the eslint MCP is unavailable in a particular session (e.g. Coder
worktree without MCP install), fall back to running `pnpm --filter
@crm/api lint <file>` or `pnpm --filter @crm/web lint <file>` from the
worktree root before commit. The pre-push hook will catch unlinted code
at the commit-message verification stage too (indirectly, via
`ac_verified:` requirement — Coder cannot honestly mark AC verified if
lint is red).

## Migration notes

- Old `.claude/hooks/eslint-feedback.sh` was **deleted** in the Phase 6
  hooks cleanup (2026-06-03) — it is no longer on disk. The eslint MCP flow
  above fully supersedes it.
- Rollback: re-add the entry to `.claude/settings.json` PostToolUse
  matchers. See `docs/architecture/2026-06-03-phase2.5-deliverable.md`.
