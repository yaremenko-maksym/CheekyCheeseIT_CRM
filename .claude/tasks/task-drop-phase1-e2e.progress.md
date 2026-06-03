# task-drop-phase1-e2e — progress

## Состояние

✅ Done — 2026-05-30. Ветка `feat/drop-role-phase1` (PR #63).

## Milestones

- [x] **M0:** прочитан спек, task-файл, autotest.md + lessons. Branch checkout, pnpm install, baseline navigation.spec зелёный (42/42).
- [x] **M1:** расширен `apps/e2e/tests/fixtures.ts` — добавлены `USERS.drop`, `USERS.seniorOrphan`, `USERS.seniorFree`, `DROP_TEAM`, `DROP_TEAM_VACANT`, `ALL_TEAMS`, `asDrop` fixture, `/api/users/drops` + `/api/users/me/rejoin-team` + `/api/teams/:id/rotate-senior` mocks. Без изменений в логике существующих fixture mock'ов.
- [x] **M2 — AC1:** `drop-create.spec.ts` (8 тестов). Создание дропа через ADMIN, payload `dropSharePercent`, USDT/Bank выбор, валидация email.
- [x] **M3 — AC2:** `drop-add-senior.spec.ts` (6 тестов). RadioGroup CREATE_NEW/JOIN_DROP_TEAM, drop-team picker mount, disabled-state когда нет vacant drop-team.
- [x] **M4 — AC3:** `senior-create-default.spec.ts` (3 теста). Регрессия — CREATE_NEW по дефолту, POST omits teamMode/dropTeamId.
- [x] **M5 — AC4:** `drop-rotate-senior.spec.ts` (6 тестов). «Сменить синьора» / «Назначить синьора» button, rotate dialog, senior-team — без кнопки.
- [x] **M6 — AC5/AC7:** `senior-teamless.spec.ts` (5 тестов). Banner + rejoin CTA, /crm/projects + /crm/interviews empty state, sidebar drops Проекты/Собеседования.
- [x] **M7 — AC6:** `drop-archive-cascade.spec.ts` (5 тестов). Архив drop-team confirm dialog, архив DROP user'а из /crm/users.
- [x] **M8 — AC7 regression:** `senior-archive-regression.spec.ts` (5 тестов). Pair-archive senior + senior-team, drop entities untouched.
- [x] **M9 — AC8:** `drop-rbac.spec.ts` (6 тестов). Sidebar только Profile/Team/Finance для DROP, /crm/dashboard redirect, /crm/users denied, self-profile tabs.
- [x] **M10 — AC9 финансовая регрессия:** существующие finance E2E прошли без правок (492 passed после моих изменений в `CI=1` mode).
- [x] **M11 — AC10 локальная проверка:** `pnpm typecheck` — все 4 пакета зелёные. `pnpm lint` — 3 pre-existing warning (не блокер). `CI=1 pnpm --filter @crm/e2e test` — **497 passed, 10 skipped, 0 failed** за 7.3 минуты.

## Артефакты

- 8 новых spec файлов в `apps/e2e/tests/`
- Расширен `apps/e2e/tests/fixtures.ts`
- Обновлён `docs/agents/memory/autotest/lessons.md`

## Открытые вопросы (не блокирующие)

- `/crm/team` и `/crm/finance` сейчас используют `useRoleGuard(['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT'])` — DROP вытолкнут на `/crm/profile`. Sidebar разрешает эти ссылки для DROP. Это front-end inconsistency: тесты сейчас фиксируют только что DROP не выкидывает на /login — фактический рендер /crm/team под DROP пока упирается в guard. Передаю на review Coder'у (можно завести follow-up в спеке Фазы 2 / отдельный fix-task).
- Финальная shape POST `/users` body для JOIN_DROP_TEAM (teamMode + dropTeamId, без hrIds) пока полагается на backend UT (Coder Vitest). E2E проверяет UI contract: radio выбираемо, drop-team picker mount. См. lessons.md запись 2026-05-30 #radix-radio.
