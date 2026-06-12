# task-fix-junior-ut-round1

## Агент: coder

## Приоритет: high

## Модель: sonnet

## Ветка: fix/junior-ut-round1

## Контекст

UT юзера по junior-поверхности (#171/#172/#174) принёс 7 находок: 1 реальный data-flow баг
(карточка «Контракт» хаба всегда показывает «Контракт не оформлен» при подписанном контракте),
расширение зарплатного блока и 5 UX-правок легенды. Разведка PM подтвердила корни — см. факты ниже,
НЕ переоткрывай их заново.

**Корень бага контракта (подтверждено):** хук `useMyContract` в `apps/web/app/routes/crm/project.tsx:81-98`
зовёт `GET /api/contracts/me` → `SignedContractsService.findMine()` (apps/api/src/contracts/signed-contracts.service.ts:172)
возвращает строки `signed_contracts` БЕЗ поля `status`. Хаб парсит `contractMeDtoSchema`
(packages/shared/src/schemas/contracts.ts:119 — требует `status`) → `.parse()` бросает → query в error →
`contract=null` → ветка «Контракт не оформлен». Статус живёт в `employee_contracts.status`
(enum DRAFT|READY_TO_SIGN|SIGNED|CANCELLED); у seed-джунов в БД status=SIGNED. Mocked-E2E это маскировал.

## Конкретные изменения

### 1. Карточка «Контракт» хаба — правильный источник статуса

- `apps/api/src/contracts/` — self-эндпоинт статуса: СНАЧАЛА посмотри `GET /api/onboarding/contract`
  (onboarding-contract.controller.ts:40 → employee-contracts.service) — если он уже отдаёт
  `{id,status}` собственного employee_contract, переиспользуй его в хабе. Если его shape/гварды
  не подходят (OnboardingGuard-семантика!) — добавь `GET /api/contracts/me/status` → `{id,status}`
  из `employee_contracts` для `currentUser.id` (self-only by construction).
- `apps/web/app/routes/crm/project.tsx` — `useMyContract` переключить на этот источник;
  состояние ошибки запроса НЕ должно рендериться как «Контракт не оформлен» (различай null и error).
  `/api/contracts/me` (список подписанных) не трогать — он останется для других нужд.

### 2. Блок «Моя зарплата» хаба (project.tsx `SalarySnapshotCard` + api)

- Показать: **текущая ставка** (`users.monthlySalary` + `salaryCurrency` — self; есть в profile-данных),
  **«изменена <дата>»**, **последние 3 транзакции** (тип SALARY: сумма, месяц, статус, дата).
- `apps/api/src/users/` — лёгкий self-эндпоинт `GET /api/users/me/salary-meta` →
  `{monthlySalary, salaryCurrency, changedAt: string|null}`; `changedAt` = `created_at` последней
  записи `user_audit_log` где `target_id = self` И `changes ? 'monthlySalary'` (значения там redacted —
  нужна только дата; см. apps/api/src/users/audit-log.service.ts SENSITIVE_FIELDS).
- `apps/web` — `useLastSalary` → `useSalaryTransactions`: тот же `GET /api/transactions?type=SALARY`
  (junior-scope в сервисе подтверждён: transactions.service.ts:423 фильтр receiverId=self),
  НО с zod-схемой `.parse()` (фикс известного follow-up «useLastSalary без .parse()») — схему
  положи в `packages/shared/src/schemas/` (переиспользуй существующую transaction-схему finance.ts
  если она подходит, не плоди дубль).
- **Фикс маппинга статуса:** salary-транзакции создаются со status `PAID`
  (transactions.service.ts:1278), а карточка показывает «Выплачено» только для `VALIDATED` →
  PAID|VALIDATED → «Выплачено», pending-статусы → «Ожидание» (сверь enum в finance.ts).

### 3-6. Легенда — `apps/web/app/routes/crm/legend.tsx` (+ `apps/web/app/components/projects/ProjectLegendSection.tsx`)

3. Убрать аватар «?» из блока персоны на странице легенды (legend.tsx:184-186 AvatarFallback + getInitials usage там).
4. Дубль «Отмена» в edit-форме персоны: верхняя (legend.tsx:203-216) и нижняя (325-334) делают одно и то же —
   оставь НИЖНЮЮ пару «Отмена + Сохранить»; верхнюю замени на icon-only `X` с `aria-label="Отмена"` или убери.
5. «Дата рождения» → существующий `DatePickerField` (`apps/web/app/components/ui/date-picker.tsx`,
   value «YYYY-MM-DD» — совместим с `upsertLegendSchema.dateOfBirth`). Пример использования:
   finance/components/dialogs/CreateTransactionDialog.tsx:573.
6. **Префилл персоны из реальных данных субъекта** (субъект = `projects.dropId ?? projects.seniorId`):
   - `apps/api/src/legends/legends.service.ts` — в ответ `GET /projects/:id/legend` добавить поле
     `defaults: {fullName: string|null, address: string|null} | null` из `users.legal_full_name` +
     `users.registration_address` субъекта. **`defaults` отдавать ТОЛЬКО когда viewer ADMIN или HR
     (hr — по существующему hrCanAccess); для JUNIOR-вьюера поле `defaults` = null/отсутствует** —
     иначе утечка реальной личности синьора джуну (класс бага #157/#158, рецидивный).
   - `packages/shared/src/schemas/legends.ts` — расширить `legendSchema` опциональным `defaults`.
   - UI (legend.tsx + ProjectLegendSection.tsx): при открытии edit-формы ПУСТЫЕ поля ФИО/Адрес
     префиллятся из `defaults` (только если они пришли). Дата рождения: в users НЕТ birth date —
     префилл невозможен, поле остаётся ручным (зафиксировано PM).

### 7. Журнал событий — дата события

- Миграция: `legend_entries` + колонка `event_date date NULL` (additive; `pnpm --filter @crm/api db:generate`).
- `packages/shared/src/schemas/legends.ts` — `addLegendEntrySchema` + `eventDate` (ISO date, optional);
  `legendEntrySchema` + `eventDate: string|null`.
- `apps/api/src/legends/legends.service.ts` — `addEntry` сохраняет eventDate; `loadEntries` сортирует
  по `COALESCE(event_date, created_at::date)` затем createdAt.
- `apps/web` LegendJournalBlock (legend.tsx:546-663): `DatePickerField` (default — сегодня) рядом с textarea;
  отображение записи показывает eventDate (fallback createdAt).

## Переиспользование / Regression scope

**Существующий код для переиспользования:**

- `DatePickerField` — apps/web/app/components/ui/date-picker.tsx (НЕ писать свой пикер).
- `hrCanAccess` / `canAccess` — legends.service.ts:43-55 (НЕ дублировать, расширять внутри сервиса).
- transaction-схемы — packages/shared/src/schemas/finance.ts.

**Shared-код который будет затронут:**

- `legendSchema` / `addLegendEntrySchema` → call-sites: legend.tsx, ProjectLegendSection.tsx, legends.service.ts (+их спеки).
- `contractMeDtoSchema` → единственный call-site project.tsx (подтверждено grep).

**Не должно сломаться:**

- Онбординг-флоу подписания контракта (OnboardingGuard bypass-list — если переиспользуешь /onboarding/contract, не меняй его семантику).
- Junior-маскировка проектов (mapProject allowlist) и SENIOR identity isolation.
- Страница Документы (списки подписанных контрактов), admin-редактор легенды на странице проекта.
- Существующие E2E хаба/легенды сломаются на новых селекторах/эндпоинтах — НЕ правь спеки сам (зона AutoTest), перечисли упавшие в финальном отчёте.

## API endpoints (новые)

- `GET /api/users/me/salary-meta` — self-only `{monthlySalary, salaryCurrency, changedAt|null}`. RBAC: любой аутентифицированный — только свои данные (без параметров).
- (опц.) `GET /api/contracts/me/status` — self-only `{id,status}` из employee_contracts.

## RBAC (кто смотрит → что видит)

| Viewer                  | legend.defaults (реальные ФИО/адрес субъекта) | salary-meta | contract status |
| ----------------------- | --------------------------------------------- | ----------- | --------------- |
| JUNIOR (member проекта) | **НЕТ (null)**                                | только своя | только свой     |
| HR (team-scoped)        | да                                            | только своя | только свой     |
| ADMIN                   | да                                            | только своя | только свой     |
| SENIOR/DROP (субъект)   | легенда недоступна (как сейчас)               | —           | —               |

## Acceptance criteria

- [ ] 1. Джун с employee_contracts.status=SIGNED видит на хабе badge «Подписан» (источник — employee_contracts, НЕ signed_contracts list); error-состояние запроса ≠ «Контракт не оформлен».
- [ ] 2. Backend integration-тест (реальная БД, НЕ мок): self contract-status эндпоинт отдаёт статус своего контракта; чужой контракт получить нельзя.
- [ ] 3. Зарплатный блок: текущая ставка + валюта, строка «изменена <дата>» (из user_audit_log), последние 3 SALARY-транзакции; PAID и VALIDATED → «Выплачено».
- [ ] 4. `GET /api/users/me/salary-meta` покрыт integration-тестом: возвращает только данные текущего юзера; junior-scope /transactions?type=SALARY покрыт тестом (существующим или новым).
- [ ] 5. Ответ /transactions в хабе парсится zod-схемой (.parse) — grep подтверждает отсутствие raw-интерфейса SalaryTx.
- [ ] 6. Аватар удалён из блока персоны легенды; в edit-форме персоны ровно одна текстовая кнопка «Отмена».
- [ ] 7. Дата рождения и дата события журнала — через DatePickerField; миграция event_date применяется идемпотентно (db:migrate на чистой БД проходит).
- [ ] 8. legend.defaults: JUNIOR-вьюер НЕ получает defaults (integration-тест с реальной БД, role=JUNIOR → defaults null); ADMIN/HR получают legal_full_name/registration_address субъекта (drop ?? senior); пустая форма префиллится у ADMIN/HR.
- [ ] 9. Unit-тесты legends.service (defaults RBAC, eventDate сортировка) и salary-meta зелёные; `pnpm typecheck` + eslint MCP чистые.

## Interaction tests

- [ ] DatePickerField (персона + журнал): открытие по клику, выбор даты коммитит значение, Escape закрывает поппер без потери остальных полей формы.
- [ ] Edit-форма персоны: «Отмена» сбрасывает значения (form.reset) и выходит из edit-режима; повторное открытие показывает префилл (ADMIN/HR).

## Запрещено трогать

- `apps/e2e/**/*.spec.ts` — зона AutoTest (перечисли что устарело — обновит AutoTest).
- `apps/api/src/finance/transactions.service.ts` — только читать (никаких изменений фильтров).
- `users.service.ts buildProfileView` allowlist — НЕ расширять.
- `.claude/**` кроме своего progress-файла, `.github/**`, `docs/**`.

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` — только файлы из «Конкретные изменения» (+ сгенерированная миграция).
2. По каждому AC — grep/тест подтверждение.
3. Playwright: dev-login джуном → скриншоты /crm/project (контракт «Подписан», зарплатный блок) и /crm/legend (форма персоны, журнал с датой); приложить в PR.
4. Финальный коммит: `ac_verified: 1,...,9` + `vision: ✓ /crm/project, /crm/legend`.
