# Fix: 45 падаючих E2E тестів — розблокувати main

## Пріоритет: КРИТИЧНИЙ

Issue #12 `e2e-broken` блокує весь AI Review pipeline. Поки він відкритий — жодний PR не пройде review.
**Після мержу цього фіксу до main** — CI запустить E2E, issue #12 закриється автоматично.

## Як доставити

**Пушити напряму в `main`** — це CI fix, дозволено згідно CLAUDE-devops.md.
НЕ створювати PR — AI Review відхилить його через `e2e-broken` блокування.

Якщо пушити напряму небезпечно (сумніваєшся) — відкрий PR БЕЗ label `ai-review-ready`.

## Failing run

https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/actions/runs/25999866477

## 45 тестів, які падають

### 1. `tests/finance.spec.ts:635` (1 тест)
```
Finance — PENDING_PAYMENT status › ADMIN: може редактировать PENDING_PAYMENT транзакцию
Error: getByTitle('Редактировать').first() → element not found
```
Кнопка редагування відсутня або змінила title/структуру для PENDING_PAYMENT статусу.

### 2. `tests/finance-senior-flow.spec.ts:157` (1 тест)
```
SENIOR INCOME — шаг 1 › SENIOR не може створити транзакцію без чека — показується помилка
```
Можливо змінився selector або текст помилки валідації.

### 3. `tests/interviews.spec.ts` (17 тестів — ВСІ разом)
Падають від першого тесту (рядок 17): `JUNIOR sees "Нет доступа" message`
Якщо перший тест падає — це або:
- Змінився текст "Нет доступа" на сторінці
- JUNIOR тепер має доступ (не повинен)
- Сторінка не завантажується (routing issue)

Перевір: `apps/web/app/routes/crm/interviews/` — що рендериться для JUNIOR.
Також перевір чи `CLIENT_INTERVIEW` stage правильно рендериться в kanban (кнопка "Client →").

### 4. `tests/navigation.spec.ts:156` (3 тести — JUNIOR sidebar)
```
JUNIOR sidebar navigation › sidebar → Команда stays in CRM
JUNIOR sidebar navigation › sidebar → Проекты stays in CRM
JUNIOR sidebar navigation › sidebar → Финансы stays in CRM
```
Тести перевіряють heading `/команд/i` на сторінці `/crm/team`.
**Причина**: PR #11 додав авто-redirect JUNIOR → `/crm/team/:id`, де heading = назва команди, НЕ "Команда".
**Фікс**: Оновити тест — перевіряти що URL містить `/crm/team` (не точний match) та що НЕ logout.

### 5. `tests/projects.spec.ts` (4 тести)
```
Projects page › Rendering › HR sees create button
Projects page › Close and reopen project › ADMIN can close an active project
Projects page › Project metadata fields › create dialog shows new metadata fields
Projects page › Edge cases › JUNIOR sees projects but no management controls
```
Перевір `apps/web/app/routes/crm/projects/` — можливо змінились селектори кнопок або тексти.

### 6. `tests/team.spec.ts` (11 тестів)
```
Team page › Read-only view › renders team list with correct name and members
Team page › Remove member › ADMIN can remove a non-protected member
Team page › Team detail page › renders team detail page with all sections
Team page › Team detail page › shows members grouped by role
Team page › Team detail page › back button navigates to team list
Team page › Team detail page › ADMIN sees management buttons on detail page
Team page › Team detail page › shows error state for non-existent team
Team page › JUNIOR RBAC › JUNIOR can access team detail page (newly allowed)
Team page › JUNIOR RBAC › JUNIOR sees filtered member list (only themselves as JUNIOR)
Team page › Clickable team cards › team cards are clickable and navigate to detail page
Team page › Clickable team cards › shows avatar cluster preview in team cards
```
Ці тести написані для функціоналу з PR #11. Перевір поточну реалізацію `apps/web/app/routes/crm/team/$teamId.tsx` та `index.tsx` — можливо selectors не збігаються.

### 7. `tests/users.spec.ts` (8 тестів)
```
Users management page › Access control › SENIOR sees "Доступ только для администратора"
Users management page › Access control › HR can access users page
Users management page › Access control › JUNIOR sees access denied
Users management page › Create SENIOR — team assignment › (4 тести)
```
Перевір `apps/web/app/routes/crm/users/` — текст access denied, структура create dialog.

## Алгоритм роботи

1. Для кожного failing test — прочитай тест ТА відповідний компонент/роут
2. Знайди розбіжність: що тест очікує vs що реально рендерується
3. Виправ **тест** (не продакшн код, якщо поведінка правильна) або **продакшн код** (якщо баг)
4. `pnpm typecheck && pnpm lint` — 0 помилок
5. Закомить конкретними файлами
6. Пушь напряму в `main`: `git push origin main`

## Файли для читання (стартова точка)

```
apps/e2e/tests/finance.spec.ts          (рядок 630-638)
apps/e2e/tests/finance-senior-flow.spec.ts (рядок 150-165)
apps/e2e/tests/interviews.spec.ts       (рядок 1-30, 110-220)
apps/e2e/tests/navigation.spec.ts       (рядок 151-170)
apps/e2e/tests/projects.spec.ts         (рядки що падають)
apps/e2e/tests/team.spec.ts             (рядки що падають)
apps/e2e/tests/users.spec.ts            (рядки що падають)

apps/web/app/routes/crm/team/$teamId.tsx
apps/web/app/routes/crm/team/index.tsx  (або team.tsx)
apps/web/app/routes/crm/interviews/
apps/web/app/routes/crm/projects/
apps/web/app/routes/crm/users/
apps/web/app/routes/crm/finance/
```
