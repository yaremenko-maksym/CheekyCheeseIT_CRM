---
name: dev-flow-resilience
description: When Coder / Reviewer / Master work on a long-running operation where a watchdog cutoff, an MCP hang, a session boundary loss or a zone-of-write violation may occur. A CRM-specific resilience layer (D1-D4 fixes from the 2026-05-23 RCA) — NOT covered by ECC. Use before starting long-running work, on suspicion of silent termination, and on cross-session waits.
when_to_use: "Use when an agent runs a long-running operation, an MCP call hangs > 5s, a session boundary may drop state, a watchdog may cut the agent off mid-task, or a cross-session wait is needed. Examples: 'the agent was cut off at the limit', 'MCP hung', 'need to wait for a review in an hour', 'completed but not done', 'sentinel recovery', 'write-then-post'."
allowed-tools:
  - Read
  - Bash(git:*)
  - mcp__scheduled-tasks__*
---

# Dev-Flow Resilience (D1-D4 lift)

Custom resilience patterns for the CRM AI pipeline. ECC covers the workflow surface (skills/), but does NOT have watchdog asymmetry / cross-session state / zone-of-write enforcement primitives — this is our custom layer. Source — `docs/architecture/2026-05-23-dev-flow-rca.md`.

3 root cause classes:

1. **Watchdog asymmetry** (C1, C2) — Coder/Reviewer are cut off before they manage to finish I/O.
2. **Cross-session state loss** (D1) — ScheduleWakeup / MCP results / worktree state are lost at the session boundary.
3. **Implicit zones-of-write** (C3, D2) — Coder overwrites Master-scripts, labels are absent without mechanism-level gates.

## When to invoke

- Coder starts a task with > 2 files to edit
- Reviewer / Legal before `mcp__github__create_pull_request_review` (any MCP I/O > 5 sec)
- Master before `ScheduleWakeup(delay > 1800)` (cross-session wait > 30 min)
- On silent termination diagnosis (Coder finished without a push)
- Before adding a new label that is used in .md rules
- On worktree checkout failure (`git checkout BRANCH` fails with "checked out elsewhere")

## Patterns

### C1: Watchdog C1 — chunking + sentinel + intent markers

**Symptom:** Coder reads the task → starts writing → the text is cut off → `git log` of the worktree is empty. Master waits for a notification, does not get one. 200k tokens / 12 min — a typical cutoff.

**Root cause:** The runtime watchdog (the Claude harness) kills the stream without a graceful shutdown. The Coder has no mechanism to "flush in progress to disk" before the kill.

**Applied fix (3-layer):**

1. **Chunking (hard rule):** `wip:` push after **every 2 files OR 5 minutes**. Previously it was 3/30 — too soft, the Coder was cut off BEFORE the first milestone.
2. **Sentinel file:** `.claude/tasks/<task>.progress.md` — the Coder updates `last_update` / `last_commit` / `last_push` after each milestone. Master, on a timeout, reads the sentinel, sees a divergence of `last_update` vs `last_push` → pulls the work out of the worktree.
3. **Intent markers (opt-in):** Before a long operation (a test run > 30 sec, an AC start, a milestone, a rebase, a migration) — `bash scripts/coder/coder-intent.sh "<intent>"`. Gives Master semantic context at recovery. Anti-pattern: writing an intent on every Edit (an auto-hook already covers this — it is spam).

**Recovery:** Master continuation (see `contracts.md` §7):

```bash
# 1. Read the sentinel
cat .claude/tasks/<task>.progress.md
# 2. Compare last_update vs last_push (timestamps)
# 3. If the divergence > 5 min → pull out the uncommitted work
cd <coder-worktree>
git status   # we see untracked / unstaged
# 4. Master either commits manually or dispatches a Coder retry with context
```

### C2: Watchdog C2 — write-then-post pattern (MCP hang recovery)

**Symptom:** The Reviewer agent finished the analysis, started `mcp__github__create_pull_request_review`, the call hung for 10+ minutes → watchdog crash → the review did not appear on the PR.

**Root cause:** An MCP call = network I/O without a timeout wrapper in the agent prompt. If the GitHub API hangs (rate limit / network) — the agent also hangs.

**Applied fix:**

1. Save the body to a file **BEFORE** the MCP call.
   ```
   /tmp/reviewer-output/pr-<N>-<TS>.md   — for code-reviewer
   /tmp/security-reviewer-output/pr-<N>-<TS>.md   — for security-reviewer
   /tmp/legal-output/pr-<N>-<TS>.md   — for legal Mode B
   ```
2. **Attempt #1:** MCP (`mcp__github__create_pull_request_review`).
3. **Attempt #2 (fallback):** `gh api repos/.../pulls/N/reviews -X POST -F body=@<file>` via Bash.
4. **Attempt #3 (recovery):** Master pulls the body from the file, posts it itself.

**Why this is enough:** the root cause is in the MCP hang, the fix is not in making MCP respond faster (we do not control GitHub), but in making the work not get lost when it hangs. Write-then-post — a standard durable-write pattern.

### C3: Zone-of-write (worktree isolation)

**Symptom:** Coder overwrites Master patches to `scripts/pm/prep-user-testing.sh`. Coder screenshots appear in others' worktrees (a PR swept up `apps/e2e/debug-*.png` from past AutoTest runs).

**Root cause:** `git add .` / `git add -A` sweeps up whatever. The Coder has no mental model that "Master-scripts are a not-mine zone".

**Applied fix (Coder-side):**

- In `coder.md` an explicit list of **off-limits zones**:
  - `scripts/pm/**` — Master scripts
  - `scripts/devops/**` — DevOps scripts
  - `.claude/agents/**` — Architect zone (system prompts)
  - `docs/business/**` — BA zone
  - `.github/workflows/**` — DevOps zone
  - `.claude/hooks/**` — DevOps + Architect zone
  - Others' task files
- In the Coder workflow §git: **never `git add .`**. Only an explicit list of files from the task section "Concrete changes".

**Applied fix (Reviewer-side, mechanism gate):**

- If the PR diff contains changes outside the Coder's zone-of-write → Verdict: BLOCK with the specific file named.
- See the skill `code-review-discipline` §3.

### D1: ScheduleWakeup boundary (cross-session state loss)

**Symptom:** Master sets `ScheduleWakeup(delay=7200)` to wait for GHA E2E. The session ended after 30 min (token cap). The wake-up at 2 hours does not fire — lost. The PR hangs without action until the user nudges it.

**Root cause:** ScheduleWakeup state is stored session-scoped (in-process). Without an external scheduler the wake-up does not survive a crash/timeout of the source session.

**Applied fix (2-layer):**

**Layer 1 (in-session, ≤ 30 min):** `ScheduleWakeup` — for wake-ups within the current session.

**Layer 2 (cross-session, > 30 min or critical):** `mcp__scheduled-tasks__create_scheduled_task` — an external scheduler survives the session boundary.

- Master runs `scripts/pm/pm-schedule.sh` to prepare the parameters (fireAt, taskId, materialized prompt).
- Then calls the MCP tool.
- Each wake-up creates a fresh Master session with a self-contained prompt from `scripts/pm/wakeup-prompts/<template>.md` — no context leak from the source session.

**Do NOT mix both layers on one wait** — this creates duplicate fires.

**Recovery (continuation catch-up):**

- At session start — Master reads the active task files in `.claude/tasks/` and the scheduled tasks (`mcp__scheduled-tasks__*`).
- If a scheduled fire is older than `max_age_min` → immediate execute (missed wake-up).
- See `contracts.md` §7 (compaction recovery) + `RULES.md` §4.3 (wake-up layers).

### D2: Missing label declarative drift

**Symptom:** a dispatch rule references the label `ci-failed`, but it does not exist in the repo. Master tries to read the label, GitHub returns 404. Master does not react to CI failures automatically.

**Root cause:** Labels were managed ad-hoc via `gh label create`. There was no declarative source-of-truth → the label was documented in `.md` but did not exist.

**Applied fix:**

- `.github/labels.yml` — a declarative source-of-truth for all labels.
- `.github/workflows/labels-sync.yml` — a GHA workflow `crazy-max/ghaction-github-labeler@v5` syncs the yml with the repo on push to main.

**Decision rule (for Master/DevOps):** Before referencing a label in .md/.sh — add it to `.github/labels.yml`. The test CI will pass `labels-sync.yml` → the label materializes in the repo.

### D3: Conditional AutoTest dispatch (process rigidity)

**Symptom:** The Coder added full E2E coverage for the AC in the PR. Master still dispatches AutoTest. AutoTest reads the specs, sees that coverage exists → no-op. ~10 min of agent time wasted.

**Root cause:** The pre-2026-05-23 rule "MUST dispatch AutoTest after Coder" was absolute.

**Applied fix:** A decision table in `contracts.md` §3 (AutoTest dispatch):

| State                                     | Action        | Reason code                   |
| ----------------------------------------- | ------------- | ----------------------------- |
| Coder did not add specs + PR touches apps | MUST dispatch | —                             |
| Coder added specs covering the AC         | skip          | `coder-added-e2e-covering-ac` |
| PR only docs/business                     | skip          | `no-product-code-changes`     |

**Observability:** a skip without a recorded reason (in the task file / PR body) is **forbidden** — without a record = a gap in coverage.

### D4: Lessons priority (read-side cost)

**Symptom:** 27 lessons in `memory/*/lessons.md` are of equal weight. The agent, when reading, does not distinguish a P0 invariant from a P2 optimization.

**Root cause:** The append-md format is optimized for the write-side (easy to add). Read-side cost — agents read everything the same way.

**Applied fix:** The format `<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <lesson>`.

**Priority selectors:**

- **P0** — mechanism / safety invariant. A real incident → loss of work / merge / data. A violation = an immediate fix.
- **P1** — process / coverage gap. May miss a regression / coverage hole.
- **P2** — optimization. Efficiency / token usage / DX.

**Read pattern:**

```bash
grep '\[P0\]' .claude/agents/memory/coder/lessons.md
```

## Anti-patterns

| ❌ Don't | ✅ Do |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------ |
| Long Coder work without a wip-push (> 5 min / > 2 files) | wip: push after each threshold |
| An MCP call without a prior `Write` of the body file | Write → MCP → gh fallback → Master recovery (chain) |
| `ScheduleWakeup(delay > 1800)` for cross-session waits | `mcp__scheduled-tasks__create_scheduled_task` + self-contained prompt template |
| `git add .` / `git add -A` in the Coder workflow | An explicit list of files from the task spec |
| A reference to a label in .md without adding it to `.github/labels.yml` | First labels.yml + sync workflow, then the reference |
| An AutoTest skip without a recorded reason | Skip + reason (reason code) in the task file / PR body |
| Appending a lesson without a priority tag | `[P0                                                                           | P1                                                                            | P2] [<task-id>] (#tag) <lesson>` mandatory |
| An intent marker on every Edit | Only before an operation > 30 sec / a milestone / a risky moment |
| `pkill -f vite` for cleanup | `lsof -ti :PORT                                                                | xargs -r kill -TERM` (by port, not by pattern name) — for macOS compatibility |
| `git checkout BRANCH` without a pre-flight worktree check | `git worktree list --porcelain` → if there is a worktree → `cd` into it |
| GNU `timeout`/`mktemp` without a macOS shim | `_timeout` with a perl fallback / `/tmp/<prefix>-$$-$RANDOM.<ext>` |

## References

- Source RCA: `docs/architecture/2026-05-23-dev-flow-rca.md` (full D1-D4 + verification + sub-tasks)
- Lifted lessons (2026-06-03):
  - `.claude/agents/memory/coder/lessons.md` — chunking, intent markers, zone-of-write, sentinel
  - `.claude/agents/memory/reviewer/lessons.md` — write-then-post
  - `.claude/agents/memory/pm/lessons.md` — ScheduleWakeup, silent completion, Mode 3 catch-up
  - `.claude/agents/memory/devops/lessons.md` — labels, macOS shims, pkill safety, worktree checkout
- Project scripts:
  - `scripts/coder/coder-intent.sh` (intent marker)
  - `scripts/pm/pm-schedule.sh` (Layer 2 scheduling)
  - `scripts/pm/wakeup-prompts/*.md` (templates for fresh sessions)
- Agent docs:
  - `.claude/agents/coder.md` §7 (chunking), §8 (sentinel), §"Zone-of-write"
  - `.claude/agents/contracts.md` §7 (continuation / catch-up)
  - `.claude/agents/code-reviewer.md` §"Write-then-post"
- Related skills:
  - `code-review-discipline` (write-then-post applied to Reviewer)
