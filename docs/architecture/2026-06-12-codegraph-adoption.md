# CodeGraph adoption — code knowledge graph MCP for agents

**Date:** 2026-06-12
**Status:** Applied (local dev-environment tooling; not product code)
**Scope:** Claude Code agent effectiveness — replaces the previously-broken
`CodeGraphContext` MCP with [`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph).

---

## Context

A code-graph MCP was already wired into the project (`coder` agent referenced
`mcp__CodeGraphContext__*`, post-feature checklist says "code graph MCP first for
navigation"), but it was **dead**: `claude mcp list` showed `CodeGraphContext`
(`cgc serve`) as `✗ Failed to connect`. `cgc` (v0.4.7) needs an external
**FalkorDB/Neo4j** graph database running; none was up, so every agent session
pointed at non-functional tools.

`colbymchenry/codegraph` (48k★, MIT, actively maintained) is a strictly lighter
replacement: **SQLite + bundled runtime, zero external DB**, tree-sitter
extraction, native-OS file-watch auto-sync, and framework-aware routing for our
exact stack (NestJS + TanStack + Express). Reported ~16% cheaper / ~58% fewer
tool calls vs grep/read exploration.

## Decision

Replace `CodeGraphContext` with `codegraph`.

- Install: `npm i -g @colbymchenry/codegraph` (v1.0.0).
- Telemetry disabled (`codegraph telemetry off`) — private commercial codebase.
- MCP config (`~/.claude.json`, project-scoped): removed `CodeGraphContext`,
  added `codegraph` → `{"command":"codegraph","args":["serve","--mcp"]}`.
- Index built at the **main checkout** root (`.codegraph/`, gitignored).
- Tools exposed: `codegraph_explore` (PRIMARY — ask before editing),
  `codegraph_callers`, `codegraph_search`, `codegraph_node`.

Agent wiring updated: `.claude/agents/coder.md` (frontmatter tool list + reuse /
blast-radius guidance) and `.claude/rules/common/mcp-first.md` (MCP catalog +
mandatory rule) now point at `codegraph` for navigation and blast-radius.

## The worktree-duplication problem (and the patch)

**Symptom:** the first index produced **94,452 nodes** and every symbol appeared
once per live worktree (`buildProfileView` ×12, `JwtAuthGuard` across 5+
worktrees). Searches and blast-radius became unusable noise.

**Root cause (CodeGraph issue #514 behaviour):** our agent factory creates
**linked git worktrees** under `.claude/worktrees/<name>/` (each its own `.git`,
same git-common-dir). CodeGraph deliberately discovers _gitignored embedded git
repos_ and indexes them anyway, **uniformly overriding the parent `.gitignore`**
— a feature for multi-repo "super-repos". Our worktrees match that pattern
exactly. Verified by reading the bundled extractor (`findIgnoredEmbeddedRepos`
→ `collectGitFiles`; `ScopeIgnore.ignores` applies built-in defaults to the full
path). Consequences:

- `.gitignore` / `.git/info/exclude` rules **cannot** exclude them (tested — no
  effect; the child worktree re-roots git and its files are "tracked").
- There is no config file / `.codegraphignore` / env var opt-out.
- The **only** filter that applies to embedded repos is the hard-coded
  `DEFAULT_IGNORE_DIRS` set in the extractor.

**Why not the obvious alternatives:**

- _Relocate worktrees outside the repo_ — location is Claude Code harness
  behaviour; `.claude/worktrees/*` is also a zone-of-write allow-path and the
  light-track rule references it. High blast radius; rejected.
- _Delete the worktrees_ — almost all hold unmerged commits (`ahead=6..17`) or
  uncommitted changes (live multi-agent work). Unsafe; rejected.

**Fix applied:** add `.claude` to CodeGraph's `DEFAULT_IGNORE_DIRS`. The same
`ScopeIgnore` governs both the indexer and the file-watcher (single source of
truth in the bundle), so this keeps `.claude/` — including the nested worktree
checkouts — out of the graph durably, including auto-sync. Result:
**94,452 → 7,422 nodes, 0 worktree paths**, index 490MB → 28MB, reindex 1:51 → ~10s.

### ⚠️ Maintenance caveat

The patch edits the installed per-platform bundle and is **lost on
`codegraph upgrade` / reinstall**. Re-apply with the idempotent script, then
rebuild:

```bash
bash scripts/devops/codegraph-patch-ignore-claude.sh
codegraph index . --force
```

The script is version-robust (anchors on the `DEFAULT_IGNORE_DIRS = new Set([`
declaration, marks with a `CRM-PATCH:ignore-claude` sentinel, refuses to write if
the result fails `node --check`).

### Upstream

The clean long-term fix belongs upstream: CodeGraph should skip **linked**
worktrees (same `git --git-common-dir`) when recursing embedded repos, since they
are the same repo, not independent clones. Worth filing against
`colbymchenry/codegraph`.

## What is committed here vs local-only

- **Committed (this PR):** `.gitignore` (`.claude/worktrees/` + `.codegraph/`),
  `coder.md` + `mcp-first.md` tool wiring, the re-apply script, this doc.
- **Local-only (per-machine, not in repo):** the global `npm` install, the
  `~/.claude.json` MCP swap, the bundle patch, the `.codegraph/` index.
