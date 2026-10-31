# Rule: Token economy — spend context on decisions, not on noise

**Status:** Always-on (procedural — observability is the report line below; the RTK hook is advisory and never refuses)
**Applies to:** All agents (Coder, AutoTest, Reviewers, DevOps, Legal, Architect, ui-ux-designer, manual-qa, plus ECC-imported agents) + Master

> Rationale: `docs/architecture/rules-rationale/token-economy.md`

---

## The rule

Tokens are spent three ways: what you **write**, what you **read**, and what you **re-send** (every
step's context is billed again on the next call). Cut all three — without cutting evidence.

1. **Write less.** No preamble, no restating the task, no closing recap of what the diff already
   shows. Report in the fixed lines the project already requires; add prose only for a decision or a
   risk.
2. **Write less code.** Before adding code, climb the ladder: does it need to exist → stdlib / platform
   → an existing dependency or helper in the repo → the smallest thing that works. Validation at trust
   boundaries, RBAC, money, data-loss handling and a11y are never cut.
3. **Read bounded.** Ask the cheapest question that answers yours: `codegraph` / `ast-grep` before
   `Read`; `Read` with `offset`/`limit`; `git diff --stat` before `git diff`; a quiet or summary reporter
   for test and build runs. Never `cat` a large file or dump a whole log into context.
4. **Park bulk output outside the context.** Output over ~200 lines goes to a file in your scratchpad;
   then `grep` / `head` / `wc` it. Breadth-first reading (≥3 modules) is a fan-out
   (`orchestration-routing.md`), not your own context.
5. **Do not re-pay for facts.** A file or result already in this conversation is not read again; a
   decision already made is not re-derived.

## What is never compressed

Terse is for narration only. These stay verbatim and complete, because shortening them is the
`verification-integrity.md` defect:

- code, commands, identifiers, paths, error text, exact counts
- the report lines `Worktree:`, `Pushed:`, `Findings: … (N)`, `ac_verified:`, `Verdict:`, `Skills:`
- security, finance and RBAC findings; decision briefs (`autonomy-levels.md`); legal text; the
  product-facing strings (`uk` / `en` catalogs)

**Filtering must not hide failure.** A bounded read of a result is fine; a bounded read of an
**exit status or a pass/fail count** is not. Keep the count visible (`N passed`, non-zero), and never
add `2>/dev/null` to a command whose output is evidence.

## Installed tools (what binds them)

- **RTK** (hook `pre:bash:rtk-rewrite`, fail-open, fixed binary path, rewrite sanity-checked) compacts Bash output. When output is evidence you must
  read verbatim — a failing test, a diff you will cite, an error — prefix it with `RTK_DISABLED=1` (e.g. `RTK_DISABLED=1 git diff`); `rtk bypass|run|test|err|summary` are refused by `pre:bash:rtk-exec-gate`.
- **Context Mode** is for the owner's own session only. Its `ctx_*` tools are **not granted to any agent**: they run code outside every `pre:bash:*` / zone hook (SR-H-2, PR #1157). Granting them needs a guard hook first — an A3 owner decision.
- **Caveman** runs in `lite` (`.caveman.json`); the never-compressed list above still wins.
- Install state and pins: `docs/architecture/rules-rationale/token-economy.md` → Install status.

## How we know it is violated

| What is reconciled                                                                                 | Who                  |
| -------------------------------------------------------------------------------------------------- | -------------------- |
| The final report has a `Token-economy:` line: one clause on the main saving made, or `n/a (<why>)` | Master at acceptance |
| A report restates the diff / task in prose where the fixed lines would do                          | reviewer, Master     |
| A whole large file or unbounded log read where `codegraph` / a window / a file+`grep` would answer | reviewer, Master     |
| A new abstraction, wrapper or dependency the task did not need (the ladder was not climbed)        | code-reviewer        |

## Related rules

- `.claude/rules/common/model-routing.md` — the cheapest sufficient tier (the biggest single lever).
- `.claude/rules/common/mcp-first.md` — `codegraph` / `ast-grep` are the bounded way to read code.
- `.claude/rules/common/verification-integrity.md` — the limit on every saving above.
- `.claude/rules/common/stream-watchdog.md` — "produce in pieces" and "read by window" are the same habit.
