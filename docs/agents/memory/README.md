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
<YYYY-MM-DD> [<task-id>] <конкретный урок одной фразой>
```

Примеры хороших уроков:
```
2026-05-20 [task-fix-pr22-ui-round5] При правке layout — читать существующие классы до замены. Round4 регрессия = добавил элемент без проверки контекста.
2026-05-19 [task-teams-redesign] data-testid обязателен для back-button и dialog-close — Playwright strict mode падает на дублях в sidebar+content.
2026-05-18 [task-fix-flaky-tests] userEvent в RTL требует delay:null для стабильности — иначе race conditions с act().
```

Примеры **плохих** уроков (не писать):
```
2026-05-20 [task-knowledge-api] Сделал задачу.        # ← бесполезно
2026-05-20 [task-x] Использовал TanStack Query.       # ← очевидно из кода
2026-05-20 [task-y] Pnpm typecheck прошёл.            # ← это норма, не урок
```

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
