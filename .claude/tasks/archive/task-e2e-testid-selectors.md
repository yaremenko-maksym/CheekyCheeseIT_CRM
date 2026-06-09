# task-e2e-testid-selectors

## Агент: autotest

## Приоритет: MEDIUM (refactor, не блокирующий)

## Ветка: tests/strengthen-pr56-flows (EXISTING — PR #60, добавить коммит ИЛИ tests/testid-selectors новая)

## Контекст

Юзер заметил что E2E specs много где используют text-based selectors (`getByRole('button', { name: 'Подтвердить оплату' })`, `getByText('Ожидает выплаты')`), что фрагильно — любое изменение текста ломает тест.

### Юзер verbatim

> «Я заметил что в е2е тестах автотестер ищет элементы на странице через текстовое наполнение того или иного элемента. Не лучше использовать data атрибуты на html нодах для более устойчивых тестов?»

### Правильный подход (Playwright recommendation + проектная практика)

- **`getByRole`** — для критически-важных accessibility-семантик (читается screen readers): submit buttons с aria-label, navigation links
- **`getByTestId`** — для всего остального (status badges, dynamic content, interactive elements которые могут менять копирайтинг)
- **`getByText`** — последний выбор, только когда текст САМ контракт (например error messages)

## Существующие testids в коде (что уже есть)

Coder уже сохранил testids в PR #56:

- `dev-login-{email}` — login кнопки
- `header-payout-button` — был в старом batch flow (удалён)
- `payout-detail-contract-address`, `payout-detail-payable`, `payout-detail-tx-hash-input`, `payout-detail-submit`
- `payout-detail-dev-simulate-{success|error|real}`
- `payout-detail-tx-{id}` — list items
- `row-pay-payout-{txId}` — inline pay pill
- `signed-invoice-{transactionId}` (если есть)
- Header buttons: `aria-label="Поиск"`, `aria-label="Уведомления"`, `aria-label="Меню пользователя"`

## AC

- [ ] **AC1: Audit existing PR #60 specs**
  - В `apps/e2e/tests/finance-payout-simulate.spec.ts`, `invoices-signing-flow.spec.ts`, `ui-invariants-pr56.spec.ts`, `finance-senior-flow.spec.ts`, `finance-senior-payment-flow.spec.ts`, `auth.spec.ts`:
    - Найди ВСЕ `getByText`, `getByRole('button', { name: ... })`, `locator(':text(...)`) — list их
    - Классифицируй каждый:
      - **Migrate to testid:** UI elements которые меняют копирайтинг (buttons, badges, links)
      - **Keep:** error messages с фиксированным контрактом, accessibility-critical labels
      - **Use existing testid:** если testid уже есть в production code

- [ ] **AC2: Добавить недостающие testids в production code**
  - Для каждого migrated selector — verify testid существует в production code
  - Если НЕ существует — добавить `data-testid="..."` (по convention `kebab-case-component-purpose`)
  - Примеры что может потребовать новых testids:
    - Status badges (`status-badge-validated`, `status-badge-pending-payment`, `status-badge-paid`)
    - DropdownMenuItem «Профиль» (`user-menu-profile-link`), «Выйти» (`user-menu-logout-button`)
    - Invoice sign button (`invoice-sign-button`)
    - Invoice list cards (`invoice-card-{transactionId}`)
    - Document delete button (`document-delete-button`)
    - Toast notification anchors (если testable)

- [ ] **AC3: Refactor specs**
  - Заменить text-selectors на testid-selectors
  - Использовать `page.getByTestId('...')` (более явный) vs `page.locator('[data-testid="..."]')`
  - Сохранить existing assertions (logic не меняется)

- [ ] **AC4: Локальный прогон**
  - `pnpm --filter @crm/e2e test` — все tests pass (как 448 в PR #60)
  - Никакой regression — только refactor selectors

- [ ] **AC5: Документация**
  - В `apps/e2e/README.md` (или create) короткая секция «Selector strategy»:
    - Приоритет: `getByTestId` > `getByRole` > `getByText`
    - Convention testid: `kebab-case-purpose`
    - Если нужен новый testid — добавь в production code сразу

## Файлы (ожидаемые)

- `apps/e2e/tests/finance-payout-simulate.spec.ts`
- `apps/e2e/tests/invoices-signing-flow.spec.ts`
- `apps/e2e/tests/ui-invariants-pr56.spec.ts`
- `apps/e2e/tests/finance-senior-flow.spec.ts`
- `apps/e2e/tests/finance-senior-payment-flow.spec.ts`
- `apps/e2e/tests/auth.spec.ts`
- Production code: добавить новые `data-testid` атрибуты (web components)
- `apps/e2e/README.md` (new) — selector strategy

## Definition of Done

- ac_verified: 1,2,3,4,5
- Локальный E2E pass (448+ tests, 0 failures excluding pre-existing flakes)
- Typecheck + lint pass на production changes
- Push на ту же ветку `tests/strengthen-pr56-flows` (PR #60 update) ИЛИ новая ветка
- Если новая ветка → новый PR против main

## Заметки для AutoTest

- Если решишь на ту же ветку PR #60 → push update'ит PR
- Если новая ветка `tests/testid-selectors` → создать новый PR (после merge PR #60 в main)
- **Рекомендация PM:** новая ветка → отдельный PR, чтобы PR #60 (новые tests) и PR #61 (testid refactor) были логически separate в истории
- Получить task: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-e2e-testid-selectors.md`
- Push --no-verify OK
- НЕ ставить labels

Commit messages по флоу OR один общий:

- `test(e2e): migrate selectors to data-testid for resilience`
- `feat(ui): add missing data-testid attrs (status badges + nav menu + invoice actions)`
