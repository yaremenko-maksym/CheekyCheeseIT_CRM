# AFK pipeline: adapting mattpocock/skills mechanisms for autonomous work

**Date:** 2026-08-22
**Status:** in progress (a single PR for the whole migration)
**Requested by:** owner — "I work remotely, commands for a human are not needed; adapt the mechanisms for autonomous invocation by an agent"
**Source:** review of `mattpocock/skills` @ 1.2.3 (36 skills, 25 promoted)

---

## 1. The decision in one phrase

We do **not** remove the human from the loop — we change **when and in what form** they are asked: the agent gathers facts itself and has no right to ask; it makes reversible decisions itself under a written record; irreversible ones it accumulates into a single batch and asks late, with the material ready.

The boundary is taken from the author (`grilling`): **"Fact-finding is the agent's job, never the user's. Decisions are the user's"**. Everything else follows from it.

## 2. What exactly is NOT ported (and why)

| Source mechanism               | Why we do not port it                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The whole **user-invoked** class | Its main trick is to shed context load by hiding the skill from the model. In AFK a skill invoked only by a human is **never** invoked. We need everything model-invoked, and we save instead on the precision of the trigger wording. |
| The **`ask-matt`** router       | It exists because user-invoked skills have no descriptions and the human is the only index. For us the index must be a machine (see §5 item 16).                                                                                     |
| Forbidding paths/lines in a spec | In its case the ticket sits around for weeks. Our task-files are executed the same day, and coordinator discipline (`pm.md`) **requires** paths and line numbers as proof of synthesis. The rule applies only to long-lived records (item 9). |
| **`teach`**                     | A teaching workspace for a human. Not our scenario.                                                                                                                                                                                 |

## 3. The autonomy axis A1 / A2 / A3

A new decision axis alongside the existing ones (cost-of-error → track → model tier). It answers the question that was missing: **how much human does this decision need**.

The canon is `.claude/rules/common/autonomy-levels.md`. Here only the anchor:

- **A1 — decide and record.** Reversible (rollback ≤ one PR), not money / RBAC / prod data /
  public text. The agent takes its own recommendation and writes a line into the `## Assumptions` section of the task-file.
- **A2 — accumulate and ask.** Everything independent is finished; the questions accumulate into a **decision brief**: one batch, each question with a recommendation and an auto-acceptance deadline.
- **A3 — stop.** Irreversible and blocking. **Only this branch** halts — neighboring frontier tasks keep going.

Parallelism under A2/A3 — from the `grilling` frontier rule: a launched reconnaissance is an unresolved premise, so only the questions **below it in the tree** wait. It is the same with questions to the owner: a subtree is blocked, not the session.

## 4. Rollout order (by dependencies, not by importance)

| Wave | Content                                                              | Items                                       |
| ---- | ------------------------------------------------------------------- | ------------------------------------------- |
| 1    | Language and the autonomy axis — the foundation everything else rests on | 1, 3, 4, 9, 17                              |
| 2    | The second review axis and completeness of the findings channel     | 2, 8, 12                                    |
| 3    | Discipline skills (independent of each other)                       | 7, 10, 11, 13, 14, 19 + `decision-frontier` |
| 4    | Mechanics: frontier, skill registry, human-only, task template      | 5, 15, 16, 18                               |
| —    | **Deferred** (see §6)                                               | 6                                           |

## 5. Items

A full breakdown with proofs — the "AFK pipeline" artifact (link in the PR). Here — what exactly is done and where the result lives.

| #   | Item                                     | Artifact                                                     |
| --- | ---------------------------------------- | ------------------------------------------------------------ |
| 1   | Project glossary                         | `CONTEXT.md` (root)                                          |
| 2   | Second review axis — conformance to the task | `.claude/agents/spec-reviewer.md` + aggregate in `contracts.md` |
| 3   | Autonomy axis + decision brief contract  | `.claude/rules/common/autonomy-levels.md`                    |
| 4   | Positive phrasing alongside the prohibition | `git-policy.md`, golden rules `pm.md` / `coder.md`           |
| 5   | Machine-computable task frontier         | `task.md.tpl` + `scripts/architect/task-frontier.mjs`        |
| 6   | Backlog triage                           | **deferred**, see §6                                         |
| 7   | "No red command — no hypotheses" gate     | `.claude/skills/diagnosing-bugs/`                            |
| 8   | Numbering findings across all four axes   | `review-findings-transfer.md` (+`QA-`, `UX-`, `SPEC-`)       |
| 9   | Durability of long-lived records          | `.claude/rules/common/doc-durability.md`                     |
| 10  | Vocabulary of deep modules                | `.claude/skills/codebase-design/`                            |
| 11  | Tautology test + seam declaration         | `coder.md` §2.6 + the `## Seams under tests` field in the template |
| 12  | Baseline of twelve smells                 | `code-reviewer.md` §3 (MED section)                          |
| 13  | Merge-conflict resolution discipline      | `.claude/skills/resolving-merge-conflicts/`                  |
| 14  | Prototype as the answer to a design question | `.claude/skills/prototype/`                                  |
| 15  | Weeding the rules                         | `.claude/skills/writing-for-agents/` (the weeding tool)      |
| 16  | The skill registry is generated           | `scripts/architect/check-skill-registry.mjs` + CI            |
| 17  | Phase-boundary tree                       | `.claude/rules/common/phase-boundaries.md`                   |
| 18  | The "human only" registry                 | `docs/runbooks/human-only.md`                                |
| 19  | External reconnaissance from primary sources | `.claude/skills/external-research/`                          |

## 6. What is deferred and why

**Item 6 (mechanically breaking `BACKLOG-followups.md` into a tracker) is not part of this PR.**

The reason is not volume but isolation: at the time of this work a neighboring session
(`claude/cheekycheeseit-crm-backlog-6e44ec`, worktree `keen-robinson-82c9a0`) is working **on exactly this file**. Editing a 3259-line file from two sessions at once is a guaranteed conflict and lost owner decisions — that is to say exactly the class of defect `agent-isolation.md` fixes.

What from item 6 **is nonetheless done** here: the `.out-of-scope/` convention (institutional memory of refusals) — it is additive, does not touch the backlog file, and is needed by the other items.

The mechanical breakdown is filed as a separate task after the neighboring session finishes its pass and its PR merges.

## 7. Discipline of this PR

- One branch `infra/afk-pipeline-migration`, one PR for the whole migration, **merge only on the owner's explicit "merge it"** and **after** the neighboring session's PR merges.
- The diff is docs-only plus two scripts and one additive CI workflow. Product code
  (`apps/**`, `packages/**`) is not touched at all.
- E2E is not run locally: light-track exempts a docs-only diff. The scripts are covered by their own smoke test.
- `BACKLOG-followups.md` is not touched by a single line.

## 8. How we know the migration worked

Not "the rules are written" but observable consequences. To check in a month:

| Item | Observable consequence                                                                         |
| ---- | ---------------------------------------------------------------------------------------------- |
| 1    | A term from the `_Avoid_` list in a PR body / variable name = a review finding (grep)           |
| 2    | Discrepancies `ac_verified` ↔ the Spec-axis verdict have appeared. Today they are physically undetectable |
| 3    | Every A1 decision exists as a line in `## Assumptions`; a decision without a line is visible by arithmetic |
| 5    | Dispatching a task that is not in the output of `task-frontier.mjs` = a violation               |
| 7    | The bug-fix report contains a line with the red-command invocation and its output               |
| 8    | The number of identifiers in the verdict = in the fix-task = in the report, across all four axes |
| 15   | The total line count of `rules/common/**` has not grown over the month                          |
| 16   | A disk↔skill-table discrepancy fails CI, rather than surfacing as "Skill not found" at runtime  |
| 18   | The human-only registry shrinks; an item without an automation attempt for two months = debt    |
