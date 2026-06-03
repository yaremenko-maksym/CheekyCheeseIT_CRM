# Phase 3c Deliverable — PM Agent Port to ECC YAML + Dispatch Logic Update

**Date:** 2026-06-03
**Architect:** Migration Architect
**Phase:** 3c (3c.1 frontmatter port + 3c.2 dispatch logic update)
**ECC version pin:** v2.0.0-rc.1
**Branches:**

- 3c.1 (merged #91): `feat/ecc-phase-3c1-pm-frontmatter` — YAML frontmatter zero-logic port
- 3c.2 (этот PR): `feat/ecc-phase-3c2-pm-dispatch` — PM dispatch logic для Phase 3b reviewer split

**Status:** 3c.1 merged (PR #91). 3c.2 proposed (awaits user review + merge).
**ADR reference:** [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.1 (PM agent port)
**Predecessors:**

- Phase 3a (#87): Legal/Architect YAML frontmatter
- Phase 3b (#90): Reviewer split → code-reviewer + security-reviewer
- Phase 3c.1 (#91): PM YAML frontmatter (zero logic change)

---

## TL;DR

Phase 3c.2 применяет Phase 3b reviewer split (code-reviewer + security-reviewer) к PM dispatch logic. Все три ECC-агента (code-reviewer, security-reviewer, Legal) теперь диспатчатся PM'ом по единому DRY-списку critical-path trigger zones. PM Mode 2 monitoring расширен aggregate verdict logic + Mode 2.F (review timeout fallback). pm-state.json event types расширены `code_review_*` + `security_review_*` + `review_timeout`; pm-state.json **live state не модифицирован** (только schema documented в новом `docs/specs/pm-state-events.md`).

---

## Inventory — что изменено / создано

### Phase 3c.1 (PR #91 — merged)

| File                       | Change                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `docs/agents/pm.md`        | Добавлен YAML frontmatter (name/description/tools/model: opus). Тело промпта не тронуто. |
| `docs/agents/CLAUDE-pm.md` | Trim deprecation references (sync с новым frontmatter).                                  |

### Phase 3c.2 (этот PR — proposed)

| File                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/pm.md`                                   | Role intro updated → перечислены code-reviewer/security-reviewer/Legal. Mode 2 таблица обновлена (split review events). Mode 2.D переписан под aggregate verdict. Mode 2.F новый — review_timeout handler. §"Critical-path trigger zones" DRY-список. §"Aggregate verdict logic" таблица. L4 lesson переписан (default reviewer policy). Reference секция расширена.                                                                                                               |
| `docs/agents/pm-snippets.md`                          | Секция «Reviewer — code review» split на «code-reviewer — default» + «security-reviewer — критичные пути». Секция «Параллельный запуск Reviewer + Legal» расширена до code-reviewer + security-reviewer + Legal параллельно. Типичные длительности агентов: добавлены code-reviewer/security-reviewer rows. Pre-review label комментарий обновлён. pm-state.json schema v2 `agent_invocations` ключи обновлены. Event types секция полностью расширена + deprecated блок добавлен. |
| `docs/agents/memory/pm/lessons.md`                    | Append-only: 2 новых lesson (2026-06-03) — reviewer split + Mode 2.F timeout recovery. Исторический 2026-05-21 lesson про Verdict: BLOCK сохранён (применим к обоим новым агентам).                                                                                                                                                                                                                                                                                                |
| `docs/specs/pm-state-events.md`                       | **NEW.** Catalog event types — historical + Phase 3a Legal + Phase 3c.2 reviewer split. Deprecated блок для `review_approve` / `review_blocked`. Aggregate verdict — derived state (не event). Agent invocations counter — новые ключи + historical compat.                                                                                                                                                                                                                        |
| `docs/architecture/2026-06-03-phase3c-deliverable.md` | **NEW.** Этот файл — Phase 3c deliverable summary.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Untouched (intentional)

| File                                        | Reason                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/specs/pm-state.json`                  | **LIVE state file** — содержит данные Phase 6A onboarding task. Schema documentation вынесена в `pm-state-events.md`. Историческое state не мигрируется.                                         |
| `docs/agents/CLAUDE-pm.md`                  | Уже deprecated stub без упоминаний reviewer (Phase 3c.1 sync). Не trigger в 3c.2.                                                                                                                |
| `docs/agents/contracts.md`                  | Cross-agent state machine — owned by separate phase. §6 Reviewer verdict semantics всё ещё работает (Verdict: BLOCK first-line — единый pattern для обоих новых агентов). Phase 3d/4 может trim. |
| `docs/agents/reviewer.md` (shim)            | Уже deprecated с Phase 3b. PM теперь явно не диспатчит — но сам файл живёт до Phase 6 cleanup.                                                                                                   |
| `docs/agents/code-reviewer.md`              | Создан в Phase 3b, не trigger в 3c.2.                                                                                                                                                            |
| `docs/agents/security-reviewer.md`          | Создан в Phase 3b, не trigger в 3c.2.                                                                                                                                                            |
| Application code (`apps/**`, `packages/**`) | Phase 3 scope — docs-only. Application code не trigger.                                                                                                                                          |
| GHA workflows                               | `.github/workflows/archive/ai-review.yml` deprecated. Active workflows не trigger в 3c.2.                                                                                                        |
| `.claude/hooks-ecc/**`                      | Phase 2.5 active, не trigger в 3c.2.                                                                                                                                                             |

---

## PM Dispatch Decision Matrix (post Phase 3b split, codified в Phase 3c.2)

Кто диспатчится для какого PR — единая matrix:

| PR характеристика                                                          |      code-reviewer      | security-reviewer | Legal Mode B |         AutoTest          |           DevOps            |   Параллельный?   |
| -------------------------------------------------------------------------- | :---------------------: | :---------------: | :----------: | :-----------------------: | :-------------------------: | :---------------: |
| Обычный feature PR (UI / non-critical apps/api/\*\*)                       |       ✓ (default)       |         —         |      —       |   conditional (см. §5)    |              —              |        n/a        |
| PR трогает `apps/api/src/auth/**`                                          |            ✓            |         ✓         |      ✓       |        conditional        |              —              |   ✓ (3 agents)    |
| PR трогает `apps/api/src/finance/**`                                       |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/src/transactions/**`                                  |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/src/payouts/**`                                       |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/src/wallets/**` (Phase 7+)                            |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/src/documents/**`                                     |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/src/users/**` (PII)                                   |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `packages/shared/src/schemas/{auth,finance,users,documents}.ts` |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `package.json` / `pnpm-lock.yaml`                               |            ✓            |   ✓ (npm audit)   |      —       |        conditional        |              —              |   ✓ (2 agents)    |
| PR трогает `contracts/**` (Phase 8 USDT)                                   |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR трогает `apps/api/drizzle/migrations/**`                                |            ✓            |  ✓ (data shape)   | conditional  |        conditional        | conditional (init-tracking) |         ✓         |
| Diff > 500 LOC + любое из выше                                             |            ✓            |         ✓         | conditional  |        conditional        |              —              |         ✓         |
| Docs-only PR (только `docs/**`)                                            |  conditional (skip OK)  |         —         |      —       | skip (`autotest_skipped`) |              —              |        n/a        |
| DevOps PR (только `.github/**`, `.claude/hooks-ecc/**`)                    | ✓ (zone-of-write check) |  ✓ (CI security)  |      —       |           skip            |          initiator          | parallel possible |

**Reading the matrix:**

- ✓ = диспатчится обязательно
- conditional = диспатчится по дополнительным правилам (см. `contracts.md` §5 для AutoTest)
- — = не диспатчится
- "Параллельный?" — диспатчатся все одним dispatch message с `run_in_background=True`

---

## Event Types Reference (new в Phase 3c.2)

Полный catalog — `docs/specs/pm-state-events.md`. Краткий обзор новых event types:

| Event type                |       Phase added        | Поля (minimal)                                     | Описание                                                                |
| ------------------------- | :----------------------: | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `code_review_started`     |           3c.2           | `pr`                                               | PM dispatched code-reviewer                                             |
| `code_review_done`        |           3c.2           | `pr`, `verdict`, `rounds`                          | code-reviewer завершил. Verdict APPROVE/BLOCK.                          |
| `security_review_started` |           3c.2           | `pr`, `triggered_paths`                            | PM dispatched security-reviewer (только для critical-path PR)           |
| `security_review_done`    |           3c.2           | `pr`, `verdict`, `rounds`, `owasp_categories_hit?` | security-reviewer завершил. Verdict APPROVE/BLOCK.                      |
| `security_dispatched`     |           3c.2           | `pr`, `triggered_paths`                            | Alias для `security_review_started` (короткая форма для Mode 2 logging) |
| `review_timeout`          |           3c.2           | `pr`, `agent`, `dispatched_at`, `timeout_at`       | Reviewer не вернул verdict за 2× expected duration. Triggers Mode 2.F.  |
| `brief_approved`          | (existing in live state) | `brief`                                            | BA brief принят PM'ом. Docmented in Phase 3c.2.                         |
| `task_file_created`       | (existing in live state) | `file`                                             | PM создал task-file. Docmented in Phase 3c.2.                           |

**Deprecated (preserved in historical completed[] tasks):**

- `review_approve` → replaced by `code_review_done` + `verdict: "APPROVE"`
- `review_blocked` → replaced by `code_review_done` ИЛИ `security_review_done` + `verdict: "BLOCK"` (PM на момент записи знает какой именно reviewer)

---

## Mode 2 Verdict Aggregation Logic (codified в Phase 3c.2)

PM ждёт ВСЕ dispatched review events перед aggregate decision. Раcчёт:

```
INPUT:
  code_review_done.verdict   ∈ {APPROVE, BLOCK}     (always present — code-reviewer default)
  security_review_done.verdict ∈ {APPROVE, BLOCK}   (present iff security-reviewer dispatched)
  legal_review_posted.confidence ∈ {HIGH, MED, LOW} (present iff Legal Mode B dispatched, info-only)

OUTPUT (aggregate):
  IF code_review_done.verdict == "BLOCK":
    aggregate = BLOCK (early-exit — no waiting on security)
    label: -awaiting-pm-review, +do-not-merge → Mode 2.D
  ELIF security_review_done.verdict == "BLOCK" (если был dispatched):
    aggregate = BLOCK (early-exit)
    label: -awaiting-pm-review, +do-not-merge → Mode 2.D
  ELIF code_review_done.verdict == "APPROVE":
    IF security_review_done was dispatched AND not yet returned:
      wait
    ELIF security_review_done.verdict == "APPROVE" OR not dispatched:
      aggregate = APPROVE
      label: +awaiting-pm-review → Mode 2.B (post-review analysis)

Legal Mode B verdict — info-only:
  legal-noted label регардлесс APPROVE/BLOCK.
  Confidence LOW + hard zone → legal_escalated_to_human event, USER informed,
    но aggregate verdict от Legal НЕ зависит (Legal не gate).
```

**Race-condition note (label awaiting-pm-review):**

Label `awaiting-pm-review` ставит **только** code-reviewer на APPROVE (per `code-reviewer.md` workflow). Если security-reviewer возвращается ПЕРВЫМ с APPROVE, он ставит `security-noted` но **не** трогает `awaiting-pm-review` — это zone code-reviewer'а. Edge case: если только security-reviewer был dispatched (ad-hoc на спорный PR без code review) — тогда security-reviewer ставит `awaiting-pm-review` (см. `security-reviewer.md` Шаг 6).

---

## Critical-Path Trigger Zones (DRY single source)

PM имеет **единый** список путей для:

1. Auto-dispatch security-reviewer параллельно с code-reviewer
2. Auto-dispatch Legal Mode B параллельно

Источник истины — `docs/agents/pm.md` §"Critical-path trigger zones". Любое изменение этого списка обновляет dispatch для обеих веток (security + legal).

**Преимущество DRY:** добавление новой sensitive path (например, Phase 8: `contracts/` directory) — однократное изменение в одном месте; security-reviewer и Legal автоматически подхватят через PM dispatch.

**Synchronization check (recommended при future зон-расширениях):**

- `pm.md` §"Critical-path trigger zones" — primary
- `security-reviewer.md` § "Когда тебя диспетчат" — secondary (должен ссылаться на pm.md)
- `legal.md` Mode B trigger heuristic — secondary
- `pm.md` Mode 2 таблица "PR diff matches critical-path trigger zones" row — derived
- `pm.md` L4 lesson "Reviewer dispatching правило" — derived

В Phase 3c.2 primary updated, secondary файлы (`security-reviewer.md`, `legal.md`) уже имели свои списки из Phase 3a/3b — они **совпадают** с primary, но при будущих расширениях нужно либо ссылаться на primary, либо синхронно обновлять оба.

---

## Risk Assessment

### R1. Reviewer hang / timeout (existing risk, Phase 3c.2 codifies recovery)

**Risk:** один из dispatched reviewer'ов (code или security) зависает на MCP call (real incident 2026-05-23). Без timeout handler — PR висит без verdict бесконечно.

**Mitigation (codified в Phase 3c.2):**

- Mode 2.F (новый) — review_timeout handler. PM детектит если > 2× expected duration.
- Recovery шаги: проверить `/tmp/reviewer-output/pr-<N>-*.md` (write-then-post safety); manual gh CLI post; re-dispatch с reminder.
- Event `review_timeout` записывается.

**Residual risk:** **LOW.** Recovery codified, write-then-post pattern уже сохраняет body даже при MCP hang.

### R2. Async race condition между двумя reviewer'ами при labels

**Risk:** security-reviewer возвращается раньше code-reviewer'а и пытается поставить `awaiting-pm-review` → race с code-reviewer на label.

**Mitigation:**

- В `security-reviewer.md` Шаг 6 ясно: label `awaiting-pm-review` ставит **только** code-reviewer (default). Security-reviewer ставит `security-noted`. Edge case (only-security dispatch) — security-reviewer ставит `awaiting-pm-review` сам.
- В `pm.md` "Aggregate verdict logic" таблица — explicit race avoidance note.

**Residual risk:** **LOW.** Race теоретически возможен только в edge case ad-hoc security-only dispatch — там single agent, race не возникает.

### R3. Aggregate verdict misinterpretation после compaction

**Risk:** PM после session compaction читает `events[]`, видит только `code_review_done` (APPROVE), не знает был ли security-reviewer dispatched. Может ошибочно считать aggregate APPROVE.

**Mitigation:**

- Session-recovery checklist (pm.md §"Session-recovery") включает чтение `pm-state.json` и `agent_invocations.security_reviewer` — если > 0, security был dispatched.
- При неуверенности — PM проверяет PR reviews через `mcp__github__get_pull_request_reviews` чтобы увидеть актуальное состояние.

**Residual risk:** **MED.** Может требовать дополнительный recovery step при будущих сложных multi-reviewer сценариях. Phase 4 (lessons consolidation) может добавить дополнительный recovery checklist item.

### R4. Critical-path zones drift (synchronization)

**Risk:** Primary список в `pm.md` обновляется, но secondary списки в `security-reviewer.md` / `legal.md` не синхронизируются → агенты приходят с разными ожиданиями.

**Mitigation:**

- В Phase 3c.2 deliverable явно описана synchronization check.
- Phase 3d/3e может добавить hook check: сравнить trigger zone списки между файлами при PR на любой из них.

**Residual risk:** **MED.** Manual sync пока — automation возможна в future phases.

### R5. Historical events compatibility

**Risk:** Старые `completed[]` tasks с `review_approve` / `review_blocked` events. PM при metrics aggregation должен правильно их интерпретировать.

**Mitigation:**

- `pm-state-events.md` явно описывает deprecated блок и mapping rule (review_approve ≡ code_review_done APPROVE).
- `agent_invocations.reviewer` (legacy) ≡ `code_reviewer` (post-split).

**Residual risk:** **LOW.** Backward compat хорошо документирован.

---

## What's Next — Phase 3d (Coder shell port)

Phase 3d следующая в migration roadmap (per ADR § 2.1.X):

- `docs/agents/coder.md` — добавить YAML frontmatter (model: sonnet или opus в зависимости от ECC pattern)
- `docs/agents/CLAUDE-coder.md` — trim deprecation references
- Update coder watchdog hooks (`.claude/hooks/coder-progress-marker.sh`) — verify совместимость с ECC YAML format
- Update `docs/agents/memory/coder/` — frontmatter / lessons format normalization

После 3d:

- **Phase 3e:** AutoTest port (frontmatter + dispatch tuning)
- **Phase 3f:** DevOps port (frontmatter + GHA workflow refs)
- **Phase 4:** lessons → skills conversion (per ADR § 2.4.3) — split общий `memory/reviewer/lessons.md` на code/security split
- **Phase 5:** GHA workflow refresh (для `ai-review.yml` archived → `code-review.yml` + `security-review.yml`)
- **Phase 6:** Cleanup — удалить `reviewer.md` shim после migration всех task-файлов / references

---

## Verification (post-push, Phase 3c.2)

```bash
# 1. PR checks green (docs-only PR — e2e должен SKIP per Phase 2.5 fix)
gh pr checks <PR#>

# 2. Diff scope = docs-only
git diff origin/main...HEAD --stat
# Ожидается:
# docs/agents/pm.md                                   | +Nnn -Mmm
# docs/agents/pm-snippets.md                          | +Nnn -Mmm
# docs/agents/memory/pm/lessons.md                    | +2  (append-only)
# docs/specs/pm-state-events.md                       | +Nnn (new)
# docs/architecture/2026-06-03-phase3c-deliverable.md | +Nnn (new)

# 3. pm-state.json НЕ trigger (live state preservation)
git diff origin/main docs/specs/pm-state.json | wc -l
# Ожидается: 0

# 4. Reviewer references = только в historical / shim / deprecated context
grep -nE "Agent\(reviewer|reviewer dispatch|^### Reviewer" docs/agents/pm.md docs/agents/pm-snippets.md
# Ожидается: пусто (или только в deprecated блоках/комментариях)

grep -nE "code-reviewer|security-reviewer" docs/agents/pm.md docs/agents/pm-snippets.md | wc -l
# Ожидается: много упоминаний (>= 20)

# 5. Modes 1-5 структура pm.md сохранена
grep -cE "^## Режим" docs/agents/pm.md
# Ожидается: 5 (Mode 1, Mode 2, Mode 3, Mode 4, Mode 4.A, Mode 5 — но 4.A в подзаголовке)

# 6. Golden rules pm.md сохранены
grep -c "Golden rules" docs/agents/pm.md
# Ожидается: 1

# 7. Session-recovery checklist pm.md сохранён
grep -c "Session-recovery" docs/agents/pm.md
# Ожидается: 1
```

---

## Rollback Plan

Если PM dispatch logic вызывает проблемы в реальной работе (новый review flow ломается) — `git revert <merged-commit>` восстанавливает Phase 3c.1 state (только YAML frontmatter). Файлы 3c.2 удаляются:

- `docs/agents/pm.md` — return to Phase 3c.1 version (frontmatter + old Mode 2 без aggregate verdict)
- `docs/agents/pm-snippets.md` — return to pre-split Reviewer section
- `docs/agents/memory/pm/lessons.md` — last 2 lessons (2026-06-03) удаляются (append-only undone)
- `docs/specs/pm-state-events.md` — удаляется (new file)
- `docs/architecture/2026-06-03-phase3c-deliverable.md` — удаляется

После rollback PM возвращается к диспатчу bare `Agent(reviewer, ...)` (старый shim redirect).

Granularity: **Full phase rollback** per ADR § Architect Rollback granularity.

---

## Confidence

**HIGH** на:

- Reviewer split dispatch decisions (Phase 3b ADR pre-approved, code-reviewer/security-reviewer wells-defined)
- DRY trigger paths consolidation (single list в pm.md, secondary refs OK)
- Event types catalog (built на existing pm-state.json schema + Phase 3a Legal events)
- Aggregate verdict logic (early-exit BLOCK правило прост и предсказуем)

**MED** на:

- Mode 2.F timeout duration estimates (`pm-snippets.md` typical durations) — may need tuning после реального usage
- pm-state-events.md как single source — может конкурировать с inline schema в pm-snippets.md (но cross-references установлены)
- Synchronization risk между primary trigger zones в pm.md vs secondary в security-reviewer.md / legal.md (R4 риск)

**LOW** на:

- USDT smart contract trigger paths (`contracts/**`) — Phase 8 не начался, prospective
- Aggregate verdict computation после compaction (R3 риск) — может требовать дополнительный recovery step

---

## Links

- ADR master: [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.1 (PM port)
- Phase 3a deliverable (Legal/Architect YAML port): PR #87
- Phase 3b deliverable: [`docs/architecture/2026-06-03-phase3b-deliverable.md`](2026-06-03-phase3b-deliverable.md) — Reviewer split
- Phase 3c.1: PR #91 — PM YAML frontmatter
- Phase 3c.2: этот PR (`feat/ecc-phase-3c2-pm-dispatch`)
- PM system prompt: [`docs/agents/pm.md`](../agents/pm.md)
- PM snippets: [`docs/agents/pm-snippets.md`](../agents/pm-snippets.md)
- code-reviewer system prompt: [`docs/agents/code-reviewer.md`](../agents/code-reviewer.md)
- security-reviewer system prompt: [`docs/agents/security-reviewer.md`](../agents/security-reviewer.md)
- pm-state.json event catalog: [`docs/specs/pm-state-events.md`](../specs/pm-state-events.md)
- Deprecated reviewer shim: [`docs/agents/reviewer.md`](../agents/reviewer.md)
