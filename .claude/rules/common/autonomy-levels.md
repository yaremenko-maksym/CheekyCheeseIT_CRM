# Rule: Autonomy levels — how much of a human this decision needs

**Status:** Always-on
**Applies to:** All agents. Master/orchestrator classifies when setting a task; the executor applies it when it hits a fork.
**Source:** Owner request 2026-08-22 ("I work remotely, commands for a human are not needed") + study of `mattpocock/skills` (`grilling`, `loop-me`). ADR: `docs/architecture/2026-08-22-afk-pipeline-migration.md`.

---

## Why

The owner works remotely and answers with a delay. A pipeline that calls the human at every fork
simply stalls in this mode. A pipeline that never calls spends money on
irreversible decisions.

Before this rule the human points were scattered and shapeless: a blocker from an agent
(`.blocked.md`), Mode 4 User Testing, "clarify with USER" in the edit-classification table,
"merge". No format, no deadline, no distinction of reversible and irreversible — so the agent either stalled
where it could decide itself, or decided where it should not have.

## The boundary from which everything follows

> **Finding facts is the agent's job, never the owner's. Decisions are the owner's.**

A **fact** is what is obtained by a command: a file's contents, the DB schema, git history, a PR's state,
what an endpoint returned, whether such a helper already exists. Asking the owner a fact is **forbidden**:
it is offloading your own work. If the answer is obtained via `grep`, `git log`, `gh`, `psql` or reading
— the question is deleted, not asked.

A **decision** is a choice with consequences where both branches are defensible. It belongs to the owner, but
**not every one** must he see personally: next — the classifier.

## Three levels

| Level                       | When                                                                                                                                             | What the agent does                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 — decide and record**  | Rollback ≤ one PR. **And** not money, not RBAC, not prod data, not public text, not an irreversible migration, not an external send              | Takes its own recommended answer, writes a line in the `## Assumptions` of the task file, continues. The line rides into the PR body                  |
| **A2 — accumulate and ask** | Irreversible, but **does not block** the rest of the work. Or reversible, but the redo is expensive                                              | Finishes everything that does not depend on the answer. Puts the question in a **decision brief**. At the end of the phase — one batch in one message |
| **A3 — stop**               | Irreversible **and** blocking. Money, prod data, legal, publication outward, deletion, everything from critical-path zones (`contracts.md` §2.1) | Asks immediately, no auto-acceptance. **Only this branch** stalls; neighbouring frontier tasks go on                                                  |

**Critical-path zones automatically give A3.** The autonomy axis does not weaken cost-of-error, it
is built on top of it: where critical-path zones (`contracts.md` §2.1) require a security-reviewer, a decision cannot be A1.

**In doubt between A1 and A2 — take A2.** In doubt between A2 and A3 — take A3. An error toward
the question costs a delay; an error the other way costs a rollback.

## The subtree is blocked, not the session

From the frontier rule (`grilling`): a launched reconnaissance is an unresolved premise, so
only the questions **below it in the tree** wait, while the rest of the frontier is asked now.

With questions to the owner it is the same. A3 stops the branch depending on the answer — not the whole task,
and certainly not neighbouring tasks. An agent that stalled entirely because of one A3 question violates the
rule.

## The decision-brief contract

One batch per phase, readable on a phone.

```
🟠 Decisions from you — <N> pcs · <task-id> · PR #<N>
Everything else on the task is finished and waits only on this.
Still running: <neighbouring tasks>

❓ 1 — <question title in one line>
   <context: 2-3 lines, jargon unfolded, numbers concrete>
➡️ I recommend: <answer> — <why, one line>
🔓 Reversible · ⏱ silence until <date time> → I take the recommendation, record it
   in "Assumptions", rollback = <rollback cost>

❓ 2 — <...>
➡️ I recommend: <...>
🔒 Irreversible (<why>). Without an answer I do not move.
```

Format rules:

- **A recommendation is always present.** A question without a recommendation offloads work onto the owner.
- **One question — one idea.** A compound question gets a compound answer that then nobody
  can interpret.
- **Jargon unfolded** per `CONTEXT.md`: the brief is read by someone who was not in the session.
- **Not a single fact.** Before sending, go through the list: if a command answers the question —
  the question is deleted and the answer obtained.
- **A deadline only on A2.** A3 has no auto-acceptance by definition.

## How we know it is violated

| What is reconciled                                                                | Who                               |
| --------------------------------------------------------------------------------- | --------------------------------- |
| Every A1 decision exists as a line in the `## Assumptions` of the task file       | Master at acceptance; reviewer    |
| The PR body has an "Assumptions" block with exactly these lines                   | code-reviewer                     |
| The decision brief has no question answerable by a command                        | the brief's author before sending |
| The whole task stalled on one A3 question, though there were independent branches | Master during monitoring          |

A decision made without a line is indistinguishable from a decision that was forgotten: **the line is the
observability**. It is the same device as the control line `Findings: … (N)` in
`review-findings-transfer.md` — arithmetic instead of attentiveness.

## What this does NOT change

- **Merge is still only on the owner's explicit "merge".** A merge is not a decision on the task but
  a separate gate, and the autonomy axis does not touch it.
- **`--admin` / `--no-verify` still require explicit consent in the current message.**
- **The blocker file (`.blocked.md`) remains** for the case "the task cannot be done as
  described" — this is not a fork but a defect in the task setup, and it goes to Master, not into a decision brief.

## Related rules

- `.claude/rules/common/light-track.md` — which track (ceremony); this axis — how much of a human.
- `.claude/rules/common/orchestration-routing.md` — the degree of parallelism; orthogonal.
- `.claude/rules/common/review-findings-transfer.md` — the same observability device via arithmetic.
- `.claude/skills/decision-frontier/SKILL.md` — mechanics: how to build the tree and extinguish branches from the repository before classification.
- `CONTEXT.md` — the glossary with which the jargon in the brief is unfolded.
