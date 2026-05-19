# Reviewer — Agent Notes

## Canonical Architecture (что ДОЛЖНО быть в коде)

- **Frontend:** Vite SPA (НЕ TanStack Start/vinxi). Entry: `apps/web/app/client.tsx`
- **Routing:** TanStack Router file-based (`apps/web/app/routes/**`), НЕ react-router
- **Forms:** TanStack Form, НЕ useState/useRef для форм
- **Data fetching:** TanStack Query + Axios, НЕ прямой fetch
- **Validation:** Zod v4. Схемы ТОЛЬКО в `packages/shared/src/schemas/`. DTO в NestJS через Zod, НЕ class-validator
- **DB:** Drizzle ORM, НЕ прямой SQL. Миграции через `drizzle-kit generate`
- **Styling:** Tailwind v4 + shadcn/ui. НЕ hardcoded цвета (`text-[#...]`)
- **Animations:** Framer Motion, 200-300ms

## Версионные ограничения (флаги несовместимости)

- Vite: `^6.4`
- TanStack Router + `@tanstack/router-plugin` — версии ОБЯЗАНЫ совпадать (`^1.168.x`)
- pnpm: `7.32.4`
- Node: 20 LTS
- **НЕ добавлять** `pnpm.overrides` для `@tanstack/router-*` — сломает сборку

## DB — актуальные таблицы (миграции 0000–0011)

`users` · `teams` · `team_members` · `projects` · `project_members` · `interviews` · `transactions` · `expenses` · `junior_payments` · `invoices` · `invoice_transactions` · `payouts` · `payout_transactions`

Новые таблицы: обязательно Drizzle schema + migration файл, НЕ прямой SQL.

## Shared schemas

`packages/shared/src/schemas/` — auth, teams, projects, interviews, finance, users, api.
Фронт и бэк ИМПОРТИРУЮТ из `@crm/shared`, не дублируют.

## RBAC — ключевые правила

| Роль | Доступ |
|------|--------|
| ADMIN | Всё |
| SENIOR | Только свои данные |
| JUNIOR | Только проекты где активный member |
| HR | Свои команды + синьоры из команд |
| ACCOUNTANT | Финансы всех синьоров |

- Каждый NestJS endpoint ОБЯЗАН проверять роль через `JwtGuard` + `RolesGuard`
- JUNIOR нельзя добавить в `team_members` напрямую — это производное от project_members

## Auth

- Google OAuth ONLY, ручной (без Passport)
- JWT в HttpOnly cookie, 7 дней
- `GET /api/auth/me` — проверка сессии
- Email проверяется по таблице `users` — если нет → 403 → `/login?error=unauthorized`

## Tailwind v4 Dark Mode

`@custom-variant dark (&:is(.dark *))` + `class="dark"` на `<html>`
`@theme inline {}` маппит CSS vars → Tailwind utilities.

## Inline-комментарии (ОБЯЗАТЕЛЬНО при REQUEST_CHANGES)

При вызове `mcp__github__create_pull_request_review` с event: "REQUEST_CHANGES"
обязательно передавать параметр `comments` — массив объектов для каждой проблемы:

```json
{
  "path": "apps/web/app/routes/crm/team/$teamId.tsx",
  "position": 42,
  "body": "Описание проблемы и конкретная рекомендация"
}
```

- `path`: относительный путь от корня репо (без leading slash)
- `position`: позиция в unified diff (не номер строки файла)
- `body`: конкретная проблема + что исправить

Каждая проблема из review body дублируется как inline-комментарий к нужной строке.
