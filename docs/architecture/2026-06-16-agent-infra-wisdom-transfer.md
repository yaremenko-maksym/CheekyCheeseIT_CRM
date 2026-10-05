# ADR 2026-06-16 — Agent-Infra Wisdom Transfer (leaked Claude Code source)

**Status:** Accepted
**Type:** Architecture / Process hardening
**Author:** Master session (wisdom-transfer dispatch)
**Scope:** `.claude/agents/**`, `.claude/skills/**`, `.claude/rules/common/**`, `docs/architecture/**` (docs-only; no production code)

---

## Context

USER found a backup of the leaked full source of Claude Code itself (leaked via an npm sourcemap, 2026-03-31),
located at `/Users/maksym/Desktop/programming/claude-code/` (outside the CRM repo, read-only). These are Anthropic's reference
implementations of the very systems we assembled by hand. The wisdom-transfer principle: **adopt
battle-tested patterns rather than inventing locally**.

Three reference files became the basis for the transfer:

| Leak file                                   | What it serves as a reference for us                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `coordinator/coordinatorMode.ts`            | Anthropic's multi-agent coordinator system prompt -> our `pm.md`                                   |
| `services/autoDream/consolidationPrompt.ts` | The memory consolidation prompt -> our MEMORY.md / lessons system                                  |
| `skills/bundled/skillify.ts`                | The canonical SKILL.md schema (frontmatter + per-step annotations) -> our `.claude/skills/*/SKILL.md` |

---

## Decision — what was transferred (D1–D3)

### D1 — `pm.md` <- coordinator patterns

Added the section **"Coordinator discipline (dispatch synthesis)"** (after "Mandatory skill invocation"),
synthesizing `coordinatorMode.ts` §4–5 for our stack. 5 principles:

1. **Synthesis is PM's main work, it cannot be delegated.** A hard ban on phrasings like
   "figure it out from the research results" / "based on the agent's findings". PM reads the research
   agent's findings itself and writes a spec with concrete paths + line numbers. An anti-pattern vs good example
   on our paths (`apps/api/src/finance/finance.controller.ts:88`).
2. **A purpose-statement** in every dispatch prompt (depth calibration).
3. Explicit phases **Research(∥) -> Synthesis(PM) -> Implementation -> Verification**, taking into account our
   real concurrency ceiling ≈3-4 (see failure-mode FM-1 below).
4. **The Verifier looks with fresh eyes** — a separate fresh agent.
5. **Self-contained dispatch prompts** — the agent does not see the conversation with USER.

**Harness limitation, explicitly recorded:** continuation of workers via `SendMessage` in our
CLI harness is UNAVAILABLE (memory `feedback_no_sendmessage`). The "continue vs spawn" matrix from
`coordinatorMode.ts` is NOT ported — for us it is always a fresh spawn. The synthesis discipline applies fully.

### D2 — `.claude/skills/*/SKILL.md` <- skillify schema

All 12 skills had `when_to_use:` added to their frontmatter (the critical auto-invocation field from
`skillify.ts`: format "Use when… Examples: '<trigger>'") + `allowed-tools:` (minimal permission patterns).
The triggers are extracted from the existing `description` + the `skills-invocation.md` table (the source
of truth). Along the way: two `description:` fields with colons (`code-review-discipline`, `playwright-patterns`)
were quoted — they previously broke strict YAML parsing.

**Decision on per-step Success criteria:** skillify requires "Success criteria REQUIRED on every step"
for **linear step-by-step** workflows. All our 12 skills are **pattern catalogs / cookbooks**
(independent recipes "pattern 1, pattern 2…"), not sequential processes where the model needs a signal
"when to move to the next step". Hanging Success criteria on independent recipes = bloat,
contradicting skillify itself ("keep simple skills simple"). Therefore the body of the skills was not touched —
only the frontmatter. If a truly linear workflow skill appears later — it will get per-step criteria.

### D3 — cleanup deprecated/stale

- `architecture-v2.md`, `architect-audit.md`, `CHANGES.md` -> `docs/architecture/archive/`
  (with ARCHIVED banners; the work is done, the ECC migration is complete).
- Removed **6 thin redirect stubs** (`CLAUDE-pm/coder/reviewer/autotest/devops/tools.md`, 8–12 lines
  each, with DEPRECATED 2026-06-02 banners). The content has long lived in `pm.md`/`coder.md`/`code-reviewer.md`
  - `security-reviewer.md`/`autotest.md`/`devops.md` + `project-state.md`/`RULES.md`. Live links
    updated in `README.md`, `architect.md`, `project-state.md`.
- **Preserved:** `CLAUDE-legal.md` (135 lines of ACTIVE operational notes — durations / knowledge base
  structure, read from `legal.md` + `pm-snippets.md` 6×; this is NOT a stub) and `reviewer.md` (deprecated
  shim, removal — a Phase 6 follow-up).
- There are no dangling links in live files (`.claude/agents/*.md` except archive, `.claude/rules/**`,
  the root `CLAUDE.md`) (grep-check in the PR).

---

## Audit — recurring failure modes + countermeasures

An audit of our recurring classes of incidents by memory pointers. For each: **symptom ->
root cause -> existing countermeasure -> proposed improvement**.

### FM-1. Over-parallelism -> 529-burst / CPU-starvation

- **Symptom:** dispatching 5+ agents in one message -> some get `API Error: 529 Overloaded` and
  die at startup (0 tool_uses); heavy Coders + a live UT stack -> load up to 47 -> pre-push timeout-flakes
  (`phone-input.test.tsx` 6s->88-309s, `compression.service.spec.ts` 60000ms) — NOT code, resource.
- **Root cause:** the simultaneous startup burst of the first API calls exceeds the rate limit of the
  machine+API combination; each Coder boots its own vite+api stack + runs full Vitest. Source:
  `session_ops_lessons_2026_06_15`, `project_push_and_stacked_pr_gotchas` §1.
- **Existing countermeasure:** memory notes (read-side), but not recorded in the rules.
- **Improvement:** an explicit **concurrency ceiling ≈3-4** recorded in `pm.md` (Coordinator section) +
  `light-track.md` (new item "Parallel dispatch"): dispatch in waves of 2-3, stagger, restart
  the 529-killed ones (they did 0 work), before push — sweep zombie dev-ports
  (`for p in 3010 3011 …; do lsof -ti tcp:$p; done` -> kill, preserving live :3000/:3001).

### FM-2. MAIN-contamination from worktree agents

- **Symptom:** a Coder in `isolation=worktree` on the FIRST Write writes into the MAIN repo by an absolute path;
  the RBAC agent switched the user's :3000 stack to a feature branch. ~5× per session (caught only because
  PM checked).
- **Root cause:** the agent copies main-repo absolute paths from the codegraph output / from the instruction
  "read the task-file at /Users/.../CheekyCheeseIT_CRM/..."; the hook `block-production-edits.sh` does NOT catch
  a worktree agent writing into the main-repo `apps/**` (infra-gap). Source:
  `session_ops_lessons_2026_06_15` §2, `feedback_parallel_coder_contamination`,
  `feedback_agent_completion_verification`.
- **Existing countermeasure:** `block-production-edits.sh` (only from the Coder's main checkout); a manual
  PM check.
- **Improvement:** a MANDATORY checklist added to `zone-of-write.md` "verify MAIN is clean after each
  Coder": `git -C <main-repo> status --porcelain apps/ packages/` after each finished Coder;
  in the Coder's dispatch prompt — an explicit block "ALL Edit/Write INSIDE the worktree, check `git -C <worktree>
status` after the first edit". Tightening the hook for the worktree case — a separate follow-up.

### FM-3. Flaky-E2E masking via retries

- **Symptom:** Playwright E2E intermittently reddens CI, blocks merge, unrelated to the change;
  `retries:2` in CI masks flakes (a green re-run hides the instability).
- **Root cause:** different classes — (a) a click->`toHaveURL` race in a hover-reveal opacity-transition;
  (b) a **dev/prod build difference**: the spec clicked a dev-only testid, tree-shaken out of the prod build
  (`import.meta.env.DEV===false`) -> a click on a missing element; (c) integration concurrency
  (see FM-4). Source: `project_e2e_flaky_and_automerge`, memory `feedback_zero_flaky_e2e`.
- **Existing countermeasure:** the zero-flaky policy (memory), known flakes fixed #163/#216; pre-push
  runs tests locally.
- **Improvement:** a rule in the `playwright-patterns` SKILL (now with `when_to_use` auto-invocation) — fix,
  not mask: verify the fix ~10× locally; a CI-only fail => suspect a dev/prod build
  difference, not only timing; guard a dev-only testid via `if (await el.isVisible())`. A "green
  re-run" is acceptable as proof ONLY when the change causally cannot touch the failing test — not as
  a habit.

### FM-4. Integration-test concurrency flake (shared CI-postgres)

- **Symptom:** `*.integration.spec.ts` intermittently reddens CI; vitest by default parallelizes FILES
  in forks against ONE shared CI-postgres; specs measuring GLOBAL deltas (an aggregate without a WHERE scope)
  break from inserts of neighboring specs in the baseline->assert window.
- **Root cause:** globally-scoped asserts + parallel forks + one DB; vitest 4.1.8 removed
  `test.poolOptions` -> the old `poolOptions.forks.maxForks` became a silent no-op. Source:
  `session_ops_lessons_2026_06_15` §3 (fixed #216).
- **Existing countermeasure:** `fileParallelism:false` ONLY for the integration run (detected by argv
  `integration.spec`); unit remains parallel.
- **Improvement:** an invariant in the ADR (and a candidate for a `testing` rule): integration specs sharing a DB
  run SERIALLY or scope their asserts to their own uniquely-marked rows (not global deltas).
  Without DATABASE_URL — graceful-skip (see FM-6).

### FM-5. Mocked-E2E misses global guards (data-leaks)

- **Symptom:** a mocked Playwright E2E is green, but the real backend returns 403/200 differently; RECURRED 3×
  (the last 2026-06-09: #157 `getProfile` identity-leak to a SENIOR, #158 `getSummary` finance-leak
  to any logged-in user — real OWASP A01 holes, were also on main).
- **Root cause:** the mock returns what the developer EXPECTS, not what the backend really returns;
  front-only gating (`enabled: isAdmin` = UX, not security) is masked by a self-fulfilling mock; reviewers
  look at controller-level authz, not global-guard interaction. Source: `feedback_mocked_e2e_guards`.
- **Existing countermeasure:** security-reviewer is mandatory for auth/finance/RBAC; mandatory Manual QA on
  the live stack; memory notes.
- **Improvement:** strengthen as an invariant (already in `skills-invocation.md` security trigger + `pm.md` Legal
  heuristic): for finance/RBAC/auth paths the security review MUST require a **real backend guard test**
  (a caller without permissions -> 403), NOT a mocked-frontend E2E. "An E2E mocks the endpoint" on a security path =
  a red flag. Read a green mocked-E2E on such paths as "the guard is not verified".

### FM-6. "completed" != done (agent cutoff)

- **Symptom:** a background agent reported "completed", but `<result>` = a mid-execution line; tests written
  but not committed, only `wip:` without a final `ac_verified:`, the PR not opened, sometimes worked in MAIN.
- **Root cause:** turn/session/usage limits cut the agent off mid-flight; SendMessage continuation
  is unavailable (always a fresh spawn). Source: `feedback_agent_completion_verification`,
  `session_ops_lessons_2026_06_11`, `session_ops_lessons_2026_06_15` §6.
- **Existing countermeasure:** wip-push every 2 files / 5 min (git-policy); RULES §4 recovery checklist;
  the `dev-flow-resilience` skill (sentinel/intent markers).
- **Improvement:** a verify checklist before "done" recorded as mandatory (RULES §4.2 + `pm.md`
  Coordinator §4 fresh-eyes verifier): `git -C <wt> status --short` (untracked `*.spec.ts`?),
  `git log --oneline origin/main..<branch>` (a final non-`wip:` with `ac_verified:`?), `gh pr list`,
  `git worktree list` (MAIN not on a feature branch?). If not — finalize it yourself or re-dispatch
  a fresh agent into the ready worktree. `dev-flow-resilience` is now auto-invocable via `when_to_use`.

### FM-7. Stacked-PR rebase after squash-merge

- **Symptom:** a squash-merge of the base branch **CLOSES** (does not retarget) the stacked PRs (#200/#201 ->
  CLOSED when #198 merged); a branch rebased onto main BEFORE the sibling merged drags its stale files -> red CI.
- **Root cause:** GitHub does not retarget a PR on deletion of the base branch; `git rebase origin/main`
  on the stack replays the squashed-away base commits -> conflict. Source: `project_push_and_stacked_pr_gotchas` §2.
- **Existing countermeasure:** a memory recipe.
- **Improvement:** an invariant in the ADR (a candidate for a git-policy follow-up): recovery of a stacked branch —
  `git rebase --onto origin/main <old-base-SHA> <branch>` (replay only its own commits), push with
  `--force-with-lease`, `gh pr create --base main`. Before merging a reconciled stack — rebase
  each branch onto the CURRENT main (so the fix of the merged sibling is included).

---

## Targeted rule edits (back-referenced to this ADR)

1. **`.claude/rules/common/light-track.md`** — a new item "Parallel dispatch (concurrency ceiling)":
   ≈3-4 simultaneous starts, waves of 2-3, zombie-port sweep, `DATABASE_URL= git push` (FM-1, FM-6, FM-7).
2. **`.claude/rules/common/zone-of-write.md`** — a MANDATORY item "Verify MAIN is clean after each
   Coder" (`git -C <main-repo> status --porcelain apps/ packages/`) + an explicit worktree block in the dispatch prompt (FM-2).
3. **`.claude/rules/common/git-policy.md`** — an item about `DATABASE_URL= git push` for feature branches
   (data-safety: integration specs graceful-skip, do not hit live crm_db) (FM-6/FM-7 data-safety).

(The minimum per success-criteria D4 — 2 pinpoint edits; 3 done.)

---

## Consequences

- PM gets an explicit coordinator mental model (synthesis discipline) on top of the existing Modes 1–5.
- All 12 skills are auto-invocable via `when_to_use` (previously only-`name`/`description`).
- The agent folder is cleaner: -6 stale stubs, -3 historical docs (to archive), no dangling links.
- Recurring failure modes are documented with countermeasures -> the rules are pinpoint-strengthened.

## Follow-ups

1. **Remove the `reviewer.md` shim** (Phase 6 follow-up) — after all live docs stop referencing it
   as the "deprecated shim until Phase 6" (`pm.md`, `code-reviewer.md`, `RULES.md`). For now it is kept.
2. **Tighten `block-production-edits.sh`** for the worktree case (an agent from a worktree writes into the main-repo
   `apps/**`) — the current infra-gap (FM-2).
3. **Sequential pre-push package runs** (`infra/prepush-cpu-resilience`) — remove the parallel `@crm/*` test
   from `.husky/pre-push`, reduces CPU-starvation timeout-flakes (FM-1).
4. **A candidate `testing` rule** for the integration-DB invariant (serially / uniquely-marked rows) (FM-4).
5. **Move the stacked-PR recovery recipe** into git-policy at the next update (FM-7).

## Sources

- Leaked Claude Code source backup, 2026-03-31 (npm sourcemap leak): `coordinator/coordinatorMode.ts`,
  `services/autoDream/consolidationPrompt.ts`, `skills/bundled/skillify.ts`.
- Memory: `session_ops_lessons_2026_06_15`, `session_ops_lessons_2026_06_11`,
  `project_push_and_stacked_pr_gotchas`, `feedback_parallel_coder_contamination`,
  `feedback_agent_completion_verification`, `project_e2e_flaky_and_automerge`, `feedback_mocked_e2e_guards`,
  `feedback_no_sendmessage`.
