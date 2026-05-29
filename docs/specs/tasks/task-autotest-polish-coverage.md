# task-autotest-polish-coverage

## Агент: autotest

## Приоритет: MEDIUM (закрепить полировочный батч, неочевидные регрессии)

## Ветка: chore/remove-knowledge-base (СУЩЕСТВУЮЩАЯ — добавить E2E внутрь неё)

## Repo: yaremenko-maksym/CheekyCheeseIT_CRM

## Контекст

PM прогнал большой UT-сweep и Coder внёс полировочный батч (раунд 1 + 2). Всё уже в ветке `chore/remove-knowledge-base` (верх d6a4a8c). PM просит E2E на **неочевидные вещи, которые могут сломаться** — регрессии от этих изменений. Многие — про консоль/формат/визуал, что текстовые тесты легко пропускают.

## КРИТИЧНО — ветка
target_branch `chore/remove-knowledge-base` УЖЕ checked out в основном worktree. НЕ делай `git checkout chore/remove-knowledge-base`. Создай рабочую ветку ОТ неё:
```
git checkout -b tests/polish-coverage chore/remove-knowledge-base
git log --oneline -3   # верх = d6a4a8c
```
PM смержит `tests/polish-coverage` обратно в `chore/remove-knowledge-base`.

## Что покрыть (AC)

- [ ] **AC1: Формат денег (AC3 полировки — затронул много диалогов)**
  - Таблица `/crm/finance`: суммы в USD с префиксом `$` (напр. `$7,777.00`). Assert что ячейка суммы содержит `$`, НЕ `₮`.
  - Деталь транзакции (клик по строке → `TransactionDetailDialog`): показывает И USD (`$...`), И исходную валюту (напр. `7 777,00 USDT`). Assert оба.
  - Coder уже обновил `finance-payout-simulate.spec.ts`, `finance-senior-flow.spec.ts`, `finance.spec.ts` под новый формат — проверь что они корректны, при необходимости укрепи.

- [ ] **AC2: Аватар/лого fallback на инициалы (НЕ стаб-иконка)**
  - Юзер без avatar-thumbnail → аватар показывает ИНИЦИАЛЫ (напр. SENIOR Oleksiy → «ОК»), НЕ иконку «Превью недоступно». 
  - Проверь хедер (`[data-testid=header-user-menu-trigger]` fallback), профиль, и логотип проекта (инициал компании, напр. TechCorp → «TA»).
  - Assert: `[data-slot=avatar-fallback]` содержит текст инициалов, и НЕ содержит `svg.lucide-image` / `aria-label="Превью недоступно"`.

- [ ] **AC3: Консоль чистая (неочевидные регрессии — forwardRef / nested-a / GSI)**
  - Используй Playwright console listener (`page.on('console', ...)`) с фильтром на errors/warnings.
  - `/crm/finance` (как SENIOR/ADMIN): НЕТ warning `Function components cannot be given refs` (forwardRef TransactionRow). Раньше падало ~60× на строку.
  - Деталь команды `/crm/team/:id`: НЕТ `validateDOMNesting` `<a> ... <a>`. 
  - `/crm/interviews` как SENIOR: НЕТ `403` на `/api/users` (gated по роли). Можешь слушать network (`page.on('response')` на `/api/users` → status != 403 для SENIOR).
  - (Опц.) `/crm/login`: НЕТ `[GSI_LOGGER]` FedCM ошибок.
  - Паттерн: собрать массив console-errors за навигацию, assert что не содержит указанных подстрок. Сделай переиспользуемый helper если удобно.

- [ ] **AC4: Написание «синьора» (не «синьера»)**
  - Публичная verify-страница `/invoice/v/:transactionId` (для подписанного инвойса) ИЛИ invoice detail: текст содержит «синьора», НЕ «синьера». Assert через `getByText(/синьора/)` + `expect(...синьера...).toHaveCount(0)`.

- [ ] **AC5: Стилизованная 404**
  - Навигация на несуществующий роут (напр. `/crm/nonexistent-xyz`) → стилизованный empty-state (иконка + сообщение + ссылка на `/crm`), НЕ голый текст «Not Found». Assert наличие ссылки «на главную»/`/crm` и осмысленного контейнера (по testid если Coder добавил, иначе по структуре `not-found.tsx`).

## Подход
- Используй существующие testid'ы (Coder сохранил: `tx-row-{id}`, `tx-status-badge-*`, `payout-detail-*`, `header-user-menu-trigger`, `dev-login-{email}`, `row-pay-payout-{id}`, и др.). Где нет — `getByRole`/`getByText` для текста-контракта.
- Логин в тестах — через dev-login (`POST /api/auth/dev-login {email}` или UI-кнопки `dev-login-{email}`). Роли: SENIOR `oleksiy.kovalenko@cheekycheese.dev`, ADMIN `yaremenkomaksym99@gmail.com`, HR `anna.lysenko@cheekycheese.dev`, ACCOUNTANT `mykola.savchenko@cheekycheese.dev`.
- Новые спеки клади в `apps/e2e/tests/` (напр. `polish-regressions.spec.ts`), либо расширь существующие где логично.

## Definition of Done
- Новые/обновлённые E2E покрывают AC1-AC5.
- `pnpm --filter @crm/e2e test` локально pass (если ресурсы машины не дают полный прогон — прогони хотя бы новые спеки + затронутые finance; честно отметь в отчёте).
- Typecheck/lint на изменениях pass.
- Push `tests/polish-coverage`. НЕ ставь лейблы, НЕ мержи — PM смержит в `chore/remove-knowledge-base`.
- Отчёт: какие спеки добавлены/изменены, что покрыто по AC, результат прогона (честно).

## Заметки для AutoTest
- Console/network-assertions — это суть задачи («неочевидное что ломается»); не ограничивайся текстовыми селекторами.
- НЕ дублируй уже существующее покрытие payout/invoice flow из PR #60 — фокус на полировочных регрессиях.
- Push `--no-verify` OK если pre-push hook мешает.
