# task-fix-e2e-round3

## Агент: autotest

## Приоритет: high

## Ветка: claude/youthful-hermann-8df1d5 (PR #28)

## КРИТИЧЕСКИ ВАЖНО

- **Fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
- Push в эту же ветку → PR #28 обновится.
- **НЕ трогай production-код**, только E2E specs и моки в `apps/e2e/`.

## Что сломалось

Unit + Typecheck зелёные, **E2E упал** на CI после большого Round 3 батча (commits `78619e5`..`ee956f8`). Failed job: `26194058091` → job ID `77123657315`. Логи через `gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/actions/jobs/77123657315/logs`.

## Изменения в production, которые ломают specs (читай ТЗ внимательно)

### 1. Requisites method switcher теперь AnimatedTabs

Раньше: `role="radio"` button с `aria-label="USDT ERC-20"` / `aria-label="Банк UAH (ФОП)"`.
Теперь: `AnimatedTabs` — обычные `<button>` без `role="radio"`. Имеют `aria-label`. Если SENIOR/ADMIN — кнопка UAH ФОП имеет `disabled` атрибут и Lock-иконку.

В `requisites-warning.spec.ts` обнови:

- `page.getByRole('radio', { name: 'USDT ERC-20' })` → `page.getByRole('button', { name: 'USDT ERC-20' })`
- Аналогично для UAH ФОП.
- Тест "SENIOR sees Bank UAH disabled" — проверь что кнопка имеет `aria-disabled="true"` (через `[aria-disabled="true"]` selector или `.isDisabled()`).

### 2. ChangeRoleDialog — colored RoleSelect

Раньше: shadcn `<Select>` с текстовыми SelectItem.
Теперь: custom RoleSelect c цветными Badge. Файл: `apps/web/app/components/ui/role-select.tsx`.

В `admin-actions.spec.ts`:

- Селекторы для "Изменить роль" → проверь как реализован — скорее всего через `role="combobox"` или ButtonAttribute, и option выбор через `role="option"` с текстом "Синьор" / "Джун" / etc. Если кастомный — посмотри файл и обнови selectors.

### 3. ChangeSalaryDialog — Slider + Input для share %

Раньше: `<Input type="number">` для seniorSharePercent.
Теперь: новый `slider-number-input.tsx` — Radix Slider + Input в одной строке.

В `admin-actions.spec.ts`:

- Для тестов "change-salary" / "Изменить долю" — fill number input по точному `name` атрибуту или role. Возможно `page.getByRole('spinbutton')` или `getByLabel('%')`. Посмотри файл и обнови.

### 4. AdminActionsMenu — контекстный label

Раньше: "Изменить зарплату" (всегда).
Теперь: для JUNIOR/HR/ACCOUNTANT → "Изменить зарплату"; для SENIOR/ADMIN → **"Изменить долю %"**.

В `admin-actions.spec.ts`:

- Если тест запускается на mock SENIOR target — selector должен быть "Изменить долю %".
- Если на JUNIOR — "Изменить зарплату".

### 5. Удалены manage-team и reassign-project

`AdminActionsMenu` теперь не имеет этих опций. Также удалены endpoints, schemas, dialogs.

В fixtures.ts:

- `buildAdminViewingUser` actions array: убери `'manage-team'` и `'reassign-project'` (если ещё не убраны).
- Также в `apps/e2e/tests/fixtures.ts` см. `users-access.service.spec.ts` для эталонного списка actions.

### 6. FinanceTab — reused list со страницы /finance

Раньше: примитивная таблица в FinanceTab.
Теперь: `TransactionRow` + `TransactionDetailDialog` со страницы `/crm/finance`. Список с фильтрами, клик по строке → modal.

Тесты на FinanceTab (если есть) обновить под новый markup.

### 7. Interviews tab убрана из ADMIN viewing SENIOR

Раньше: ADMIN на SENIOR имел 8 tabs включая "Собеседования".
Теперь: 7 tabs. Вместо tab — **кнопка "Доска собеседований"** в header.

В `rbac-*.spec.ts` или `admin-actions.spec.ts`:

- `expect(page.getByRole('tab', { name: 'Собеседования' })).toBeVisible()` → удалить или заменить на проверку `getByRole('link', { name: /Доска собеседований/ })` в header.

### 8. Admin note card в OverviewTab

Новая карточка "Заметка администратора" — видна только если `permissions.actions.includes('set-note')` (т.е. ADMIN viewer не-self).

Если тесты ожидают определённый рендер OverviewTab — possible breakage.

## Действие

1. Запусти `pnpm --filter @crm/e2e test --reporter=list` локально, собери ВСЕ failed specs.
2. Для каждого failed spec — определи причину (один из 8 пунктов выше или новая).
3. Обнови selectors / моки / fixtures под новый UI.
4. Перезапусти тесты — все должны проходить.

## Acceptance

- `pnpm --filter @crm/e2e test --reporter=list` → 0 failed
- CI на PR #28 `E2E Tests` job — зелёный
- НЕ трогай production-код (production изменения уже желаемое поведение)
- Push в `claude/youthful-hermann-8df1d5`

## Commit

`test(e2e): update profile specs after Round 3 — AnimatedTabs/Slider/RoleSelect/contextual labels/removed actions`

## После

Короткий summary (≤200 слов):

- SHA коммита
- Сколько spec файлов обновлено
- Сколько тестов починено
- Какие patterns изменились (примеры: selector A → selector B)
- CI E2E job status

Используй MCP:

- ast-grep для поиска паттернов в specs
- playwright MCP для отладки selectors на localhost:3000
- eslint MCP pre-check
