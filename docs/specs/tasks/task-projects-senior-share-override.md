# task-projects-senior-share-override

## Агент: coder
## Приоритет: high
## Зависит от: —
## Ветка: feature/projects-senior-share-override

---

## Контекст

Сейчас процент SENIOR'а (сколько он оставляет себе при выплате) хранится глобально в `users.seniorSharePercent` (default 26%). Нужно дать ADMIN и ACCOUNTANT возможность override-ить этот процент **для конкретного проекта** при редактировании. Backend-каркас наполовину уже есть:

- ✅ Drizzle `apps/api/src/database/schema.ts:160-161` — поле `seniorSharePercentOverride: integer('senior_share_percent_override')` уже описано
- ✅ `apps/api/src/finance/transactions.service.ts:209-211` — логика расчёта уже читает `settings?.seniorSharePercentOverride ?? senior.seniorSharePercent`
- ✅ `apps/api/src/database/schema.ts:237-238` — `transactions.seniorSharePercent` snapshot
- ❌ **БД миграция не сгенерирована** — колонки `senior_share_percent_override` физически нет → `settings?.seniorSharePercentOverride` всегда `undefined`, fallback всегда срабатывает (поле «мёртвое»)
- ❌ `packages/shared/src/schemas/projects.ts` — нет поля ни в `projectSchema`, ни в `updateProjectSchema`, ни в `createProjectSchema`
- ❌ Backend RBAC — нет проверки что только ADMIN+ACCOUNTANT могут менять это поле
- ❌ UI: форма редактирования проекта без поля
- ❌ UI: отображение эффективного процента в 4 местах

Задача — доделать всю вертикаль: миграция → shared → API + RBAC → UI редактирование → UI отображение в 4 местах → E2E.

**Существующая логика snapshot'а сохраняется:** при создании `SENIOR_INCOME` транзакции эффективный % записывается в `transactions.seniorSharePercent` и payout считается из этого snapshot'а — то есть изменение override **не пересчитывает старые транзакции**, только применяется к новым приходам. Это правильное поведение, не менять.

## Конкретные изменения

### 1. Drizzle миграция

1. `apps/api/drizzle/migrations/0009_project_senior_share_override.sql` — **CREATE** через `pnpm --filter @crm/api drizzle-kit generate`. Должна содержать только `ALTER TABLE projects ADD COLUMN senior_share_percent_override integer` (поле уже описано в schema.ts:161). Проверить что миграция не трогает другие таблицы.
2. Применить: `pnpm --filter @crm/api drizzle-kit migrate` — убедиться что в БД `\d projects` показывает новую колонку (nullable).

### 2. Shared Zod schemas

3. `packages/shared/src/schemas/projects.ts` — добавить поле в три места + одно computed:
   - `projectSchema` (после `currency`): 
     - `seniorSharePercentOverride: z.number().int().min(0).max(100).nullable(),` — сам override
     - `seniorSharePercentDefault: z.number().int().min(0).max(100),` — **computed на бэке**: значение `users.seniorSharePercent` синьора проекта. Нужно для UI чтобы показать подсказку «(по умолчанию X%)» когда override null. Не сохраняется в БД, только в response DTO.
   - `updateProjectSchema`: `seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),`
   - `createProjectSchema`: `seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),`
   - Type `ProjectDto` / `UpdateProjectDto` / `CreateProjectDto` подхватятся через `z.infer<>`.

3a. `packages/shared/src/schemas/auth.ts` — расширить `SessionUser` (или `sessionUserSchema`) полем `seniorSharePercent: z.number().int().min(0).max(100)`. Используется фронтом для отображения «по умолчанию X%» в SENIOR-виджете без дополнительного запроса. Бэк (`auth.service.ts` или где собирается JWT payload) должен включать это поле — оно уже есть в БД `users.senior_share_percent`. Если используется для всех ролей кроме SENIOR оно не имеет смысла финансово, но в схеме держим как обязательное число (default 26 на уровне БД).

### 3. Backend сервис + RBAC

4. `apps/api/src/projects/projects.service.ts` — в методах `create()` и `update()`:
   - Маппинг: пробрасывать `seniorSharePercentOverride` из DTO в INSERT/UPDATE statement.
   - **RBAC**: если в payload присутствует `seniorSharePercentOverride` (включая `null` для очистки override) — проверить `user.role === 'ADMIN' || user.role === 'ACCOUNTANT'`, иначе `throw new ForbiddenException('Only ADMIN or ACCOUNTANT can change senior share percent override')`. **Не блокировать update**, только это поле — другие поля HR может менять как раньше.
   - `mapProject()` (или эквивалентный helper) — добавить в DTO поле `seniorSharePercentDefault` = `senior.seniorSharePercent` (получить через join или отдельный lookup).
   - Audit log: убедиться что существующий `project_edited` action записывает изменение `seniorSharePercentOverride` в `changes` (если audit infra пишет diff всех полей автоматически — ничего делать; иначе добавить).

4a. `apps/api/src/auth/auth.service.ts` (или где собирается JWT payload / `me` response) — добавить `seniorSharePercent` из БД в SessionUser. Уже хранится в `users.senior_share_percent` — нужно только прокинуть в payload.

5. `apps/api/src/projects/projects.service.spec.ts` (или эквивалентный test файл) — добавить тесты:
   - HR PATCH со `seniorSharePercentOverride: 30` → `ForbiddenException`
   - HR PATCH с другими полями (БЕЗ override) → 200 OK
   - ADMIN PATCH со `seniorSharePercentOverride: 30` → 200, поле сохранено
   - ACCOUNTANT PATCH со `seniorSharePercentOverride: 30` → 200, поле сохранено
   - ADMIN PATCH со `seniorSharePercentOverride: null` → 200, поле сброшено в БД на NULL
   - Создание `SENIOR_INCOME` транзакции на проект с override 30 → `transactions.seniorSharePercent === 30` (snapshot), payout считает 70% к оплате
   - Создание `SENIOR_INCOME` на проект без override → snapshot = `users.seniorSharePercent` (26 по дефолту)

### 4. UI — форма редактирования проекта

6. `apps/web/app/routes/crm/projects/$projectId.tsx` — функция `ProjectEditFields({ form, mode })` (строки 126-294), секция `mode === 'info'`:
   - После блока `<form.Subscribe>` с `rate/currency` (≈строка 285) добавить новый `<form.Field name="seniorSharePercentOverride">`:
     - Number input с placeholder = текущий `users.seniorSharePercent` синьора проекта (нужно получить через `project.senior` или отдельный запрос)
     - Label: «Доля синьора на проекте, %»
     - Подсказка под полем: «Если оставить пустым — используется доля синьера по умолчанию (X%)»
     - Кнопка-крестик «Сбросить» рядом с input → `field.handleChange(null)`
     - **`disabled` если `user.role !== 'ADMIN' && user.role !== 'ACCOUNTANT'`** — поле видно всем кто видит форму, но менять могут только эти роли
     - Валидация `onBlur`: 0-100 integer
   - Проверить что `useForm` defaults включают `seniorSharePercentOverride: project.seniorSharePercentOverride ?? null`

### 5. UI — карточка «Доля SENIOR» на странице проекта (видна всем)

7. `apps/web/app/routes/crm/projects/$projectId.tsx` — read-only view (НЕ edit mode):
   - В правой панели info (рядом с rate/currency блоком — найти место где отображаются финансовые параметры) добавить компактный блок:
     ```
     Доля синьора: 30%  [Override]      ← если override стоит
     Доля синьора: 26%  (по умолчанию)  ← если override null
     ```
   - Badge «Override» — variant `secondary` или акцентный цвет, тултип «Установлено для этого проекта; глобальная доля синьера: X%»
   - `data-testid="project-senior-share"` для E2E

### 6. UI — строка SENIOR_INCOME в таблице финансов

8. `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` — для `tx.type === 'SENIOR_INCOME'`:
   - В колонке «Сумма» (или соседней) добавить мелким серым текстом второй строкой: «Доля: {tx.seniorSharePercent}%» (snapshot из транзакции)
   - Видно ADMIN, ACCOUNTANT, SENIOR (владельцу). Для остальных — скрыть (если такие строки им вообще видны).
   - `data-testid="tx-row-senior-share-{tx.id}"` для E2E

### 7. UI — превью расчёта в диалоге payout

9. `apps/web/app/routes/crm/finance/components/dialogs/PayoutDialog.tsx`:
   - Перед кнопкой «Запросить выплату» добавить блок-превью: для каждой выбранной транзакции показать строку:
     ```
     Транзакция #abc от 10.05.2026: 1000 USDT
       Ваша доля 26%: 260 USDT (остаётся вам)
       К оплате 74%: 740 USDT
     ```
   - Итог: «Всего к оплате: <sum>» — должен совпадать с `payableAmount` который посчитает backend
   - Расчёт делается **на фронте** из `tx.seniorSharePercent` (snapshot уже в DTO)
   - Если snapshot отсутствует (старая транзакция до миграции) — fallback на текущий `users.seniorSharePercent` синьора, badge «approx»
   - `data-testid="payout-preview-row-{tx.id}"`, `data-testid="payout-preview-total"`

### 8. UI — виджет «Мои проекты и доли» в /crm/finance (только SENIOR)

10. `apps/web/app/routes/crm/finance/index.tsx` или новый компонент `apps/web/app/routes/crm/finance/components/MyProjectShares.tsx`:
    - Видно **только для SENIOR** (по `user.role === 'SENIOR'`). Для других ролей блок не рендерится.
    - Карточка «Мои проекты и доли» рядом с `KpiCards`:
      ```
      Проект A (TechCorp)  →  30% [Override]
      Проект B (BigData)   →  26% (по умолчанию)
      Проект C (FinTech)   →  22% [Override]
      ```
    - Источник: `GET /api/projects` (уже фильтруется по RBAC → SENIOR увидит свои), для каждого вычислить эффективный % = `project.seniorSharePercentOverride ?? user.seniorSharePercent`
    - `data-testid="my-project-shares"`, `data-testid="my-project-share-{projectId}"`

### 9. E2E

11. `apps/e2e/tests/projects-senior-share-override.spec.ts` — **CREATE**, сценарии:
    - **Scenario A** (ADMIN): login as ADMIN → /crm/projects/:id → редактировать → ввести `seniorSharePercentOverride = 30` → сохранить → reload → поле сохранилось → бейдж «Override» появился
    - **Scenario B** (HR заблокирован): login as HR → /crm/projects/:id (проект из своей команды) → редактировать → поле override **disabled** → HR может менять другие поля → сохранение работает (без override в body)
    - **Scenario C** (ACCOUNTANT может): login as ACCOUNTANT → /crm/projects/:id → редактировать → override = 35 → сохранить → бейдж появился
    - **Scenario D** (snapshot): login as ADMIN → создать override 30 на проекте → seed SENIOR_INCOME через прямой API (или вручную, найти существующий project) → проверить что строка транзакции показывает «Доля: 30%»
    - **Scenario E** (payout превью): login as SENIOR → /crm/finance → создать payout из транзакции с override 30 → диалог показывает «Ваша доля 30%: ...» «К оплате 70%: ...»

## API endpoints (изменения существующих)

- `PATCH /api/projects/:id` — теперь принимает `seniorSharePercentOverride` (опциональный, nullable). **RBAC для этого поля**: только ADMIN + ACCOUNTANT. Если HR/SENIOR/JUNIOR прислали с этим полем → 403. Без поля — HR работает как раньше.
- `POST /api/projects` — аналогично, опциональный override при создании.
- `GET /api/projects` и `GET /api/projects/:id` — DTO теперь содержит `seniorSharePercentOverride: number | null`.

## DB schema

```sql
-- Миграция 0009_project_senior_share_override.sql
ALTER TABLE projects ADD COLUMN senior_share_percent_override integer;
```

(Поле nullable; без default — `NULL` означает «используется глобальная доля синьера».)

## RBAC

| Роль       | Видит поле override | Может менять |
|------------|--------------------|--------------|
| ADMIN      | да                 | **да**       |
| ACCOUNTANT | да                 | **да**       |
| SENIOR     | да (своё)          | нет          |
| HR         | да                 | нет          |
| JUNIOR     | нет (нет доступа к проекту в большинстве случаев) | нет |

## Acceptance criteria

Каждый пункт проверяется через `git diff HEAD`, `grep`, или БД-запрос:

- [ ] AC1: миграция существует — `ls apps/api/drizzle/migrations/0009_*.sql`
- [ ] AC2: колонка в БД — `psql -d crm_db -c "\d projects" | grep senior_share_percent_override` показывает integer nullable
- [ ] AC3: `seniorSharePercentOverride` в `projectSchema` — `grep -n "seniorSharePercentOverride" packages/shared/src/schemas/projects.ts` ≥ 3 совпадения (project/create/update)
- [ ] AC3a: `seniorSharePercentDefault` (computed) в `projectSchema` — `grep -n "seniorSharePercentDefault" packages/shared/src/schemas/projects.ts` ≥ 1
- [ ] AC3b: `seniorSharePercent` в SessionUser — `grep -n "seniorSharePercent" packages/shared/src/schemas/auth.ts` ≥ 1
- [ ] AC3c: backend возвращает default — `grep -n "seniorSharePercentDefault" apps/api/src/projects/projects.service.ts` ≥ 1 (в `mapProject` или эквиваленте)
- [ ] AC3d: SessionUser содержит default — `grep -rn "seniorSharePercent" apps/api/src/auth/` находит передачу из БД в payload
- [ ] AC4: контроллер не меняется (приём через Zod) — `git diff apps/api/src/projects/projects.controller.ts` пуст (или только импорты)
- [ ] AC5: сервис проверяет RBAC — `grep -n "ForbiddenException.*senior.*share" apps/api/src/projects/projects.service.ts` находит проверку
- [ ] AC6: unit тесты добавлены — `grep -n "seniorSharePercentOverride" apps/api/src/projects/projects.service.spec.ts` ≥ 5 совпадений (по сценариям)
- [ ] AC7: `pnpm --filter @crm/api test` зелёный, включая новые сценарии
- [ ] AC8: input в форме — `grep -n "seniorSharePercentOverride" apps/web/app/routes/crm/projects/\$projectId.tsx` ≥ 4 совпадения (Field + disabled check + defaults + read view)
- [ ] AC9: бейдж «Override» — `grep -n "Override" apps/web/app/routes/crm/projects/\$projectId.tsx` находит badge text или data-testid="project-senior-share"
- [ ] AC10: строка SENIOR_INCOME показывает долю — `grep -n "seniorSharePercent" apps/web/app/routes/crm/finance/components/TransactionRow.tsx`
- [ ] AC11: payout preview — `grep -n "payout-preview" apps/web/app/routes/crm/finance/components/dialogs/PayoutDialog.tsx`
- [ ] AC12: виджет SENIOR в finance — `grep -rn "my-project-shares" apps/web/app/routes/crm/finance/`
- [ ] AC13: E2E файл — `ls apps/e2e/tests/projects-senior-share-override.spec.ts`
- [ ] AC14: `pnpm typecheck` зелёный на всех пакетах
- [ ] AC15: `pnpm lint` зелёный
- [ ] AC16: `pnpm --filter @crm/e2e test projects-senior-share-override` зелёный локально (ОБЯЗАТЕЛЬНО перед push — см. coder.md секция 6.7)

## Interaction tests

Форма редактирования проекта с number input — проверить:

- [ ] Number input — ввод нечислового значения отклоняется
- [ ] Number input — отрицательное значение / > 100 — показывает ошибку валидации, save disabled
- [ ] Кнопка «Сбросить» — `null` записывается в БД, бейдж «Override» исчезает после reload
- [ ] Tab из rate-input → попадает в override-input (focus order)
- [ ] HR/SENIOR/JUNIOR видят поле, но input disabled (Playwright `await expect(input).toBeDisabled()`)

## Milestones — wip-пуши (ОБЯЗАТЕЛЬНО при > 3 файлов, см. coder.md секция 7)

После каждой milestone — коммит `wip(<scope>): <milestone>` и push (hook пропустит wip без `ac_verified:`):

1. **wip(migration+shared):** миграция сгенерирована, применена, БД проверена; shared Zod добавлен; `pnpm typecheck` зелёный
2. **wip(backend):** projects.service + RBAC + unit-тесты; `pnpm --filter @crm/api test` зелёный
3. **wip(ui-edit):** ProjectEditFields с полем + disabled, скриншот через Playwright приложен в commit message
4. **wip(ui-display):** карточка на странице проекта + строка транзакции + payout dialog preview + finance виджет — все 4 места, скриншоты в commit messages
5. **wip(e2e-local):** E2E файл написан, локально `pnpm --filter @crm/e2e test projects-senior-share-override` зелёный
6. **Финальный push (с `ac_verified:`):** AC1-AC16 проверены, lint + typecheck зелёные, PR описание готово

## Запрещено трогать

- `apps/api/src/finance/transactions.service.ts` — backend logic уже работает с override через fallback. Менять **только** если в milestone #2 unit-тест выявит баг в существующем `sharePercent` маппинге. Иначе оставить как есть.
- `apps/api/src/database/schema.ts:160-161` — поле уже описано, дублировать нельзя.
- Существующие колонки `users.seniorSharePercent` и `transactions.seniorSharePercent` — НЕ ТРОГАТЬ. Семантика:
  - `users.seniorSharePercent` — глобальный default
  - `projects.seniorSharePercentOverride` — per-project override (новое)
  - `transactions.seniorSharePercent` — snapshot на момент создания (immutable)
- Frontend `useAuth()` контекст — расширение поля `seniorSharePercent` входит в эту задачу (step 3a + 4a), это OK. **Не добавлять других полей** в SessionUser в рамках этого PR.

## Verification (Coder перед финальным push)

1. `git diff HEAD --name-only` — только файлы из «Конкретные изменения» (плюс migration meta)
2. Для каждого AC1-AC16: исполнить grep / БД-запрос / `pnpm test` команду, приложить в commit message блок:
   ```
   ac_verified: 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16
   ```
3. Для UI задач (steps 4-8): `mcp__playwright__browser_navigate` + screenshot после каждой milestone, приложить в commit message:
   ```
   vision: ✓ /crm/projects/<id> (edit), ✓ /crm/finance (row+widget), ✓ /crm/finance (payout dialog)
   ```
4. **E2E локально перед `git push`** (см. `docs/agents/coder.md` секция 6.7 + memory feedback_e2e_before_push):
   ```
   pnpm --filter @crm/e2e test projects-senior-share-override
   ```
   Зелёный — пушим. Красный — фиксим локально, **не пушим broken код**.

## PR описание (шаблон для итогового PR)

```
feat(projects): per-project senior share % override (ADMIN/ACCOUNTANT)

ADMIN и ACCOUNTANT теперь могут переопределить процент SENIOR'а
для конкретного проекта (по умолчанию используется users.seniorSharePercent).

Изменения:
- DB: миграция 0009 — projects.senior_share_percent_override (nullable)
- Shared: seniorSharePercentOverride в project/create/update Zod схемах
- Backend: RBAC ADMIN+ACCOUNTANT для редактирования; existing snapshot
  логика в transactions сохранена (история не пересчитывается)
- UI:
  * Форма редактирования проекта — number input + disabled для HR/SENIOR/JUNIOR
  * Страница проекта — бейдж «Override» с эффективным %
  * /crm/finance — строка SENIOR_INCOME показывает snapshot %
  * /crm/finance — payout dialog с превью расчёта (ваша доля / к оплате)
  * /crm/finance — виджет «Мои проекты и доли» (только SENIOR)
- E2E: 5 сценариев (ADMIN edit, HR blocked, ACCOUNTANT edit, snapshot,
  payout preview)

Closes: dispatch-from-pm
```
