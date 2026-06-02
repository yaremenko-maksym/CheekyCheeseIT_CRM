# task-selftest-typo-fix

## Агент: coder

## Приоритет: low

## Ветка: feat/multiagent-docs-v2-implementation (та же что у Architect)

## Контекст

Self-test для нового docs/agents/ v2 рефакторинга. Цель — проверить что Coder:

1. Читает новую структуру (`docs/agents/coder.md` + `RULES.md` + `project-state.md` + `memory/coder/lessons.md`).
2. Соблюдает golden rules (zone-of-write, git add без `.`/`-A`, no `--no-verify`).
3. Делает финальный коммит с `ac_verified:`.

Задача максимально trivial: исправить опечатку в комментарии. Реализация — 1 строка кода.

## Конкретное изменение

**Файл:** `apps/web/app/components/ui/phone-input.tsx`, строка 139 (искать `nubmer` через grep — единственное вхождение в файле).

**Сейчас:**

```typescript
// unparsable nubmer — treat as not matching current country
```

**Должно быть:**

```typescript
// unparsable number — treat as not matching current country
```

Опечатка: `nubmer` → `number`.

## Acceptance Criteria

- [ ] AC1: Файл `apps/web/app/components/ui/phone-input.tsx` строка 139 содержит правильное слово `number` вместо `nubmer`.
- [ ] AC2: Других изменений в файле нет (только эта строка в diff).
- [ ] AC3: Никаких других файлов не тронуто (zone-of-write: только этот один файл).
- [ ] AC4: Финальный коммит содержит `ac_verified: 1,2,3` (без `vision:` — это не UI-задача).
- [ ] AC5: `git push` выполнен успешно (proof of push в финальном отчёте — `git log -1 --oneline` и `git rev-parse HEAD`).

## Что НЕ нужно

- НЕ менять что-либо в `docs/agents/**` (это zone PM/Architect).
- НЕ создавать PR (этот self-test делается в текущей ветке без отдельного PR).
- НЕ запускать `pnpm dev`.
- НЕ менять unit-тесты — фикс — только комментарий, тесты не затрагивает.

## Инструкции к финальному отчёту

В финальном отчёте обязательно укажи:

1. Какие docs ты прочитал (список path'ов).
2. Какие skill'ы ты вызвал (Skill tool calls).
3. Команды `git log -1 --oneline` и `git rev-parse HEAD` после push'а.
4. Подтверждение что не пытался `git push --no-verify`.
