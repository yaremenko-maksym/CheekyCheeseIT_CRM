---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Use the `eslint` MCP for code linting (replaces post-edit hook feedback)

> Rationale, why the post-edit lint hook was replaced: `docs/architecture/rules-rationale/eslint-mcp-first.md`

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

## Fallback

If the eslint MCP is unavailable in a particular session (e.g. Coder
worktree without MCP install), fall back to running `pnpm --filter
@crm/api lint <file>` or `pnpm --filter @crm/web lint <file>` from the
worktree root before commit. The pre-push hook will catch unlinted code
at the commit-message verification stage too (indirectly, via
`ac_verified:` requirement — Coder cannot honestly mark AC verified if
lint is red).
