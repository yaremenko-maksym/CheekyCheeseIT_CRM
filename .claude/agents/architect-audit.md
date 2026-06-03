# Architect Audit — multi-agent docs inventory

**Date:** 2026-06-02
**Branch:** `chore/multiagent-docs-refactor`
**Scope:** `.claude/agents/**` + корневой `CLAUDE.md`
**Цель:** зафиксировать текущее состояние (размеры, дубликаты, противоречия, cross-refs) до того как предлагать architecture v2.

Этот файл — **read-only снимок реальности**. Никаких рекомендаций здесь нет; они в `architecture-v2.md`.

---

## 1. Inventory всех .md (размер + содержание)

`.claude/agents/**` содержит **23 .md файла** (`233992` bytes ≈ **228 KB**). Корневой `CLAUDE.md` — ещё `36 KB`. Итого **264 KB** только в multi-agent layer.

### 1.1. Top-level agent docs

| Файл                             | Lines | Size  | Назначение (сейчас)                                                              |
| -------------------------------- | ----- | ----- | -------------------------------------------------------------------------------- |
| `.claude/agents/coder.md`           | 580   | 34 KB | Полный system prompt Coder: workflow, MCP, skills, watchdog, zone-of-write       |
| `.claude/agents/pm.md`              | 410   | 24 KB | Полный system prompt PM: 4 режима, Mode 2.A-2.E, dispatch decision, User Testing |
| `.claude/agents/pm-snippets.md`     | 411   | 20 KB | On-demand сниппеты Agent()/gh/E2E/recovery (загружается через skill)             |
| `.claude/agents/reviewer.md`        | 300   | 20 KB | Code Review: workflow, security check, AST patterns, write-then-post resilience  |
| `.claude/agents/autotest.md`        | 289   | 16 KB | Test agent: 3 режима, AC-first, RBAC coverage, anti-no-op verification           |
| `.claude/agents/CLAUDE-pm.md`       | 326   | 16 KB | PM notes: GH secrets, ScheduleWakeup limitations, pm-state schema v2             |
| `.claude/agents/ba.md`              | 260   | 16 KB | BA workflow: коллизии, requirements, brief, role boundaries                      |
| `.claude/agents/CLAUDE-devops.md`   | 224   | 16 KB | DevOps notes: pipeline architecture, secrets, branch protection                  |
| `.claude/agents/devops.md`          | 230   | 12 KB | DevOps workflow: tasks, blockers, Docker, GHA conventions                        |
| `.claude/agents/CLAUDE-tools.md`    | 195   | 12 KB | Полный справочник MCP/native tools                                               |
| `.claude/agents/CLAUDE-autotest.md` | 118   | 8 KB  | AutoTest notes: seed users, anti-patterns, селекторы                             |
| `.claude/agents/CLAUDE-ba.md`       | 101   | 8 KB  | BA notes: бизнес-модель, role table, pipeline diagram                            |
| `.claude/agents/CLAUDE-coder.md`    | 93    | 8 KB  | Coder notes: команды, структура, статус фаз, технические gotchas                 |
| `.claude/agents/CLAUDE-reviewer.md` | 75    | 4 KB  | Reviewer notes: canonical architecture, version pins, RBAC, inline-comments      |

### 1.2. Memory (lessons) и meta

| Файл                                     | Lines | Size | Содержание                                                |
| ---------------------------------------- | ----- | ---- | --------------------------------------------------------- |
| `.claude/agents/memory/README.md`           | 79    | 8 KB | Lessons format, priority tags (P0/P1/P2), rotation policy |
| `.claude/agents/memory/pm/lessons.md`       | 18    | 8 KB | 11 строк уроков PM                                        |
| `.claude/agents/memory/coder/lessons.md`    | 17    | 8 KB | 10 строк уроков Coder                                     |
| `.claude/agents/memory/reviewer/lessons.md` | 16    | 4 KB | 3 строки уроков + HTML-comment placeholder                |
| `.claude/agents/memory/autotest/lessons.md` | 14    | 4 KB | 6 строк уроков AutoTest                                   |
| `.claude/agents/memory/devops/lessons.md`   | 12    | 4 KB | 5 строк уроков DevOps                                     |
| `.claude/agents/archive/qa.md`              | 174   | 8 KB | Archived QA agent (упразднён)                             |
| `.claude/agents/archive/CLAUDE-qa.md`       | 58    | 4 KB | Archived QA notes                                         |

**Замечание по lessons.md:** ни один файл не превышает порог 30 записей из `memory/README.md`. Rotation policy на бумаге существует, но реальной ротации ещё **не было** — все lessons исторически в актуальных файлах.

### 1.3. Корневой CLAUDE.md

`CLAUDE.md` (36 KB / 523 lines) — это **другой жанр**: не agent prompt, а project memory bank (статус фаз, миграции, business rules, design system). Используется всеми агентами + сессией пользователя как контекст проекта. **Не входит** в scope refactor agent-prompts, но содержит дубли с `CLAUDE-ba.md` / `CLAUDE-coder.md` (бизнес-правила, статус фаз, миграции).

---

## 2. Граф cross-references

Использован `grep -rn "docs/agents" .claude/agents/**/*.md`. Markdown link targets — не AST-конструкции, поэтому ast-grep здесь хуже plain grep.

### 2.1. Ссылки между .md (адресные пары)

```
ba.md
  → .claude/agents/CLAUDE-ba.md (обязательное чтение)

autotest.md
  → .claude/agents/CLAUDE-tools.md
  → .claude/agents/CLAUDE-autotest.md
  → .claude/agents/memory/autotest/lessons.md
  → .claude/agents/autotest.md  (self-reference)

coder.md
  → .claude/agents/CLAUDE-tools.md
  → .claude/agents/CLAUDE-coder.md
  → .claude/agents/memory/coder/lessons.md
  + zone-of-write упоминает .claude/agents/** как off-limits

pm.md
  → .claude/agents/CLAUDE-tools.md (`CLAUDE-tools.md` linked)
  → .claude/agents/CLAUDE-pm.md
  → .claude/agents/memory/pm/lessons.md
  → .claude/agents/pm-snippets.md
  → CLAUDE-pm.md → секция «ScheduleWakeup limitations»

devops.md
  → .claude/agents/CLAUDE-tools.md
  → .claude/agents/CLAUDE-devops.md
  → .claude/agents/memory/devops/lessons.md

reviewer.md
  → .claude/agents/CLAUDE-tools.md
  → .claude/agents/CLAUDE-reviewer.md
  → .claude/agents/memory/reviewer/lessons.md

pm-snippets.md
  → .claude/agents/coder.md
  → .claude/agents/CLAUDE-coder.md
  → .claude/agents/memory/coder/lessons.md
  → .claude/agents/autotest.md
  → .claude/agents/memory/autotest/lessons.md
  → .claude/agents/reviewer.md
  → .claude/agents/memory/reviewer/lessons.md
  → .claude/agents/devops.md
  → .claude/agents/memory/devops/lessons.md
  → CLAUDE-pm.md секция «ScheduleWakeup limitations»

memory/coder/lessons.md
  → coder.md (см. секции 6.1, 7, 8, 8.1.1, «Zone-of-write»)

memory/reviewer/lessons.md
  → reviewer.md шаг 4.5, coder.md «Zone-of-write»

memory/pm/lessons.md
  → CLAUDE-pm.md секция «ScheduleWakeup limitations»
  → pm.md (Mode 2.D, AutoTest dispatch decision)
```

### 2.2. Граф зависимостей (ASCII)

```
                    ┌────────────────────────┐
                    │   CLAUDE-tools.md      │ ← обязательное чтение для:
                    │   (195 lines, MCP+nat) │   coder/autotest/reviewer/devops
                    └────────────┬───────────┘
                                 │
        ┌───────────────┬────────┴───────┬───────────────┬───────────────┐
        │               │                │               │               │
   ┌────▼──┐       ┌────▼────┐      ┌────▼─────┐    ┌────▼────┐    ┌────▼────┐
   │ coder │       │autotest │      │ reviewer │    │ devops  │    │   ba    │
   │ .md   │       │  .md    │      │  .md     │    │  .md    │    │  .md    │
   │ 580   │       │  289    │      │  300     │    │  230    │    │  260    │
   └───┬───┘       └────┬────┘      └────┬─────┘    └────┬────┘    └────┬────┘
       │                │                │               │              │
   ┌───▼──────┐    ┌────▼──────┐    ┌────▼──────┐    ┌────▼──────┐  ┌───▼──────┐
   │CLAUDE-   │    │CLAUDE-    │    │CLAUDE-    │    │CLAUDE-    │  │CLAUDE-   │
   │coder.md  │    │autotest.md│    │reviewer.md│    │devops.md  │  │ba.md     │
   │93 lines  │    │118 lines  │    │75 lines   │    │224 lines  │  │101 lines │
   └───┬──────┘    └────┬──────┘    └────┬──────┘    └────┬──────┘  └────┬─────┘
       │                │                │                │              │
   ┌───▼──────┐    ┌────▼──────┐    ┌────▼──────┐    ┌────▼──────┐       │
   │memory/   │    │memory/    │    │memory/    │    │memory/    │       │
   │coder/    │    │autotest/  │    │reviewer/  │    │devops/    │       │
   │lessons   │    │lessons    │    │lessons    │    │lessons    │       │
   └──────────┘    └───────────┘    └───────────┘    └───────────┘       │
                                                                          │
   ┌────────────────────────────────────────────────────────────────┐    │
   │                          pm.md                                 │    │
   │                       (410 lines)                              │    │
   │  ↓                                                             │    │
   │  CLAUDE-pm.md (326 lines) — ScheduleWakeup, pm-state.json      │    │
   │  pm-snippets.md (411 lines) — sniplets для всех агентов        │    │
   │  memory/pm/lessons.md                                          │    │
   └──┬────────────────────────────────────────────────┬────────────┘    │
      │ (диспетчит)                                    │ (читает brief)  │
      └────────────────────────────────────────────────┴─────────────────┘
```

**Выводы из графа:**

- `CLAUDE-tools.md` — единственный shared dep всех агентов. Это **уже** работает как общий файл.
- `pm-snippets.md` — единственный файл, который **знает все агент-пути** (cross-cutting concern).
- Lessons files изолированы, не ссылаются друг на друга.
- BA не ссылается на `CLAUDE-tools.md` (хотя по логике должен).
- CLAUDE-X.md шаблон не обязателен: BA читает `CLAUDE.md` корневой вместо `CLAUDE-ba.md` (видно по обязательному чтению в `ba.md` шаг 1).

---

## 3. Дедупликация — какие правила повторяются

Выявлены повторяющиеся правила (поиск по характерным фразам). Каждое — single source of truth violation.

### 3.1. MCP-first priority

Появляется в:

| Где                                                         | Формулировка                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CLAUDE.md` корневой (lines 3-16, 17-49)                    | Таблица «Какой MCP использовать»; перечисление 6 серверов с описанием      |
| `CLAUDE-tools.md` (lines 6-13)                              | Правило выбора: `MCP → нативные → Bash`                                    |
| `coder.md` секция «Приоритет инструментов» (lines 28-48)    | Таблица + «Конкретные правила: ast-grep, postgres query, eslint, context7» |
| `pm.md` секция «Приоритет инструментов» (lines 23-35)       | Таблица; ссылка на `CLAUDE-tools.md`                                       |
| `reviewer.md` секция «Приоритет инструментов» (lines 16-35) | Таблица + «Конкретные правила»                                             |
| `autotest.md` секция «Приоритет инструментов» (lines 16-34) | Таблица + «Конкретные правила»                                             |
| `devops.md` секция «Приоритет инструментов» (lines 25-39)   | Таблица + «Конкретные правила»                                             |

**Расхождения:** в `pm.md` правило сформулировано как «MCP → нативные → Bash», в `coder.md`/`reviewer.md`/`autotest.md`/`devops.md` — «MCP → Bash/Read → grep/find». В `CLAUDE-tools.md` — «MCP → нативные (Read/Edit/Write) → Bash». Три разных формулировки одного правила.

### 3.2. Superpowers skills table

Появляется в:

| Где                             | Skills упоминаемые                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `coder.md` lines 17-26          | TDD / systematic-debugging / verification-before-completion / frontend-design / simplify / security-review |
| `pm.md` lines 393-399           | writing-plans / dispatching-parallel-agents / systematic-debugging / pm-dispatching                        |
| `reviewer.md` lines 10-14       | requesting-code-review / security-review                                                                   |
| `autotest.md` lines 7-13        | TDD / systematic-debugging / verification-before-completion                                                |
| `devops.md` lines 16-22         | writing-plans / verification-before-completion / systematic-debugging                                      |
| `CLAUDE-tools.md` lines 182-196 | Полная таблица всех 8 skills                                                                               |

Skills **не противоречат друг другу**, но **дублируются** во всех 5 agent docs. Каждый агент перечисляет свой subset, а в `CLAUDE-tools.md` есть «полная таблица», на которую никто не ссылается явно.

### 3.3. Обязательное чтение — формат

Все 5 agent docs (coder/autotest/reviewer/devops/ba) начинаются с **похожей структуры**:

```
## Обязательное чтение перед работой
1. .claude/agents/CLAUDE-tools.md
2. /.clauderules
3. .claude/agents/CLAUDE-<role>.md
4. .claude/agents/memory/<role>/lessons.md
5. <task-file or business modules>
```

Идентичная структура, но повторяется 5 раз. ba.md отклоняется: читает `CLAUDE.md` корневой первым, не `CLAUDE-tools.md`.

### 3.4. Бизнес-правила (RBAC + finance flow)

Появляются:

| Где                                  | Содержание                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| `CLAUDE.md` корневой (lines 439-449) | Полный список ключевых правил                                     |
| `CLAUDE-ba.md` (lines 88-96)         | Ключевые ограничения (тот же список, слегка другой порядок)       |
| `CLAUDE-coder.md` (lines 81-89)      | «Бизнес-логика — критичные ограничения» (тот же контент)          |
| `CLAUDE-reviewer.md` (lines 33-45)   | RBAC таблица + «JUNIOR нельзя добавить в team_members напрямую»   |
| `ba.md` (lines 226-247)              | Бизнес-модель + роли + ограничения (резюме)                       |
| `reviewer.md` (RBAC чек-лист)        | «RBAC: каждый endpoint проверяет роль пользователя» (без таблицы) |
| `autotest.md` («покрывать RBAC»)     | Только декларация, без правил                                     |

**Single source of truth должен быть** `CLAUDE.md` корневой или **новый** `docs/business/overview.md`. Сейчас 5+ копий, рискуют разойтись.

### 3.5. Канонические версии (Vite 6.4, TanStack 1.168, Node 20 LTS, pnpm 7.32.4)

Появляются:

| Где                                  | Что упоминается                          |
| ------------------------------------ | ---------------------------------------- |
| `CLAUDE.md` корневой (lines 105-108) | Все 4 версии                             |
| `CLAUDE-reviewer.md` (lines 14-21)   | Все 4 версии + правила несовместимости   |
| `CLAUDE-coder.md` (lines 73-78)      | Vite/Fastify gotchas без числовых версий |
| `CLAUDE-devops.md` (lines 136-148)   | Node 20 + pnpm 7.32.4 + правила versions |
| `devops.md` (lines 145-147)          | Опять Node 20 + pnpm 7.32.4              |

3 файла дублируют version constraints. CLAUDE-reviewer.md — самая каноническая версия.

### 3.6. Git workflow / commit hygiene

| Где                                          | Что говорит                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `coder.md` секция 3 «Коммит»                 | ЗАПРЕЩЕНО: `git add .`, `git add -A`, `git add *`, `git add apps/`               |
| `autotest.md` секция 6                       | «ТОЛЬКО конкретные spec-файлы, НИКОГДА git add . / -A / apps/e2e/»               |
| `devops.md` секция 4                         | «Не использовать `git add .` — только конкретные файлы»                          |
| `memory/coder/lessons.md` 2026-05-20 [P0]    | «git add . подметает чужие debug-артефакты — только явный список из task-секции» |
| `memory/autotest/lessons.md` 2026-05-20 [P0] | «Не коммитить debug-screenshots — складывать в `/tmp/autotest-<runid>/`»         |

Правило применимо ко всем агентам с write-access — должно быть **общим**, не повторяться 3 раза.

### 3.7. Phase status (текущее состояние фаз)

| Где                                  | Информация                                     |
| ------------------------------------ | ---------------------------------------------- |
| `CLAUDE.md` корневой (lines 185-204) | Полный список фаз 1-9 с галочками              |
| `CLAUDE-ba.md` (lines 64-73)         | Тот же список фаз                              |
| `CLAUDE-pm.md` (lines 148-157)       | Тот же список фаз                              |
| `CLAUDE-coder.md` (lines 52-61)      | Тот же список («Текущий статус (реализовано)») |

4 копии — одна часть **необходимо устаревает первой**, и остальные станут несогласованными.

### 3.8. Drizzle миграции 0000-0011

| Где                                  | Информация                              |
| ------------------------------------ | --------------------------------------- |
| `CLAUDE.md` корневой (lines 491-498) | Список миграций 0000-0011               |
| `CLAUDE-coder.md` (lines 63-69)      | Тот же список                           |
| `CLAUDE-reviewer.md` (lines 22-24)   | Список таблиц (производное от миграций) |

### 3.9. data-testid правило для навигационных кнопок

| Где                                       | Что говорит                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `coder.md` секция 6.6                     | Таблица: back-button / dialog-close / cancel-button                                   |
| `CLAUDE-autotest.md` lines 73-83          | «Слишком широкие CSS-селекторы — antipattern; data-testid на навигационных элементах» |
| `memory/coder/lessons.md` 2026-05-19 [P0] | «data-testid обязателен — Playwright strict mode падает на дублях»                    |

### 3.10. Zone-of-write (что Coder НЕ трогает)

Появляется:

- `coder.md` секция «Zone-of-write» — основная (~ строк 559-580)
- `memory/coder/lessons.md` 2026-05-23 [P0]
- `memory/reviewer/lessons.md` 2026-05-23 [P1] — Reviewer выдаёт BLOCK при violation
- `pm.md` секция «Зоны записи» (lines 379-389)

Это **новое** правило (2026-05-23). Уже зафиксировано в 4 местах с расходящимися формулировками.

---

## 4. Inconsistencies / противоречия

### 4.1. ⚠️ CRITICAL: workflows в archive, но docs ссылаются как на активные

`.claude/agents/CLAUDE-pm.md`, `CLAUDE-ba.md`, `CLAUDE-devops.md`, `ba.md` ссылаются на `.github/workflows/coder.yml`, `autotest.yml`, `devops.yml`, `ai-review.yml` как на **активные**. Реальность:

```
.github/workflows/
├── archive/
│   ├── ai-review.yml      ← упомянут в docs как активный
│   ├── autotest.yml       ← упомянут в docs как активный
│   ├── coder.yml          ← упомянут в docs как активный
│   └── devops.yml         ← упомянут в docs как активный
├── ci.yml
├── e2e.yml
├── auto-merge-on-label.yml
├── e2e-watchdog.yml
└── labels-sync.yml
```

**Все 4 agent workflows УЖЕ архивированы**. Это значит:

- Pipeline в `CLAUDE-ba.md` ("→ coder.yml → ai-review.yml") **уже не работает**.
- `CLAUDE-devops.md` lines 5-13 описывает воркфлоу пайплайна как активный — устарело.
- `pm-snippets.md` использует ТОЛЬКО `Agent(isolation="worktree")` — local dispatch.

Это **самое крупное противоречие** в текущей docs-инфраструктуре. Все докуметы про "PM запускает gh workflow run coder.yml" — стейл.

### 4.2. CLAUDE-X.md vs X.md — целевая роль не зафиксирована

В `CLAUDE-tools.md` нет описания зачем CLAUDE-X.md существует. В практике:

| Файл                        | Что в нём                                  | Что в коротком X.md (system prompt)                      |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `CLAUDE-coder.md` (93 ln)   | Команды, структура, статус, gotchas, RBAC  | Полный workflow (580 lines)                              |
| `CLAUDE-reviewer.md`(75 ln) | Architecture, version pins, RBAC, inline   | Полный workflow (300 lines)                              |
| `CLAUDE-autotest.md`(118)   | Seed users, паттерны, antipatterns         | Полный workflow (289 lines)                              |
| `CLAUDE-devops.md` (224)    | Pipeline, secrets, branch protection       | Полный workflow (230 lines) — **CLAUDE-X почти равен X** |
| `CLAUDE-pm.md` (326)        | Secrets, durations, ScheduleWakeup, schema | Полный workflow (410 lines) — **CLAUDE-X почти равен X** |
| `CLAUDE-ba.md` (101)        | Business-model, roles, fase, pipeline      | Полный workflow (260 lines)                              |

Гипотеза изначальная: CLAUDE-X.md — короткий снимок для system prompt, X.md — полный reference. **Не соблюдается** в PM/DevOps (CLAUDE-X.md почти равен X.md). И ни в одном файле явно не написано "это для system prompt", "это reference".

### 4.3. Скрипт vs PM snippet расхождение

`pm-snippets.md` lines 287-371 секция «Coder hung — recovery» дублирует логику из `coder.md` секции 8.1-8.1.1. Если правило про intent markers / activity log изменится в `coder.md`, `pm-snippets.md` останется устаревшим. Сейчас оба описывают один и тот же `.claude/coder-activity.log`, но в разных форматах.

### 4.4. PM hints на инструменты которых нет в окружении агента

`pm.md` lines 396-410 ссылается на slash-команды `superpowers:writing-plans`, `pm-dispatching` и др. Но `coder.md`, `reviewer.md` тоже ссылаются на skills (`superpowers:test-driven-development`). **Эти skills существуют только в LOCAL Claude Code session**. Если агент запускается через GHA — skills недоступны. Это противоречие не отражено в docs.

С учётом того что workflows архивированы (см. 4.1), сейчас агенты ВСЕ запускаются локально через Agent() — skills доступны. Но docs не зафиксированы под эту реальность; формулировки «в GHA не работает» в `CLAUDE-devops.md` lines 107-119 остаются как stale предупреждение.

### 4.5. Memory rotation policy не работает

`memory/README.md` lines 69-78 описывает правило ротации: при > 30 строк — переместить в `lessons.archive.md`. Реальность:

- coder/lessons.md — 10 строк (нет даже близко к лимиту)
- pm/lessons.md — 11 строк
- остальные — < 10 строк

Но это **не потому что rotation срабатывает** — lessons просто **редко добавляются**. После 13 PR'ов (по словам пользователя — 5 фаз drop role) в memory должны были накопиться десятки уроков, а их по 10-11 на агента. Это **скорее значит** что PM не выполняет шаг "memory append" из `pm.md` lines 363-374 регулярно.

### 4.6. AutoTest dispatch decision — конфликт между inversion и backward-compat

`pm.md` Mode 2 таблица (line 98) ставит для PR-created: **MUST dispatch Reviewer**, **AutoTest — условный** (D3 [P2]).

Но `pm-snippets.md` секция «AutoTest — post-approval тесты» (lines 43-51) не упоминает условный диспетч — даёт сниппет как для безусловного запуска.

И `memory/autotest/lessons.md` 2026-05-23 [P2] подтверждает что skip норма, но в snippets файле PM этого нет.

### 4.7. CLAUDE-coder.md — нет упоминания --no-verify правила

В PR #75 добавляются "Запрещённые паттерны" (no-verify, pre-existing flake, fake verification). В **main** этого нет. Пользователь говорит про 3 incidents с `git push --no-verify` в одну сессию.

Это значит: правило **не существует в актуальном main** — оно только в feature branch PR #75. Сразу после merge PR #75 проблема решена локально, но это **patchwork** — основное правило никогда не было в golden rules секции.

### 4.8. QA-агент упразднён, но remnants в active docs

`ba.md` line 35: "QA-агент нашёл несостыковку" — упоминание QA как активного. Но в `ba.md` line 146-149 явно сказано "QA-агент упразднён". Один документ противоречит самому себе.

`autotest.md` lines 234-264: «Если найдена логическая ошибка — REQUEST_CHANGES» — это **прежняя QA-функция** (бизнес-логика анализ). AutoTest теперь делает QA work тоже, но это нигде явно не описано как «AutoTest унаследовал QA responsibilities».

`.claude/agents/archive/qa.md` существует, но его никто не должен читать. Сейчас в archive только QA — нет structure для будущих архивов.

### 4.9. Conflicting wip-push threshold

`coder.md` секция 7 (line 218):

> Раньше threshold был «> 3 файлов ИЛИ > 30 мин» — это оказалось слишком мягко. Coder обрывался ДО первого милстоуна на «средних» задачах.

`memory/coder/lessons.md` 2026-05-23 [P0] @ dev-flow-rca:

> Wip-push после **каждых 2 файлов ИЛИ 5 минут** (раньше было 3 файла/30 мин — слишком мягко...)

Расходятся **внутри одного источника**: текст doc уже обновлён к 2/5, но также упоминает «было 3/30». Это **history note** — нужно в historical/changelog, не в живом правиле.

### 4.10. Lessons формат менялся

`memory/README.md` фиксирует формат `<date> [P0|P1|P2] [<task-id>] (#topic) <урок>` (введён 2026-05-23). Старые lessons (до 2026-05-23) **не имеют priority** — но формат-валидация в README говорит что priority обязателен. Пишет: "Retro-tag legacy lessons" в lines 62 — но реальность: legacy уже теперь tagged (после ретагинга на 23-го). То есть documentation gap закрыт, но процесс retro-tag не описан.

---

## 5. No deprecation tracking

Старые правила не имеют статуса. Примеры стейл-инфо в current main:

- `CLAUDE-ba.md` Pipeline diagram — описывает воркфлоу через `coder.yml`, который **архивирован**.
- `pm.md` Mode 2.B — «Reviewer review event = APPROVE» — описывает Reviewer как GHA workflow, но он теперь Agent(...) tool.
- `devops.md` секция 5 — «Добавить label ai-review-ready чтобы запустить Reviewer агента» — стейл.
- `CLAUDE-devops.md` — вся структура «pipeline jobs» — стейл с момента архивации workflows.

Каждое из этих правил **формально true** для момента когда оно было написано — но **сейчас misleading** для нового агента. Нет ни одного маркера "DEPRECATED 2026-XX-XX, use Y instead". Нет CHANGES.md / CHANGELOG.

---

## 6. Token budget — реальные числа

Подсчёт на основе размеров файлов:

| Сценарий                                             | Прочитано (примерно)         |
| ---------------------------------------------------- | ---------------------------- |
| Coder dispatch (читает все обязательные)             | 34 + 12 + 8 + 4 = **58 KB**  |
| PM dispatch (CLAUDE-pm.md + memory)                  | 24 + 16 + 8 = **48 KB**      |
| PM при peak load (читает + on-demand pm-snippets.md) | 48 + 20 = **68 KB**          |
| Reviewer dispatch                                    | 20 + 12 + 4 + 4 = **40 KB**  |
| AutoTest dispatch                                    | 16 + 12 + 8 + 4 = **40 KB**  |
| DevOps dispatch                                      | 12 + 12 + 16 + 4 = **44 KB** |

В перерасчёте на токены (1 char ≈ 0.3-0.4 token): **Coder сжирает 15-20K токенов** только на «обязательное чтение» **до** того как начал работать над task.

С учётом того что top-of-coder.md (58 KB) содержит ~ 30% **дубликатов** другого контента (MCP, RBAC, skills) — это **существенная экономия** при дедупликации.

---

## 7. Что НЕ найдено (gaps)

Нет в текущей инфраструктуре, но требуется (per task spec):

- ⛔ Нет **golden rules секции** ни в одном agent doc (zero-tolerance правила нигде не выделены)
- ⛔ Нет **cross-agent contracts** — диаграмма кто кому когда отправляет state (PM → Coder → Reviewer)
- ⛔ Нет **session-recovery protocol** sub-section в каждом doc (есть partial в `CLAUDE-pm.md` про ScheduleWakeup, но это PM-only)
- ⛔ Нет **CHANGES.md** / changelog в `.claude/agents/`
- ⛔ Нет **deprecation markers** в стейл-секциях
- ⛔ Нет общего файла **`.claude/agents/common-rules.md`** для cross-agent правил (commit hygiene, MCP, etc.)
- ⛔ Нет **task spec templates inventory** в `.claude/tasks/templates/` — упомянуто в `pm.md` line 68 что должно быть, но не верифицировано

---

## 8. Summary findings

10 проблем из task spec — все подтверждены аудитом:

| #   | Проблема (из task spec)              | Подтверждение в audit                                                                                                            |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Token bloat (coder.md 34KB)          | Section 1 / 6 — да, 580 lines, 30% дубликатов                                                                                    |
| 2   | Rules silently ignored (--no-verify) | Section 4.7 — да, правило отсутствует в main, добавлено в PR #75                                                                 |
| 3   | Duplication                          | Section 3 — 10 видов дублирующихся правил                                                                                        |
| 4   | CLAUDE-X.md vs X.md split не ясен    | Section 4.2 — CLAUDE-X.md ~ X.md по объёму в PM/DevOps, изначальная роль size-reduction не соблюдается                           |
| 5   | Memory rot (lessons.md grow)         | Section 4.5 — обратная проблема: lessons недостаточно добавляются. Rotation policy на бумаге но никогда не запускалась           |
| 6   | No golden rules                      | Section 7 — да, нет в любом doc                                                                                                  |
| 7   | Cross-agent contracts not formal     | Section 7 — да, нет contracts.md                                                                                                 |
| 8   | Session-boundary recovery scattered  | Section 7 + `CLAUDE-pm.md` lines 31-66 единственное полноценное описание                                                         |
| 9   | Skills hierarchy not integrated      | Section 3.2 — да, 5 разных subsets skills во всех docs, единый `CLAUDE-tools.md` существует но не используется как single source |
| 10  | No deprecation tracking              | Section 5 — да, нет CHANGES.md, нет deprecation markers, реальные stale параграфы есть (workflow archive)                        |

Plus **новые проблемы**, не упомянутые в task spec но критичные:

| #   | Новая проблема                                                  |
| --- | --------------------------------------------------------------- |
| 11  | Workflows архивированы — все docs стейл с pipeline (см. 4.1)    |
| 12  | BA roadmap не выровнен с реальностью (CI-based dispatch удалён) |
| 13  | Lessons недозаписываются (PM скипает шаг)                       |
| 14  | AutoTest унаследовал QA work без формализации (см. 4.8)         |

---

## 9. Следующий шаг

Design doc `.claude/agents/architecture-v2.md` должен решить:

1. **Структура** каждого agent doc — golden rules → workflow → recovery → reference.
2. **CLAUDE-X.md vs X.md** — merge / удалить / переименовать.
3. **Single source of truth** для каждого дублирующегося правила (см. секция 3).
4. **Cross-agent contracts.md** — диаграмма state-machine.
5. **Session-recovery protocol** sub-section в каждом doc.
6. **Lessons rotation policy** — workable mechanism.
7. **Token budget** per doc (target).
8. **CHANGES.md** в `.claude/agents/`.
9. **Deprecation strategy** — как помечать стейл-секции.
10. **Workflows archive sync** — обновить docs под реальность (Agent()-based, не gh workflow run).

См. `.claude/agents/architecture-v2.md`.
