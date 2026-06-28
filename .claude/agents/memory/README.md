# Agent Memory — Lessons Learned

Каждый агент имеет свой `lessons.md` — накопленные уроки от прошлых задач.

## Структура

```
.claude/agents/memory/
├── README.md          (этот файл)
├── coder/lessons.md
├── autotest/lessons.md
├── reviewer/lessons.md
├── devops/lessons.md
└── pm/lessons.md       (active, ≤ 20 строк; архивных файлов НЕТ)
```

Механизм архивации `.md` удалён (2026-06-29) — `lessons.archive.md` больше нет; устаревшие уроки удаляются при консолидации, история восстановима из git.

## Когда читать

Каждый агент читает свой `lessons.md` при старте — это часть обязательного чтения (см. `.claude/agents/<self>.md` секция «Session-recovery»).

## Когда писать

**Trigger-based** (User answer #5 — skill-driven через `anthropic-skills:consolidate-memory`):

После каждого **merged PR** PM ОБЯЗАН:

1. Append 1-3 урока в `.claude/agents/memory/<agent>/lessons.md` соответствующего агента (тот кто делал основную работу).
2. Консолидировать при достижении threshold (`lessons.md` ≥ **20 строк** ИЛИ после batch merged PRs): дедуп / упрощение / выделение паттернов → promote-and-prune (**без архива**):

- **P0 (5+ повторений)** → promote в Golden rules соответствующего agent doc (`<agent>.md`).
- **P1** → consolidate в `rules/common/<topic>.md` (если cross-agent) или `<agent>.md` (если agent-specific).
- **Остальное (одноразовое / поглощённое промоутом)** → **удалить** (не архивировать; история в git).

> Это отдельная операция PM над in-repo `lessons.md`, НЕ скилл `anthropic-skills:consolidate-memory` (тот дедупит личную user-memory `~/.claude`).

Это «levelling-up» урока: персональный case → общее правило → enforced rule.

## Формат строки

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <конкретный урок одной фразой>
```

**Поля:**

- `<YYYY-MM-DD>` — дата урока.
- `[P0]|[P1]|[P2]` — **приоритет** (D4 [P2] фикс, 2026-05-23):
  - **P0** — критическое правило. Нарушение ведёт к: data loss, security gap, repeat regression, потеря коммитов, отказ системы. Агент ОБЯЗАН прочитать P0 при старте.
  - **P1** — важное правило. Нарушение ведёт к: rework, увеличение раундов review, замедление пайплайна.
  - **P2** — nice-to-know. Помогает оптимизировать, не блокирует.
- `[<task-id>]` — task-id для трассируемости.
- `#topic` — опциональный topic-тег для grep'абельности. Примеры: `#tunnel`, `#tdd`, `#review-gate`, `#commit-hygiene`, `#layout`, `#ci`, `#worktree`, `#workflow`.

Примеры хороших уроков:

```
2026-05-20 [P0] [task-fix-pr22-ui-round4] #commit-hygiene git add . подметает чужие debug-артефакты — только явный список файлов из task.
2026-05-19 [P0] [task-teams-redesign] #testing data-testid обязателен для back-button/dialog-close — Playwright strict mode падает на дублях в sidebar+content.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent в RTL требует delay:null для стабильности — иначе race с act().
```

Примеры **плохих** уроков (не писать):

```
2026-05-20 [P1] [task-knowledge-api] Сделал задачу.       # ← бесполезно
2026-05-20 [P2] [task-x] Использовал TanStack Query.      # ← очевидно из кода
2026-05-20 [P2] [task-y] Pnpm typecheck прошёл.           # ← это норма, не урок
```

**Как выбрать приоритет (rule of thumb):**

- Урок про **mechanism** (gate, label, hook) → P0
- Урок про **safety/security/data** → P0
- Урок про **regression-prevention** → P0 или P1
- Урок про **process/communication** → P1
- Урок про **optimization/style** → P2

## Правила

1. **Один урок = одна строка.** Не размазывать на абзац.
2. **Конкретность.** «Layout regression потому что X» лучше чем «осторожнее с layout».
3. **Применимость.** Урок должен помочь следующему агенту в похожей ситуации.
4. **Лимит.** Active `lessons.md` ≤ 20 строк. Достигли — PM консолидирует (promote-and-prune, см. «Когда писать»).

## Где жил этот файл раньше

Старая версия (до 2026-06-02 refactor) описывала threshold-based ротацию (30 строк). Это не работало — lessons недозаписывались (см. `architect-audit.md` §4.5). Новая версия — trigger-based + skill-driven (PM вызывает skill после merged PR при threshold 20 строк).
