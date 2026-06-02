# task-team-senior-share-override

## Агент: coder

## Приоритет: high

## Ветка: feat/team-senior-share-override

## Зависит от: PR #72 (merged в main — refactor remove ТОВ)

## Контекст

Сейчас senior share computed как:

1. Если project имеет `seniorSharePercentOverride` — берётся он.
2. Иначе берётся `user.seniorSharePercent` (default 26).

Нужен **промежуточный уровень — team**: если синьор работает под дропом, то в настройках команды можно задать процент которым синьор получает с проектов этой команды.

## Приоритет (по убыванию)

1. **Project-level override** (existing) — `project.seniorSharePercentOverride`.
2. **Team-level override** (новое) — `team.seniorSharePercentOverride`.
3. **User default** — `user.seniorSharePercent` (default 26).

## Критически важно

UI должен **показывать source** выбранного процента (проект / команда / default). Сейчас уже есть отображение процента (MyProjectShares, transactionRow `Доля: X%`, badge `seniorSharePercentOverride`). Нужно расширить — НЕ ломать существующее.

## Acceptance Criteria

### AC1. Backend — DB migration

- [ ] Миграция: добавить колонку `senior_share_percent_override` в таблицу `teams` (integer, nullable, проверка 0-100).
- [ ] Drizzle schema — соответствующее поле в `teams`.

### AC2. Backend — services

- [ ] Найди существующий resolver senior-share-процента (вероятно в `transactions.service.ts` или `payouts.service.ts` или helper). Через ast-grep MCP найди `seniorSharePercentOverride` и понять flow.
- [ ] Расширь логику:
  ```ts
  resolveSeniorShare(project, senior, team?) {
    if (project.seniorSharePercentOverride != null) return { value: ..., source: 'PROJECT' }
    if (team?.seniorSharePercentOverride != null) return { value: ..., source: 'TEAM' }
    return { value: senior.seniorSharePercent, source: 'USER_DEFAULT' }
  }
  ```
- [ ] Как определить team для project? Через project_members → drop user → drop's team. Если drop в нескольких командах ИЛИ нет drop'а — team_override не применяется (fall back). Решай по месту — возможно через project.teamId если такой будет нужен.

### AC3. Backend — endpoints

- [ ] PATCH `/api/teams/:id` — body может содержать `seniorSharePercentOverride: number | null`.
  - RBAC: ADMIN / HR (owner of team).
  - Validation: 0-100 integer или null.
- [ ] GET endpoints возвращают `team.seniorSharePercentOverride` в DTO.
- [ ] При создании транзакции snapshot `seniorSharePercent` (как сейчас) + новое поле `seniorSharePercentSource: 'PROJECT' | 'TEAM' | 'USER_DEFAULT'` сохраняется в `transactions`.

### AC4. Shared schemas

- [ ] `teamSchema` — добавь `seniorSharePercentOverride: z.number().int().min(0).max(100).nullable()`.
- [ ] `updateTeamSchema` — то же, optional.
- [ ] `transactionSchema` — добавь `seniorSharePercentSource: z.enum(['PROJECT','TEAM','USER_DEFAULT']).nullable()` (nullable для legacy transactions без source).

### AC5. Frontend — Team settings UI

- [ ] В существующем диалоге редактирования команды (TeamDialog или похожий) — добавь поле «Доля синьора (override для команды)»:
  - Input number 0-100 + label.
  - Подсказка: «Если задано — применяется ко всем проектам команды (приоритет ниже project override, выше default).»
  - Кнопка «Сбросить» (= set null) рядом.

### AC6. Frontend — отображение source

- [ ] `MyProjectShares.tsx` — для каждого проекта показывать **source badge**: «(по умолчанию X%)» / «(команда X%)» / «(проект X%)».
- [ ] `TransactionRow.tsx` (где `Доля: X%`) — рядом или в tooltip показывать source: «Источник: проект / команда / default».
- [ ] `TransactionDetailDialog.tsx` — секция share %, если есть source — показать.
- [ ] `PayoutDialog.tsx` / `ConfirmPayoutDialog.tsx` — показать source если применимо.

### AC7. Backfill (если нужно)

- [ ] Существующие транзакции без `seniorSharePercentSource` — оставить null (UI показывает «—» или старое поведение).
- [ ] Не делать destructive backfill.

### AC8. UT обязательно

- [ ] `senior-share-resolver.spec.ts` (или в transactions.spec.ts):
  - Project override → берётся он (`source=PROJECT`).
  - Team override без project override → берётся team (`source=TEAM`).
  - Ни project ни team → user default (`source=USER_DEFAULT`).
  - Drop в нескольких командах — team-override не применяется (fall back).
- [ ] Teams.spec.ts — обновление team.seniorSharePercentOverride работает, RBAC проверяется.

### AC9. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC10. Playwright (через MCP)

- [ ] ADMIN → /crm/team → редактирование команды → видит «Доля синьора override» поле → сохранить 16 → DB обновлена.
- [ ] Создать DROP_INCOME на проекте этой команды → транзакции с `seniorSharePercent=16`, `source=TEAM`.
- [ ] /crm/finance с SENIOR → видит «Доля: 16%» + badge «команда» в строке.
- [ ] /crm/finance с SENIOR → MyProjectShares показывает «16% (команда)» для проектов этой команды.

### AC11. Visual regressions (КРИТИЧНО)

Coder должен **визуально проверить через Playwright** что **существующие** места показа процента НЕ сломаны:

- [ ] MyProjectShares — все 3 формата отображаются корректно: project override / team override / default.
- [ ] Transaction row `Доля: 26%` — рендерится для legacy transactions без source.
- [ ] TransactionDetailDialog — share section не выглядит broken.
- [ ] PayoutDialog — share calculation не сломан.
- [ ] Если есть видимая регрессия — фикси перед PR.

### AC12. PR

- [ ] Ветка `feat/team-senior-share-override`.
- [ ] Title: `feat(teams): team-level senior share override (приоритет: project > team > default)`.
- [ ] Body — описать data model, hierarchy, UI changes, visual regression checklist.

## Что НЕ нужно

- Менять existing project-level override логику.
- Менять user.seniorSharePercent default.
- Менять drop role infrastructure.
- Менять payment channels.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
