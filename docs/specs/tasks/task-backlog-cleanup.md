# task-backlog-cleanup

## Агент: coder

## Приоритет: medium

## Ветка: chore/backlog-cleanup (от main)

## Зависит от: — (Phase 1 + 2 merged)

## Контекст

Сборный PR закрывает накопленный бэклог из 5 пунктов. Каждый пункт — точечный фикс, не связан с другими, но удобно мерджить вместе. Все в одной ветке, один PR.

## Acceptance Criteria

### AC1. Phone «+380» без номера — скрыть в карточках

**Сейчас**: если у пользователя пустой телефон, поле в БД хранится как `+380` (UA код), и в UI показывается «+380» без цифр (видимо в карточках команды / пользователей).

- [ ] Через ast-grep найди где рендерится телефон в карточках (`apps/web/app/components/users/`, `apps/web/app/routes/crm/team/...`, `apps/web/app/components/user-profile/...`).
- [ ] Реализуй helper `hasRealPhone(phone)` → `phone && phone.length > 4 && phone !== '+380'` (или аналогично) в `apps/web/app/lib/format-phone.ts` (новый или существующий файл).
- [ ] В рендерах телефона использовать `hasRealPhone()` — если false, скрыть строку/иконку телефона. Не показывать ссылку `tel:+380` если номера нет.
- [ ] Регрессия: настоящие телефоны отображаются как раньше.

### AC2. Dashboard placeholder — русский

**Сейчас**: на `/crm/dashboard` (он же `/crm` для не-DROP) показывается plaholder с английскими текстами «Active Candidates», «Open Vacancies», «Connect DB to see data», «Recent Candidates», «Team Roles». Phase 9 ещё не реализован — placeholder.

- [ ] В `apps/web/app/routes/crm/dashboard.tsx` (или `apps/web/app/routes/crm/index.tsx`) заменить англ. строки на русские:
  - «Active Candidates» → «Активные кандидаты»
  - «Open Vacancies» → «Открытые вакансии»
  - «Placements MTD» → «Найм за месяц»
  - «Avg. Time to Hire» → «Среднее время найма»
  - «Connect DB to see data» → «Подключите БД для просмотра данных»
  - «Recent Candidates» → «Последние кандидаты»
  - «Team Roles» → «Роли команды»
  - «Administrator» → «Администратор» (если ADMIN badge)
  - и любые другие англ. фрагменты на странице
- [ ] **Не менять** структуру/layout — только текст.

### AC3. invoice-pdf testTimeout бамп

**Сейчас**: 12 тестов в `apps/api/src/invoices/invoice-pdf.service.spec.ts` падают по таймауту (5000ms vitest default) — QR / PDF generation тяжёлые.

- [ ] В `apps/api/src/invoices/invoice-pdf.service.spec.ts` (или его vitest config / per-describe) подними `testTimeout` до **20000ms** для всех тестов файла (или per-block).
- [ ] Локально прогонять: `pnpm --filter @crm/api test invoice-pdf` — должны проходить.
- [ ] Не менять логику самого `invoice-pdf.service` — только timeout config теста.

### AC4. `payPayoutRequest` для DROP — корректный response

**Сейчас**: AutoTest заметил, что `payPayoutRequest` (когда DROP отмечает что заплатил админу) commit'ит cascade-транзакции, но HTTP response — 403. Это происходит потому, что после commit система пытается через `findPayoutRequest` прочитать обновлённое состояние, а RBAC рестрикт не пускает DROP user'а.

- [ ] Через ast-grep найди `payPayoutRequest` в `apps/api/src/finance/transactions.service.ts`.
- [ ] **Reproduce**: создай test scenario (или существующий E2E `drop-distribution.spec.ts`) где DROP вызывает payout — проверь что HTTP code 200, не 403.
- [ ] **Возможный фикс**: либо вернуть результат до final RBAC re-fetch, либо расширить RBAC чтобы DROP мог читать **свои** payout requests.
- [ ] AutoTest helper `payPayoutRequestViaAPI` использовал ADMIN follow-up как workaround — после твоего фикса убрать workaround. Тест должен проходить без admin re-fetch.

### AC5. PAYOUT_ADMIN сохраняет `projectId` (senior path)

**Сейчас**: при создании PAYOUT_ADMIN транзакций в `payPayoutRequest` для senior path, поле `projectId` остаётся пустым. Это pre-existing issue, не связано с Phase 2 (drop path может сохранять — проверь).

- [ ] В `payPayoutRequest` (метод создания PAYOUT_ADMIN) для **обеих** веток (senior + drop) добавить `projectId: payoutRequest.projectId` (или эквивалент) в insert.
- [ ] UT регрессия: существующие тесты на PAYOUT_ADMIN проходят (если они проверяли что projectId был null — это изменится). Если нужно — обнови.
- [ ] E2E `senior-project-distribution-regression.spec.ts` — после фикса проверь, что PAYOUT_ADMIN строки имеют корректный projectId (через postgres MCP).

### AC6. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
```

Все зелёные. Особое внимание к invoice-pdf тестам после AC3.

### AC7. Playwright проверка (через MCP)

- [ ] Открыть `/crm/team/<some-team>` — карточки без телефона не показывают «+380».
- [ ] ADMIN → `/crm/dashboard` — placeholder на русском.
- [ ] DROP → `/crm` → редирект на `/profile` (регрессия Phase 1, не сломалось).

Скриншоты в `/tmp/backlog-cleanup-*.png`.

### AC8. PR

- [ ] Ветка `chore/backlog-cleanup` от main.
- [ ] Push, open PR. Title: `chore: backlog cleanup — phone fallback, dashboard rus, invoice-pdf timeout, payout response, projectId fix`.
- [ ] PR body: список AC и что в каждом сделано.

## Что НЕ нужно

- Любые изменения функционала за пределами AC.
- Не трогать Phase 1/2 функционал.
- Если AC4 (DROP cascade 403) требует серьёзный рефакторинг — флагни в PR-комменте и оставь только UI/UX полиш + AC3/AC5.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
