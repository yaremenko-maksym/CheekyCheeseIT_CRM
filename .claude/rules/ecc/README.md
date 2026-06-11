# ECC Rules (local curated copy)

Curated subset of the ECC rules pack, imported 2026-06-03 and **pruned 2026-06-11**
(context-diet audit). This is a local copy — upstream installation instructions do
not apply here.

## Precedence (важно)

**Project policy always wins.** On any conflict:

1. `.claude/rules/common/*` — project policy (git, MCP, zones, language, version pins, light-track)
2. `.claude/rules/ecc/*` — advisory style/quality reference (this directory)

## Inventory

- `common/` — coding-style, patterns, security, testing. Path-scoped via `paths:`
  frontmatter — loads only when code files are touched.
- `typescript/` — TS idioms. Path-scoped to `*.ts/tsx/js/jsx`.
- `web/` — frontend patterns, performance budgets, design quality, security headers,
  testing priorities. Path-scoped to `apps/web/**` (testing also `apps/e2e/**`).

## Removed 2026-06-11 (conflicted with project policy or stale)

`common/git-workflow` (contradicted git-policy.md commit format), `common/development-workflow`
and `common/agents` (referenced non-existent agent registry), `common/performance` (stale
model-selection advice, not code rules), `common/hooks` (generic harness advice),
`common/code-review` (superseded by code-reviewer agent + code-review-discipline skill),
`web/hooks` (recommended PostToolUse eslint hooks — superseded by eslint-mcp-first.md).
