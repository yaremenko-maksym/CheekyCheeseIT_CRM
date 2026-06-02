# RULES — Cross-Agent Rules

Single source of truth для правил, применимых ко всем агентам (PM, Coder, AutoTest, Reviewer, DevOps, BA). Каждый правило живёт ТОЛЬКО здесь. Agent docs линкуют, не дублируют.

**Кому читать:** всем агентам upfront при старте сессии (~5 KB).

---

## 1. Tool priority

```
MCP-инструмент подходит? → использовать MCP
Нет MCP, есть нативный (Read/Edit/Write)? → нативный
Только через shell? → Bash
```

Никогда не используй Bash там, где есть подходящий MCP.

### 1.1. MCP catalog (когда что)

| Задача                                                 | MCP / Tool                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Найти функцию / класс / импорт / паттерн в коде        | `mcp__ast-grep__find_code`, `find_code_by_rule`                                      |
| Проверить реальную схему БД / данные                   | `mcp__postgres__query` — вместо чтения `schema.ts`                                   |
| Документация NestJS / TanStack / Zod / React / Drizzle | `mcp__context7__resolve-library-id` → `query-docs`                                   |
| Lint проверка на изменённых файлах                     | `mcp__eslint__lint-files` — вместо ожидания pre-commit                               |
| UI проверка после изменений                            | `mcp__playwright__browser_navigate` + `browser_snapshot` + `browser_take_screenshot` |
| Список изменённых файлов PR                            | `mcp__github__get_pull_request_files`                                                |
| Описание/статус/labels PR                              | `mcp__github__get_pull_request`, `get_pull_request_status`                           |
| Reviews / inline-comments                              | `mcp__github__get_pull_request_reviews`, `get_pull_request_comments`                 |
| Создать review (APPROVE / COMMENT)                     | `mcp__github__create_pull_request_review`                                            |
| Labels на PR                                           | Bash: `gh pr edit --add-label / --remove-label`                                      |
| Cross-session wake-up (> 30 мин)                       | `mcp__scheduled-tasks__create_scheduled_task`                                        |

### 1.2. Native tools

| Tool    | Когда                                             | Когда НЕ                            |
| ------- | ------------------------------------------------- | ----------------------------------- |
| `Read`  | Конкретный файл целиком / диапазон строк          | Поиск (есть ast-grep)               |
| `Edit`  | Точечные правки в существующем файле              | Полная перезапись (используй Write) |
| `Write` | Создать новый файл / полная перезапись            | Без Read существующего файла        |
| `Bash`  | `git`, `gh`, `pnpm`, операции без MCP             | Там где есть MCP                    |
| `Agent` | Параллельная / изолированная задача (PM → агенты) | Простые однофайловые задачи         |
| `Skill` | Вызов superpowers (см. §3)                        | —                                   |

### 1.3. Конкретные правила

- Перед написанием любого сервиса/хука → `ast-grep find_code` чтобы найти аналог.
- Перед `pnpm --filter @crm/api db:generate` → `postgres query` для проверки текущей схемы.
- После каждого Edit/Write на `.ts/.tsx` → `eslint lint-files` вместо ожидания пре-коммит хука.
- Для любого API NestJS / TanStack / Zod / Drizzle — сначала `context7`, не угадывать.
- Перед написанием `getByRole/getByText` (E2E) → `playwright browser_snapshot` чтобы увидеть реальный DOM.
- Для seed-данных в тестах (id, email, суммы) → `postgres query`, не хардкод.

---

## 2. Git commit hygiene & forbidden patterns

### 2.1. 🔴 Zero-tolerance (применимо ко всем write-агентам — Coder, AutoTest, DevOps)

| Запрет                                                           | Почему                                                                                                               | Альтернатива                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `git push --no-verify`                                           | Обходит pre-push hook, который проверяет `ac_verified:`. Реальные инциденты 2026-06-02: 3× за сессию.                | Доделать AC → честный commit с `ac_verified:`.                    |
| `git commit -n` / `git commit --no-verify`                       | То же.                                                                                                               | То же.                                                            |
| `git -c core.hooksPath=/dev/null` (любая форма bypass'а hook'ов) | То же.                                                                                                               | То же.                                                            |
| `--no-gpg-sign` без явного запроса USER                          | Обходит signing.                                                                                                     | Спросить USER.                                                    |
| `git add .` / `git add -A` / `git add *` / `git add apps/`       | Подметает чужие debug-артефакты из worktree (PR #22 round4 incident, см. `memory/coder/lessons.md` 2026-05-20 [P0]). | Только явный список файлов из task-секции «Конкретные изменения». |
| Push в `main` напрямую                                           | Branch protection — только через PR.                                                                                 | PR + label `merge-approved` → CI auto-merge.                      |
| `git push --force` в `main`/`master`                             | Уничтожает историю.                                                                                                  | На своих ветках `--force-with-lease`, на main — никогда.          |
| Сброс `git reset --hard origin/main` без warning                 | Уничтожает локальную работу.                                                                                         | `git stash` → restore.                                            |

### 2.2. Commit message format

```
<type>(<scope>): <subject>

<optional body>

ac_verified: 1,2,3,4,5        # номера AC из task-файла, разделённые запятой
vision: ✓ /crm/team, /crm/team/$teamId    # ТОЛЬКО для UI задач — затронутые роуты
```

- Если все AC выполнены — перечислить все номера: `ac_verified: 1,2,3,4,5`
- Если часть не сделана — указать сделанные + комментарий: `ac_verified: 1,2,4 (3,5 — blocked, см. .blocked.md)`
- Если задача без UI — `vision:` строку опустить, `ac_verified:` обязательна.

**Pre-push hook** (`.claude/hooks/coder-pre-push.sh`) блокирует `git push` если последний commit на ветке `feature/*`, `fix/*`, `infra/*`, `test/*` не содержит `ac_verified:`. Не обходить — доделать AC.

### 2.3. Wip-commits и chunking

`wip:` префикс — маркер незавершённости. Pre-push hook НЕ требует `ac_verified:` на `wip:` коммитах (только на финальном).

- **`wip:` push после каждых 2 файлов** ИЛИ
- **`wip:` push после каждых 5 минут** ИЛИ
- **`wip:` push перед любой операцией > 1 мин** (билд, тесты, миграция)

Финальный коммит — без `wip:`, с `ac_verified:`.

---

## 3. Skill catalog (mandatory invocation)

**Trigger → Skill mapping.** Если trigger applies — обязан вызвать skill (через `Skill` tool), не «помнить». Если skill отсутствует в окружении — `Skill` tool падает с ошибкой, это explicit failure (лучше silent skip).

| Trigger                                                              | Skill                                        | Agents                  |
| -------------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| Сессия начинается (любая)                                            | `superpowers:using-superpowers`              | All                     |
| Любая creative задача (фича / UI / behavior change)                  | `superpowers:brainstorming`                  | BA, PM, Coder           |
| Multi-step task — перед implementation                               | `superpowers:writing-plans`                  | Coder, DevOps           |
| Любая feature/fix — перед implementation                             | `superpowers:test-driven-development`        | Coder                   |
| Баг / test failure / unexpected behavior                             | `superpowers:systematic-debugging`           | All                     |
| Перед PR / completion claim                                          | `superpowers:verification-before-completion` | Coder, AutoTest, DevOps |
| PR трогает auth / finance / wallets / transactions / smart-contracts | `superpowers:security-review`                | Coder, Reviewer         |
| Начало каждого review                                                | `superpowers:requesting-code-review`         | Reviewer                |
| Получение review feedback                                            | `superpowers:receiving-code-review`          | Coder                   |
| После написания кода (cleanup)                                       | `superpowers:simplify`                       | Coder                   |
| Новая страница / сложный UI component                                | `frontend-design:frontend-design`            | Coder                   |
| Need isolated workspace (parallel work)                              | `superpowers:using-git-worktrees`            | PM (Coder dispatch)     |
| Implementation plan execution                                        | `superpowers:executing-plans`                | PM, Coder               |
| Multi-task dispatch                                                  | `superpowers:dispatching-parallel-agents`    | PM                      |
| Branch ready to merge (готовится PR)                                 | `superpowers:finishing-a-development-branch` | Coder, PM               |
| Memory consolidation / dedup (после merged PR)                       | `anthropic-skills:consolidate-memory`        | PM                      |

В финальном отчёте — указать какие skills вызывал. PM проверяет.

---

## 4. Session recovery (after compaction / cold start)

Каждый agent — ВСЕГДА читает свои golden rules + этот раздел при старте новой сессии.

### 4.1. Универсальный чек-лист (все агенты)

1. Прочитать `docs/agents/<self>.md` секция Golden rules + Recovery checklist.
2. Прочитать `docs/agents/RULES.md` (этот файл) — cross-agent rules.
3. Прочитать `docs/agents/project-state.md` — текущие фазы / миграции / RBAC.
4. Прочитать свой `docs/agents/memory/<self>/lessons.md`.

### 4.2. Per-agent дополнительные шаги

**Coder (after compaction):**

1. `git status && git log --oneline -10` — узнать где остановился
2. `cat docs/specs/tasks/<my-task>.progress.md` (если есть) — milestone N/M
3. `tail -5 .claude/coder-activity.log | grep INTENT` — что планировал
4. Resume: если milestone N completed — продолжай с N+1. Если intent был "starting test run" без push после — проверь не сломал ли локально.

**PM (after compaction):**

1. `cat docs/specs/pm-state.json` — текущее состояние работы
2. `ls docs/specs/tasks/*.blocked.md` — есть ли blocked задачи
3. `gh pr list --state open` — open PRs от агентов
4. Проверить `next_action` в каждом active task — если есть и `scheduled_at` < now, выполнить немедленно (ScheduleWakeup не выжил session boundary).

**Reviewer / AutoTest / DevOps (after compaction):**

1. Re-read PR / task-file целиком (без trust в conversation history).
2. Если в middle-of-work — `git status` / `git log --oneline -5`.

### 4.3. Wake-up layers — какой когда

PM использует два слоя для cross-session waits. Подробная матрица — `pm-reference.md` (если будет создан) или текущий `pm.md` Mode 4.

| Слой                                 | Выживает session? | Когда                            |
| ------------------------------------ | ----------------- | -------------------------------- |
| `ScheduleWakeup` (in-session)        | НЕТ               | Wait < 30 мин, активная сессия   |
| `mcp__scheduled-tasks__*` (external) | ДА                | Wait ≥ 30 мин ИЛИ критичный fire |

Не комбинировать оба слоя на один wait — дубли fire'ов.

---

## 5. Zone-of-write contract

Каждый агент может писать ТОЛЬКО в свою зону. Reviewer выдаёт `Verdict: BLOCK` на diff где агент перетоптал чужие файлы.

| Агент        | Может писать                                                                                                                                                                                   | НЕ может                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coder**    | `apps/api/**`, `apps/web/**`, `apps/e2e/**`, `packages/**`, `docs/specs/tasks/<my-task>.progress.md`, `docs/specs/tasks/<my-task>.blocked.md`                                                  | `scripts/pm/**`, `scripts/devops/**`, `docs/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.gitmessage`, чужие task-файлы |
| **AutoTest** | `apps/e2e/tests/*.spec.ts`, `apps/e2e/fixtures/`, `apps/e2e/playwright.config.ts`, `docs/specs/tasks/<my-task>.blocked.md`                                                                     | `apps/api/**`, `apps/web/**`, `packages/**`, `docs/business/**`, `docs/agents/**`, `.github/workflows/**`                                                                         |
| **DevOps**   | `.github/workflows/`, `docker-compose.yml`, `.env.example`, root `package.json` scripts (`dev:start`, etc.), `scripts/devops/**`                                                               | `apps/**`, `packages/**`, `docs/business/**`, `docs/agents/**`, `scripts/pm/**`                                                                                                   |
| **Reviewer** | `mcp__github__create_pull_request_review` (read-only к коду)                                                                                                                                   | Любые файлы в репо                                                                                                                                                                |
| **PM**       | `docs/specs/tasks/`, `docs/specs/pm-state.json`, `docs/specs/pm-brief.md` (update), `docs/business/` (при резолве блокеров), `docs/agents/memory/<agent>/lessons.md` (append), `scripts/pm/**` | `apps/**`, `packages/**`, `apps/e2e/**`, `.github/workflows/**`, `docs/agents/<X>.md` (кроме memory)                                                                              |
| **BA**       | `docs/business/`, `docs/specs/pm-brief.md`                                                                                                                                                     | `docs/specs/tasks/`, `.github/workflows/`, `apps/**`, `packages/**`, `apps/e2e/**`                                                                                                |

**Hook `.claude/hooks/block-production-edits.sh` блокирует Coder из main repo (не worktree).** В worktree блокировка снимается — Coder _технически_ может перезаписать что угодно. Но это нарушение zone-of-write → Reviewer выдаст `Verdict: BLOCK`.

**Если задача требует выйти за зону:** создать `.blocked.md`, не делать самовольно. Исключение: PM явно указал в task-файле «обнови `docs/business/modules/<X>.md`» — допустимо.

---

## 6. Memory & lessons protocol

Полное описание — `docs/agents/memory/README.md`. Здесь — сжатое правило.

### 6.1. Когда писать (trigger-based)

**После каждого merged PR (no exceptions)** PM ОБЯЗАН append 1-3 урока в `docs/agents/memory/<agent>/lessons.md`:

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic) <конкретный урок одной фразой>
```

Это не optional — это часть PM workflow Mode 2.A (completed).

### 6.2. Что считать уроком

Хороший: про **что было неочевидно**, что reproducible, что предотвратимо.
Плохой: «сделал задачу», «использовал TanStack Query» — это нормальный workflow.

### 6.3. Приоритеты

- **P0** — критическое (data loss, security gap, repeat regression, отказ системы). Агент ОБЯЗАН прочитать при старте.
- **P1** — важное (rework, замедление пайплайна). Должен учитывать.
- **P2** — nice-to-know. Помогает оптимизировать.

### 6.4. Rotation (consolidate via skill)

Когда `lessons.md` достигает **20 строк** (или после каждого batch merged PRs) PM вызывает `anthropic-skills:consolidate-memory`:

1. Skill анализирует duplicates / упрощает / выделяет паттерны.
2. **P0 lessons (5+ повторений)** → promote в Golden rules соответствующего agent doc.
3. **P1 lessons** → consolidate в общие правила в `RULES.md`.
4. **P2 lessons** → archive в `docs/agents/memory/<agent>/lessons.archive.md`.

### 6.5. Archive structure

```
docs/agents/memory/<agent>/
├── lessons.md          (active, ≤ 20 строк)
├── lessons.archive.md  (historical, full record)
```

Agents читают только `lessons.md`, не `archive.md`. Archive для retrospective.

---

## 7. Version pins (canonical)

Single source of truth. Не дублировать в agent docs.

- **Node:** 20 LTS (строго). Не 21, не 22.
- **pnpm:** 7.32.4 (строго).
- **Vite:** `^6.4` (НЕ 7.x).
- **TanStack Router + `@tanstack/router-plugin`** — версии ОБЯЗАНЫ совпадать (`^1.168.x`).
- **PostgreSQL:** 16-alpine.
- **Redis:** 7-alpine.
- **Fastify:** форсирован через `pnpm.overrides` на `^5.8.5` (конфликт с `@fastify/helmet`).

**НЕ добавлять** `pnpm.overrides` для `@tanstack/router-*` пакетов — сломает сборку.

---

## 8. Quick reference — agent entry points

| Doc                         | Кому                | Размер | Что внутри                                     |
| --------------------------- | ------------------- | ------ | ---------------------------------------------- |
| `RULES.md` (этот файл)      | All                 | ~9 KB  | Cross-agent rules                              |
| `project-state.md`          | All                 | ~7 KB  | Phases, migrations, RBAC, tech stack           |
| `contracts.md`              | PM, Coder, Reviewer | ~6 KB  | Cross-agent state-machine + labels + sequences |
| `coder.md`                  | Coder               | ~11 KB | Golden rules + workflow + recovery             |
| `pm.md`                     | PM                  | ~11 KB | 4 режима + dispatch decision                   |
| `pm-snippets.md`            | PM (on-demand)      | ~16 KB | Готовые Agent() / gh / E2E сниппеты            |
| `reviewer.md`               | Reviewer            | ~10 KB | Workflow + security + write-then-post          |
| `autotest.md`               | AutoTest            | ~10 KB | 3 режима + AC-first + anti-patterns            |
| `devops.md`                 | DevOps              | ~9 KB  | Workflow + CI pipeline + secrets               |
| `ba.md`                     | BA                  | ~10 KB | Сценарий 1 (новая фича) + role boundaries      |
| `memory/<agent>/lessons.md` | Each agent          | varies | Накопленные уроки                              |
