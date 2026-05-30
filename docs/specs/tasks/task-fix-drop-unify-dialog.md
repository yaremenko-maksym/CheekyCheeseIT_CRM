# task-fix-drop-unify-dialog

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase1 (продолжение)

## Зависит от: PR #63 (включая последний фикс guard'ов)

## Контекст

Владелец фидбэк после User Testing: **«Только одна кнопка Добавить, модалка одна для всех ролей»**. Сейчас на `/crm/users` две кнопки: «+ Добавить» и «+ Создать дропа», два разных диалога. Нужно унифицировать: одна кнопка `Добавить`, один универсальный `UserDialog`, который умеет создавать всех — ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT/DROP, форма адаптируется по выбранной роли.

## Acceptance Criteria

### AC1. Убрать вторую кнопку

- [ ] `apps/web/app/routes/crm/users/index.tsx` — удалить кнопку «+ Создать дропа» и весь связанный state/handler/import `CreateDropDialog`. Осталась одна кнопка «+ Добавить».

### AC2. Удалить CreateDropDialog

- [ ] Удалить файл `apps/web/app/components/users/CreateDropDialog.tsx` (или, если в нём есть переиспользуемая логика, перенести её внутрь UserDialog и тоже удалить файл).
- [ ] Удалить из импортов везде, где он используется.

### AC3. Расширить UserDialog под все роли (включая DROP)

`apps/web/app/components/users/UserDialog.tsx`:

- [ ] В Select роли — добавить опцию `DROP` (была ли — проверь; если нет — добавь).
- [ ] **Когда выбрана роль `DROP`:**
  - Показать поле `dropSharePercent` (number, default 5, range 0-100, label «Доля дропа, %», hint «Доля дропа от каждой выплаты»). Обязательное.
  - Показать секцию «Команда дропа» — те же поля что появляются у SENIOR при `teamMode='CREATE_NEW'`:
    - HR(ы) — мульти-селект (мин 1, обязательно).
    - Бухгалтер — селект (обязательно).
    - Telegram-канал — если у SENIOR есть это поле в форме команды, показать; нет — не добавлять.
  - **НЕ показывать** RadioGroup `teamMode` для DROP (у дропа всегда создаётся своя drop-team, нет «опции 2»).
- [ ] **Когда выбрана роль `SENIOR`:** показывать существующий RadioGroup `teamMode` (опция 1 «Создать свою команду» + поля HR/бухгалтер; опция 2 «Добавить в существующую команду дропа» + Select drop-команды) — текущее поведение.
- [ ] **Другие роли** (ADMIN/JUNIOR/HR/ACCOUNTANT): без team-секции, как сейчас.

### AC4. Submit — корректный routing по роли

- [ ] При submit:
  - `role === 'DROP'` → `POST /api/users/drops` с body `{ identity, contacts, requisites, dropSharePercent, team: { hrIds, accountantId, telegram? } }`. Это уже реализованный backend endpoint из Phase 1.
  - `role === 'SENIOR'` → текущий запрос (`POST /api/users` с `teamMode`).
  - Другие роли → текущий запрос без изменений.
- [ ] После success одинаковый success-handler: toast «Пользователь создан» / «Дроп создан» (с разным текстом по роли), invalidate `['users']`, `['teams']`, закрыть диалог, навигация — для DROP `/crm/team/<новой команды>`, для остальных текущее поведение.

### AC5. Регрессия

- [ ] Все существующие сценарии «Добавить» для ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT работают 1:1.
- [ ] Сценарий «Создать дропа» теперь живёт через ту же «Добавить» → выбрать роль DROP → форма перестраивается.

### AC6. E2E adjustments

- [ ] `apps/e2e/tests/drop-create.spec.ts` — обновить флоу: вместо клика по «Создать дропа» теперь кликать «Добавить» → выбрать роль `DROP` в Select → форма должна перестроиться → заполнить.
- [ ] `apps/e2e/tests/drop-add-senior.spec.ts` — если использовала отдельную кнопку «Создать дропа» для seed-данных, перевести на унифицированный flow.
- [ ] Остальные тесты проверь — где использовалась `CreateDropDialog` — переключи.
- [ ] Скриншоты до/после в `/tmp/drop-unify-*.png` через playwright MCP.

### AC7. Локальная проверка

```bash
pnpm typecheck
pnpm lint
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test  # ВСЁ зелёное
```

### AC8. Push

- [ ] `git push origin feat/drop-role-phase1`.
- [ ] `gh pr comment 63` — «UX fix: унифицирована форма создания пользователя; «Создать дропа» убрана; UserDialog поддерживает DROP роль с drop-share + командой».

## Что НЕ нужно

- Backend — не трогать, `/api/users/drops` уже готов.
- Любые другие правки помимо унификации.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
