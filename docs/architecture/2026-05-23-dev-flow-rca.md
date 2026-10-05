# Dev-flow Root Cause Analysis — 2026-05-23

**Status:** Implemented (PR `infra/dev-flow-fixes` co-authored DevOps + AI Architect)
**Triggered by:** Session `2026-05-23-projects-senior-share-override` — 3 rounds of edits, in each of which systemic issues at the level of the pipeline, not the feature, surfaced.
**Authors:** DevOps agent (scripts), AI Architect (.md + RCA)

## TL;DR

7 dev-flow problems → the root causes reduce to **3 classes**:
1. **Watchdog asymmetry** — Coder/Reviewer are cut off before they manage to finish I/O (push, MCP post). The root is in harness timeouts, not in the agents' logic.
2. **Cross-session state loss** — ScheduleWakeup, MCP results, uncommitted worktree files are lost at the session boundary. The root is session-scoped state without a durable layer.
3. **Implicit zones-of-write** — Coder overwrites PM-scripts, AI agents use labels absent from the repo, the "never add ." discipline is not enforced. The root is textual rules without mechanism-level gates.

Each class received a **partial fix in this PR** (documentation, workaround patterns) + a **sub-task for harness/infra-level fixes** where external integration is required.

---

## Group C — Coder/Reviewer stability

### C1 [P0]. Coder silently terminates without a push

**Symptom:** In the session 2026-05-23 round 1, the Coder read the task → started writing `apps/api/src/projects/projects.service.ts` → the text breaks off at "Let me check the schema..." → the worktree `git log` is empty. PM waits for a notification, does not receive one (the worktree is alive but idle). 200k tokens / 12 min — a typical cutoff.

**Root cause:** The runtime watchdog (Claude harness) kills the stream without a graceful shutdown. The Coder has no "flush in progress to disk" mechanism before the kill. Result: the in-memory work is lost.

**Why the textual rules (coder.md section 7 "task chunking > 3 files") did not work:**
The threshold "> 3 files OR > 30 min" was too lax. The Coder did not reach the first milestone on medium tasks (2-3 files, exploratory schema reading eats up 5-10 min).

**Applied fix (this PR):**
- `coder.md` section 7 tightened: a `wip:` push after **every 2 files OR 5 minutes** (was 3/30).
- `coder.md` section 8 (new): a sentinel pattern `<task>.progress.md` — the Coder updates `last_update`/`last_commit`/`last_push` after each milestone. On a timeout, PM reads the sentinel, sees the discrepancy `last_update` vs `last_push` → takes the work from the worktree.
- `pm/lessons.md` recorded a P0 lesson.

**Open question / follow-up:**
- A hook `.claude/hooks/coder-progress-marker.sh` (PostToolUse Edit/Write) for auto-updating the sentinel — otherwise the Coder may forget to do it by hand. Sub-task: `task-coder-watchdog-progress-markers.md`.
- Harness-level fix: a graceful SIGTERM before the hard kill so the Coder manages to `git push`. NEEDS-USER.

### C2 [P1]. Reviewer stall on posting

**Symptom:** The Reviewer agent finished the analysis, started `mcp__github__create_pull_request_review`, the call hung for 10+ minutes → watchdog crash → the review did not appear on the PR. The review body was in memory only — lost.

**Root cause:** The MCP call = network I/O without a timeout wrapper in the agent prompt. If the GitHub API hangs (rate limit / network) — the agent hangs too. The watchdog kills both.

**Applied fix (this PR):**
- `reviewer.md` Step 4.5: write-then-post pattern. The Reviewer **saves the body to a file** (`/tmp/reviewer-output/pr-N-TS.md`) BEFORE the MCP call.
- Attempt #1: MCP. Attempt #2 (fallback): `gh api repos/.../pulls/N/reviews` via Bash. Attempt #3 (recovery): PM retrieves the body from the file, posts it itself.
- The body survives a session crash → manual recovery is possible.

**Why this is enough:** the root cause is in the MCP hang, the fix is not to make MCP respond faster (we do not control GitHub) but to keep the work from being lost when it hangs. Write-then-post is a standard durable-write pattern.

### C3 [P2]. Worktree isolation leaks

**Symptoms:**
1. Coder screenshots appear in other worktrees (a PR swept up `apps/e2e/debug-*.png` from past AutoTest runs — round 4 PR #22).
2. The Coder discards PM patches to `scripts/pm/prep-user-testing.sh` ("it's not real code, I can rewrite it") — real incident 2026-05-23.

**Root cause:** `git add .` / `git add -A` sweeps up whatever is there. `.gitignore` catches fresh files, but **already tracked** files — no. And the Coder has no mental model of "PM-scripts are a not-mine zone".

**Applied fix (this PR):**
- `coder.md` new section "Zone-of-write — what the Coder does NOT TOUCH": an explicit list of off-limits zones (`scripts/pm/**`, `scripts/devops/**`, `docs/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, others' task-files).
- `reviewer.md` lesson (P1): if the diff contains changes outside the Coder zone — Verdict: BLOCK.
- `coder/lessons.md` a P0 lesson about zone-of-write.

**Open question:**
- Hook-level enforcement: the hook `block-production-edits.sh` already blocks apps/packages in the main repo, but in a worktree it is lifted. One could make a second hook that checks the target path vs the "coder zone". The difficulty: the hook sees the cwd, does not know the zone. Workaround: the Reviewer catches it at the PR stage.

---

## Group D — Orchestration

### D1 [P0]. ScheduleWakeup does not survive the session boundary

**Symptom:** PM sets `ScheduleWakeup(delay=7200)` to wait for the GHA E2E (long-running). The session ended after 30 min (token cap / timeout). The wake-up at 2 hours does not fire — it is lost. The PR hangs without action until the user nudges it.

**Root cause:** ScheduleWakeup state is stored session-scoped (in-process). Without an external scheduler (Redis queue / cron / database row) the wake-up does not survive a crash/timeout of the source session.

**Applied fix (this PR):**
- `CLAUDE-pm.md` new section "⚠️ ScheduleWakeup limitations":
  - Use ONLY for wake-ups within the current session (< 30 min)
  - For cross-session waiting — save `next_action` in `pm-state.json.active[task]` (durable)
  - Mode 3 (continuation) — catch-up logic reads `next_action`, if `scheduled_at` is older than `max_age_min` → immediate execute
- `pm/lessons.md` recorded a P0 lesson.

**Open question / follow-up:**
- Sub-task `task-harness-schedule-wakeup-persistence.md` (NEEDS-USER) — two options:
  a) Persistent ScheduleWakeup via an external scheduler (verify `mcp__scheduled-tasks__*` is sufficient)
  b) PM uses `mcp__scheduled-tasks__create_scheduled_task` for critical long-waits
- This is harness/integration level, not an AI agent.

### D2 [P1]. The `ci-failed` label is absent from the repo

**Symptom:** `pm.md` Mode 2 step 1 has a line "PR label `ci-failed` → create a fix-task for the Coder". PM tries to read the label, GitHub returns a 404. PM does not react to CI failures automatically.

**Root cause:** Labels were managed manually via `gh label create` ad-hoc. There was no declarative source-of-truth → the label was documented in `.md` but did not exist in the repo.

**Applied fix (this PR):**
- Created `.github/labels.yml` — a declarative source-of-truth for all 17 labels (including `ci-failed`).
- `ci-failed` created in the repo via `gh label create` immediately (see commit body).
- `devops/lessons.md` a P0 lesson about the CI gate.

**Open question / follow-up:**
- Sub-task `task-infra-labels-yml-sync.md` for DevOps: a GHA workflow `crazy-max/ghaction-github-labeler@v5` synchronizing the yml with the repo on push to main. So that later when the yml changes — the repo automatically follows.

### D3 [P2]. AutoTest dispatch redundant

**Symptom:** The Coder added full E2E coverage for the AC in the PR. PM dispatches AutoTest anyway. AutoTest reads the specs, sees that the coverage exists → no-op. ~10 min of agent time wasted, tokens.

**Root cause:** The pre-2026-05-23 rule "MUST dispatch AutoTest after the Coder" was absolute. There was no "check coverage before dispatch" mechanism.

**Applied fix (this PR):**
- `pm.md` Mode 2 — conditional dispatch with a decision table:
  - Coder did not add specs + PR touches apps → MUST dispatch
  - Coder added specs covering the AC → skip, event `autotest_skipped` reason="coder-added-e2e-covering-ac"
  - PR only docs/business → skip, reason="no-product-code-changes"
- `autotest.md` updated — a skip is normal.
- Observability is preserved: a skip without an event is still forbidden.

**Why this is enough:** D3 is an efficiency improvement, not safety. The coverage guarantee is from the Reviewer (they will check the AC in the code) + AutoTest fallback if the coverage is insufficient.

### D4 [P2]. Memory lessons.md without a priority template

**Symptom:** 27 lessons in `memory/*/lessons.md` are all equal. The P0 rule "sequence intent ≠ approval" (real incident → a lost merge) lies next to the P2 "delay:null for userEvent" (test-stability). The agent does not distinguish when reading.

**Root cause:** The append-md format was originally optimized for the write-side (easy to add). The read-side has a cost — agents read everything the same.

**Applied fix (this PR):**
- `memory/README.md` updated: a new format `<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <lesson>`.
- Rule-of-thumb selectors for priority (mechanism/safety = P0, process = P1, optimization = P2).
- All 27 existing lessons retro-tagged + 7 new lessons from the dev-flow-rca added.

**Why markdown and not YAML/JSON (architectural question Q4):**
I tested the mental model. Markdown:
- Plus: human-readable, easy grep (`grep '\[P0\]' lessons.md`), append-friendly (PM writes one line).
- Minus: no schema validation, no structured queries.

YAML/JSON:
- Plus: queryable (jq, structured agents).
- Minus: harder write (PM must form the structure), worse git diff readability.

Decision: markdown + tag-prefix gives **read-side** queryability via grep with minimal write-side load. If in the future queries more complex than `grep "[P0] #review-gate"` are needed — switch to YAML.

---

## Architectural questions — answers

### Q1: Single source of truth for PM-only scripts

**Problem:** The Coder overwrites scripts/pm/prep-user-testing.sh because there is no mental model of "this is not my zone".

**Solution (applied):**
- A zone-of-write section in `coder.md` — an explicit off-limits list.
- The Reviewer catches violations at the PR stage with Verdict: BLOCK.

**What we did NOT apply (considered):**
- A file-level header marker (`# PM-MANAGED — Coder do not edit`) — fragile, the Coder may ignore it.
- File ownership via CODEOWNERS — applies to PR review, does not prevent an edit. Useful additionally.
- Filesystem permissions — overhead in the dev-env, breaks worktrees.

**Open:** CODEOWNERS on `scripts/pm/`, `docs/agents/`, etc. — add in a follow-up sub-task for DevOps.

### Q2: User Testing flow — hot-reload vs production rebuild?

**Current (after PR #37 + DevOps in this PR):** production rebuild (vite preview). Tunnel via Serveo.

**Trade-offs:**
- Production build = +30-40 sec on each cycle, but the runtime via the tunnel is stable (minified bundle, no HMR socket).
- Dev hot-reload = instant code changes, but via the tunnel hundreds of unbundled modules load + the HMR socket flakes on a mobile.

**Decision: we keep the production build.** Reasons:
1. The User Testing cycle — once every N hours (after a batch of edits), not every 30 sec. 30-40 sec overhead — tolerable.
2. Tunnel reliability is critical — User Testing on a phone is mandatory, if the page does not load via the tunnel → the whole step fails.
3. Dev mode suits the local development of the dev themselves, not a shareable User Testing URL.

**Compromise:** `SKIP_TUNNEL=1` env lets the dev run locally without the tunnel (faster) if phone testing is not needed on that round.

### Q3: Coder built-in retry self-check

**Solution (applied):** The sentinel pattern `<task>.progress.md` (see C1) — the Coder declares progress to a durable file, PM uses it for recovery.

**What we did NOT apply:**
- Built-in retry inside the Coder session — impossible, a cutoff = death of the session.
- A watchdog in the Coder logic itself (timer + flush) — adds complexity without a guarantee (the watchdog is also subject to a kill).

**Why the sentinel is enough:** Recovery is modeled on the PM-side (not the Coder-side). PM is an external observer — it survives a Coder crash. The Coder declares progress → PM uses it if the Coder dies.

### Q4: PM memory — structured (YAML/JSON) vs append-md?

**Solution (applied):** markdown + tag prefix (see D4). This gives 80% of YAML's queryability at 20% of the complexity.

**Triggers for migration to YAML/JSON in the future:**
- > 100 lessons in a single file (currently 5 files × 4-9 lessons)
- Need for cross-agent queries (e.g., "all P0 lessons about #worktree across all agents")
- Need for structured fields (e.g., resolution_pr_link, related_task_ids)

---

## Summary table

| Problem | Priority | Root cause class | Applied fix | Sub-task (follow-up) |
|---|---|---|---|---|
| C1 silent termination | P0 | Watchdog asymmetry | coder.md tightened chunking + sentinel; pm.md recovery | task-coder-watchdog-progress-markers.md |
| C2 Reviewer post stall | P1 | Watchdog asymmetry | reviewer.md write-then-post + gh fallback | — (self-contained) |
| C3 worktree leaks | P2 | Implicit zones | coder.md zone-of-write + reviewer check | (CODEOWNERS optional) |
| D1 ScheduleWakeup loss | P0 | Cross-session state loss | CLAUDE-pm.md limits + workaround pattern | task-harness-schedule-wakeup-persistence.md |
| D2 ci-failed label missing | P1 | Declarative drift | .github/labels.yml + label created | task-infra-labels-yml-sync.md |
| D3 AutoTest redundant | P2 | Process rigidity | pm.md conditional dispatch | — (self-contained) |
| D4 lessons priority | P2 | Read-side cost | memory/README.md priority schema + retro-tag | — (self-contained) |

## Verification

- All 7 problems have either an applied fix or a sub-task with a justification for why it is out-of-scope.
- `pnpm typecheck` / `pnpm lint` green — the changes are only in .md/.yml (DevOps confirmed for .sh).
- 3 sub-tasks created (see `docs/specs/tasks/task-{infra-labels-yml-sync,harness-schedule-wakeup-persistence,coder-watchdog-progress-markers}.md`).

## Lessons distilled

- **A textual rule in .md without a mechanism = aspiration.** The Coder ignored the task-file with "git diff verification before each commit" — a hook `coder-pre-push.sh` was required. Same for zone-of-write: a Reviewer mechanism at the PR stage is mandatory.
- **The session boundary is a first-class concern.** Any state needed after the boundary — durable (file/db/external scheduler). In-memory state = lost.
- **A watchdog without a graceful shutdown breaks invariants.** The solution for AI agents — durable progress markers (sentinel files) before each milestone, do not rely on in-memory state survival.
