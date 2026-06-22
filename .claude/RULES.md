# RULES — Cross-Agent Rules (TOC + references)

Single source of truth для правил, применимых ко всем агентам (PM, Coder, AutoTest, Reviewer, DevOps, BA, Architect, Legal). **Phase 5 миграции** разнёс топики по отдельным файлам в `.claude/rules/common/`. Этот документ — точка входа: TOC + краткие резюме + ссылки.

**Кому читать:** всем агентам upfront при старте сессии. Сначала этот файл (~3 KB), потом релевантные `.claude/rules/common/<topic>.md` файлы on-demand.

> ECC pattern: `.claude/rules/common/` + `rules/<language>/` (см. `.claude/rules/ecc/README.md`). Мы используем только common namespace в Phase 5; language-extensions (typescript / web) — опциональны позже.

---

## 1. Tool priority — `.claude/rules/common/mcp-first.md`

**Резюме:** MCP-инструмент подходит → MCP. Нет MCP, есть нативный (Read / Edit / Write) → нативный. Только shell → Bash. Никогда не используй Bash там, где есть подходящий MCP.

**Catalog highlights:** `ast-grep` для поиска по AST, `postgres query` вместо чтения `schema.ts`, `context7` для NestJS / TanStack / Zod / Drizzle, `eslint lint-files` вместо post-edit hook'а (см. также `.claude/rules/common/eslint-mcp-first.md` для деталей Phase 2.5), `playwright browser_snapshot` перед getByRole, `github` MCP для PR review.

См. полный catalog + конкретные mandatory правила: **[`.claude/rules/common/mcp-first.md`](../../rules/common/mcp-first.md)**.

---

## 2. Git policy — `.claude/rules/common/git-policy.md`

**Резюме:** Zero-tolerance forbidden: `--no-verify`, `git add .`, push в main напрямую, force-push в main, `--admin` merge. Commit format: `<type>(<scope>): <subject>` + `ac_verified: 1,2,3` + опционально `vision:` для UI. WIP chunking: push после 2 файлов / 5 минут / перед операцией > 1 мин.

CI hard-блок: `check-no-skip-hooks.yml` падает на любой `--no-verify` в diff. Pre-push hook (`pre-bash-coder-push-gate.sh`) требует `ac_verified:` на не-`wip:` коммитах.

См. полный список forbidden patterns + commit format + chunking: **[`.claude/rules/common/git-policy.md`](../../rules/common/git-policy.md)**.

---

## 3. Skill invocation (mandatory triggers) — `.claude/rules/common/skills-invocation.md`

**Резюме:** Если trigger applies — агент **обязан** вызвать skill через `Skill` tool, не «помнить». Если skill отсутствует — explicit failure через ошибку `Skill` tool (лучше silent skip).

**Trigger highlights:** session start → `superpowers:using-superpowers`; creative task → `superpowers:brainstorming`; feature/fix → `superpowers:test-driven-development`; long-running ops → `dev-flow-resilience`; review → `code-review-discipline`; security PR → `superpowers:security-review`; .spec.ts → `playwright-patterns`; Legal mode → `ua-tax-compliance` / `ua-crypto-compliance` / `ua-it-contract` / `legal-escalation-patterns`.

См. полный trigger → skill mapping (superpowers + project-local Phase 4 lift + ECC workflow surface policy): **[`.claude/rules/common/skills-invocation.md`](../../rules/common/skills-invocation.md)**.

---

## 4. Session recovery (after compaction / cold start)

Каждый агент — ВСЕГДА читает свои golden rules + этот раздел при старте новой сессии. (Этот раздел остаётся в RULES.md, не вынесен — он навигационный и tightly coupled к этому документу.)

### 4.1 Универсальный чек-лист (все агенты)

1. Прочитать `.claude/agents/<self>.md` секция Golden rules + Recovery checklist.
2. Прочитать `.claude/RULES.md` (этот файл) — TOC + ссылки на топики.
3. Прочитать **релевантные** `.claude/rules/common/<topic>.md` on-demand.
4. Прочитать `.claude/agents/project-state.md` — текущие фазы / миграции / RBAC.
5. Прочитать свой `.claude/agents/memory/<self>/lessons.md`.

### 4.2 Per-agent дополнительные шаги

**Coder (after compaction):**

1. `git status && git log --oneline -10` — узнать где остановился
2. `cat .claude/tasks/<my-task>.progress.md` (если есть) — milestone N/M
3. `tail -5 .claude/coder-activity.log | grep INTENT` — что планировал
4. Resume: если milestone N completed — продолжай с N+1. Если intent был "starting test run" без push после — проверь не сломал ли локально.

**PM (after compaction):**

1. `cat .claude/state/pm-state.json` — текущее состояние работы
2. `ls .claude/tasks/*.blocked.md` — есть ли blocked задачи
3. `gh pr list --state open` — open PRs от агентов
4. Проверить `next_action` в каждом active task — если есть и `scheduled_at` < now, выполнить немедленно (ScheduleWakeup не выжил session boundary).

**Reviewer / AutoTest / DevOps (after compaction):**

1. Re-read PR / task-file целиком (без trust в conversation history).
2. Если в middle-of-work — `git status` / `git log --oneline -5`.

### 4.3 Wake-up layers — какой когда

PM использует два слоя для cross-session waits.

| Слой                                 | Выживает session? | Когда                            |
| ------------------------------------ | ----------------- | -------------------------------- |
| `ScheduleWakeup` (in-session)        | НЕТ               | Wait < 30 мин, активная сессия   |
| `mcp__scheduled-tasks__*` (external) | ДА                | Wait ≥ 30 мин ИЛИ критичный fire |

Не комбинировать оба слоя на один wait — дубли fire'ов.

---

## 5. Zone-of-write — `.claude/rules/common/zone-of-write.md`

**Резюме:** Каждый агент пишет ТОЛЬКО в свою зону. Reviewer выдаёт `Verdict: BLOCK` на cross-zone diffs. Active hook `.claude/hooks/pre-edit-write-zone-of-write.sh` блокирует Coder из main repo при попытке `apps/**` / `packages/**` без PM-разрешения (live с Phase 2.5).

**Zone highlights:**

- **Coder** → `apps/**`, `packages/**`, своих task progress / blocked
- **AutoTest** → `apps/e2e/**`
- **DevOps** → `.github/workflows/`, root scripts
- **PM** → `.claude/briefs/`, `.claude/agents/memory/<X>/lessons.md` (append), `scripts/pm/**`
- **BA** → `docs/business/`, `.claude/briefs/pm-brief.md`
- **Architect** → `docs/architecture/**`, `rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `<agent>.md` frontmatter + golden rules при ECC migration

См. полную матрицу + enforcement + worktree caveat + Architect-specific notes: **[`.claude/rules/common/zone-of-write.md`](../../rules/common/zone-of-write.md)**.

---

## 6. Memory & lessons protocol

Полное описание — `.claude/agents/memory/README.md`. (Этот раздел остаётся в RULES.md как навигационный к workflow PM, не extracted в `.claude/rules/common/` — он tightly coupled к PM Mode 2.A.)

### 6.1 Когда писать (trigger-based)

**После каждого merged PR (no exceptions)** PM ОБЯЗАН append 1-3 урока в `.claude/agents/memory/<agent>/lessons.md`:

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <конкретный урок одной фразой>
```

Это не optional — это часть PM workflow Mode 2.A (completed).

### 6.2 Что считать уроком

Хороший: про **что было неочевидно**, что reproducible, что предотвратимо.
Плохой: «сделал задачу», «использовал TanStack Query» — это нормальный workflow.

### 6.3 Приоритеты

- **P0** — критическое (data loss, security gap, repeat regression, отказ системы). Агент ОБЯЗАН прочитать при старте.
- **P1** — важное (rework, замедление пайплайна). Должен учитывать.
- **P2** — nice-to-know. Помогает оптимизировать.

### 6.4 Rotation (consolidate via skill)

Когда `lessons.md` достигает **20 строк** (или после каждого batch merged PRs) PM вызывает `anthropic-skills:consolidate-memory`:

1. Skill анализирует duplicates / упрощает / выделяет паттерны.
2. **P0 lessons (5+ повторений)** → promote в Golden rules соответствующего agent doc.
3. **P1 lessons** → consolidate в общие правила в `.claude/rules/common/<topic>.md` (после Phase 5 — extracted topic files, не в этом RULES.md).
4. **P2 lessons** → archive в `.claude/agents/memory/<agent>/lessons.archive.md`.

### 6.5 Archive structure

```
.claude/agents/memory/<agent>/
├── lessons.md          (active, ≤ 20 строк)
├── lessons.archive.md  (historical, full record)
```

Agents читают только `lessons.md`, не `archive.md`. Archive для retrospective.

### 6.6 Phase 4 substantive lift

Phase 4 (см. `docs/architecture/2026-06-03-phase4-deliverable.md`) лифтнула 51 substantive pattern из lessons.md → 7 skills под `.claude/skills/`. lessons.md preserved как append-log; skills — primary surface для invocation.

---

## 7. Version pins — `.claude/rules/common/version-pins.md`

**Резюме:** Node 20 LTS, pnpm 7.32.4, Vite ^6.4 (НЕ 7.x), TanStack Router `1.170.15` + plugin `1.168.18` (peer-matched EXACT пара, номера НЕ совпадают), Tailwind v4, NestJS 11, Fastify ^5.8.5 через pnpm.overrides, Zod v4, PostgreSQL 16-alpine, Redis 7-alpine.

**Forbidden overrides:** `@tanstack/router-*` в pnpm.overrides, Vite 7.x, Node major change без DevOps task.

См. полный список с rationale + forbidden overrides: **[`.claude/rules/common/version-pins.md`](../../rules/common/version-pins.md)**.

---

## 8. Other extracted rules (Phase 2.5 + earlier)

- **Russian language for user-facing output** — **[`.claude/rules/common/russian-language.md`](../../rules/common/russian-language.md)** (Phase 2.5 / ADR Q7 Option C). Все агенты общаются с user на русском; код / commits / variable names — английский.
- **ESLint MCP-first** — **[`.claude/rules/common/eslint-mcp-first.md`](../../rules/common/eslint-mcp-first.md)** (Phase 2.5 supersedes post-edit hook). Перед Edit / Write на `.ts` / `.tsx` → `mcp__eslint__lint-files`.
- **Orchestration routing (агент vs воркфлоу vs light-track)** — **[`.claude/rules/common/orchestration-routing.md`](../../rules/common/orchestration-routing.md)** (2026-06-22). Master / PM выбирает степень параллелизма: single-pipeline vs wave-fanout vs read-only audit-fanout. Cost-of-error (`pm.md`) + light-track + тир модели (`model-routing.md`) НЕ дублируются — отрабатывают раньше. Энфорсмент процедурный (judgment, как `design-gate`).

---

## 9. Quick reference — agent entry points

| Doc                                         | Кому                | Размер | Что внутри                                          |
| ------------------------------------------- | ------------------- | ------ | --------------------------------------------------- |
| `RULES.md` (этот файл)                      | All                 | ~5 KB  | TOC + summary + ссылки на .claude/rules/common/     |
| `.claude/rules/common/*.md`                 | On-demand           | varies | Per-topic detailed rules (MCP / git / skills / ...) |
| `project-state.md`                          | All                 | ~7 KB  | Phases, migrations, RBAC, tech stack                |
| `contracts.md`                              | PM, Coder, Reviewer | ~6 KB  | Cross-agent state-machine + labels + sequences      |
| `coder.md`                                  | Coder               | ~11 KB | Golden rules + workflow + recovery                  |
| `pm.md`                                     | PM                  | ~11 KB | 4 режима + dispatch decision                        |
| `pm-snippets.md`                            | PM (on-demand)      | ~16 KB | Готовые Agent() / gh / E2E сниппеты                 |
| `code-reviewer.md` + `security-reviewer.md` | Reviewer            | ~10 KB | Workflow + security + write-then-post               |
| `autotest.md`                               | AutoTest            | ~10 KB | 3 режима + AC-first + anti-patterns                 |
| `devops.md`                                 | DevOps              | ~9 KB  | Workflow + CI pipeline + secrets                    |
| `../business/roles/ba.md`                   | BA (human)          | ~10 KB | Сценарий 1 (новая фича) + role boundaries (Phase 6) |
| `architect.md`                              | Architect           | ~12 KB | ECC migration workflow + zone-of-write              |
| `legal.md`                                  | Legal               | ~17 KB | 4 modes A/B/C/D + UA jurisdictional                 |
| `memory/<agent>/lessons.md`                 | Each agent          | varies | Накопленные уроки (Phase 4: skills primary)         |
| `.claude/skills/<name>/SKILL.md`            | All (via Skill)     | varies | Invocable knowledge primitives (Phase 4 lift)       |

---

## Phase 5 migration note

Этот документ — результат **Phase 5 ECC migration (2026-06-03)**. Топики 1 / 2 / 3 / 5 / 7 экстрагированы из inline content в `.claude/rules/common/<topic>.md`. Топики 4 / 6 / 9 остались inline (навигационные / tightly coupled к PM workflow). Подробности — `docs/architecture/2026-06-03-phase5-deliverable.md` (extraction map).

Per ADR §2.8: rules extraction позволяет shorter agent prompts (через `@rule` references), single source of truth, и cross-harness portability (Phase 7+).
