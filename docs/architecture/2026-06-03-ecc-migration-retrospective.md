# ECC Migration Retrospective

**Date:** 2026-06-03
**Status:** Retrospective written at the conclusion of Phase 6 (final cleanup), prior to merge of PR #94. Treats the migration as functionally complete.
**Migration window:** 2026-05-31 (design ADR) → 2026-06-03 (Phase 6 cleanup) — three calendar days, ~6 working phases.
**Author:** AI Architect

---

## 0. TL;DR

Cheeky Cheese IT CRM migrated its multi-agent infrastructure from a custom layout (5 LLM agent docs + 5 bash hooks) to **ECC (Everything Claude Code) v2.0.0-rc.1** patterns. The migration was incremental, additive-first, and rolled forward through PR #94 (`feat/ecc-migration-finish`) on top of two earlier merged PRs (#85 bootstrap, #86 + #87 + #88 + #89 Phase 2/2.5).

**Preserved (unchanged):** business rules, RBAC matrix, finance flow, agent system prompts' Russian-language voice, all production code (apps/**, packages/**), CI/CD workflows.

**Adapted:** agent prompts gained ECC YAML frontmatter (`name`, `description`, `model`, `tools`) without removing custom golden rules; hooks ported to ECC JSON matcher format; lessons.md content lifted into invocable Skill primitives where viable; cross-agent rules extracted from `RULES.md` into discrete `rules/<topic>.md` files for ECC code-reviewer convention.

**Removed:** legacy `.claude/hooks/*.sh` (5 files, 306 lines) — superseded by `.claude/hooks-ecc/`; `.claude/hooks-ecc-draft.json` — superseded by live `.claude/settings.json`; `docs/agents/CLAUDE-ba.md` — BA is a human role with no LLM session needing a context-skip stub.

---

## 1. Phase summary

| Phase | Title                                                                                     | Outcome       | PR / commit                  |
| ----- | ----------------------------------------------------------------------------------------- | ------------- | ---------------------------- |
| 1     | Bootstrap ECC v2.0.0-rc.1 skeleton via developer profile                                  | merged        | #85                          |
| 2     | Port 5 hooks to ECC JSON matcher format (draft)                                           | merged        | #86                          |
| 2.5   | Activate ECC hooks — live swap in `.claude/settings.json`                                 | merged        | #89                          |
| 3a    | Legal + Architect agents port to ECC YAML frontmatter                                     | merged        | #87                          |
| 3b    | Reviewer split — `reviewer.md` → `code-reviewer.md` + `security-reviewer.md`              | rolling (#94) | de7fdda predecessor sequence |
| 3c    | PM monitoring + dispatch updates for split Reviewer                                       | rolling (#94) | predecessor sequence         |
| 3d    | Coder workflow integration with ECC `tdd-guide` / `typescript-reviewer`                   | rolling (#94) | predecessor sequence         |
| 3e    | AutoTest + DevOps frontmatter port + `build-error-resolver` / `harness-optimizer`         | rolling (#94) | predecessor sequence         |
| 4     | Skills lift — 7 new SKILL.md from lessons.md + dev-flow-rca patterns                      | rolling (#94) | predecessor sequence         |
| 5     | GHA stub (disabled) for ECC code-reviewer + rules extraction to `rules/common/<topic>.md` | rolling (#94) | predecessor sequence         |
| 6     | Cleanup — deprecated hooks, BA move, draft config                                         | rolling (#94) | THIS                         |

Phase 2 + 2.5 split was load-bearing: Phase 2 ported hooks **without activating** them (zero behavioral change) so smoke tests D1-D4 could validate equivalence. Phase 2.5 was a separate PR that flipped `.claude/settings.json` to the new wiring.

---

## 2. What ECC patterns we adopted

| ECC pattern                                                | Our adaptation                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML frontmatter (`name`, `description`, `model`, `tools`) | Added to all 7 LLM agent prompts (pm, coder, code-reviewer, security-reviewer, autotest, devops, legal, architect). Custom golden rules / session-recovery / workflow sections preserved below frontmatter.                                                                     |
| Hook JSON matcher registration                             | 5 hooks live in `.claude/hooks-ecc/*.sh` with `.claude/settings.json` matchers. Stable IDs per ECC convention (`<lifecycle>:<matcher>:<purpose>`).                                                                                                                              |
| Skill primitives (`<name>/SKILL.md`)                       | 7 skills lifted from lessons.md + dev-flow-rca: `playwright-patterns`, `code-review-discipline`, `dev-flow-resilience`, `ua-tax-compliance`, `ua-crypto-compliance`, `ua-it-contract`, `legal-escalation-patterns`. Plus the existing `pm-dispatching` skill from earlier work. |
| `rules/<topic>.md` extraction                              | Cross-agent rules from monolithic `RULES.md` extracted into `rules/common/*.md` (TS strict, MCP-first, zone-of-write, etc.) with `RULES.md` becoming a TOC + reference document. Enables future ECC code-reviewer GHA invocation.                                               |
| Reviewer split (code / security)                           | Monolithic `reviewer.md` split per ECC v2 convention. Old file retained as deprecated shim during Phase 3c PM dispatch transition.                                                                                                                                              |
| Multi-agent dispatch pattern                               | PM gained Mode 2 monitoring + parallel dispatch pattern for code-reviewer + security-reviewer when finance/auth/USDT code is touched.                                                                                                                                           |

---

## 3. What we preserved (non-negotiable)

Per architect-audit.md Phase 1 inventory + ADR § 1 (Coexistence Principle):

- All production code in `apps/**` and `packages/**` untouched by migration.
- All CI/CD workflows (`.github/workflows/*.yml`) unchanged in behavior; only an additive disabled stub (`ecc-code-review.yml`) added in Phase 5.
- Russian-language voice in agent prompts and User-facing messages.
- Business rules in `docs/agents/project-state.md` and `docs/business/`.
- RBAC matrix unchanged (ADMIN / SENIOR / JUNIOR / HR / ACCOUNTANT).
- Existing deprecated CLAUDE-\*.md context-skip stubs (PM / Coder / AutoTest / DevOps / Reviewer) — only BA's stub was removed because BA is human.
- All historical ADRs / audits / changelogs preserved as-is — they record past state, not current wiring.

---

## 4. What we removed (final cleanup, Phase 6)

| Removed                                   | Replaced by                                           |
| ----------------------------------------- | ----------------------------------------------------- |
| `.claude/hooks/block-production-edits.sh` | `.claude/hooks-ecc/pre-edit-write-zone-of-write.sh`   |
| `.claude/hooks/coder-pre-push.sh`         | `.claude/hooks-ecc/pre-bash-coder-push-gate.sh`       |
| `.claude/hooks/coder-progress-marker.sh`  | `.claude/hooks-ecc/post-edit-write-coder-progress.sh` |
| `.claude/hooks/eslint-feedback.sh`        | eslint MCP (per Phase 2 ADR — replaced by tool)       |
| `.claude/hooks/safety.sh`                 | `.claude/hooks-ecc/pre-bash-safety.sh`                |
| `.claude/hooks-ecc-draft.json`            | `.claude/settings.json` (Phase 2.5 live wiring)       |
| `docs/agents/ba.md`                       | MOVED → `docs/business/roles/ba.md` (ADR Q5 Option B) |
| `docs/agents/CLAUDE-ba.md`                | (deleted — no LLM session needs it; BA is human)      |

---

## 5. Lessons learned

### 5.1 Additive-first works

Every phase except Phase 6 was **purely additive** (new files, new frontmatter, new skills). Even the Reviewer split kept `reviewer.md` as a deprecated shim. This made every intermediate state reviewable in isolation and allowed PR #94 to ship as a single rolling branch with 20 commits across 6 phases.

Phase 2.5 (the only destructive moment — flipping live config) was a separate small PR with a single focused change. This let smoke tests D1-D4 happen on a controlled blast radius.

### 5.2 Phase 4 (skills) is the hardest

Out of 12 potential skill candidates surveyed in Phase 4.A reconnaissance, only 7 were viable for skill primitives. Skipped: `nestjs`, `react`, `react-testing`, `auth-jwt`, `drizzle`. Rationale: these were generic per-framework wisdom that's better captured by ECC's own framework agents (`typescript-reviewer`, `database-reviewer`, `e2e-runner`) or by docs/MCP context7. Re-assess in a future review.

### 5.3 RULES.md splitting was load-bearing

Pre-migration, `RULES.md` was a 9 KB monolith covering MCP / git / skill catalog / zone-of-write / version pins. Phase 5 extracted these into discrete `rules/common/<topic>.md` files. This was necessary precondition for the ECC code-reviewer GHA stub (which expects per-topic rule files) and incidentally improved discoverability for agents loading specific rules on-demand.

### 5.4 Historical refs should NOT be sweep-updated

A recurring temptation during cleanup phases is to update **every** reference to a renamed/moved file. Phase 5 set the precedent: historical ADRs, audits, deliverables, and changelogs that **record past state** should NOT be updated. They are immutable narrative.

Phase 6 followed this precedent: only **live wiring** docs (active agent tables, README, RULES.md) updated. Historical refs in `docs/architecture/2026-05-31-ecc-migration-design.md`, `architect-audit.md`, `architecture-v2.md`, `CHANGES.md`, `superpowers/plans/*` preserved as-is.

### 5.5 BA is human — model the project's role boundary

Pre-migration `docs/agents/ba.md` lived alongside LLM agent prompts, which created a subtle risk: an LLM session-bootstrap heuristic could pick up `ba.md` thinking it's an agent. ADR Q5 chose Option B (move to `docs/business/roles/`) to disambiguate. The deprecated `CLAUDE-ba.md` stub was deleted entirely (other CLAUDE-\*.md stubs preserve LLM context-skip prompts, but BA has no LLM session).

### 5.6 Russian + English split worked

Agent prompts and user-facing messages are Russian; code, commits, ADR titles, and frontmatter are English. This was preserved through migration. ECC YAML frontmatter (`description: ...`) accepts arbitrary language; we use English there for ECC tooling consistency.

---

## 6. Risk that materialized (or didn't)

| Risk identified pre-migration                    | Outcome                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Hook port (Phase 2) breaks dev-flow watchdog     | Did not materialize. D1-D4 smoke tests pre-flight passed before Phase 2.5 swap.        |
| Reviewer split (Phase 3b) breaks PM dispatch     | Did not materialize. Phase 3c PM monitoring update landed in same rolling PR.          |
| Skills lift (Phase 4) creates noise / low signal | Partial. 5 of 12 candidates dropped during reconnaissance to avoid this.               |
| Cleanup (Phase 6) removes still-referenced files | Did not materialize. Pre-check `grep settings.json` confirmed zero refs before delete. |
| RULES.md extraction (Phase 5) breaks agent reads | Did not materialize. TOC + references kept backward compat.                            |

No rollback needed at any phase.

---

## 7. Future work (out of ECC migration scope)

Captured for separate PRs with explicit User direction:

- **Zone-of-write text refresh** — `RULES.md` and several agent prompts still say `.claude/hooks/**`; should say `.claude/hooks-ecc/**` (or omit the subdirectory and just say `.claude/hooks*/**` to cover both).
- **Skill expansion** — Re-evaluate the 5 skipped candidates (`nestjs`, `react`, `react-testing`, `auth-jwt`, `drizzle`) once we have real agent invocation data showing where context7 / typescript-reviewer / e2e-runner fall short.
- **ECC code-reviewer enable** — Phase 5 added the GHA stub disabled. Enable in a future PR once team is ready for narrow code-review automation alongside existing `code-reviewer` / `security-reviewer` flows.
- **`agents/COEXISTENCE.md` retire** — Stop calling Phase 3 "in progress" once PR #94 merges.
- **`docs/agents/architect.md`** — Several refs to legacy `.claude/hooks/*.sh` and old migration-plan language remain; refresh to post-Phase-6 reality.

---

## 8. Acknowledgements

- ECC team — for v2.0.0-rc.1 patterns that gave us a clear destination.
- User — for the rolling-PR + per-phase approval cadence that allowed incremental validation.
- Five Architect dispatches — Phase 3a → Phase 6, each with isolated worktree, persisted state brief, and clean handoff.

---

## 9. Final state snapshot (after PR #94 merge)

- `.claude/settings.json` → 5 hooks via `hooks-ecc/`
- `.claude/hooks-ecc/` → 5 active scripts
- `.claude/skills/` → 8 skills (1 pre-existing + 7 from Phase 4)
- `agents/` → 61 ECC catalog agents (Phase 1 copy, reference)
- `docs/agents/` → 7 LLM agent prompts + cross-cutting RULES / project-state / contracts / pm-snippets + memory/ + deprecated CLAUDE-\*.md stubs for LLM context-skip
- `docs/business/roles/` → 1 human-role spec (BA)
- `rules/common/` → 6 extracted rule files (Phase 5)
- `.github/workflows/` → existing CI/CD untouched + `ecc-code-review.yml` (disabled stub)

ECC migration: **complete**.
