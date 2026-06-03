# Phase 3b Deliverable — Reviewer split into code-reviewer + security-reviewer

**Date:** 2026-06-03
**Architect:** Migration Architect
**Phase:** 3b (Reviewer agent split)
**ECC version pin:** v2.0.0-rc.1
**Branch:** `feat/ecc-phase-3b-reviewer-split`
**Status:** Proposed (awaits user review + merge)
**ADR reference:** [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.5

---

## TL;DR

Монолитный `docs/agents/reviewer.md` (262 строки) разделён на два narrow ECC-агента согласно ADR § 2.1.5:

- **`code-reviewer.md`** — code correctness (sonnet, ESLint MCP, write-then-post, zone-of-write)
- **`security-reviewer.md`** — security depth (opus, OWASP, npm audit, USDT/ETH patterns)
- **`reviewer.md`** — redirect shim до Phase 3c PM dispatch transition

Все Cheeky-specific паттерны (Verdict: BLOCK / write-then-post / russian / eslint MCP / session-recovery / Pre-Report Gate) сохранены в обоих новых агентах.

---

## Inventory — что создано / изменено

### Created

| File                                                  | Lines       | Назначение                                                                                                   |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `docs/agents/code-reviewer.md`                        | ~235        | Narrow code review агент (default для любого PR). YAML frontmatter (sonnet), tools allowlist, golden rules.  |
| `docs/agents/security-reviewer.md`                    | ~354        | Security-focused агент (auto-dispatched для auth/finance/wallets). YAML frontmatter (opus), tools allowlist. |
| `docs/architecture/2026-06-03-phase3b-deliverable.md` | (этот файл) | Phase 3b deliverable summary.                                                                                |

### Modified

| File                             | Change                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/reviewer.md`        | **Deprecated → shim** (262 → ~40 строк). YAML frontmatter `name: reviewer` (deprecated description), redirect body + ADR ссылка.                  |
| `docs/agents/CLAUDE-reviewer.md` | Trim references: вместо одного `reviewer.md` указано на `code-reviewer.md` + `security-reviewer.md`. Обновлена дата deprecation.                  |
| `docs/agents/README.md`          | Таблица агентов: Reviewer row заменён на 2 строки (code-reviewer + security-reviewer); добавлены Architect/Legal; reviewer.md в Deprecated stubs. |

### Untouched (intentional — для Phase 3c / Phase 4)

| File                                               | Reason                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/memory/reviewer/lessons.md`           | Общий накопленный legacy для обоих агентов до Phase 4 (lessons→skills conversion). Не split на 2 файла сейчас.                    |
| `docs/agents/pm.md` / `docs/agents/pm-snippets.md` | PM dispatch logic — обновляется в Phase 3c (отдельный deliverable). Сейчас PM продолжает диспетчить `reviewer` (shim проксирует). |
| `.github/workflows/archive/ai-review.yml`          | Архивный workflow, не активен. Trim не обязателен.                                                                                |
| `.claude/hooks-ecc/**`                             | Phase 2.5 hooks live, не Phase 3b zone.                                                                                           |

---

## Split rationale

Per ADR § 2.1.5 и ECC `AGENTS.md` "Agent-First orchestration with radical specialization":

| Concern                 | Monolith reviewer.md                                                 | Split rationale                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**               | Code correctness + security mixed                                    | Different mental models — code review = pattern matching / arch rules; security = adversarial threat modeling.                                |
| **Optimal model**       | sonnet (для скорости)                                                | code-reviewer = sonnet (fast). security-reviewer = opus (deep reasoning для OWASP / contract patterns).                                       |
| **Tool allowlist**      | Broad (mcp**eslint, mcp**github, ast-grep, WebSearch, WebFetch, ...) | Narrow per concern: code-reviewer = eslint + ast-grep + github MCP; security-reviewer = WebSearch + WebFetch + github + ast-grep (no eslint). |
| **Parallel invocation** | Один агент = sequential                                              | Финансовые PR — оба запускаются параллельно (code + security), результаты независимы → PM собирает оба verdict.                               |
| **Token efficiency**    | Каждый review загружает обе зоны проверок                            | code-reviewer не тратит токены на OWASP/secrets scan для обычных PR; security-reviewer не дублирует code review.                              |

---

## PM dispatch examples (для Phase 3c справки)

### Обычный PR (не sensitive paths)

```
Agent(
  description="code-reviewer: PR #N review",
  prompt="Прочитай docs/agents/code-reviewer.md. Review PR #N в yaremenko-maksym/CheekyCheeseIT_CRM. Sensitive paths не задеты."
)
```

Один dispatch, sequential, reviewer возвращает `Verdict: APPROVE` или `BLOCK`.

### PR трогает auth/finance/wallets/transactions

```
# Параллельный dispatch (PM запускает оба сразу)

Agent(
  description="code-reviewer: PR #N review",
  prompt="Прочитай docs/agents/code-reviewer.md. Review PR #N. Sensitive paths: apps/api/src/finance/**, packages/shared/src/schemas/finance.ts. Сигнализируй что security-reviewer параллельно."
)

Agent(
  description="security-reviewer: PR #N security review",
  prompt="Прочитай docs/agents/security-reviewer.md. Security review PR #N. Sensitive paths: apps/api/src/finance/**, packages/shared/src/schemas/finance.ts. Code-reviewer параллельно."
)
```

PM ждёт оба verdict, объединяет в общую review-round 1 logic. Если оба APPROVE → label `awaiting-pm-review` ставит code-reviewer (default). Если хотя бы один BLOCK → fix-task для Coder с обоими списками findings.

### Triggers for security-reviewer auto-dispatch

PM проверяет `gh pr files <N>` против списка sensitive paths из `security-reviewer.md` § "Когда тебя диспетчат":

- `apps/api/src/auth/**`
- `apps/api/src/finance/**`
- `apps/api/src/transactions/**`
- `apps/api/src/payouts/**`
- `apps/api/src/wallets/**`
- `packages/shared/src/schemas/finance.ts`
- `packages/shared/src/schemas/auth.ts`
- `package.json` / `pnpm-lock.yaml`
- USDT/ETH контракты (Phase 8: будущая `contracts/`)

Если хоть один файл попадает — security-reviewer dispatched параллельно с code-reviewer.

---

## Preservation note (Cheeky-specific)

Все паттерны из бывшего монолитного reviewer.md **сохранены** в обоих новых агентах:

| Pattern                                  | code-reviewer.md | security-reviewer.md | Why preserved                                                                                                       |
| ---------------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Verdict: BLOCK** first-line            | ✓                | ✓                    | GitHub блокирует `REQUEST_CHANGES` когда author==reviewer (один owner `yaremenko-maksym`). PM парсит первую строку. |
| **Write-then-post pattern**              | ✓                | ✓                    | Real incident 2026-05-23 — MCP hang > 10 мин → review теряется. Body сохраняется в `/tmp/reviewer-output/`.         |
| **Mandatory `mcp__eslint__lint-files`**  | ✓                | —                    | code-reviewer проверяет lint до review (ESLint = code concern). Security-reviewer не дублирует.                     |
| **Russian язык вывода**                  | ✓                | ✓                    | CLAUDE.md hard requirement.                                                                                         |
| **Session-recovery checklist**           | ✓                | ✓                    | Защита от compaction / cold start.                                                                                  |
| **Pre-Report Gate (HIGH/MED/LOW)**       | ✓                | ✓                    | LOW findings → summary для PM, не в review body (noise reduction).                                                  |
| **Zone-of-write check**                  | ✓                | —                    | Coder zone violations — code concern. Security-reviewer focuses on app code only.                                   |
| **NOT REQUEST_CHANGES (owner conflict)** | ✓                | ✓                    | Same author/reviewer = `yaremenko-maksym`. Только `event: COMMENT` или `event: APPROVE`.                            |

---

## Что осталось для Phase 3c

1. **PM dispatch logic update** — `docs/agents/pm.md` и `docs/agents/pm-snippets.md`:
   - Заменить `Agent(reviewer, ...)` на `Agent(code-reviewer, ...)` (default)
   - Добавить sensitive-path triage логику для auto-dispatch security-reviewer параллельно
   - Обновить `pm-state.json` schema для tracking двух reviewer dispatches (вместо одного)
2. **PM Mode 3 (parallel dispatch)** — кодифицировать pattern параллельного запуска двух reviewer-агентов для финансовых PR
3. **Smoke verification** — реальный test dispatch обоих агентов на open PR, verify что они корректно coordinate
4. **Lessons split (Phase 4)** — `memory/reviewer/lessons.md` → `memory/code-reviewer/lessons.md` + `memory/security-reviewer/lessons.md` (или skill-based migration per ADR § 2.4.3)

---

## Что осталось untouched в этой phase (intentional)

- **PM dispatch code** — не trigger Phase 3b zone (PM остаётся диспетчить `reviewer` через shim до Phase 3c)
- **memory/reviewer/lessons.md** — split откладывается до Phase 4 (lessons→skills) для cleaner conversion
- **GHA workflows** — `.github/workflows/ai-review.yml` archived; не trigger в Phase 3b
- **ECC hooks** (`.claude/hooks-ecc/**`) — Phase 2.5 live, не Phase 3b zone

---

## Verification (post-push)

```bash
# 1. PR checks green (docs-only PR, e2e должен SKIP per Phase 2.5 fix)
gh pr checks <PR#>

# 2. YAML frontmatter validity
head -10 docs/agents/code-reviewer.md       # тройные дефисы, name/description/tools/model
head -10 docs/agents/security-reviewer.md   # то же
head -10 docs/agents/reviewer.md            # deprecated shim frontmatter

# 3. Diff scope = docs-only
git diff origin/main...HEAD --stat
# Ожидается:
# docs/agents/code-reviewer.md                  | +235
# docs/agents/security-reviewer.md              | +354
# docs/agents/reviewer.md                       | -242 +42 (rewrite as shim)
# docs/agents/CLAUDE-reviewer.md                | small trim
# docs/agents/README.md                         | table update
# docs/architecture/2026-06-03-phase3b-deliverable.md | +Nnn
```

---

## Rollback plan

Если split вызывает проблемы в PM dispatch (Phase 3c) — `git revert <merged-commit>` восстанавливает монолитный `reviewer.md`. Новые файлы (`code-reviewer.md`, `security-reviewer.md`, deliverable doc) удаляются, README откатывается. ECC migration возвращается к Phase 3a state.

Granularity: **Full phase rollback** per ADR § Architect Rollback granularity (single commit revert).

---

## Confidence

**HIGH** на overall split decision (ADR pre-approved § 2.1.5, ECC pattern well-documented).

**MED** на exact distribution paths (sensitive-path триггеры могут потребовать fine-tuning в Phase 3c когда PM dispatch implemented).

**LOW** на USDT smart-contract section в security-reviewer — PHASE 8 ещё не начался, паттерны written prospectively, будут validated в реальной practice когда контракты появятся.

---

## Links

- ADR master: [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.5 (Reviewer split decision)
- Phase 3a (Legal/Architect YAML port): PR #87
- Phase 2.5 (ECC hooks live): PR #89
- CI fix (docs-only PR pass required checks): PR #88
- code-reviewer system prompt: [`docs/agents/code-reviewer.md`](../agents/code-reviewer.md)
- security-reviewer system prompt: [`docs/agents/security-reviewer.md`](../agents/security-reviewer.md)
- Deprecated reviewer shim: [`docs/agents/reviewer.md`](../agents/reviewer.md)
