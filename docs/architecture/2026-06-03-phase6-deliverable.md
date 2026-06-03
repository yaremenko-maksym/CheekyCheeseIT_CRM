# Phase 6 ECC Migration — Deliverable

**Date:** 2026-06-03
**PR:** #94 (rolling, branch `feat/ecc-migration-finish`)
**Architect:** AI Architect (5th / final Architect dispatch in series)
**Scope status:** Strictly per User directive — `chore(architect): Phase 6 — cleanup (удалить deprecated .sh, BA docs, hooks-ecc-draft.json)`. No scope creep beyond the three target groups.

---

## 0. TL;DR

Phase 6 is the **final cleanup** of the ECC migration. Three targeted deletions / moves:

1. **Deprecated bash hooks** — `.claude/hooks/*.sh` (5 files, 306 lines) removed. Live wiring lives in `.claude/hooks-ecc/` (Phase 2.5).
2. **BA docs** — `docs/agents/ba.md` → `docs/business/roles/ba.md` (Option B per ADR Q5). `docs/agents/CLAUDE-ba.md` deleted (deprecated stub with no LLM use).
3. **Draft hook config** — `.claude/hooks-ecc-draft.json` removed (Phase 2 draft, superseded by Phase 2.5 `.claude/settings.json`).

Plus light ref updates in 5 live docs that linked to BA paths (historical ADRs / audits / changelogs preserved as-is per Phase 5 precedent).

After Phase 6 → orchestrator final verify → User merge approval → ECC migration **DONE**.

---

## 1. Inventory of changes

### 1.1 Sub-task A — Deprecated bash hooks

Pre-check evidence:

```bash
grep -E "\.claude/hooks/[^-]" .claude/settings.json
# (empty — zero references to legacy path)
```

`.claude/settings.json` references **only** `.claude/hooks-ecc/`:

- `post-edit-write-coder-progress.sh`
- `pre-bash-safety.sh`
- `pre-bash-coder-push-gate.sh`
- `pre-edit-write-zone-of-write.sh`
- `pre-edit-write-suggest-compact.sh`

Removed files (commit `daf4b5f`):

| File                                      | Lines | Status                                                              |
| ----------------------------------------- | ----- | ------------------------------------------------------------------- |
| `.claude/hooks/block-production-edits.sh` | 75    | DELETED (replaced by `hooks-ecc/pre-edit-write-zone-of-write.sh`)   |
| `.claude/hooks/coder-pre-push.sh`         | 81    | DELETED (replaced by `hooks-ecc/pre-bash-coder-push-gate.sh`)       |
| `.claude/hooks/coder-progress-marker.sh`  | 86    | DELETED (replaced by `hooks-ecc/post-edit-write-coder-progress.sh`) |
| `.claude/hooks/eslint-feedback.sh`        | 32    | DELETED (replaced by eslint MCP per Phase 2 ADR)                    |
| `.claude/hooks/safety.sh`                 | 32    | DELETED (replaced by `hooks-ecc/pre-bash-safety.sh`)                |

Directory `.claude/hooks/` was empty after deletions and auto-pruned by git.

### 1.2 Sub-task B — BA docs cleanup

**Decision:** **Option B (Move)** per ADR Q5 § 4.6 + Phase 3a README update.

Files affected (commit `de7fdda`):

| File                                  | Action                              | Rationale                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/ba.md` (285 lines)       | MOVED → `docs/business/roles/ba.md` | Substantive spec (golden rules, scenarios, ТЗ template, role boundaries). Preserves long-term value in a clear human-roles location.                                         |
| `docs/agents/CLAUDE-ba.md` (11 lines) | DELETED                             | Pure deprecated redirect stub. Other CLAUDE-\*.md stubs preserve LLM context-skip prompts; BA has no LLM session, so the stub has no compatibility value once `ba.md` moves. |

**Internal links inside the moved file** were updated for new path depth:

- `[RULES.md](RULES.md)` → `[RULES.md](../../agents/RULES.md)`
- `[project-state.md](project-state.md)` → `[project-state.md](../../agents/project-state.md)`
- `[contracts.md](contracts.md)` → `[contracts.md](../../agents/contracts.md)`

Note added to the top of `docs/business/roles/ba.md` explaining the move (date, ADR ref, cross-doc link convention).

**Live external refs updated:**

| File                    | Change                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`             | Agent table — BA location → `docs/business/roles/ba.md` (human)                                                                                                          |
| `docs/README.md`        | Docs tree — BA file relocated note                                                                                                                                       |
| `docs/agents/README.md` | Agent table row removed; Human roles section now points to `docs/business/roles/ba.md`; deprecated stubs section notes CLAUDE-ba.md removed; History adds Phase 6 entry. |
| `docs/agents/RULES.md`  | Agent docs table — BA row points to `../business/roles/ba.md`                                                                                                            |
| `agents/COEXISTENCE.md` | Active set listing — BA path updated                                                                                                                                     |

**Historical refs preserved as-is** (Phase 5 precedent — records describe past state):

- `docs/architecture/2026-05-31-ecc-migration-design.md` § 4.6, Q5
- `docs/architecture/2026-06-03-phase3e-deliverable.md`
- `docs/architecture/2026-06-03-phase3d-deliverable.md`
- `docs/architecture/2026-06-03-phase5-deliverable.md`
- `docs/architecture/2026-05-31-ecc-user-guide.md`
- `docs/agents/CHANGES.md`
- `docs/agents/architecture-v2.md` (2026-06-02 design proposal)
- `docs/agents/architect-audit.md`
- `docs/agents/project-state.md` "previously was scattered in" history block
- `docs/superpowers/plans/2026-05-18-multiagent-architecture.md`

### 1.3 Sub-task C — Draft hook config

`.claude/hooks-ecc-draft.json` removed (commit `9ad95d2`).

Pre-check: `_meta.status: "draft"`, `_meta.activation_target: "Phase 2.5 (separate PR)"`. After Phase 2.5 (`PR #89`) the live registration moved into `.claude/settings.json` with the actual `hooks-ecc/*.sh` wiring. The draft has been non-authoritative since then.

---

## 2. Out of Phase 6 scope (preserved)

Per User directive: "не преобразуй Phase 6 в большой refactor". The following were left as-is even though they could superficially look like cleanup candidates:

| Artifact                                    | Why preserved                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `docs/agents/reviewer.md` (deprecated shim) | Phase 3b Option = "Deprecated shim (Recommended)" preserved by user.        |
| `docs/agents/CLAUDE-coder.md`               | Deprecated context-skip stub for LLM Coder sessions. Preserved by Phase 3d. |
| `docs/agents/CLAUDE-pm.md`                  | Same — Phase 3a/3c preserved.                                               |
| `docs/agents/CLAUDE-autotest.md`            | Same — Phase 3e preserved.                                                  |
| `docs/agents/CLAUDE-devops.md`              | Same — Phase 3e preserved.                                                  |
| `docs/agents/CLAUDE-reviewer.md`            | Same — Phase 3b preserved.                                                  |
| `.github/workflows/archive/`                | Historical workflows; out of explicit User scope.                           |
| `docs/agents/_legacy/` (if exists)          | Out of explicit User scope.                                                 |
| `docs/agents/architect-audit.md`            | Phase 1 audit snapshot — historical record.                                 |
| `docs/agents/architecture-v2.md`            | 2026-06-02 design proposal — historical record.                             |
| `docs/agents/CHANGES.md`                    | Migration history log — append-only.                                        |
| `docs/architecture/2026-05-31-*.md`         | ADRs — immutable decision history.                                          |

---

## 3. Pre-check evidence (smoke verify after push)

```bash
# 1. settings.json clean
$ grep -E "\.claude/hooks/[^-]" .claude/settings.json
# (empty)

# 2. legacy hooks dir gone
$ ls .claude/hooks/ 2>/dev/null
# ls: .claude/hooks/: No such file or directory

# 3. BA in new home
$ ls docs/business/roles/ba.md
# docs/business/roles/ba.md

# 4. old paths gone
$ ls docs/agents/ba.md docs/agents/CLAUDE-ba.md 2>/dev/null
# (empty)

# 5. draft hook config gone
$ ls .claude/hooks-ecc-draft.json 2>/dev/null
# (empty)
```

PR #94 commit count: 17 (prior Phases 3a–5) + 3 (Phase 6) = **20 commits**.

---

## 4. ADR Q5 trace (BA placement decision)

From `docs/architecture/2026-05-31-ecc-migration-design.md` § 4.6 + Q5:

> **Q5:** Where do BA docs live after ECC migration?
>
> **Options:**
>
> - A. Keep in `docs/agents/ba.md` with note "human role, not LLM"
> - B. Move to `docs/business/roles/ba.md` to disambiguate
> - C. Move to `docs/agents/_human/ba.md` to keep `docs/agents/` thematically related but disambiguated
>
> **Recommendation:** B — clean separation, removes risk of LLM session-bootstrap heuristics picking up `docs/agents/ba.md` mistakenly.

Phase 6 chose **B** as recommended. The substantive content (285 lines of golden rules + 5-step scenario + ТЗ template) is preserved in the new location with relative-link updates and a banner note explaining the move. The deprecated `CLAUDE-ba.md` redirect stub is deleted because BA has no LLM session to read it.

---

## 5. Final ECC migration status

After Phase 6 push:

- Phase 1 (bootstrap) — DONE (PR #85)
- Phase 2 (hooks port to ECC JSON draft) — DONE (PR #86)
- Phase 2.5 (live hook swap) — DONE (PR #89)
- Phase 3a (Legal + Architect frontmatter) — DONE (PR #87)
- Phase 3b (Reviewer split) — DONE (in rolling)
- Phase 3c (PM monitoring + dispatch updates) — DONE (in rolling)
- Phase 3d (Coder workflow integration) — DONE (in rolling)
- Phase 3e (AutoTest + DevOps frontmatter port) — DONE (in rolling)
- Phase 4 (skills lift) — DONE (in rolling)
- Phase 5 (GHA stub + rules extraction) — DONE (in rolling)
- **Phase 6 (cleanup) — DONE (in rolling)** ← THIS

Next: orchestrator final smoke verify → User merge approval (`merge-approved` label per `feedback_approval_from_chat`).

---

## 6. What Phase 6 is NOT doing (deferred)

The following are real candidates for future cleanup but were explicitly out of the User's Phase 6 scope:

- Update RULES.md `.claude/hooks/**` zone-of-write reference to `.claude/hooks-ecc/**` (current text still says `.claude/hooks/**` — applies to both via parallel namespace; future ADR will narrow).
- Sweep `docs/agents/architect.md` references to `.claude/hooks/*.sh` (historical migration plan — should reflect post-Phase 2.5 reality after a separate update).
- Update skill files (`dev-flow-resilience/SKILL.md`, `code-review-discipline/SKILL.md`) zone-of-write strings.
- Delete `agents/COEXISTENCE.md` once Phase 3+ migration is "done" rather than "in-progress" (still a useful living doc during the rolling PR window).

All of the above should land in a separate PR with explicit User direction.
