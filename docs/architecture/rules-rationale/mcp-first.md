# Rationale: mcp-first

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

- Not an MCP server on purpose: a second server adds its tool set to every agent's context for
  questions asked rarely. Do not register `graphify-mcp`.

---

- Shell coverage is uneven: scripts that dispatch through variables and loops (for example
  `run-guard-tests.sh`) yield almost no edges — static extraction, not a bug. An empty answer there
  means "unknown", not "nothing calls it".

---

## Sources

CLAUDE.md "MCP servers — USE FIRST" · Phase 2.5 activation of the `eslint` MCP:
`docs/architecture/2026-06-03-phase2.5-deliverable.md` · ADR
`docs/architecture/2026-05-31-ecc-migration-design.md` §2.7 (MCP configs).
_(This rule is catalog and mechanism throughout — it has no separate rationale file.)_

---

graphify is an **addition**, not a replacement. It is built locally and code-only (AST, no model call,
nothing leaves the machine) by `scripts/devops/build-graphify.sh` (~45 s) into the gitignored
`graphify-out/`.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

## Native tools (when MCP does not fit)

| Tool    | When                                              | When NOT                              |
| ------- | ------------------------------------------------- | ------------------------------------- |
| `Read`  | A specific file whole / a line range              | Search (there is ast-grep)            |
| `Edit`  | Pointed edits in an existing file                 | Full rewrite (use `Write`)            |
| `Write` | Create a new file / full rewrite                  | Without a `Read` of the existing file |
| `Bash`  | `git`, `gh`, `pnpm`, operations without an MCP    | Where an MCP exists                   |
| `Agent` | Parallel / isolated task (Master → agents)        | Simple single-file tasks              |
| `Skill` | Invoking superpowers (see `skills-invocation.md`) | —                                     |
