---
name: decomposing-large-code
description: "A reproducible discipline for safely splitting giant files and modules: the Mikado Method (goal → naive attempt → revert at the first blocker → prerequisite node into the graph → recursion down to the leaves) on top of Michael Feathers' characterization tests. Execution by leaves bottom-up, each leaf an atomic PR, the base always green. Behavior-preserving: zero changes to observable behavior."
when_to_use: "Use when about to split a giant file or module whose seam is already chosen (via codebase-design): a >800-line service/route/component, a god file, a module that is 'too big'. Examples: 'split a giant file', 'decompose god file', 'split of a module >800 lines', 'transactions.service.ts is too big', 'this file is too big to edit safely', 'split schema.ts', 'how to safely cut up UserDialog.tsx'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
  - mcp__ast-grep__find_code
  - mcp__codegraph__codegraph_explore
  - mcp__codegraph__codegraph_callers
---

# Safely splitting giants

This skill is about **HOW** to safely execute a split, when **WHERE** to put the seam is already decided.
Where to put the seam is a separate decision, it is in `codebase-design` (depth, deletion test, adapters).
People come here with a ready seam and a big file that is scary to touch: the giants of the project
(`transactions.service.ts` ~9.4k lines, `schema.ts`, `users.service`, `projects.service`,
`$projectId.tsx`, `UserDialog.tsx`) — **human-planned**, the owner sanctions the start
(category #3 of the gardener rulebook).

The danger of a split is one: **changing behavior while thinking you are only moving code.** Two techniques
remove it — Mikado gives rollback-as-information instead of accumulating broken state;
characterization tests pin the behavior before the first edit. The method is reproducible: the agent repeats
the **process**, not guesses the seams anew.

## Leading words

- **Leaf** — a change that needs no prerequisite; it can be done right now,
  leaving the base green. The unit of work and of the PR.
- **Graph** (`mikado.md`) — the external memory of the strategy: the goal at the bottom, the leaves at the top.
- **Revert-as-information** — rolling back a breaking edit does not lose work, but obtains a prerequisite.
- **Characterization test** — a test that pins the **current** behavior (even if strange), so that
  the split provably preserves it.
- **Behavior-preserving** — the split changes the placement of the code, not the observable behavior.

## Step 1 — the goal: concrete and testable

Formulate one goal as a **checkable behavior after the split**, not as an intention. "Extract the
drop-share calculation from `transactions.service.ts` into a separate module, the calls and behavior unchanged" —
is a goal; "clean up transactions" — is not.

Write the goal at the very bottom of `mikado.md`. **Completion criterion of the step:** the goal is named by an action verb
and has an observable "done" sign (compiles + the same tests green + the callers untouched).

## Step 2 — the net under the code BEFORE the first edit

Feathers' sequence: find change points → test points → break dependencies →
write characterization tests → only now change the code.

Check that the behavior being split is **caught by a test**. Page compositions (`$projectId.tsx`,
`UserDialog.tsx`) often have no unit tests — the reliance is on E2E; calculation logic (`finance`) relies on
units. Found a gap — **add characterization**: a test that pins what the code does now, not what
it "should". If the current behavior looks like a bug — pin it as-is anyway and
mark it with a marker line; fixing the behavior is a separate task after the split, not inside it.

> Feathers: "characterization test … documents the actual current behavior." (≤15 words)

**Completion criterion of the step:** each branch of the behavior being split goes red with at least one test,
if deliberately broken. No red on the behavior — there is no net, do not start the split.

## Step 3 — Mikado: four rules

1. **Goal — concrete testable** (step 1).
2. **Naive attempt straight away.** Make the change toward the goal directly, without a prior analysis of the
   consequences — let the compiler and the tests show what falls off.
3. **First blocker → `git reset --hard`.** Roll back immediately and fully. The rollback is not a loss: tokens
   are cheap, wall-clock is seconds, and the broken attempt already **reported a prerequisite**.
4. **Blocker → a prerequisite node into the graph, recursion.** Write down what must be done BEFORE the goal,
   as a node above it. Apply the same four rules to the node. Recursion down to the **leaves** — nodes without
   prerequisites.

> Source: "At the first blocker, revert everything." (≤15 words)

**Completion criterion of the step:** the graph has at least one leaf, and the path from the leaf to the goal is traced.

## Step 4 — the graph `mikado.md`: external memory against goal drift

The graph lives as a file in the branch, not in context. It is read at the start of **every** session/agent — this is
the only thing that keeps the goal unchanged while the agent edits dozens of files (the agent's model of the codebase
degrades by the end of a long session).

The format of the nodes — **by behavior and symbol names, NOT by line numbers** (`doc-durability`:
`resolveDropShare` survives a file move, `finance.service.ts:412` — not). Structure: the goal
at the bottom, prerequisite arrows up, the leaves at the top, a status on each node (`todo` / `done`).

> Source: "The graph survives; the broken code does not." (≤15 words)

**Completion criterion of the step:** each node is named by a symbol/behavior, not a single line number,
the goal and the leaves are distinguishable.

## Step 5 — execution by leaves bottom-up

Extinguish the leaves in order from the top of the graph (without prerequisites) down to the goal. Each leaf:

- **an atomic PR** — 3–5 files, one commit;
- **the base green before and after** — typecheck + the affected tests pass at each step;
- **behavior-preserving** — the characterization tests from step 2 stay green without edits to the tests
  themselves.

A monster PR for the whole split is broken into a chain of checkable leaves. Mark a leaf `done` in the graph
right after the merge — the next session reads the current state.

**Completion criterion of the step:** all leaves `done`, the goal achieved, no characterization test
was weakened for the sake of green.

## Three agent failures and countermeasures

| Failure                                                                        | Countermeasure                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Greed of edits** — the agent fixes everything at once, accumulates broken    | The leaf constraint (3–5 files) + `git reset --hard` at the first blocker instead of "one more edit and it will work"                                                                                           |
| **Goal drift** — by the end of the session the agent edits not what it started | The external graph `mikado.md`, read at the start of each session; a node by symbol, not by line                                                                                                                |
| **The illusion of green** — the test was tweaked to pass                       | `mutation-gate` catches weakened specs; the rule "never weaken a spec" (`.claude/rules/common/*`); behavior-preserving = zero changes to observable behavior, so there is nothing to change in the tests either |

The countermeasure against the illusion of green is positive: the split preserves behavior, so the tests
stay as they are; the need to touch a test on a purely mechanical split is a signal that the behavior
has moved, not that the test is outdated.

## Our gates on top of the method

- **zone-of-write** — the split stays in its zone (Coder: `apps/**`/`packages/**`); the characterization test files
  — the AutoTest zone by the nature of the file.
- **Each leaf — `code-reviewer`.** A leaf in `finance` / RBAC / `schema.ts` / auth —
  **`security-reviewer` MANDATORY** (critical-path zones, `contracts.md` §2.1).
- **Giants — human-planned.** The owner sanctions the start of splitting a giant; the agent does not start
  a blind auto-PR on a >800-line giant on its own initiative.
- **`DATABASE_URL= git push`** on feature branches (integration specs graceful-skip).
- **Hooks are passed honestly** — finish the AC/format, do not bypass the pre-push and prettier gates.

## Sources

The method is external; the snapshot is checkable, goes stale silently — recheck on a change of approach.

- Michael Feathers, "Working Effectively with Legacy Code" (2004) — the sequence of
  legacy-change and characterization tests. Book, accessed 2026-10-05.
- Mikado + AI agents — <https://anischaabani.com/en/blog/mikado-method-ai-agents/>, accessed
  2026-10-05.
- Mikado + AI agents — <https://wellaged.dev/posts/mikado-method-ai-agents/>, accessed 2026-10-05.
- **Shelf life:** ~2027-04 or earlier if the approach to decomposing giants changes; the sign
  for a recheck — a divergence of this skill from the gardener rulebook (category #3).

## Related

- `.claude/skills/codebase-design/SKILL.md` — WHERE to put the seam (depth, deletion test, adapters);
  this skill — HOW to safely execute the split after choosing the seam.
- `.claude/skills/diagnosing-bugs/SKILL.md` — the "red command" as a gate before hypotheses (the same
  discipline "no red — do not touch").
- `.claude/skills/resolving-merge-conflicts/SKILL.md` — resolution by intent, never `--abort`
  (a kindred technique: carry the operation to the end, do not abandon it).
- `docs/runbooks/codebase-gardener.md` — category #3 (splitting giants, human-planned).
- `.claude/rules/common/doc-durability.md` — graph nodes by symbol, not by line.
- `.claude/rules/common/zone-of-write.md` · `.claude/agents/contracts.md` §2.1 — zones and
  the mandatory security-reviewer on critical-path leaves.
