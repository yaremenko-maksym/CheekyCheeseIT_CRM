---
name: token-economy
description: 'Use at the start of any task and before large reads, long command output, or adding code. Cuts tokens without cutting evidence: terse narration, bounded reads, bulk output parked in files, a code-restraint ladder.'
when_to_use: "Use at the start of any agent task, before reading a large file or running a command with long output, and before writing new code or a new dependency. Examples: 'the log is huge', 'read this whole module', 'run the full suite', 'add a helper/wrapper', 'the context is filling up', 'write the final report', 'how do I keep this cheap'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Token economy — playbook

The rule is `.claude/rules/common/token-economy.md` (always-on, short). This is the on-demand detail.
Four levers, each adapted from a published tool but implemented as **plain habit** — no third-party
plugin, hook or MCP server is installed (reasons: `docs/architecture/rules-rationale/token-economy.md`).

## 1. Terse narration (output)

Output is the smallest share of a session's bill, so this lever is modest — take it, do not oversell it.

- Open with the action, not "I will now…". No recap of the task, no recap of the diff at the end.
- Reports: the fixed lines first (`Worktree:`, `Pushed:`, `Findings: … (N)`, `Verdict:`, `Skills:`,
  `Token-economy:`), then only decisions and risks.
- One sentence per finding where one suffices; the evidence is the command, not the adjectives.
- **Exempt** (verbatim, complete): code, commands, paths, error text, counts, security/finance/RBAC
  findings, decision briefs, legal text, `uk`/`en` product strings.

## 2. Code-restraint ladder (less code written → fewer tokens now and in every later review)

Stop at the first rung that works:

1. **Does it need to exist?** Re-read the AC. Scope creep is the most expensive code.
2. **Platform / stdlib** (`structuredClone`, `Intl`, `URL`, native `<dialog>`, Postgres constraint).
3. **Already in the repo** — `ast-grep find_code` / `codegraph_search` for an existing helper (this is
   already mandatory in `mcp-first.md`).
4. **Already-installed dependency** (Zod, Drizzle, TanStack, shadcn primitive).
5. **The smallest thing that satisfies the AC** — no config knob, wrapper, generic or abstraction for a
   single caller.

**Never cut** (the ladder does not apply): input validation at trust boundaries (Zod `.parse()`),
RBAC checks, money and transaction logic, data-loss handling, tests the task requires, accessibility,
Lingui wrapping of visible strings. "Less code" that removes any of these is a defect.

## 3. Bounded reads (input)

| Instead of                          | Do                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `Read` of a 1,000-line file         | `codegraph_node` / `codegraph_explore`, or `Read` with `offset` + `limit` |
| grepping for a symbol's callers     | `codegraph_callers <symbol>`                                              |
| `git diff` of a big change          | `git diff --stat`, then `git diff -- <one path>`                          |
| `git log` full                      | `git log --oneline -n 20`                                                 |
| full test / build output            | a quiet reporter; keep the **pass/fail count** and the failing case only  |
| re-reading a file seen this session | use what is already in the conversation                                   |

The limit: **a bound may shorten a result, never hide a failure.** Keep the exit status or the count in
view (`N passed`, non-zero). Do not add `2>/dev/null` to a command whose output you will cite
(`verification-integrity.md`). Remember `${VAR}:path`, not `$VAR:path`, in zsh.

## 4. Park bulk output outside the context

Anything you would otherwise paste into context past ~200 lines:

```bash
pnpm --filter @crm/api test > "$SCRATCH/api-test.log" 2>&1; echo "exit=$?"   # keep the status
grep -nE "FAIL|✗|Error" "$SCRATCH/api-test.log" | head -40
tail -n 30 "$SCRATCH/api-test.log"
```

(`$SCRATCH` is your session scratchpad — expand it once to a literal path, `agent-isolation.md` rule 6.)
Long-running commands go `run_in_background: true` and are probed once, not polled
(`stream-watchdog.md`, `light-track.md`). Surveys across ≥3 modules are a `codebase-audit` fan-out with
`haiku` readers, so the raw material never enters the orchestrator's window.

## 5. Session hygiene

- Choose the tier by `model-routing.md` (haiku for mechanics) — the largest single saving.
- Phase boundary → apply `phase-boundaries.md` (continue / clear / subagent / compact) rather than
  carrying dead context forward.
- A non-terminal event (CI still running) gets no text turn.

## Anti-patterns

- Compressing a **report line, verdict or finding** to save a few tokens — that is the integrity defect.
- A caveman-style persona on anything that reaches the owner as a decision brief or a legal/finance note.
- Parking output in a file and then `cat`-ing the whole file back.
- "Saving" tokens by skipping `codegraph` and grepping the whole repo.
