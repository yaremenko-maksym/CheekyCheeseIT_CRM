---
name: decision-frontier
description: 'Autonomous version of a grilling session: the agent builds the task''s decision tree itself, extinguishes each branch with facts from the repository, and classifies only the irreducible remainder by autonomy levels A1/A2/A3. The reversible it decides itself on the record, the irreversible it accumulates into a decision brief. Replaces interviewing the owner where the owner is unavailable.'
when_to_use: "Use when an agent hits a fork it cannot resolve from the task file: Master task decomposition, a Coder facing an unspecified case, any agent about to write '.blocked.md' or ask the owner. Examples: 'unclear which of the two options to do', 'the task does not describe the edge-case', 'I want to ask the owner', 'gather questions into one batch', 'what decisions are there even here', 'does this need to be blocked'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__ast-grep__find_code
  - mcp__codegraph__codegraph_explore
  - mcp__postgres__query
  - mcp__github__get_pull_request
---

# Decision frontier — a decision tree without the owner at the keyboard

The mechanics of the rule `rules/common/autonomy-levels.md`. The rule says **what** to do with a decision;
this skill is **how** to arrive at it.

The source of the technique is `grilling` from `mattpocock/skills`, where the interview runs in rounds over the
"frontier" of the decision tree. We have no one to interview, so the agent runs the rounds with itself, and only
the irreducible remainder goes to the owner.

## Step 1. Build a tree, not a list

Forks are not flat: some questions **depend** on the answers to others. Write them out as a tree.

**Frontier** — the questions whose premises are already resolved; process only those in this round.
A question whose answer depends on another open question belongs to the next round.

Done when every fork of the task is written down and each shows what it depends on.

## Step 2. Extinguish everything that is actually a fact

**This is the main step.** Most "questions for the owner" are facts the agent is obliged to obtain itself.
Walk the frontier and for each question ask: **does a command answer it?**

| Where to look                       | With what                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Project language and concepts       | `CONTEXT.md`                                                              |
| Decisions already made              | `docs/architecture/**` (ADR), `.out-of-scope/**`                          |
| Owner's decisions on this topic     | `.claude/tasks/BACKLOG-followups.md` ("Owner decisions" sections)         |
| Past gotchas                        | `.claude/agents/memory/<agent>/lessons.md`                                |
| How it is built now                 | `codegraph_explore`, `ast-grep find_code`                                 |
| What is actually in the data        | `postgres query` — **`SELECT` only** (`rules/common/live-db-access.md`)   |
| What was decided last time on a similar case | `gh pr list --search`, `git log --grep`                          |

A branch extinguished by a fact **disappears from the tree** — it was not a decision. Record the found fact
next to the branch: you will need it to justify the recommendation.

Done when for every remaining branch you can say **exactly which command you ran** and
why it did not give an answer.

## Step 3. For each remaining branch — a recommendation

A branch without a recommendation is not ready for classification: A1 literally means "take your own
recommendation", and in the brief a recommendation is mandatory.

The recommendation rests on something from step 2 (an existing pattern in the code, an ADR, a past owner
decision) — otherwise it is taste, not a recommendation. One line of "why".

## Step 4. Classify by A1 / A2 / A3

Per the table in `autonomy-levels.md`. Three questions per branch:

1. **Cost of rollback** — does the rework fit within one PR?
2. **Is a sensitive surface touched** — money, RBAC, prod data, public text,
   an irreversible migration, sending outward? Any "yes" → at minimum A2, and together with blocking → A3.
3. **Does it block the rest of the work** — are there branches of the task that can be done without knowing the answer?

Doubt between levels is resolved **toward the question**: A1→A2, A2→A3.

## Step 5. Act by levels without stopping the rest

- **A1** — accept the recommendation, add a line to `## Assumptions` of the task file:
  `- <decision> — <why> · reversible, rollback: <cost>`. Continue.
- **A2** — put the question into the brief accumulator and **go on with the independent branches**. The brief goes
  out in one batch at the phase boundary (`rules/common/phase-boundaries.md`).
- **A3** — send the question immediately, stand **only on this branch**. The task's other branches and
  all neighboring tasks keep going.

An agent that stood still entirely because of a single A3 question applied the skill incorrectly.

## Step 6. Before sending the brief — a fact scrub

A final pass over the brief: for each question ask again whether a command answers it.
A question that survived to the brief but is obtainable by `grep`/`gh`/`psql` is **deleted**, and the answer obtained.

This is cheaper than it seems: the owner answers with a delay, and one extra question costs hours.

## Anti-patterns

- **A flat list instead of a tree.** Gives a false "everything is blocked": in reality one
  question blocks, and the rest merely queue behind it.
- **A question without a recommendation.** Offloads the work onto the owner and doubles the correspondence.
- **Bundling A3 together with A2.** The irreversible and blocking waits for the phase boundary — this is exactly
  the pipeline stall the skill is supposed to prevent.
- **A1 without a line in "Assumptions".** A decision that cannot be learned about is indistinguishable from a forgotten one.
- **Classification before step 2.** Half the "decisions" will turn out to be facts; classifying them is wasted
  work and extra noise for the owner.

## Related

- `rules/common/autonomy-levels.md` — the canon of levels and the decision brief format.
- `rules/common/phase-boundaries.md` — when to send the accumulated brief.
- `rules/common/live-db-access.md` — reading the live DB is allowed, writing is not.
- `CONTEXT.md` — the vocabulary that unpacks jargon in the questions.
