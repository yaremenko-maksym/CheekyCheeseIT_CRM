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
