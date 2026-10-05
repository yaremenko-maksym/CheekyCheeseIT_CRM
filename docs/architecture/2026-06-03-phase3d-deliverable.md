# Phase 3d Deliverable — Coder migration (3d.1 + 3d.2)

**Date:** 2026-06-03
**Phase:** 3d (Coder agent migration)
**Sub-phases:** 3d.1 (frontmatter port — PR #93, merged d7d02ce) + 3d.2 (workflow integration with ECC sub-agents — current rolling PR)
**ADR reference:** `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.3
**Migration target:** ECC v2.0.0-rc.1
**Status:** 3d.1 ✅ merged · 3d.2 ✅ committed in the rolling PR

---

## 1. Inventory — what changed

### 3d.1 (PR #93, merged)

| File                          | Change                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `docs/agents/coder.md`        | Added YAML frontmatter (name / description / tools / model) — ECC agent format, lines 1-6    |
| `docs/agents/CLAUDE-coder.md` | No changes (9-line deprecated stub without manual TDD/Reviewer mentions)                     |

### 3d.2 (current PR)

| File                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/coder.md`                                | (a) Extended the "Mandatory skill invocation" table — added ECC `tdd-guide` + `typescript-reviewer` rows + a note about D1-D4 preservation. (b) Added section §1.5 "ECC tdd-guide invocation" (workflow Step 1.5 for new features). (c) Added section §2.5 "ECC typescript-reviewer self-review" (workflow Step 2.5 — BEFORE `git push`). (d) Extended the "Reference (on-demand)" — a section of ECC sub-agents catalog references + a stack-specific skills note (after Phase 4). |
| `docs/agents/memory/coder/lessons.md`                 | Append-only lesson `2026-06-03 [phase3d.2-ecc-migration]` about the tdd-guide / typescript-reviewer delegation rules.                                                                                                                                                                                                                                                                                                                                                       |
| `docs/agents/pm-snippets.md`                          | In "Coder — new feature" + "Coder — fix in an existing branch" added notes about the Coder's self-delegation to ECC sub-agents (PM does not pass additional prompts).                                                                                                                                                                                                                                                                                                       |
| `docs/agents/CLAUDE-coder.md`                         | No changes (no mentions of manual TDD/Reviewer to update).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/architecture/2026-06-03-phase3d-deliverable.md` | New file — this document.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 2. Decomposition diagram — Coder shell + ECC sub-agents

```
                  PM (Mode 1: Dispatch)
                          │
                          ▼
              ┌───────────────────────┐
              │ Agent(coder, isolation│
              │   ="worktree", ...)   │
              └───────────┬───────────┘
                          │
                          ▼
        ┌──────────────────────────────────────┐
        │ Coder shell (docs/agents/coder.md)   │
        │ ─ project-specific orchestrator       │
        │ ─ D1-D4 resilience layer (preserved): │
        │   • intent marker (scripts/coder/)    │
        │   • chunking (wip-push every 2 files) │
        │   • AC verification (ac_verified:)    │
        │   • pre-push hook (hooks-ecc/)        │
        │ ─ zone-of-write enforcement           │
        │ ─ workflow §0-11 + ECC §1.5 + §2.5   │
        └──────┬─────────────────┬──────────────┘
               │                 │
               ▼                 ▼
   ┌───────────────────┐  ┌──────────────────────────┐
   │ ECC tdd-guide     │  │ ECC typescript-reviewer  │
   │ (§1.5 — new feat) │  │ (§2.5 — self-review)     │
   │                   │  │                          │
   │ Trigger: new      │  │ Trigger: milestone touch │
   │   feature only    │  │   .ts / .tsx files       │
   │ When: BEFORE §2   │  │ When: BEFORE git push    │
   │   Development     │  │                          │
   │ Output: TDD plan  │  │ Output: TS/Lint findings │
   │   RED→GREEN→IMPR  │  │   for self-fix           │
   │   80% coverage    │  │                          │
   └───────────────────┘  └──────────────────────────┘

   Notes:
   ─ ECC sub-agents = code quality/narrativity.
   ─ D1-D4 resilience = workflow robustness → NOT duplicated in ECC.
   ─ Knowledge primitives (nestjs-patterns / react-patterns / react-testing skills) — Phase 4 (lessons → skills).
```

---

## 3. Invocation matrix — who-when-why invokes ECC sub-agents

| Diff in the milestone                                     | Task type   | sub-agent                             | When to invoke                                          | Why                                                                      |
| --------------------------------------------------------- | ----------- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| New feature — production                                  | New feature | `tdd-guide`                           | Step 1.5 (after the branch, BEFORE §2 Development)      | TDD plan: RED→GREEN→IMPROVE + 80% coverage scaffolding                   |
| Bugfix in an existing branch                              | Bug fix     | (do not dispatch tdd-guide)           | — Use the `superpowers:systematic-debugging` skill      | A TDD plan is not applicable — a bug-isolated repro is needed            |
| Milestone with `.ts` / `.tsx`                             | Any         | `typescript-reviewer`                 | Step 2.5 (AFTER Development, BEFORE `git push`)         | Self-review: strict types / ESLint / Zod usage — reduces review iterations |
| Milestone without `.ts` / `.tsx` (only docs / config / yml) | Any         | (skip typescript-reviewer)            | —                                                       | No TS code — nothing to review                                           |
| Coder UI task                                             | New feature | `tdd-guide` + `frontend-design` skill | §1.5 + during frontend development                      | TDD plan + design quality primitives                                     |

**IMPORTANT (do not confuse):**

- ECC `typescript-reviewer` — the Coder's _self-review_, **before `git push`**, narrowly over TS/TSX.
- `docs/agents/code-reviewer.md` (Phase 3b) — _PM dispatch after the Coder push_, on the PR, narrowly over correctness/architecture.
- `docs/agents/security-reviewer.md` (Phase 3b) — _PM parallel dispatch with code-reviewer_, narrowly over OWASP/secrets/USDT.

Three different reviewers, three different moments in the pipeline.

---

## 4. Preservation — what did not move to ECC

| What is preserved                                    | Where it lives                                                                          | Why                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **D1-D4 resilience layer**                           | `docs/agents/coder.md` §3 (wip-push), §4 (watchdog), §7 (AC-in-diff), §8 (final commit) | Project-specific contract — ECC does not cover it   |
| **Intent markers**                                   | `scripts/coder/coder-intent.sh` + §4 Coder workflow                                     | Layer 8.1.1 — semantic context for PM recovery      |
| **Sentinel progress files**                          | `docs/specs/tasks/<task>.progress.md` + §4 Coder workflow                               | Recovery through PM (see `contracts.md` §7)         |
| **ac_verified pre-push gate**                        | `hooks-ecc/coder-push-gate.sh` + §8 Coder workflow                                      | Layer C3 enforcement (see ADR D3 fix)               |
| **Zone-of-write enforcement**                        | `docs/agents/RULES.md` §5 + Coder Golden rule §6                                        | Multi-agent specific (not in ECC)                   |
| **Bizlogic blocker mechanism** (`<task>.blocked.md`) | `docs/agents/coder.md` §Blocker                                                         | Custom escalation pattern for PM                    |
| **`coder.md` workflow §0-§11**                       | `docs/agents/coder.md`                                                                  | The Coder's orchestration layer — ECC only augments it |

ECC sub-agents (`tdd-guide` / `typescript-reviewer`) — _augmentation_, not _replacement_. The Coder remains a narrowly specialized orchestrator for the project.

---

## 5. Risk assessment + mitigation

| Risk                                                                  | Severity | Mitigation                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tdd-guide` invocation may slow down the Coder (extra round-trip)     | MED      | The trigger is gated on "new feature only" — a bugfix skips it (see invocation matrix §3). For small fixes — the `superpowers:systematic-debugging` skill, not a sub-agent.                                 |
| `typescript-reviewer` self-review duplicates `code-reviewer` post-push | LOW      | Different scope: typescript-reviewer = TS-only (narrow), code-reviewer = architecture/zone-of-write/ESLint comprehensive. typescript-reviewer reduces the _number_ of code-reviewer iterations, does not duplicate it. |
| The Coder may forget to invoke the ECC sub-agents (workflow drift)    | MED      | (a) The mandatory skill table lists them explicitly. (b) In the final report the Coder is required to state the invoked skills/sub-agents (see coder.md §Mandatory skill invocation footer). PM checks it in Mode 2 verify. |
| `tdd-guide` 80% coverage may conflict with E2E-only tests             | LOW      | The coverage rule is from ECC AGENTS.upstream.md § Testing Requirements. If the Coder does only E2E (apps/e2e/\*\*) — the coverage criterion is not applicable, and the Coder records this in the final report as "scope: E2E only". |
| Confusion `typescript-reviewer` ↔ `code-reviewer`                     | LOW      | An explicit "IMPORTANT:" note in coder.md §2.5 + a lesson in memory/coder/lessons.md (2026-06-03) + the invocation matrix of this deliverable.                                                              |

---

## 6. What remains for the subsequent phases (rolling PR)

### Phase 3e — AutoTest + DevOps adapt

- **AutoTest:** `docs/agents/autotest.md` — port the frontmatter (like coder.md 3d.1) + integration with the ECC `e2e-runner` (if present in the catalog) + a Playwright patterns skills note.
- **DevOps:** `docs/agents/devops.md` — port the frontmatter + integration with the ECC `build-error-resolver` + `harness-optimizer` sub-agents.
- ADR refs: § 2.1.4 (AutoTest) + § 2.1.6 (DevOps).

### Phase 4 — lessons → ECC skills

- Convert the accumulated lessons (`docs/agents/memory/*/lessons.md`) into `.claude/skills/*` knowledge primitives.
- Stack-specific skills: `nestjs-patterns`, `react-patterns`, `react-testing` — for the Coder.
- UA-specific skills for Legal (if lessons accumulate).
- The Coder reference in `coder.md` §Reference already mentions "available after Phase 4".

### Phase 5 — GHA integration

- Additive job in `.github/workflows/ci.yml` for the ECC `code-reviewer` (optional, for the experience).
- Extract the `rules/` patches from the ECC catalog.
- ADR ref: § 2.3 GHA Workflows.

### Phase 6 — cleanup

- Remove the deprecated `.claude/hooks/*.sh` (already inactive after the Phase 2.5 live-swap).
- BA legacy docs decision (`docs/agents/ba.md` keep or move).
- Remove `hooks-ecc-draft.json` (if present, a Phase 2 artifact).
- ADR refs: § 2.1.2 (BA) + § 2.2 Hooks cleanup.

### Final verify

- Orchestrator-driven: run the full multi-agent cycle (PM → Coder → code/security-reviewer → AutoTest → DevOps) on a test task, make sure all ECC integrations work.

---

## 7. Phase 3 progress overview

| Sub-phase | Agent / scope                    | Status | PR                   |
| --------- | -------------------------------- | ------ | -------------------- |
| 3a        | Legal + Architect frontmatter    | ✅     | #87                  |
| 3b        | Reviewer split → code + security | ✅     | #90                  |
| 3c.1      | PM frontmatter                   | ✅     | #91                  |
| 3c.2      | PM dispatch logic (Modes 1-5)    | ✅     | #92                  |
| **3d.1**  | **Coder frontmatter**            | ✅     | #93 (merged d7d02ce) |
| **3d.2**  | **Coder workflow integration**   | ✅     | Current rolling PR   |
| 3e        | AutoTest + DevOps adapt          | TBD    | Rolling PR (next)    |

After 3e, Phase 3 (agent migration) is fully closed. Next — Phase 4-6.

---

## 8. Verification — what should work after merge

1. PM dispatches the Coder with the usual snippet from `pm-snippets.md` — the Coder reads coder.md and in §1.5 / §2.5 knows about the ECC sub-agents.
2. Coder for a new feature: invokes `tdd-guide` via `Agent(subagent_type="tdd-guide", ...)` — a plan of TDD steps in the task progress.
3. Coder for a milestone with TS/TSX: invokes `typescript-reviewer` via `Agent(subagent_type="typescript-reviewer", ...)` — self-review findings, fixes in the same milestone, then push.
4. Coder in the final report lists which skills + ECC sub-agents it invoked (see coder.md §Mandatory skill invocation footer).
5. D1-D4 are not broken: intent markers / chunking / AC verification / pre-push hook — work as before 3d.2.

---

## 9. Links

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.3 (lines 111-122)
- ECC catalog: `docs/architecture/ecc-reference/AGENTS.upstream.md` (`tdd-guide` line 21, `typescript-reviewer` line 48)
- Phase 3b deliverable: `docs/architecture/2026-06-03-phase3b-deliverable.md` (Reviewer split precedent)
- Phase 3c deliverable: `docs/architecture/2026-06-03-phase3c-deliverable.md` (PM Modes 1-5)
- Coder agent: `docs/agents/coder.md` (305 → ~340 lines after 3d.2)
- Coder lessons: `docs/agents/memory/coder/lessons.md` (lesson 2026-06-03 phase3d.2)
- PM snippets: `docs/agents/pm-snippets.md` (Coder dispatch sections 11-65 after 3d.2)
