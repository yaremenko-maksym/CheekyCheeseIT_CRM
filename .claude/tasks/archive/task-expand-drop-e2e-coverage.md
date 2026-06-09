# task-expand-drop-e2e-coverage

## Агент: autotest

## Приоритет: high

## Ветка: feat/drop-role-phase1 (PR #63)

## Зависит от: task-fix-drop-archive-and-409 (должен быть смержен в ветку первым)

## Контекст

Второй раунд user-testing выявил, что текущие E2E (`drop-archive-cascade.spec.ts` и др.) **мокают backend** и поэтому не ловят реальные баги в backend logic. Также отсутствует покрытие edge cases: duplicate email UI, slider extremes, multi-HR, JUNIOR 403 на drop-team direct URL.

Стартуй ПОСЛЕ того как Coder запушит фикс архива и 409 (см. task-fix-drop-archive-and-409).

## Acceptance Criteria

### AC1. Real-API тест архива drop-team (NEW spec)

`apps/e2e/tests/drop-archive-real.spec.ts`:

- [ ] Setup: создать через **реальный API** drop (без моков) + drop-team + опционально senior через `addSeniorToDropTeam`.
- [ ] Login ADMIN → navigate to `/crm/team/<drop-team-id>` → click «Архивировать» → asserts:
  - Заголовок диалога: «Архивировать команду дропа».
  - Текст содержит **«дроп»** (не «синьор»).
  - Подтверждение: имя дропа (не имя синьора).
- [ ] Ввести имя дропа → submit → asserts через **реальный API**:
  - `GET /api/teams/<id>` → `archivedAt != null`.
  - `GET /api/users/<dropId>` → `archivedAt != null`.
  - Если был senior: `GET /api/users/<seniorId>` → `archivedAt === null` (не архивирован!), но в `team_members` его row имеет `leftAt != null`.
  - Drop-проекты: `status === 'CLOSED'`, `archivedAt != null`.

### AC2. Real-API тест архива drop user

`apps/e2e/tests/drop-archive-user-real.spec.ts` (или extend существующего):

- [ ] Setup через реальный API: drop с активным senior.
- [ ] Login ADMIN → /crm/users → клик archive на drop row → диалог → confirm.
- [ ] Asserts через API:
  - drop.archivedAt != null
  - drop-team.archivedAt != null (cascade)
  - senior.archivedAt === null, его member-row leftAt != null
  - drop-проекты архивированы.

### AC3. Duplicate email — UI flow

`apps/e2e/tests/drop-duplicate-email.spec.ts`:

- [ ] Через реальный API создать drop с email X.
- [ ] Login ADMIN → форма создания drop → ввести тот же email X → submit.
- [ ] Asserts:
  - HTTP 409 от backend.
  - Toast «Пользователь с таким email уже существует» виден.
  - Dialog остаётся открытым (пользователь может поправить).
- [ ] Изменить email → submit → success.

### AC4. Slider extreme values

`apps/e2e/tests/drop-share-slider.spec.ts`:

- [ ] В форме создания drop:
  - Установить slider в 0 → значение принимается, форма submit'ится успешно (backend разрешает 0%).
  - Установить slider в 100 → значение 100 принимается.
  - Через spinbutton ввести -5 → UI отказывается или показывает error.
  - Через spinbutton ввести 150 → UI отказывается или показывает error.
- [ ] Verify backend получает корректное значение в payload (или 0, или 100).

### AC5. Multi-HR в drop creation

`apps/e2e/tests/drop-multi-hr.spec.ts`:

- [ ] В форме DROP добавить 2 HR (Anna + Kateryna).
- [ ] Submit → success.
- [ ] Через API подтвердить: drop-team `team_members` содержит обоих HR с `leftAt = null`.
- [ ] На странице drop-team detail оба HR видны.

### AC6. JUNIOR 403 на прямом URL drop-team

`apps/e2e/tests/drop-junior-rbac.spec.ts`:

- [ ] Login JUNIOR (Ivan) → прямой URL `/crm/team/<drop-team-id>` → 403 от API → UI показывает либо empty state, либо редирект (зафиксировать текущее поведение, не сломать).
- [ ] Sidebar не показывает «Команда» для JUNIOR (если так в спеке) или показывает но детальная страница недоступна — зафиксировать в тесте.

### AC7. SENIOR в drop-team — read-only

`apps/e2e/tests/drop-senior-readonly.spec.ts`:

- [ ] Setup через API: senior в drop-team.
- [ ] Login этот senior → `/crm/team` → редирект на свою drop-team detail.
- [ ] Asserts: видит drop-team, **НЕ видит** кнопки «Архивировать», «Сменить синьора», «Добавить», «Редактировать».
- [ ] Видит «Команда дропа» badge.

### AC8. Существующий drop-archive-cascade.spec.ts: рефакторинг

- [ ] **Уменьшить mock-зависимость**: если у Coder'а заработала real-API ветка архива, замени мок-вызовы на real fetch + cleanup.
- [ ] Если решишь оставить mocks для UI-уровня — добавь comment что **integration covered by drop-archive-real.spec.ts**.

### AC9. Локально

```bash
pnpm --filter @crm/e2e test  # ВСЕ зелёные, включая новые
```

Включая регрессионные тесты — должны оставаться зелёными без правок.

### AC10. Push

- [ ] git push origin feat/drop-role-phase1
- [ ] gh pr comment 63: список новых spec'ов + summary.

## Helpers

При необходимости расширь `apps/e2e/tests/fixtures.ts`:

- `createDropViaAPI(page, opts)` — POST /api/users/drops, возвращает {dropId, teamId}.
- `addSeniorToDropTeamViaAPI(page, teamId, opts)` — POST.
- `archiveDropTeamViaAPI(page, teamId)` — DELETE.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
