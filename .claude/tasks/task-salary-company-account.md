# Task: Зарплата/расход/приход админа со счёта компании + убрать LOCKED (BACKEND)

## Модель: opus

(Money-ledger: balance-математика, гейты, RBAC, reconciliation двух balance-функций → opus per model-routing.)

## Зона: Coder — `apps/api/**`, `packages/shared/**`, `.claude/tasks/<my-task>.progress.md`. (Фронт-селектор — ОТДЕЛЬНАЯ задача, НЕ трогай `apps/web`.)

## Контекст / направление владельца (2026-06-20)

Счёт компании (Phase 8) = **только USDT** пул. Расширяем ledger: зарплаты/расходы со счёта компании списывают баланс, приход админа на счёт компании — пополняет. Изучи через **codegraph** ПЕРЕД правкой (verbatim source): `createSalary` (1635), `createMonthlySalaries` (3088), `paySalary` (3053), `createExpense`, `createAdminIncome`, `computeCompanyAccountBalance` (1612), `unlockJuniorSalaryForProject` (3544, callers 1439/1497), `company-account.service.computeBalance` (71), `balance.service` (admin персональный баланс).

## РЕШЕНИЯ ВЛАДЕЛЬЦА (зафиксировано — не переспрашивать)

1. **Приход админа (ADMIN_INCOME) со «Счётом компании» → ПОПОЛНЯЕТ баланс счёта (+)**. Деньги идут в пул компании, НЕ на личный баланс админа.
2. **Всё со «Счётом компании» — только USDT** (без конверсии; сумма = USDT).
3. Крон оставляем; **LOCKED-зависимость от дохода синьора/дропа убираем** (джуны получают PENDING сразу).
4. **Зарплаты по умолчанию создаются с fundingSource = COMPANY_ACCOUNT** (и крон, и ручной диалог).
5. **При оплате зарплаты `txDate` → дата оплаты** (now).
6. Опция «Счёт компании» доступна также при создании **расхода (EXPENSE)** и **прихода админа (ADMIN_INCOME)** (для них это ОПЦИЯ, не дефолт).

## Единая ledger-формула (используется И для display, И для gate — РЕКОНСИЛИЯ)

```
Баланс = + Σ(COMPANY_DEPOSIT PAID)
         + Σ(PAYOUT PAID, fundingSource='COMPANY_ACCOUNT')
         + Σ(ADMIN_INCOME PAID, fundingSource='COMPANY_ACCOUNT')   ← НОВОЕ (+)
         − Σ(DIVIDEND_TO_ADMIN PAID)
         − Σ(SALARY PAID, fundingSource='COMPANY_ACCOUNT')
         − Σ(EXPENSE PAID, fundingSource='COMPANY_ACCOUNT')         ← НОВОЕ (−)
```

**КРИТИЧНО (баг-фикс):** сейчас две функции расходятся — `company-account.service.computeBalance` (71) включает `+PAYOUT(COMPANY_ACCOUNT)`, а `transactions.service.computeCompanyAccountBalance` (1612, используется как salary-gate) — НЕТ. Это значит gate недосчитывает баланс. **Сведи к ОДНОЙ shared-функции** (вынеси общий хелпер ИЛИ пусть transactions.service зовёт company-account.service), чтобы gate и display были БАЙТ-в-байт идентичны. Добавь оба новых терма в единую функцию.

## Реализация

### 1. Убрать LOCKED (крон + unlock)

- `createMonthlySalaries` (3088): для **JUNIOR** убрать ветку `hasValidatedIncome ? PENDING : LOCKED` — всегда **PENDING**. Убрать запрос `hasValidatedIncome` и связанную логику.
- Удалить метод `unlockJuniorSalaryForProject` (3544) + оба вызова в `validateTransaction` (1439, 1497). Проверь, что удаление не оставляет осиротевших импортов/переменных.
- Статус `LOCKED` для SALARY больше не создаётся. (Существующие LOCKED-строки в проде — не мигрируем; но проверь, что UI/findAll их не ломает — они станут «висячими». Если просто: оставь как есть, документируй.)

### 2. Зарплата по умолчанию = COMPANY_ACCOUNT

- `createMonthlySalaries`: создаёт зарплаты (HR/ACCOUNTANT + JUNIOR) с **fundingSource='COMPANY_ACCOUNT'**, currency **USDT**, senderId=null, senderLabel='Счёт компании', status **PENDING** (НЕ PAID — деньги спишутся при оплате). Сумма = как сейчас (`monthlySalary` / `juniorSalaryOverride`), но трактуется как USDT. Идемпотентность (skip если уже есть на месяц) — сохрани.
- `createSalary` (manual, 1635): дефолт `fundingSource` при ОТСУТСТВИИ → **COMPANY_ACCOUNT** (раньше было ADMIN_PERSONAL legacy — флипаем; обнови затронутые тесты, в т.ч. #222 ACCOUNTANT self-pay — теперь дефолт company). Manual по-прежнему создаёт PAID с creation-time balance-gate (уже есть для COMPANY_ACCOUNT).
- `createSalarySchema`: можно оставить `fundingSource` optional и дефолтить в сервисе (чище для backward-compat вызовов), ИЛИ `.default('COMPANY_ACCOUNT')` в схеме — выбери одно, задокументируй.

### 3. paySalary (3053): txDate + gate

- При флипе PENDING→PAID: установить **`txDate: new Date()`** (дата оплаты).
- Если `tx.fundingSource === 'COMPANY_ACCOUNT'`: перед флипом проверить единый баланс ≥ `tx.amount`; иначе `BadRequestException('Недостаточно средств на счёте компании')`. (Деньги списываются именно при PAID — баланс-формула считает только PAID SALARY.)
- ADMIN-only (как сейчас).

### 4. EXPENSE со счётом компании

- `createExpenseSchema` (packages/shared): добавь `fundingSource: salaryFundingSourceSchema.optional()` (переиспользуй существующий enum) + superRefine «COMPANY_ACCOUNT → currency только USDT» (как в salary).
- `createExpense` сервис: если `fundingSource==='COMPANY_ACCOUNT'` → currency='USDT', balance-gate (≥ amount, иначе BadRequest), senderId=null, senderLabel='Счёт компании', записать `fundingSource`. Иначе — текущее поведение (legacy, без fundingSource). EXPENSE создаётся PAID. Дефолт — НЕ company (опция).

### 5. ADMIN_INCOME со счётом компании (ПОПОЛНЯЕТ +)

- `createAdminIncomeSchema`: добавь `fundingSource` optional + USDT-superRefine.
- `createAdminIncome` сервис: если `fundingSource==='COMPANY_ACCOUNT'` → currency='USDT', записать `fundingSource='COMPANY_ACCOUNT'` на ADMIN_INCOME-строку. Деньги идут на счёт компании (баланс-формула суммирует ADMIN_INCOME PAID COMPANY_ACCOUNT как **+**). Проект — как сейчас (доход с проекта), но назначение = счёт компании. Дефолт — НЕ company (опция).
- **КРИТИЧНО — не задвоить:** обнови `balance.service` (личный баланс админа) так, чтобы ADMIN_INCOME с `fundingSource='COMPANY_ACCOUNT'` **НЕ** кредитовал личный баланс админа (деньги ушли в пул компании, а не админу лично). Изучи balance.service через codegraph, исключи company-funded admin income из персонального расчёта. Если balance.service влияет на getSummary/другие места — проверь blast-radius.

### 6. Reconcile balance (см. формулу выше) — единая функция, оба новых терма.

## Acceptance Criteria (каждый — с тестом, integration против РЕАЛЬНОЙ scratch-DB `crm_qa`, НЕ `crm_db`)

1. Крон/`createMonthlySalaries`: JUNIOR всегда PENDING (нет LOCKED); HR/ACCOUNTANT/JUNIOR создаются с fundingSource=COMPANY_ACCOUNT, USDT, PENDING. `unlockJuniorSalaryForProject` удалён, валидация дохода больше не разблокирует зп. (unit + integration).
2. `createSalary` manual: дефолт (absent fundingSource) = COMPANY_ACCOUNT. typecheck зелёный.
3. `paySalary`: txDate становится датой оплаты; company-funded зп блокируется при недостатке баланса (BadRequest), проходит при достатке + списывает баланс. (integration).
4. EXPENSE COMPANY_ACCOUNT: USDT, gate, списывает баланс; legacy EXPENSE (без fundingSource) не трогает баланс. (integration).
5. ADMIN_INCOME COMPANY_ACCOUNT: USDT, **пополняет** баланс счёта компании; НЕ кредитует личный баланс админа (balance.service). legacy ADMIN_INCOME — как раньше. (integration — проверь и баланс счёта, и личный баланс админа).
6. **Reconciliation:** display-баланс (`GET /company-account`) == gate-баланс (используемый в createSalary/paySalary/createExpense) — одна функция, включает PAYOUT + оба новых терма. (unit/integration — задай данные со всеми 6 термами, сверь обе точки).
7. eslint чистый; полный `pnpm --filter @crm/api test` зелёный на crm_qa; api typecheck.

## Тестовая дисциплина

Integration против `crm_qa` (guard #233), ассерты баланс-дельт + 403 где RBAC. Real-controller где меняется RBAC-поверхность (FM-5; finance уже в allowlist). НЕ хардкодь суммы — вычисляй из seed. `DATABASE_URL= git push`.

## Worktree (FM-2)

`/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/salary-company-account`, ветка `feature/salary-company-account` off main `cfffec61`. ВСЕ Edit/Write внутри него. НЕ писать по main-repo путям. После первого edit `git -C <wt> status`. `pnpm -C <wt> install --frozen-lockfile` если нет node_modules.

## Git

Chunked `wip:`. Финальный без `wip:`: `feat(api): salary/expense/admin-income via company account + remove LOCKED salary + pay-date on salary pay` + `ac_verified: 1,2,3,4,5,6,7`. `DATABASE_URL= git push`. PR на main. НЕ мержить. Фронт-селектор (источник в CreateTransactionDialog для salary/expense/admin-income) — ОТДЕЛЬНАЯ задача после ревью бэка.
