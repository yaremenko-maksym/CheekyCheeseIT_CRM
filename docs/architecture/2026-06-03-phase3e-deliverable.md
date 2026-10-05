# Phase 3e Deliverable — AutoTest + DevOps migration

**Date:** 2026-06-03
**Phase:** 3e (AutoTest + DevOps agent migration)
**ADR references:** `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.4 (AutoTest) + § 2.1.6 (DevOps)
**Migration target:** ECC v2.0.0-rc.1
**Status:** ✅ committed in rolling PR #94

---

## 1. Inventory — what changed

### 1.1 AutoTest (`docs/agents/autotest.md`)

| File                                     | Change                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/autotest.md`                | (a) Added YAML frontmatter (name / description / tools / model: sonnet) — ECC agent format. (b) Extended "Mandatory skill invocation" — added a row about ECC `skills/playwright-patterns` (after Phase 4) + a note about D3 preservation. (c) Extended "Reference (on-demand)" — a section of ECC sub-agents / skills (after Phase 4). |
| `docs/agents/CLAUDE-autotest.md`         | No changes (10-line deprecated stub without manual reviewer mentions).                                                                                                                                                                                                                                                             |
| `docs/agents/memory/autotest/lessons.md` | No changes (no new lesson — Phase 3e does not introduce new E2E patterns, only frontmatter).                                                                                                                                                                                                                                       |

### 1.2 DevOps (`docs/agents/devops.md`)

| File                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/devops.md`                | (a) Added YAML frontmatter (name / description / tools / model: sonnet). (b) Extended "Mandatory skill invocation" — added rows about ECC `build-error-resolver` + `harness-optimizer`. (c) Added a new section §7 "ECC sub-agents — invocation matrix" with 4 subsections: §7.1 build-error-resolver triggers, §7.2 harness-optimizer triggers, §7.3 DevOps custom shell scope (what stays), §7.4 workflow integration examples. (d) Extended "Reference (on-demand)" — a section of ECC sub-agents catalog refs + Phase 3e ref. |
| `docs/agents/CLAUDE-devops.md`         | No changes (10-line deprecated stub).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/agents/memory/devops/lessons.md` | No changes (no new lesson — Phase 3e is a workflow integration without new patterns).                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 1.3 Cross-cutting

| File                                                  | Change                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/README.md`                               | Updated the rows of the "Agent system prompts" table for AutoTest and DevOps — added a `(model: sonnet)` note for consistency with the Phase 3 ECC port. |
| `docs/architecture/2026-06-03-phase3e-deliverable.md` | New file — this document.                                                                                                                     |

---

## 2. Decision rationale — Adapt for both agents

| Agent    | ADR ref | Decision  | Justification                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AutoTest | § 2.1.4 | **Adapt** | Custom shell preserved (the D3 dispatch decision is unique to the project). ECC `skills/playwright-patterns` — a _knowledge primitive_ for anti-patterns, available after Phase 4. ECC `agents/e2e-runner` (if it appears in the catalog) does _not_ duplicate D3, AutoTest's job.                                                                                                                     |
| DevOps   | § 2.1.6 | **Adapt** | Decomposition: GHA workflows / Docker / env / scripts/devops — the DevOps custom shell (ECC scope does not cover it). Build errors → ECC `build-error-resolver` (pnpm/TS/Vite/Turbo). Harness config tuning → ECC `harness-optimizer` (.claude/settings.json, hooks-ecc/\*). Cite ECC `AGENTS.upstream.md` § Performance "Build troubleshooting" + § Agent Orchestration "Harness config reliability and cost". |

**Not Replace.** No agent is replaced by ECC — both are augmented with delegation to narrow sub-agents.

---

## 3. DevOps ECC invocation matrix

(The full matrix — in `docs/agents/devops.md` §7. Here, a compressed overview.)

```
                          DevOps custom shell
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌─────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│ GHA / Docker /  │    │ ECC build-error-     │    │ ECC harness-       │
│ env / scripts/  │    │ resolver (sub-agent) │    │ optimizer (sub-ag) │
│ devops          │    │                      │    │                    │
│                 │    │ Trigger: build fail  │    │ Trigger: hooks/    │
│ Owner: DevOps   │    │  (pnpm/TS/Vite/Turbo)│    │  settings.json/    │
│ Scope: workflow │    │                      │    │  agent config tune │
│  files, Docker, │    │ Output: diagnose +   │    │                    │
│  branch protect,│    │  incremental fix     │    │ Output: matcher /  │
│  secrets, GHA   │    │  suggestions         │    │  config tradeoffs  │
│  concurrency    │    │                      │    │                    │
│                 │    │ Does NOT touch GHA   │    │ Does NOT touch prod│
│                 │    │  workflows           │    │  code (apps/**)    │
└─────────────────┘    └──────────────────────┘    └────────────────────┘
```

### 3.1 Build issue routing decision tree

```
Build fails in CI or locally
        │
        ▼
┌───────────────────────────────────┐
│ Is it build-related?              │
│ (pnpm/TS/Vite/Turbo)              │
└──────────┬────────────────────────┘
           │ Yes
           ▼
┌───────────────────────────────────┐
│ Invoke ECC build-error-resolver   │
│ with the log + failing command    │
└──────────┬────────────────────────┘
           │
           ▼
┌───────────────────────────────────┐
│ Fix in the DevOps zone (workflows,│
│ scripts/devops)?                  │
└────┬──────────────┬───────────────┘
     │ Yes          │ No (prod code)
     ▼              ▼
  Do it myself  Escalate to PM → Coder dispatch
```

### 3.2 Harness tune routing

```
Hook noisy / slow OR settings.json review
        │
        ▼
┌───────────────────────────────────┐
│ Invoke ECC harness-optimizer       │
│ with a target file + goal          │
└──────────┬────────────────────────┘
           │
           ▼
┌───────────────────────────────────┐
│ Apply in .claude/settings.json /   │
│ hooks-ecc/*  (DevOps zone)         │
└──────────┬────────────────────────┘
           │
           ▼
       Smoke verify
       (latency / reliability check)
```

---

## 4. AutoTest D3 dispatch preservation

**D3 (per ADR § 2.1.4):** "If the Reviewer suggests a test fix — decide who handles it (AutoTest vs Coder)" — _AutoTest's job_, not ECC.

| What is preserved                                                    | Where it lives                                                                                                  | Why                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **D3 dispatch decision**                                             | `docs/agents/autotest.md` (intro), `docs/agents/contracts.md` §5, `docs/architecture/2026-05-23-dev-flow-rca.md` | Project-specific routing — ECC `e2e-runner` covers general E2E discipline, but not our D3 contract. |
| **3 modes** (new spec / fix flaky / coverage audit)                  | `docs/agents/autotest.md` (Mode 1 + Mode 2 + Mode 3 sections)                                                    | Workflow scoping for PM dispatch — custom.                                                        |
| **AC-first rule** (a test from the AC task-file, not from the code)  | `docs/agents/autotest.md` (Mode 1 Step 1) + Golden rule §6                                                       | Project contract — ECC `tdd-guide` RED→GREEN is not identical (TDD vs regression coverage).       |
| **Anti-patterns** (route.continue / getByText scoping / data-testid) | `docs/agents/autotest.md` section "Anti-patterns" + `memory/autotest/lessons.md`                                 | Until Phase 4 — here. After Phase 4 — they move to `skills/playwright-patterns/`.                 |
| **Worktree hygiene** (debug artifacts → /tmp)                        | `docs/agents/autotest.md` Golden rule §4 + lessons.md (2026-05-20)                                               | Multi-agent specific (not in ECC).                                                                |
| **`pnpm --filter @crm/e2e test` locally** before push               | `docs/agents/autotest.md` (frontmatter description) + RULES.md                                                   | Project mandatory rule, not covered by ECC.                                                       |

ECC sub-agents for AutoTest are _only_ knowledge primitives (Phase 4 skills/playwright-patterns). The agent shell is custom.

---

## 5. Risk assessment + mitigation

| Risk                                                                         | Severity | Mitigation                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DevOps invokes `build-error-resolver` for CI logs that require GHA edits      | MED      | §7.1 explicit note: "build-error-resolver does NOT touch `.github/workflows/*.yml`". If a build issue requires workflow edits — DevOps does it itself. Diagnose vs Fix scope separation.                                                                            |
| `harness-optimizer` edits production code (apps/api, apps/web)                | LOW      | §7.2 explicit note: "harness-optimizer does NOT edit production code. Only the Claude Code config + hooks". The Architect's zone-of-write is enforced via the `block-production-edits.sh` hook (Phase 2.5 active).                                                   |
| AutoTest forgets that D3 is AutoTest's job                                   | LOW      | The frontmatter `description` explicitly lists D3 + a secondary mention in the Mandatory skill invocation footer. Also in the Phase 3e deliverable §4. `contracts.md` §5 — single source.                                                                          |
| Phase 4 (skills/playwright-patterns) is delayed → AutoTest without primitives | LOW      | The anti-patterns remain in the `autotest.md` section "Anti-patterns" + `memory/autotest/lessons.md`. The reference in the frontmatter says "available after Phase 4" — an explicit time-gate, does not block AutoTest until Phase 4.                               |
| ECC sub-agent unavailability (the catalog is not loaded in the profile)      | MED      | DevOps fallback: if `Agent(subagent_type="build-error-resolver", ...)` errors with `unknown subagent` — DevOps classifies it itself (§6.4 CI monitoring) and applies the fix without ECC. Does not block the workflow. Same for harness-optimizer (fallback to manual matcher review). |
| Double readability of the invocation matrix (devops.md §7 + this deliverable §3) | LOW      | devops.md §7 — _agent-facing_ (a living contract). The Phase 3e deliverable §3 — a _migration record_ (a historical snapshot). The duality is OK per the pattern of past deliverables (Phase 3d.2 had the same setup for the Coder).                                 |

---

## 6. Phase 3 progress overview (after 3e)

| Sub-phase | Agent / scope                    | Status | PR                   |
| --------- | -------------------------------- | ------ | -------------------- |
| 3a        | Legal + Architect frontmatter    | ✅     | #87                  |
| 3b        | Reviewer split → code + security | ✅     | #90                  |
| 3c.1      | PM frontmatter                   | ✅     | #91                  |
| 3c.2      | PM dispatch logic (Modes 1-5)    | ✅     | #92                  |
| 3d.1      | Coder frontmatter                | ✅     | #93 (merged d7d02ce) |
| 3d.2      | Coder workflow integration       | ✅     | #94 (rolling)        |
| **3e**    | **AutoTest + DevOps adapt**      | ✅     | **#94 (rolling)**    |

After 3e, Phase 3 (agent migration) is **fully closed**. Next — Phase 4 (lessons → skills), Phase 5 (GHA integration), Phase 6 (cleanup).

---

## 7. What remains for the subsequent phases

### Phase 4 — lessons → ECC skills

- Convert `docs/agents/memory/autotest/lessons.md` anti-patterns → `.claude/skills/playwright-patterns/` knowledge primitives.
- Convert `docs/agents/memory/devops/lessons.md` cross-platform shims → `.claude/skills/devops-cross-platform/` (if it accumulates).
- Stack-specific skills for the Coder: `nestjs-patterns`, `react-patterns`, `react-testing`.
- UA-specific skills for Legal (if lessons accumulate).
- The AutoTest frontmatter reference (`skills/playwright-patterns available after Phase 4`) — becomes active after Phase 4.

### Phase 5 — GHA integration

- Additive job in `.github/workflows/ci.yml` for the ECC `code-reviewer` (optional, for the experience).
- ECC `build-error-resolver` available as an Agent via the CI claude-code-action (if the experience shows value).
- Extract the `rules/` patches from the ECC catalog into `.cursorrules` / `.clauderules`.
- ADR ref: § 2.3 GHA Workflows.

### Phase 6 — cleanup

- Remove the deprecated `.claude/hooks/*.sh` (already inactive after the Phase 2.5 live-swap).
- BA legacy docs decision (`docs/agents/ba.md` keep or move).
- Remove `hooks-ecc-draft.json` (if present, a Phase 2 artifact).
- ADR refs: § 2.1.2 (BA) + § 2.2 Hooks cleanup.

### Final verify (after Phase 6)

- Orchestrator-driven: run the full multi-agent cycle (PM → Coder → code/security-reviewer → AutoTest → DevOps) on a test task, make sure all ECC integrations work.

---

## 8. Verification — what should work after merge

1. PM dispatches AutoTest with the usual snippet from `pm-snippets.md` — AutoTest reads autotest.md and the frontmatter `description` mentions D3 + 3 modes + the mandatory `pnpm --filter @crm/e2e test`.
2. PM dispatches DevOps for a build issue — DevOps reads devops.md §7.1, invokes `Agent(subagent_type="build-error-resolver", ...)` with the log and failing command. ECC gives fix suggestions, DevOps applies them in the workflow (if DevOps zone) or escalates to PM (if prod code).
3. DevOps for a harness review — invokes `Agent(subagent_type="harness-optimizer", ...)` with a target file and a goal (latency / cost). Applies it in `.claude/settings.json` or `hooks-ecc/*`.
4. AutoTest D3 is not broken: on a Reviewer test-fix suggestion — AutoTest decides per `contracts.md` §5 (AutoTest vs Coder), it is not handed off to ECC `e2e-runner`.
5. AutoTest anti-patterns remain available in the `autotest.md` section "Anti-patterns" + `memory/autotest/lessons.md` — until the Phase 4 skills migration.

---

## 9. Links

- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` § 2.1.4 (lines 124-132, AutoTest) + § 2.1.6 (lines 146-156, DevOps)
- ECC catalog: `docs/architecture/ecc-reference/AGENTS.upstream.md` (`build-error-resolver` line 24, `e2e-runner` line 25, `harness-optimizer` line 43)
- Phase 3b deliverable: `docs/architecture/2026-06-03-phase3b-deliverable.md` (Reviewer split precedent)
- Phase 3c deliverable: `docs/architecture/2026-06-03-phase3c-deliverable.md` (PM Modes 1-5)
- Phase 3d deliverable: `docs/architecture/2026-06-03-phase3d-deliverable.md` (Coder decomposition + invocation matrix)
- AutoTest agent: `docs/agents/autotest.md` (~340 lines after 3e)
- DevOps agent: `docs/agents/devops.md` (~395 lines after 3e — +§7 invocation matrix)
- AutoTest lessons: `docs/agents/memory/autotest/lessons.md`
- DevOps lessons: `docs/agents/memory/devops/lessons.md`
