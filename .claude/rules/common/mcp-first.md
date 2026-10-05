# Rule: MCP-first tool priority

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents) + Master (orchestrator)
**Source:** Project hard requirement (CLAUDE.md "MCP servers — USE FIRST") + Phase 2.5 activation of `eslint` MCP

---

## The rule

```
An MCP tool fits? → use MCP
No MCP, there is a native one (Read/Edit/Write)? → native
Only via shell? → Bash
```

Never use Bash where a suitable MCP exists.

## MCP catalog (what, when)

| Task                                                                 | MCP / Tool                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Find a function / class / import / pattern in code (AST)             | `mcp__ast-grep__find_code`, `find_code_by_rule`                                                                                                                          |
| "How X works" / architecture / blast-radius / call-sites of a symbol | `mcp__codegraph__codegraph_explore` (PRIMARY, ask BEFORE editing), `codegraph_callers`, `codegraph_search`, `codegraph_node` — pre-indexed graph, cheaper than grep/Read |
| Check the real DB schema / data                                      | `mcp__postgres__query` — instead of reading `schema.ts`                                                                                                                  |
| NestJS / TanStack / Zod / React / Drizzle documentation              | `mcp__context7__resolve-library-id` → `query-docs`                                                                                                                       |
| Lint check on changed files                                          | `mcp__eslint__lint-files` — instead of waiting for pre-commit                                                                                                            |
| UI check after changes                                               | `mcp__playwright__browser_navigate` + `browser_snapshot` + `browser_take_screenshot`                                                                                     |
| List of changed files in a PR                                        | `mcp__github__get_pull_request_files`                                                                                                                                    |
| PR description / status / labels                                     | `mcp__github__get_pull_request`, `get_pull_request_status`                                                                                                               |
| Reviews / inline comments                                            | `mcp__github__get_pull_request_reviews`, `get_pull_request_comments`                                                                                                     |
| Create a review (APPROVE / COMMENT)                                  | `mcp__github__create_pull_request_review`                                                                                                                                |
| Labels on a PR                                                       | Bash: `gh pr edit --add-label / --remove-label`                                                                                                                          |
| Cross-session wake-up (> 30 min)                                     | `mcp__scheduled-tasks__create_scheduled_task`                                                                                                                            |

## Native tools (when MCP does not fit)

| Tool    | When                                              | When NOT                              |
| ------- | ------------------------------------------------- | ------------------------------------- |
| `Read`  | A specific file whole / a line range              | Search (there is ast-grep)            |
| `Edit`  | Pointed edits in an existing file                 | Full rewrite (use `Write`)            |
| `Write` | Create a new file / full rewrite                  | Without a `Read` of the existing file |
| `Bash`  | `git`, `gh`, `pnpm`, operations without an MCP    | Where an MCP exists                   |
| `Agent` | Parallel / isolated task (Master → agents)        | Simple single-file tasks              |
| `Skill` | Invoking superpowers (see `skills-invocation.md`) | —                                     |

## Concrete rules (mandatory)

- Before writing any service / hook / component → `ast-grep find_code` to find an existing analog.
- Before changing an existing exported symbol → `codegraph_callers <symbol>` / `codegraph_explore` for blast-radius (resolves cross-file references more precisely than grep). An architectural question "how does X work" → `codegraph_explore` BEFORE reading files.
- Before `pnpm --filter @crm/api db:generate` → `postgres query` to check the current schema.
- After each Edit / Write on `.ts` / `.tsx` → `eslint lint-files` instead of waiting for the pre-commit hook. Details — `.claude/rules/common/eslint-mcp-first.md`.
- For any NestJS / TanStack / Zod / Drizzle API — `context7` first, do not guess.
- Before writing `getByRole` / `getByText` (E2E) → `playwright browser_snapshot` to see the real DOM.
- For seed data in tests (id, email, amounts) → `postgres query`, not hardcode.

## Related rules

- `.claude/rules/common/eslint-mcp-first.md` — details of the ESLint MCP replacement for the post-edit hook.
- Superpowers skills invocation — `.claude/rules/common/skills-invocation.md`.

## Sources

- CLAUDE.md "MCP servers — USE FIRST"
- Phase 2.5 deliverable: `docs/architecture/2026-06-03-phase2.5-deliverable.md`
- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` §2.7 (MCP configs)
