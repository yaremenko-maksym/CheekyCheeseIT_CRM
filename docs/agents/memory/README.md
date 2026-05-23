# Agent Memory — Lessons Learned

Каждый агент имеет свой `lessons.md` — накопленные уроки от прошлых задач.

## Структура

```
docs/agents/memory/
├── README.md          (этот файл)
├── coder/lessons.md
├── autotest/lessons.md
├── reviewer/lessons.md
├── devops/lessons.md
└── pm/lessons.md
```

## Когда читать

Каждый агент читает свой `lessons.md` при старте — это часть обязательного чтения (см. секцию "Обязательное чтение" в `<agent>.md`).

## Когда писать

После каждого **merged PR** — PM аппендит ОДНУ строку в файл соответствующего агента (того кто делал основную работу).

## Формат строки

```
<YYYY-MM-DD> [P0|P1|P2] [<task-id>] (#topic-tag) <конкретный урок одной фразой>
```

**Поля:**
- `<YYYY-MM-DD>` — дата урока
- `[P0]|[P1]|[P2]` — **приоритет**, новое поле (D4 [P2] фикс, 2026-05-23):
  - **P0** — критическое правило. Нарушение ведёт к: data loss, security gap, repeat regression, потеря коммитов, отказ системы. Агент ОБЯЗАН прочитать P0 при старте.
  - **P1** — важное правило. Нарушение ведёт к: rework, увеличение раундов review, замедление пайплайна. Агент должен учитывать.
  - **P2** — nice-to-know. Помогает оптимизировать, но не блокирует.
- `[<task-id>]` — task-id когда урок возник (для трассируемости)
- `#topic` — опциональный topic-тег для grep'абельности. Примеры: `#tunnel`, `#tdd`, `#review-gate`, `#commit-hygiene`, `#layout`, `#ci`, `#worktree`, `#workflow`.

Примеры хороших уроков:
```
2026-05-20 [P0] [task-fix-pr22-ui-round4] #commit-hygiene git add . подметает чужие debug-артефакты — только явный список файлов из task.
2026-05-19 [P0] [task-teams-redesign] #testing data-testid обязателен для back-button/dialog-close — Playwright strict mode падает на дублях в sidebar+content.
2026-05-18 [P1] [task-fix-flaky-tests] #test-stability userEvent в RTL требует delay:null для стабильности — иначе race с act().
2026-05-22 [P2] [retro-session-after-archive-pr] #communication Для нетривиальных visual багов — присылать пользователю свою интерпретацию ДО dispatch Coder.
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
- Урок про **regression-prevention** → P0 или P1 в зависимости от impact
- Урок про **process/communication** → P1
- Урок про **optimization/style** → P2

**Retro-tag legacy lessons:** все уроки до 2026-05-23 (когда введена приоритизация) получили priority tag по best-effort оценке. Если видишь несогласие — корректируй inline при чтении.

## Правила

1. **Один урок = одна строка.** Не размазывать на абзац.
2. **Конкретность.** «Layout regression потому что X» лучше чем «осторожнее с layout».
3. **Применимость.** Урок должен помочь следующему агенту в похожей ситуации.
4. **Лимит.** Не больше 30 последних уроков в файле. Старые → `lessons.archive.md`.

## Ротация

Когда `lessons.md` превышает 30 строк — PM перемещает старшие в `lessons.archive.md` (та же папка). Архив агенты не читают upfront, но могут заглянуть если ищут конкретный исторический случай.

```bash
# Ротация (примерная команда — PM выполняет вручную при необходимости)
head -n -30 docs/agents/memory/coder/lessons.md >> docs/agents/memory/coder/lessons.archive.md
tail -n 30 docs/agents/memory/coder/lessons.md > /tmp/recent.md && mv /tmp/recent.md docs/agents/memory/coder/lessons.md
```
