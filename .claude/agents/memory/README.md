# Agent Memory — Lessons Learned

Each agent has its own `lessons.md` — accumulated lessons from past tasks.

## Structure

```
.claude/agents/memory/
├── README.md          (this file)
├── coder/lessons.md
├── autotest/lessons.md
├── reviewer/lessons.md
├── devops/lessons.md
└── pm/lessons.md       (active, ≤ 20 lines; NO archive files)
```

The `.md` archiving mechanism was removed (2026-06-29) — there is no more `lessons.archive.md`; stale lessons are deleted on consolidation, history is recoverable from git.

## When to read

Each agent reads its own `lessons.md` at startup — it is part of the mandatory reading (see `.claude/agents/<self>.md` section "Session-recovery").

## When to write

**Trigger-based** (User answer #5 — skill-driven via `anthropic-skills:consolidate-memory`):

After each **merged PR** PM MUST:

1. Append 1-3 lessons to `.claude/agents/memory/<agent>/lessons.md` of the corresponding agent (the one who did the main work).
2. Consolidate when reaching the threshold (`lessons.md` ≥ **20 lines** OR after a batch of merged PRs): dedup / simplify / extract patterns → promote-and-prune (**without an archive**):

- **P0 (5+ repetitions)** → promote into the Golden rules of the corresponding agent doc (`<agent>.md`).
- **P1** → consolidate into `rules/common/<topic>.md` (if cross-agent) or `<agent>.md` (if agent-specific).
- **The rest (one-off / absorbed by a promote)** → **delete** (do not archive; history is in git).

> This is a separate PM operation over the in-repo `lessons.md`, NOT the skill `anthropic-skills:consolidate-memory` (that one dedups the personal user memory `~/.claude`).

This is the "levelling-up" of a lesson: a personal case → a general rule → an enforced rule.

## Line format

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <a concrete lesson in one phrase>
```

**Fields:**

- `<YYYY-MM-DD>` — the date of the lesson.
- `[P0]|[P1]|[P2]` — **priority** (D4 [P2] fix, 2026-05-23):
  - **P0** — a critical rule. A violation leads to: data loss, a security gap, a repeat regression, lost commits, a system failure. The agent MUST read P0 at startup.
  - **P1** — an important rule. A violation leads to: rework, more review rounds, pipeline slowdown.
  - **P2** — nice-to-know. Helps to optimize, does not block.
- `[<task-id>]` — the task-id for traceability.
- `#topic` — an optional topic tag for greppability. Examples: `#tunnel`, `#tdd`, `#review-gate`, `#commit-hygiene`, `#layout`, `#ci`, `#worktree`, `#workflow`.

Examples of good lessons:

```
2026-05-20 [P0] [task-fix-pr22-ui-round4] #commit-hygiene git add . sweeps up other people's debug artifacts — only an explicit list of files from the task.
2026-05-19 [P0] [task-teams-redesign] #testing data-testid is mandatory for back-button/dialog-close — Playwright strict mode fails on duplicates in sidebar+content.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent in RTL requires delay:null for stability — otherwise a race with act().
```

Examples of **bad** lessons (do not write):

```
2026-05-20 [P1] [task-knowledge-api] Did the task.       # ← useless
2026-05-20 [P2] [task-x] Used TanStack Query.      # ← obvious from the code
2026-05-20 [P2] [task-y] Pnpm typecheck passed.           # ← this is the norm, not a lesson
```

**How to choose the priority (rule of thumb):**

- A lesson about a **mechanism** (gate, label, hook) → P0
- A lesson about **safety/security/data** → P0
- A lesson about **regression-prevention** → P0 or P1
- A lesson about **process/communication** → P1
- A lesson about **optimization/style** → P2

## Rules

1. **One lesson = one line.** Do not spread it over a paragraph.
2. **Concreteness.** "Layout regression because of X" is better than "be careful with layout".
3. **Applicability.** The lesson should help the next agent in a similar situation.
4. **Limit.** The active `lessons.md` ≤ 20 lines. Reached it — PM consolidates (promote-and-prune, see "When to write").

## Where this file used to live

The old version (before the 2026-06-02 refactor) described threshold-based rotation (30 lines). It did not work — lessons were under-recorded (see `architect-audit.md` §4.5). The new version is trigger-based + skill-driven (PM invokes the skill after a merged PR at the 20-line threshold).
