# task: fix PR 34 user testing round 7

## Ветка: feature/archive-views-teams-projects (PR 34, HEAD c715d63)

User-testing round 7 — 4 правки на трёх list-страницах CRM:

## ut-41 + ut-42: /crm/projects на row-list

- Удалить grid `sm:grid-cols-2 xl:grid-cols-3`.
- Новый компонент `apps/web/app/components/projects/ProjectRow.tsx` —
  horizontal-row layout по образцу `UserRow` (stretched-link + colon layout).
- Row содержит: avatar/logo, project name + company, senior (avatar+name),
  junior (avatar+name OR «Нет джуна»), rate + currency, дата старта,
  status badge (domain или «В архиве»).
- Clickable → /crm/projects/$projectId.
- НЕТ inline edit/archive (consistent с ut-27/ut-38) — действия живут на
  detail page header.
- testid: `project-row-${id}` на компоненте; обёртка в `index.tsx` keeps
  legacy `project-card-${id}` testid для существующих E2E.

## ut-43: единая «list page toolbar» across /crm/projects + /crm/team + /crm/users

- Toolbar: Search input (flex-1) + per-page filters + Sort dropdown
  («Сортировка») + Direction toggle button (arrow-up/down) — одна форма
  на всех трёх страницах.
- Projects: search, senior filter (только ADMIN), sort companyName/rate/startDate.
- Team: уже имеет search + sort (round 6) — оставляем как есть, форма совпадает.
- Users: уже имеет search + role filter + sort + direction — round 7
  заменяет checkbox «Показать архивных» на tabs (см. ut-44).

## ut-44: 3 tabs «Все | Активные | Архив» everywhere

- /crm/projects — уже 3 tabs (round 5). Verify, без изменений в логике вкладок.
- /crm/team — был 2 tabs «Активные | Архив»; round 7 добавляет «Все».
- /crm/users — checkbox «Показать архивных» убран; теперь
  `SegmentedToggle variant="tabs"` с тремя tabs, аналогично projects/team.
- Backend (api/controllers + services): findAll принимает
  `archived=all` (новое значение) → возвращает оба архивных и активных.
  Tri-state `archived?: boolean | 'all'`: `true` (legacy archived-only),
  `false`/missing (legacy active-only), `'all'` (round 7).

## Конкретные изменения

### Backend (NestJS, Drizzle)
- `apps/api/src/users/users.controller.ts` — accept `archived=all`
- `apps/api/src/users/users.service.ts` — `findAll`/`findAllIncludingAdmin`
  with `archived: boolean | 'all'`
- `apps/api/src/teams/teams.controller.ts` — accept `archived=all`
- `apps/api/src/teams/teams.service.ts` — `findAll` tri-state
- `apps/api/src/projects/projects.controller.ts` — accept `archived=all`
- `apps/api/src/projects/projects.service.ts` — `findAll` tri-state

### Frontend (Vite + TanStack)
- `apps/web/app/components/projects/ProjectRow.tsx` — NEW
- `apps/web/app/routes/crm/projects/index.tsx` — row list + unified toolbar
- `apps/web/app/routes/crm/team/index.tsx` — 3-tab toggle + fetch all
- `apps/web/app/routes/crm/users/index.tsx` — 3-tab toggle replaces checkbox

### E2E
- `apps/e2e/tests/crm/users/users-refactor.spec.ts` — update «Toggle archived»
  to use tabs instead of checkbox; testid `users-toggle-archived` preserved
  as the Archive tab's button so historical selectors keep working.

## AC

1. /crm/projects использует row-list layout (нет `sm:grid-cols-2 xl:grid-cols-3`).
2. ProjectRow компонент создан в apps/web/app/components/projects/.
3. /crm/projects, /crm/team, /crm/users имеют единую toolbar форму.
4. /crm/projects + /crm/team + /crm/users показывают 3 tabs «Все | Активные | Архив».
5. Backend API endpoints принимают `archived=all` filter и возвращают оба активных+архивных.
6. Local E2E pass — 1-worker.

## Тесты

- Typecheck (4 packages) — pass
- Unit (api + web + shared) — pass
- E2E 1-worker — pass
