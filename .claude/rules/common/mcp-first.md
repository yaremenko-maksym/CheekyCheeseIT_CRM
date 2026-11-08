# Rule: MCP-first tool priority

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents) + Master (orchestrator)

> Rationale: `docs/architecture/rules-rationale/mcp-first.md`

---

## The rule

```
An MCP tool fits? → use MCP
No MCP, there is a native one (Read/Edit/Write)? → native
Only via shell? → Bash
```

Never use Bash where a suitable MCP exists.

## MCP catalog (what, when)

| Task                                                                                                                                                                  | MCP / Tool                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Find a function / class / import / pattern in code (AST)                                                                                                              | `mcp__ast-grep__find_code`, `find_code_by_rule`                                                                                                                          |
| "How X works" / architecture / blast-radius / call-sites of a symbol                                                                                                  | `mcp__codegraph__codegraph_explore` (PRIMARY, ask BEFORE editing), `codegraph_callers`, `codegraph_search`, `codegraph_node` — pre-indexed graph, cheaper than grep/Read |
| **SQL DDL, shell scripts, JSON** — "which trigger / index / reference touches table T", "what does script S call or source" (codegraph returns **nothing** for these) | **CLI, not MCP:** `graphify query\|affected\|explain` over `graphify-out/graph.json`, built by `scripts/devops/build-graphify.sh` — see `graphify.md`                    |
| Check the real DB schema / data                                                                                                                                       | `mcp__postgres__query` — instead of reading `schema.ts`                                                                                                                  |
| NestJS / TanStack / Zod / React / Drizzle documentation                                                                                                               | `mcp__context7__resolve-library-id` → `query-docs`                                                                                                                       |
| Lint check on changed files                                                                                                                                           | `mcp__eslint__lint-files` — instead of waiting for pre-commit                                                                                                            |
| UI check after changes                                                                                                                                                | `mcp__playwright__browser_navigate` + `browser_snapshot` + `browser_take_screenshot`                                                                                     |
| List of changed files in a PR                                                                                                                                         | `mcp__github__get_pull_request_files`                                                                                                                                    |
| PR description / status / labels                                                                                                                                      | `mcp__github__get_pull_request`, `get_pull_request_status`                                                                                                               |
| Reviews / inline comments                                                                                                                                             | `mcp__github__get_pull_request_reviews`, `get_pull_request_comments`                                                                                                     |
| Create a review (APPROVE / COMMENT)                                                                                                                                   | `mcp__github__create_pull_request_review`                                                                                                                                |
| Labels on a PR                                                                                                                                                        | Bash: `gh pr edit --add-label / --remove-label`                                                                                                                          |
| Cross-session wake-up (> 30 min)                                                                                                                                      | `mcp__scheduled-tasks__create_scheduled_task`                                                                                                                            |

## Native tools (when MCP does not fit)

`Read` a file / line range (not for search); `Edit` pointed edits; `Write` new file or full rewrite (never without a `Read` of the existing file); `Bash` for `git`, `gh`, `pnpm` and ops without an MCP; `Agent` for parallel / isolated tasks (not simple single-file ones); `Skill` for superpowers (`skills-invocation.md`).

## graphify alongside codegraph

`.sql` / `.sh` / `.json` questions go to the graphify CLI (codegraph indexes none of them); `.yaml`
stays codegraph; `.md` goes to neither tool (`Read` / `Grep`). Hard bans, always: `graphify extract` only with `--code-only`; never `--no-gitignore` or `--postgres`; never `graphify label`; `cluster-only` only with `--no-label`. **Before you run any `graphify`
command or register an MCP server, read `.claude/rules/common/graphify.md`**: it lists the flags
and subcommands that are forbidden. It also auto-loads when you open a `.sql`, `.sh` or `.json` file.

## Concrete rules (mandatory)

- Before writing any service / hook / component → `ast-grep find_code` to find an existing analog.
- Before changing an existing exported symbol → `codegraph_callers <symbol>` / `codegraph_explore` for
  blast-radius (resolves cross-file references more precisely than grep). An architectural question
  "how does X work" → `codegraph_explore` BEFORE reading files.
- Before `pnpm --filter @crm/api db:generate` → `postgres query` to check the current schema.
- After each Edit / Write on `.ts` / `.tsx` → `eslint lint-files` instead of waiting for the
  pre-commit hook. Details — `.claude/rules/common/eslint-mcp-first.md`.
- For any NestJS / TanStack / Zod / Drizzle API — `context7` first, do not guess.
- Before writing `getByRole` / `getByText` (E2E) → `playwright browser_snapshot` to see the real DOM.
- For seed data in tests (id, email, amounts) → `postgres query`, not hardcode.

## Related rules

- `.claude/rules/common/eslint-mcp-first.md` — details of the ESLint MCP replacement for the post-edit hook.
- Superpowers skills invocation — `.claude/rules/common/skills-invocation.md`.
