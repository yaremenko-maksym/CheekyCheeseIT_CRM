# task-drop-phase1-e2e

## Агент: autotest

## Приоритет: high

## Ветка: feat/drop-role-phase1 (та же что у backend/frontend)

## Зависит от: task-drop-phase1-backend + task-drop-phase1-frontend (оба в ветке)

## Источник истины: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md)

## Контекст

**Фаза 1 — E2E.** Backend + frontend уже в ветке `feat/drop-role-phase1`. PR открыт. Твоя задача:

1. Добавить **новые** E2E-тесты для drop-флоу.
2. **Регрессия:** убедиться, что существующие senior-тесты НЕ требуют изменений их логики (единственное допустимое изменение — учёт RadioGroup в форме создания синьора, где надо явно выбрать «Создать свою команду» если тест ранее на этом дефолте полагался; **не менять** селекторы, только при необходимости явно кликнуть default-опцию).

После твоего push'а CI пройдёт второй раз; затем Reviewer гейтит → PM зовёт на User Testing → юзер аппрувит → merge.

## Подготовка

1. Прочитай спек: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md).
2. `git checkout feat/drop-role-phase1 && git pull` — все коммиты backend+frontend там.
3. Прочитай `docs/agents/autotest.md`, `docs/agents/memory/autotest/lessons.md`.
4. Прогон существующих E2E локально: `pnpm --filter @crm/e2e test` — убедись что **всё зелёное** до твоих правок. Если упало — НЕ маскируй, а опиши в PR-комменте, какие тесты упали и почему (Coder вернётся фиксить).
5. Через postgres MCP убедись, что миграция 0020+ применена: `\d users`, `\d teams`, `\d projects` — есть `drop_share_percent`, `team.type`, `projects.drop_id`.

## Тестовые пользователи

Для seed-сценариев используй dev-login (`POST /api/auth/dev-login {email}`). Если нужны новые персонажи для drop-сценариев — добавь их в `apps/api/src/database/seed.ts` (расширение seed — допустимо, это часть фичи).

Минимум для нового seed:

- 1 пользователь `DROP` (email типа `drop1@cheekycheese.dev`).
- 1 синьор без команды (для teamless edge сценария — `senior-orphan@cheekycheese.dev`).
- 1 синьор «свободный» (без команды и без флага orphan — для теста добавления в drop-team при создании).

Существующие seed-пользователи (Admin/Senior/HR/Accountant) — НЕ переименовывать, НЕ удалять.

## Acceptance Criteria

### AC1. E2E: создание дропа

`apps/e2e/tests/drop-create.spec.ts`:

- [ ] Login as ADMIN → `/crm/team` → кнопка «Создать дропа».
- [ ] Заполнить форму: имя, email, telegram, phone, реквизиты USDT, дроп-доля = 7%, HR×1, бухгалтер. Submit.
- [ ] Ассерт: toast «Дроп создан»; карточка новой команды (badge «DROP») появляется в списке; навигация на `/crm/team/<id>`; на странице видны: имя дропа, HR, бухгалтер; активного синьора нет.
- [ ] Через postgres MCP (или API call) проверить: `users.role='DROP'`, `users.drop_share_percent=7`; `teams.type='DROP'`; в `team_members` — drop + hr + accountant.

### AC2. E2E: синьор в команду дропа (опция 2)

`apps/e2e/tests/drop-add-senior.spec.ts`:

- [ ] Preconditions: в seed/из предыдущего сценария есть drop-team без активного синьора.
- [ ] Login as ADMIN → форма создания синьора → RadioGroup → выбрать «Добавить в существующую команду дропа» → выбрать drop-team из выпадающего списка → submit.
- [ ] Ассерт: senior создан; в `/crm/team/<drop-team-id>` появился активный синьор; **новой senior-team НЕ создалось** (счётчик команд `type='SENIOR'` не увеличился).
- [ ] Проверка через DB: `team_members` для этого синьора — ровно 1 row (drop-team), `leftAt IS NULL`.

### AC3. E2E: регрессия — синьор «Создать свою команду» (default)

`apps/e2e/tests/senior-create-default.spec.ts` (новый файл или extend существующего):

- [ ] Login as ADMIN → форма создания синьора → RadioGroup → **явно** клик «Создать свою команду» (даже если default — это для надёжности) → заполнить HR/бухгалтер/telegram → submit.
- [ ] Ассерт: senior создан; новая senior-team создана автоматически с этим синьором (как раньше); badge типа не показывается (или показывается «SENIOR»).
- [ ] **Это тест-эталон регрессии — старый флоу работает.**

### AC4. E2E: ротация синьора в drop-team

`apps/e2e/tests/drop-rotate-senior.spec.ts`:

- [ ] Preconditions: drop-team с активным синьором; есть второй синьор без команды.
- [ ] Login as ADMIN → `/crm/team/<drop-team>` → кнопка «Сменить синьора» → выбрать второго → confirm.
- [ ] Ассерт: в карточке команды — новый синьор; через DB старый member-row имеет `leftAt != NULL`, новый — `leftAt IS NULL`; дроп остаётся в команде.

### AC5. E2E: edge — синьор без команды

`apps/e2e/tests/senior-teamless.spec.ts`:

- [ ] Preconditions: синьор-сирота (можно из seed `senior-orphan@cheekycheese.dev` либо создать сценарий «архив drop-team → синьор отцепился»).
- [ ] Login as этот senior → `/crm/profile`:
  - В шапке — чип «Без команды».
  - Баннер «У вас нет активной команды».
  - Кнопка «Создать/выбрать команду» открывает диалог с RadioGroup.
- [ ] Sidebar: пункты «Проекти» и «Співбесіди» — скрыты или дизейблены.
- [ ] Открыть `/crm/projects` напрямую → empty state «Нет активной команды».
- [ ] Открыть `/crm/interviews` напрямую → empty state (или 403 friendly UI).
- [ ] Через диалог выбрать «Создать свою команду» → заполнить HR/бухгалтер → submit → ассерт: чип «Без команды» исчез, sidebar заполнился, `/crm/projects` показывает обычный список.

### AC6. E2E: каскад архива

`apps/e2e/tests/drop-archive-cascade.spec.ts`:

- [ ] Preconditions: drop-team с активным синьором и одним drop-проектом (если drop-проектов ещё нельзя создавать через UI в Фазе 1, **создай через прямой SQL/postgres MCP** до запуска UI-теста: insert в `projects` с `drop_id` указанным).
- [ ] Login as ADMIN → архив команды дропа (UI-кнопка или API call, в зависимости от того, что реализовано) → impact-cascade экран показывает: «N проектов архивируется, синьор открепляется» → confirm.
- [ ] Ассерт через DB:
  - `teams.archived_at IS NOT NULL` (drop-team).
  - Drop-проект: `status='CLOSED'`, `archived_at IS NOT NULL`, `end_date IS NOT NULL`.
  - Синьор: `users.archived_at IS NULL` (не архивирован!); его member-row в drop-team — `leftAt IS NOT NULL`.
  - Дроп: `users.archived_at IS NULL` (архив команды дропа НЕ архивит самого дропа).
- [ ] Аналогично — отдельный сценарий «архив дропа» → каскадит drop-team + проекты, синьор отцеплён, **дроп.archivedAt IS NOT NULL**.

### AC7. E2E: регрессия — архив синьора (senior-team)

`apps/e2e/tests/senior-archive-regression.spec.ts` (либо проверить, что существующий тест на архив синьора всё ещё проходит):

- [ ] Архив синьора → его senior-team + проекты архивируются. **Drop entities (если есть в БД) не должны быть тронуты.**
- [ ] Этот тест существует или нужно добавить — на твой выбор. Если уже есть аналогичный (под другим именем) — просто убедись, что он зелёный без правок логики.

### AC8. RBAC для DROP (видимость)

`apps/e2e/tests/drop-rbac.spec.ts`:

- [ ] Login as DROP → sidebar содержит только: Профіль, Команда, Фінанси.
- [ ] Открыть `/crm/interviews` напрямую → redirect или 403.
- [ ] Открыть `/crm/projects` напрямую → redirect или 403 (или empty с подсказкой, как договорено).
- [ ] `/crm/finance` → видит **только свои** транзакции; чужие отсутствуют.
- [ ] `/crm/team` → видит **только свою** команду.

### AC9. Регрессия — финансы синьора/админа/бухгалтера

- [ ] Запусти существующие finance E2E как есть (без правок). Должны быть зелёные.
- [ ] Если падают — НЕ маскируй, опиши в PR-комменте; backend Coder вернётся фиксить.

### AC10. Локальная проверка перед push

```bash
pnpm --filter @crm/e2e test
```

Все тесты (новые + регрессионные) зелёные локально. Скриншоты упавших — в `/tmp/e2e-fails-*.png`.

## Структура файлов

Новые spec-файлы — в `apps/e2e/tests/`:

- `drop-create.spec.ts`
- `drop-add-senior.spec.ts`
- `senior-create-default.spec.ts`
- `drop-rotate-senior.spec.ts`
- `senior-teamless.spec.ts`
- `drop-archive-cascade.spec.ts`
- `senior-archive-regression.spec.ts` (или extend существующего)
- `drop-rbac.spec.ts`

Helpers — если нужно, добавь в `apps/e2e/tests/helpers/` (drop-test-data.ts с factory для дропа/синьора-сироты).

## Что НЕ нужно

- Тесты на distribution drop-проекта (Фаза 2).
- Тесты на manual payout confirmation (Фаза 3).
- Менять логику существующих spec-файлов (если только не явный default-clicker для RadioGroup в форме создания синьора).

## После push

- Дождись зелёного CI на ветке.
- Закомментируй в PR: «E2E ready, X новых сценариев, регрессия зелёная». Помечь в комменте список новых файлов.
- Лейбл `awaiting-pm-review` ставит Reviewer после своего approve (не ты).

## Memory & lessons

- После работы — обнови `docs/agents/memory/autotest/lessons.md` если нашёл что-то non-obvious.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
