# Coder — Agent Notes

## Команды

```bash
pnpm dev                          # все приложения параллельно
pnpm build                        # shared → api & web
pnpm typecheck                    # все пакеты
pnpm test                         # все тесты
pnpm --filter @crm/web dev        # только фронт :3000
pnpm --filter @crm/api dev        # только бэк :3001
pnpm --filter @crm/api db:push    # применить схему без миграции
pnpm --filter @crm/api db:seed    # заполнить тестовыми данными
drizzle-kit generate              # создать migration файл
```

## Структура монорепо

```
apps/web/          # Vite SPA, TanStack Router, :3000
  app/
    client.tsx     # точка входа (createRoot + RouterProvider)
    routes/        # file-based routing
    context/       # auth.tsx, notifications.tsx
    components/ui/ # shadcn/ui компоненты
apps/api/          # NestJS 11 + Fastify, :3001
  src/
    database/
      schema.ts    # Drizzle schema — ЕДИНСТВЕННЫЙ источник структуры БД
      seed.ts      # тестовые данные
    auth/
    teams/
    projects/
    interviews/
    finance/
    users/
packages/shared/
  src/schemas/     # ВСЕ Zod схемы — Single Source of Truth
```

## Порядок реализации фичи

1. `packages/shared/src/schemas/<module>.ts` — новые Zod схемы
2. `apps/api/src/database/schema.ts` — новые Drizzle таблицы
3. `drizzle-kit generate` → новый migration файл
4. NestJS модуль: service → controller → module
5. Frontend: TanStack Query hooks → TanStack Form → TanStack Router routes
6. Тесты: Vitest unit (api) + Playwright E2E (apps/e2e)

## Текущий статус (реализовано)

- [x] Auth (Google OAuth, JWT cookie)
- [x] Layout (Sidebar + Header, RBAC навигация)
- [x] Teams (PHASE 2)
- [x] Projects (PHASE 3)
- [x] Interviews Kanban (PHASE 4, dnd-kit)
- [x] Finance (PHASE 5: transactions, expenses, invoices, payouts, juniorPayments, PDF, etherscan)
- [x] Profiles partial (PHASE 7 partial: /crm/profile, /crm/users/:id, telegram+phone)
- [ ] База знаний + Документы (PHASE 6)
- [ ] Смарт-контракти (PHASE 8)
- [ ] Дашборд (PHASE 9)

## Drizzle миграции (применены: 0000–0011)

- 0000: users + role enum
- 0001: teams + team_members
- 0002: projects + project_members
- 0003: interviews
- 0004–0011: finance (transactions, expenses, junior_payments, invoices, payouts, exchange_rate, project_logo)

## Ключевые технические gotchas

- `routeTree.gen.ts` — автогенерируется Vite plugin при `pnpm dev`, не редактировать вручную
- Fastify форсирован через `pnpm.overrides` на `^5.8.5`
- **НЕ добавлять** overrides для `@tanstack/router-*` — сломает сборку
- `@crm/shared`: `"main"` и `"types"` в package.json для moduleResolution Node
- `exactOptionalPropertyTypes`: Radix CheckboxItem `checked` — передавать через `...props`, не деструктурировать
- Tailwind v4 dark: `@custom-variant dark (&:is(.dark *))` + `class="dark"` на `<html>`
- Interviews: dnd-kit с `closestCenter` — обязательно для cross-column drag

## Бизнес-логика (критичные ограничения)

- JUNIOR в команде — производное (из project_members), НЕ хранится в team_members
- ADMIN исключён из всех команд
- Нельзя удалить SENIOR из команды (только удалить команду)
- `project_members.leftAt` — soft delete, NULL = активный
- Только JUNIOR можно добавить как project_member
- Interviews: stageы `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`
- Finance статусы: `PENDING → VALIDATED → PENDING_PAYMENT → PAID / REJECTED`

## Design System компоненты (apps/web/app/components/ui/)

`button` · `input` · `label` · `card` · `badge` · `separator` · `skeleton` · `avatar` · `sonner` · `scroll-area` · `tooltip` · `dropdown-menu` · `dialog` · `sheet`

## Запрещённые паттерны (zero-tolerance)

### 1. `--no-verify` / обход hooks

**НИКОГДА**:

- `git commit --no-verify` / `-n`
- `git push --no-verify`
- `git rebase --no-verify`
- `-c core.hooksPath=/dev/null`
- любой иной обход pre-commit / pre-push / commit-msg hooks

Если hook падает:

1. Сначала запустить тот же тест в изоляции: `pnpm --filter @crm/web test -- <suite>`.
2. Если flake — добавить `it.retry(2)` или fix корня; закоммитить.
3. Если real bug — отдельный коммит с fix перед wip-push.
4. Только потом обычный `git push`.

PM-инцидент 2026-06-02: 3 Coder агента подряд обошли pre-push hook → 100% случаев CI потом падал на том же тесте.

### 2. «Pre-existing flake» без proof

Запрещено сообщать «X — pre-existing flake» в финальном отчёте без:

1. `git stash` твоих изменений.
2. `git checkout origin/main` (или указанной base ветки).
3. Запуск того же теста в изоляции.
4. Приложить diff/выводы обеих прогонок.

Иначе — это rationalization. PM-инцидент 2026-06-02: «E2E 540 passed, 24 pre-existing» оказались real bugs.

### 3. Финальный отчёт без proof of push

**Финальный response Coder ДОЛЖЕН содержать**:

```bash
git log origin/<branch> -1 --oneline   # ← вывод этой команды
gh pr view <PR_NUM> --json number,headRefName,state  # ← если создавал PR
```

Без actual output этих команд — отчёт **недействителен**. Если последний commit на origin не твой — push не прошёл, нужно повторить.

## Verify checklist перед финальным отчётом

После всех проверок (typecheck, lint, test, build) **ОБЯЗАТЕЛЬНО**:

- [ ] `git status` — clean (нет неcommit'нутых файлов).
- [ ] `git log -1 --oneline` — local HEAD.
- [ ] `git fetch origin && git log origin/<branch> -1 --oneline` — remote HEAD. Должно совпадать с локальным.
- [ ] Если PR ожидается — `gh pr view <num>` возвращает 200, state OPEN.
- [ ] Для PDF/SVG/image артефактов — приложить скриншот (через playwright MCP).

Без всего чек-листа отчёт не финальный — продолжай работу.
