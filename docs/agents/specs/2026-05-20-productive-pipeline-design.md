# Productive Multi-Agent Pipeline — Design v2

**Дата:** 2026-05-20
**Статус:** Proposed (ждёт user-review)
**Контекст:** PR #22 завершился после 5 раундов UI-правок. Окно для архитектурного рефактора открыто (0 active PR).

---

## Цель

Сократить среднее число раундов на фичу с 3-5 до 1-2, уменьшить cold start PM на ~40%, дать видимость на узкие места пайплайна.

## Данные текущего состояния (факты)

- PR #22 потребовал 5 раундов UI-правок (`task-fix-pr22-ui-round1.md` → `round5.md`)
- `task-fix-pr22-ui-round5.md` — дословный диктант с line-numbers и git-diff чеклистом (PM пишет код руками)
- `round4` сделал регрессию: вернул Telegram в среднюю колонку вместо Pills
- `docs/agents/pm.md` — **688 строк**, из них ~250 (36%) дублируют `CLAUDE-tools.md` или копируют сниппеты из режимов
- `docs/specs/pm-state.json` десинхронизирован с реальностью (показывает `round4 running` хотя PR смерджен)
- Дважды подряд в истории: `chore(agent): safety-net — agent forgot to commit changes`
- **CRITICAL safety hole:** `.github/workflows/ci.yml` → `auto_merge` мерджит на `!= 'failure'` без проверки label → User Testing был обойдён для PR #22
- **Coder verification gap:** task-файл round4 явно требовал `git diff HEAD` проверку каждого AC — Coder проигнорировал → регрессия. Правило в task-файле не enforced системой.
- **Worktree pollution:** commit 77b5274 удалил `apps/e2e/debug-*.png`, `test-telegram-ui.{js,mjs}` (521 строка удалений vs 39 вставок) — Coder сделал `git add .` и подмёл артефакты AutoTest. Изолированные worktrees + неаккуратный `git add` = чужие файлы в PR.

## Корневая причина высоких раундов

Coder работает **вслепую** — он не открывает браузер до создания PR. AutoTest и Reviewer подключаются только ПОСЛЕ открытия PR. Визуальные регрессии ловятся только глазами пользователя на стадии User Testing → новый раунд.

PM-bloat — налог на токены/скорость, но НЕ корневая причина раундов.

## Корневая причина обхода User Testing

CI auto-merge срабатывает на любом не-failure → нет явного human-in-the-loop гейта. PM не имеет рычага «остановить мердж», кроме как полагаться что quality/e2e упадёт. Это противоречит самой логике Mode 4 (User Testing обязателен) и сохранённой памяти `feedback_pr_merge_approval.md`.

---

## Архитектурные изменения

### 1. PM slim — 688 → ~300 строк

**Что остаётся в `pm.md`** (стратегия — то, что PM реально решает):

| Блок | Размер | Почему остаётся |
|---|---|---|
| Роль + 3 строгих запрета | ~30 | Identity + hard limits |
| Tool priority — одна таблица + ссылка на CLAUDE-tools.md | ~15 | Без дублей |
| Обязательное чтение при старте | ~10 | Список из 3 файлов |
| Режим 1 — Декомпозиция | ~50 | Логика + ссылка на skill `writing-plans` |
| Режим 2 — **Плоская event-таблица** | ~60 | Вместо 4 вложенных подрежимов |
| Режим 4 — User Testing | ~70 | Логика сбора правок + классификация |
| Режим 4.A — Батч-диспетч | ~40 | Группировка по агентам |
| Циркуит-брейкер (review_rounds) | ~15 | Безопасный лимит |
| Ссылки на pm-snippets / template / script | ~10 | «Если нужен готовый Agent()-вызов — см. X» |

**Итого:** ~300 строк чистой стратегии.

**Что уходит** (механика — переиспользуемое):

| Что | Куда | Размер |
|---|---|---|
| Готовые `Agent(...)` вызовы | `docs/agents/pm-snippets.md` (читается по запросу) | ~86 строк |
| `gh pr ...` / `git fetch && pnpm dev &` блоки | `scripts/pm/prep-user-testing.sh` | ~40 строк |
| Шаблон task-файла (Appendix A) | `docs/specs/tasks/templates/task.md.tpl` | ~40 строк |
| 3 продублированные MCP-таблицы | Одна короткая со ссылкой на CLAUDE-tools.md | ~50 строк экономии |
| Mode 2 вложенный (2.A/2.B/2.C) | Плоская branch-by-event таблица в самом pm.md | переструктура |

**Режим 2 рефакторится** из иерархии в плоскую таблицу:

```
Событие                          → Действие
────────────────────────────────────────────────────────
agent finished with PR           → Reviewer + AutoTest (parallel)
agent created .blocked.md        → читать → спросить пользователя → resume
PR label = ci-failed             → fix-task для Coder
PR label = awaiting-pm-review    → Mode 2.B (post-review analysis)
E2E run = failure                → классифицировать (bug vs test) → fix-task
E2E run = success                → уведомить пользователя → ждать "мерджи"
review_rounds >= 3               → STOP, эскалация пользователю
```

**Локальный skill `pm-dispatching`** — `.claude/skills/pm-dispatching/SKILL.md`. PM вызывает skill когда реально диспетчит — snippets не лежат постоянно в контексте.

### 2. Coder vision + AC-in-diff verification — закрытие UI feedback loop ⭐

**Главный killer раундов.** В `docs/agents/coder.md` добавляется обязательный **двойной чеклист** до открытия PR.

#### A. Vision check — visual feedback loop
Для задач трогающих `apps/web/`:

1. После всех code-правок, до `git push`:
   - `mcp__playwright__browser_navigate` → http://localhost:3000/crm/<затронутый-роут>
   - `mcp__playwright__browser_take_screenshot` — визуальная сверка
   - Для каждого AC где упоминается UI — отметить «видно/не видно» в DOM через `mcp__playwright__browser_snapshot`
2. Если AC говорит «русский текст» / «pills layout» / «bg-muted» — Coder проверяет это в DOM до push

#### B. AC-in-diff check — текстовая верификация (для ВСЕХ задач)
Перед каждым `git push`:

1. `git diff HEAD --name-only` — список изменённых файлов
2. Для каждого пункта AC из task-файла:
   - Если AC указывает конкретный паттерн (class, prop, function name) → `grep -n "<pattern>" <file>` подтверждает наличие
   - Если паттерна нет в diff → **STOP, AC не выполнен**, не пушить
3. В commit message — **обязательные** строки:
   ```
   vision: ✓ /crm/team, /crm/team/$teamId
   ac_verified: 1,2,3,4,5
   ```
   Где `ac_verified` — номера выполненных AC из task-файла. Если все AC не выполнены — отметить какие.

#### Hook gate (страховка)
PreToolUse Bash hook на `git push`: проверяет что последний commit message содержит `ac_verified:`. Если нет — блокирует push, агент должен либо доделать AC, либо явно отметить отсутствующие.

**Это решает round4 проблему:** task-файл уже требовал git diff проверку, но это не было enforced. Теперь — hook.

### 3. State schema v2 — события + метрики (часть Approach C, без хуков)

`pm-state.json` обогащается. Формат:

```json
{
  "active": [
    {
      "id": "task-fix-pr22-ui-round5",
      "started_at": "2026-05-20T03:10:00Z",
      "rounds": 0,
      "agent_invocations": { "coder": 5, "reviewer": 4, "autotest": 1 },
      "events": [
        { "at": "...", "type": "agent_started", "agent": "coder" },
        { "at": "...", "type": "pr_opened", "pr": 22 },
        { "at": "...", "type": "review_rejected", "rounds": 1 }
      ]
    }
  ],
  "completed": [
    {
      "id": "task-fix-pr22-ui-round5",
      "duration_min": 18,
      "rounds": 5,
      "regression_count": 1,
      "agent_invocations": { "coder": 5, "reviewer": 4, "autotest": 1 },
      "merged_at": "..."
    }
  ],
  "phase": "development",
  "pending_fixes": []
}
```

PM пишет event при каждом действии. Через 5-10 фич видим:
- `avg(rounds)` per task — норма ли 1-2 раунда?
- `regression_count` per agent — кто чаще ломает
- `duration_min` per phase — где затыки
- `agent_invocations.coder` per round — сколько раз PM перезапускал Coder

### 4. Per-agent memory (минимальная)

`docs/agents/memory/<agent>/lessons.md` — по файлу на агента (Coder, AutoTest, Reviewer, DevOps). После merged PR — PM аппендит одну строку:

```
2026-05-20 [task-fix-pr22-ui-round5] При правке layout — сначала читать существующие классы, потом заменять. Round4 регрессия = добавил элемент без проверки контекста.
```

Каждый агент при старте читает свой `lessons.md`. Малый overhead (5-10 строк после месяца), накапливается со временем.

### 5. Worktree hygiene + git add discipline (новое)

**Проблема:** commit 77b5274 показал — Coder сделал `git add .` или `git add -A` и подмёл `apps/e2e/debug-*.png`, `test-telegram-ui.{js,mjs}` из чужого worktree.

**Решение в трёх местах:**

1. **`.gitignore` усиление** (DevOps): добавить
   ```
   apps/e2e/debug-*.png
   apps/e2e/screenshot-*.png
   apps/e2e/test-*.{js,mjs}
   output.txt
   ```
   Чтобы debug-артефакты вообще не попадали в репо.

2. **`coder.md` — git add discipline:** запретить `git add .` / `git add -A`. Только `git add <конкретный-файл>` из списка изменений task-файла. Список файлов берётся из секции «Конкретные изменения».

3. **`autotest.md` — никаких debug-коммитов:** screenshots и временные тестовые скрипты НЕ коммитятся. Если AutoTest нужно сохранить screenshot для отладки — путь в `/tmp/autotest-<runid>/`, не в репо.

---

## Шаги миграции

Каждый — отдельный PR, реверсивный.

| PR | Что | Риск | Эффект |
|---|---|---|---|
| **PR-0** ⚠️ | **Merge gate** — `ci.yml` + label `merge-approved` + pm.md Mode 4 апрув-шаг. **Делается ПЕРЕД всем остальным.** Task уже создан: `docs/specs/tasks/task-infra-merge-gate.md` | низкий | критическая safety дыра закрыта |
| **PR-1** | Извлечение из `pm.md` → `pm-snippets.md` + `task.md.tpl` + `prep-user-testing.sh` (механический вынос) | низкий | -150 строк PM |
| **PR-2** | Рефактор Mode 2 в плоскую таблицу | средний | -100 строк PM, навигация быстрее |
| **PR-3** | Локальный skill `pm-dispatching` + обновление ссылок в pm.md | низкий | snippets on-demand |
| **PR-4** | **Coder vision + AC-in-diff** — coder.md обновление + Playwright + hook на git push | средний | **главный killer раундов + закрытие round4 verification gap** |
| **PR-5** | Worktree hygiene — `.gitignore` + git add discipline в coder.md + autotest.md | низкий | предотвращение pollution |
| **PR-6** | State schema v2 — миграция pm-state.json + обновление PM логики записи events | низкий | видимость метрик |
| **PR-7** | Memory структура + auto-append после merge | низкий | долгосрочный compound effect |

**Порядок изменён:** PR-0 первый и срочный (safety). PR-1,2,3 — рефактор PM (быстро, безопасно). PR-4 отдельно — главный effect Coder vision измерить чисто. PR-5 идёт сразу после PR-4 (та же область — Coder/AutoTest workflow). PR-6,7 — фундамент видимости.

---

## Критерии успеха

- **0 PR смерджено** без лейбла `merge-approved` за следующие 10 PR (safety инвариант)
- **Avg rounds per feature ≤ 2** за следующие 3 фичи (сейчас 3-5)
- **Cold start PM** (`pm.md` + `CLAUDE-pm.md` + obligatory reads) ≤ **1000 строк** (сейчас ~1100)
- `pm-state.json` содержит events/metrics, синхронен с реальностью в течение часа после merge
- **Регрессии** (round_N ломает что-то из round_{N-1}) ≤ 1 за 5 фич
- Coder ни разу не открывает PR без `vision: ✓` и `ac_verified:` строк за следующие 5 фич
- **0 debug-артефактов** (`debug-*.png`, `test-*.{js,mjs}`, `output.txt`) в коммитах за следующие 10 PR

## Риски и откат

| Риск | Митигация |
|---|---|
| Coder с Playwright станет медленнее | `duration_min` в state schema v2 покажет — откатим vision-step если +3min не оправдывает скип раунда |
| pm-snippets.md устареет от pm.md | Один integration test: pm.md должен ссылаться на все секции pm-snippets.md (можно сделать `pnpm pm:lint`) |
| State schema v2 ломает существующий PM | Все поля nullable, миграция read-write совместимая. Старые поля (`tasks`, `merged`) остаются как алиасы первый раунд |
| Memory lessons превратятся в шум | Лимит 10 последних lessons в файле; ротация старых в `lessons.archive.md` |

**Полный откат:** каждый PR независим, можно revert любого без каскадных эффектов.

---

## Что НЕ входит в этот дизайн (явный out-of-scope)

- **Architect-агент** — не нужен пока PHASE 6 не стартует
- **BA как агент** (вместо документа) — пользователь не жаловался
- **Auto-trigger AutoTest по затронутым роутам** — это отдельная история про CI, не про агентов
- **Split PM на 3 субагента** (Approach A) — оставляем как опцию на потом, если slim-PM упрётся в потолок
- **Event-driven через хуки** (Approach C полная) — слишком тяжело, добавляем только пассивную часть (state v2 с events)

Если что-то из этого надо — отдельный design-doc.
