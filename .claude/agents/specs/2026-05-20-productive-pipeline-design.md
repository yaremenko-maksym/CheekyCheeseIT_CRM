# Productive Multi-Agent Pipeline — Design v2

**Date:** 2026-05-20
**Status:** Proposed (awaiting user-review)
**Context:** PR #22 finished after 5 rounds of UI edits. A window for an architectural refactor is open (0 active PR).

---

## Goal

Reduce the average number of rounds per feature from 3-5 to 1-2, reduce the PM cold start by ~40%, give visibility into the pipeline bottlenecks.

## Current-state data (facts)

- PR #22 required 5 rounds of UI edits (`task-fix-pr22-ui-round1.md` → `round5.md`)
- `task-fix-pr22-ui-round5.md` — a verbatim dictation with line numbers and a git-diff checklist (PM writes code by hand)
- `round4` made a regression: returned Telegram to the middle column instead of Pills
- `docs/agents/pm.md` — **688 lines**, of which ~250 (36%) duplicate `CLAUDE-tools.md` or copy snippets from the modes
- `docs/specs/pm-state.json` is desynchronized with reality (shows `round4 running` although the PR is merged)
- Twice in a row in the history: `chore(agent): safety-net — agent forgot to commit changes`
- **CRITICAL safety hole:** `.github/workflows/ci.yml` → `auto_merge` merges on `!= 'failure'` without a label check → User Testing was bypassed for PR #22
- **Coder verification gap:** the round4 task file explicitly required a `git diff HEAD` check of each AC — the Coder ignored it → a regression. The rule in the task file is not enforced by the system.
- **Worktree pollution:** commit 77b5274 removed `apps/e2e/debug-*.png`, `test-telegram-ui.{js,mjs}` (521 lines of deletions vs 39 insertions) — the Coder did a `git add .` and swept up AutoTest artifacts. Isolated worktrees + a careless `git add` = someone else's files in the PR.

## Root cause of the high rounds

The Coder works **blind** — it does not open a browser before creating a PR. AutoTest and the Reviewer connect only AFTER the PR is opened. Visual regressions are caught only by the user's eyes at the User Testing stage → a new round.

PM-bloat — a tax on tokens/speed, but NOT the root cause of the rounds.

## Root cause of the User Testing bypass

CI auto-merge fires on any non-failure → there is no explicit human-in-the-loop gate. PM has no lever to "stop the merge", other than relying on quality/e2e to fail. This contradicts the very logic of Mode 4 (User Testing is mandatory) and the saved memory `feedback_pr_merge_approval.md`.

---

## Architectural changes

### 1. PM slim — 688 → ~300 lines

**What stays in `pm.md`** (strategy — what PM actually decides):

| Block | Size | Why it stays |
|---|---|---|
| Role + 3 strict prohibitions | ~30 | Identity + hard limits |
| Tool priority — one table + a link to CLAUDE-tools.md | ~15 | No duplicates |
| Mandatory reading at startup | ~10 | A list of 3 files |
| Mode 1 — Decomposition | ~50 | Logic + a link to the skill `writing-plans` |
| Mode 2 — **A flat event table** | ~60 | Instead of 4 nested sub-modes |
| Mode 4 — User Testing | ~70 | The logic of collecting edits + classification |
| Mode 4.A — Batch dispatch | ~40 | Grouping by agents |
| Circuit breaker (review_rounds) | ~15 | A safe limit |
| Links to pm-snippets / template / script | ~10 | "If you need a ready Agent() call — see X" |

**Total:** ~300 lines of pure strategy.

**What leaves** (mechanics — reusable):

| What | Where | Size |
|---|---|---|
| Ready `Agent(...)` calls | `docs/agents/pm-snippets.md` (read on-demand) | ~86 lines |
| `gh pr ...` / `git fetch && pnpm dev &` blocks | `scripts/pm/prep-user-testing.sh` | ~40 lines |
| The task-file template (Appendix A) | `docs/specs/tasks/templates/task.md.tpl` | ~40 lines |
| 3 duplicated MCP tables | One short one with a link to CLAUDE-tools.md | ~50 lines saved |
| Mode 2 nested (2.A/2.B/2.C) | A flat branch-by-event table in pm.md itself | a restructure |

**Mode 2 is refactored** from a hierarchy into a flat table:

```
Event                            → Action
────────────────────────────────────────────────────────
agent finished with PR           → Reviewer + AutoTest (parallel)
agent created .blocked.md        → read → ask the user → resume
PR label = ci-failed             → a fix-task for the Coder
PR label = awaiting-pm-review    → Mode 2.B (post-review analysis)
E2E run = failure                → classify (bug vs test) → a fix-task
E2E run = success                → notify the user → wait for "merge"
review_rounds >= 3               → STOP, escalate to the user
```

**A local skill `pm-dispatching`** — `.claude/skills/pm-dispatching/SKILL.md`. PM invokes the skill when it actually dispatches — the snippets do not sit permanently in the context.

### 2. Coder vision + AC-in-diff verification — closing the UI feedback loop ⭐

**The main killer of rounds.** A mandatory **double checklist** is added to `docs/agents/coder.md` before opening a PR.

#### A. Vision check — a visual feedback loop
For tasks touching `apps/web/`:

1. After all code edits, before `git push`:
   - `mcp__playwright__browser_navigate` → http://localhost:3000/crm/<affected-route>
   - `mcp__playwright__browser_take_screenshot` — a visual check
   - For each AC where a UI is mentioned — mark "visible/not visible" in the DOM via `mcp__playwright__browser_snapshot`
2. If an AC says "Russian text" / "pills layout" / "bg-muted" — the Coder checks this in the DOM before the push

#### B. AC-in-diff check — a text verification (for ALL tasks)
Before each `git push`:

1. `git diff HEAD --name-only` — the list of changed files
2. For each AC item from the task file:
   - If the AC specifies a concrete pattern (a class, prop, function name) → `grep -n "<pattern>" <file>` confirms its presence
   - If the pattern is not in the diff → **STOP, the AC is not done**, do not push
3. In the commit message — the **mandatory** lines:
   ```
   vision: ✓ /crm/team, /crm/team/$teamId
   ac_verified: 1,2,3,4,5
   ```
   Where `ac_verified` — the numbers of the completed AC from the task file. If not all AC are completed — mark which.

#### Hook gate (a safeguard)
A PreToolUse Bash hook on `git push`: checks that the last commit message contains `ac_verified:`. If not — it blocks the push, the agent must either finish the AC, or explicitly mark the missing ones.

**This solves the round4 problem:** the task file already required a git diff check, but it was not enforced. Now — a hook.

### 3. State schema v2 — events + metrics (part of Approach C, without hooks)

`pm-state.json` is enriched. The format:

```json
{
  "active": [
    {
      "id": "task-fix-pr22-ui-round5",
      "started_at": "2026-05-20T03:10:00Z",
      "rounds": 0,
      "agent_invocations": { "coder": 5, "reviewer": 4, "autotest": 1 },
      "events": [
        { "at": "...", "type": "agent_started", "agent": "coder" },
        { "at": "...", "type": "pr_opened", "pr": 22 },
        { "at": "...", "type": "review_rejected", "rounds": 1 }
      ]
    }
  ],
  "completed": [
    {
      "id": "task-fix-pr22-ui-round5",
      "duration_min": 18,
      "rounds": 5,
      "regression_count": 1,
      "agent_invocations": { "coder": 5, "reviewer": 4, "autotest": 1 },
      "merged_at": "..."
    }
  ],
  "phase": "development",
  "pending_fixes": []
}
```

PM writes an event on each action. After 5-10 features we see:
- `avg(rounds)` per task — is 1-2 rounds the norm?
- `regression_count` per agent — who breaks things more often
- `duration_min` per phase — where the bottlenecks are
- `agent_invocations.coder` per round — how many times PM restarted the Coder

### 4. Per-agent memory (minimal)

`docs/agents/memory/<agent>/lessons.md` — a file per agent (Coder, AutoTest, Reviewer, DevOps). After a merged PR — PM appends one line:

```
2026-05-20 [task-fix-pr22-ui-round5] When editing layout — first read the existing classes, then replace. The round4 regression = added an element without checking the context.
```

Each agent reads its own `lessons.md` at startup. A small overhead (5-10 lines after a month), accumulates over time.

### 5. Worktree hygiene + git add discipline (new)

**Problem:** commit 77b5274 showed — the Coder did a `git add .` or `git add -A` and swept up `apps/e2e/debug-*.png`, `test-telegram-ui.{js,mjs}` from someone else's worktree.

**The solution in three places:**

1. **`.gitignore` reinforcement** (DevOps): add
   ```
   apps/e2e/debug-*.png
   apps/e2e/screenshot-*.png
   apps/e2e/test-*.{js,mjs}
   output.txt
   ```
   So that debug artifacts do not get into the repo at all.

2. **`coder.md` — git add discipline:** forbid `git add .` / `git add -A`. Only `git add <specific-file>` from the task file's change list. The list of files is taken from the section "Concrete changes".

3. **`autotest.md` — no debug commits:** screenshots and temporary test scripts are NOT committed. If AutoTest needs to save a screenshot for debugging — the path in `/tmp/autotest-<runid>/`, not in the repo.

---

## Migration steps

Each is a separate PR, reversible.

| PR | What | Risk | Effect |
|---|---|---|---|
| **PR-0** ⚠️ | **Merge gate** — `ci.yml` + the label `merge-approved` + a pm.md Mode 4 approve step. **Done BEFORE everything else.** The task is already created: `docs/specs/tasks/task-infra-merge-gate.md` | low | the critical safety hole is closed |
| **PR-1** | Extraction from `pm.md` → `pm-snippets.md` + `task.md.tpl` + `prep-user-testing.sh` (a mechanical extraction) | low | -150 lines of PM |
| **PR-2** | Refactor Mode 2 into a flat table | medium | -100 lines of PM, faster navigation |
| **PR-3** | A local skill `pm-dispatching` + updating the links in pm.md | low | snippets on-demand |
| **PR-4** | **Coder vision + AC-in-diff** — a coder.md update + Playwright + a hook on git push | medium | **the main killer of rounds + closing the round4 verification gap** |
| **PR-5** | Worktree hygiene — `.gitignore` + git add discipline in coder.md + autotest.md | low | prevention of pollution |
| **PR-6** | State schema v2 — migration of pm-state.json + updating the PM events-writing logic | low | visibility of metrics |
| **PR-7** | Memory structure + auto-append after merge | low | a long-term compound effect |

**The order is changed:** PR-0 first and urgent (safety). PR-1,2,3 — the PM refactor (fast, safe). PR-4 separately — to measure the main effect of Coder vision cleanly. PR-5 goes right after PR-4 (the same area — the Coder/AutoTest workflow). PR-6,7 — the foundation of visibility.

---

## Success criteria

- **0 PRs merged** without the `merge-approved` label over the next 10 PRs (a safety invariant)
- **Avg rounds per feature ≤ 2** over the next 3 features (currently 3-5)
- **PM cold start** (`pm.md` + `CLAUDE-pm.md` + obligatory reads) ≤ **1000 lines** (currently ~1100)
- `pm-state.json` contains events/metrics, synchronous with reality within an hour after merge
- **Regressions** (round_N breaks something from round_{N-1}) ≤ 1 per 5 features
- The Coder never opens a PR without the `vision: ✓` and `ac_verified:` lines over the next 5 features
- **0 debug artifacts** (`debug-*.png`, `test-*.{js,mjs}`, `output.txt`) in commits over the next 10 PRs

## Risks and rollback

| Risk | Mitigation |
|---|---|
| The Coder with Playwright will become slower | `duration_min` in state schema v2 will show it — we roll back the vision-step if +3min does not justify skipping a round |
| pm-snippets.md will go stale from pm.md | One integration test: pm.md must reference all sections of pm-snippets.md (can be done as `pnpm pm:lint`) |
| State schema v2 breaks the existing PM | All fields nullable, a read-write compatible migration. The old fields (`tasks`, `merged`) stay as aliases for the first round |
| Memory lessons will turn into noise | A limit of the 10 latest lessons in a file; rotation of the old ones into `lessons.archive.md` |

**Full rollback:** each PR is independent, any can be reverted without cascading effects.

---

## What is NOT part of this design (explicit out-of-scope)

- **An Architect agent** — not needed until PHASE 6 starts
- **BA as an agent** (instead of a document) — the user did not complain
- **Auto-trigger of AutoTest by affected routes** — this is a separate story about CI, not about agents
- **Splitting PM into 3 sub-agents** (Approach A) — we leave it as an option for later, if slim-PM hits a ceiling
- **Event-driven via hooks** (the full Approach C) — too heavy, we add only the passive part (state v2 with events)

If anything of this is needed — a separate design-doc.
