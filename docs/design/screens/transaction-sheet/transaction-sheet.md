# Transaction sheet (add / edit with receipt) — finance

> Per-screen artifact (CRM redesign v2, Task 1.3). Coder-ready spec on our shadcn/ui + tokens.
> Headless agents rely ONLY on this file + `assets/` (they have no browser access). Template:
> `docs/design/screens/_TEMPLATE.md`. Plan: `docs/superpowers/plans/2026-11-11-crm-redesign-v2.md`
> (Task 1.3). Spec: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` §4.5b / §4.6.

| Field              | Value                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Screen             | `transaction-sheet` — the receipt-first add / edit transaction sheet                                  |
| Route / trigger    | Opens over `/finance` (and the other entry points in "Current"); no route of its own                  |
| Roles              | ADMIN, ACCOUNTANT, SENIOR, DROP (create); ADMIN (admin edit); SENIOR (edit of a rejected income)      |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design is not drivable headless; HTML prototypes + Playwright) |
| Status             | `captured` (mockups) — work in progress                                                               |
| Last synced commit | `11554c089`                                                                                           |

_Work in progress: sections below are filled in the following commits._

## Current (what exists today)

Today's surfaces are Radix dialogs under the finance route's `components/dialogs/` plus the shared
`ReceiptInput` component. Inventory, by behaviour and symbol:

### Entry points

| Entry                                                | Who                                          | Opens                                          |
| ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Finance header «Нова транзакція» (icon-only < sm)    | `canCreate`: ADMIN, SENIOR, DROP, ACCOUNTANT | `CreateTransactionDialog`                      |
| SALARY row action «Додати частину зарплати»          | ADMIN, ACCOUNTANT (`canAddSalaryPart`)       | `CreateTransactionDialog` with `salaryPrefill` |
| DROP cabinet (`DropFinancePage`)                     | DROP                                         | `CreateTransactionDialog` (DROP_INCOME only)   |
| Dashboard «В роботі» panel (`InProgressPanel`)       | roles that can create                        | `CreateTransactionDialog`                      |
| Row «Редагувати» (`canAdminEdit`)                    | ADMIN                                        | `AdminEditTransactionDialog`                   |
| Row «Редагувати» (`canEdit`, REJECTED SENIOR_INCOME) | SENIOR (author)                              | `EditSeniorIncomeDialog`                       |
| Row receipt icon / detail «Додати чек»               | `canAttachReceipt`                           | `AttachReceiptSheet`                           |

### Create (`CreateTransactionDialog`)

- Container: centred Radix dialog `CrmDialogContent` (`sm:max-w-lg`) on every width — a desktop modal
  on the phone.
- Title «Нова транзакція»; «Додати частину зарплати» with `salaryPrefill`.
- Kinds per role (`availableTypes`):

  | Role       | Kinds                                                   |
  | ---------- | ------------------------------------------------------- |
  | ADMIN      | ADMIN_INCOME, EXPENSE, SALARY, ADMIN_TRANSFER, DIVIDEND |
  | ACCOUNTANT | ADMIN_INCOME, EXPENSE, SALARY, ADMIN_TRANSFER           |
  | SENIOR     | SENIOR_INCOME                                           |
  | DROP       | DROP_INCOME                                             |
  | JUNIOR, HR | none (no entry point)                                   |

- Field order: «Тип операції» → project (`ProjectSelectSection`) → kind-specific block → amount +
  currency (`AmountCurrencyInput`, all kinds except DIVIDEND; USDT locked for a USDT project) →
  «Дата транзакції» → receipt (`ReceiptField`) → «Примітки (необов’язково)» → field-error summary
  «Заповніть виділені поля» → error banner → footer «Скасувати» / «Створити транзакцію».
- Kind-specific blocks:
  - ADMIN_INCOME (ADMIN): «Рахунок отримувача» — an admin or «Рахунок компанії» (shows «Баланс рахунку
    компанії»). With a USDT project: `ObligationPreviewBanner`.
  - ADMIN_INCOME (ACCOUNTANT): «Рахунок отримувача» toggle — «Власник проєкту» / company account.
  - SALARY: «Співробітник», «Місяць», `ExistingSalaryParts` (parts already paid for that month).
  - EXPENSE: «Джерело коштів» — «Звичайна витрата» / «Списується з рахунку компанії (USDT)»;
    «Категорія» with suggestion chips (`EXPENSE_CATEGORIES`).
  - ADMIN_TRANSFER (≥ 2 admins): «Напрямок переказу» (надсилає / отримує); swap control for ACCOUNTANT only.
  - DIVIDEND: «Баланс рахунку компанії», «Отримувач (партнер)», «Сума (USDT)».
- Receipt: every kind except SALARY (SALARY is a reminder; its receipt is attached at pay time in
  `PaySalaryDialog`). Exactly one of a file or a link (`receiptMandatoryError`); USDT accepts an explorer
  link only.
- NBU rate: for a non-USD / non-USDT currency the form reads `['exchange-rate', date]` and shows the rate.
- Validation (`useCreateTransactionValidator`): amount > 0; project required for ADMIN_INCOME /
  SENIOR_INCOME / DROP_INCOME; receipt mandatory and currency-aware; receiver required for ADMIN_INCOME
  (ADMIN), SALARY, ADMIN_TRANSFER, DIVIDEND; DIVIDEND amount ≤ company balance.
- Idempotency: one key per dialog open for DIVIDEND, USDT income, SENIOR_INCOME, DROP_INCOME and SALARY.
  EXPENSE, non-USDT ADMIN_INCOME and ADMIN_TRANSFER are keyless today (Task 1.1 adds keys).
- Submit: `disabled={mutation.isPending}`, label «Створення…»; the dialog waits for the server (no
  optimistic row).
- Success (`useCreateTransactionMutation`): invalidates `['transactions']`, `['finance-summary']`, plus
  `['company-account']` for DIVIDEND and company-funded expenses. Toasts «Дохід зареєстровано, очікує
  валідації» (DROP) and «Дивіденди виведено».

### Receipt input (`ReceiptInput`)

- `ReceiptState` is an XOR: an uploaded file (`documentId`) or a link (`externalUrl`).
- Upload through `useUploadDocument`; the file / link mode switch is blocked while uploading; progress via
  `UploadProgress`.
- `accept="image/*,application/pdf"`, no `capture` attribute; hint «JPG, PNG, PDF — до 10 МБ».
- The upload is tied to the open dialog: closing the dialog abandons it.

### Edit

- `AdminEditTransactionDialog` (ADMIN; `canAdminEdit`: not deleted, not PAYOUT / PAYOUT_ADMIN, and status
  PENDING_PAYMENT or no `payoutRequestId`): title «Редагувати транзакцію», subtitle kind · amount;
  non-editable banner «Транзакцію не можна редагувати (це виплата або транзакція прив’язана до заявки на
  виплату)»; amount + currency (currency locked on a PAID row, amount lock reason note);
  `CascadeImpactPanel` (cascade preview; save blocked with «Зберегти не можна — по відмічених рядках суму
  не перерахувати, потрібне ручне рішення»); date (`TxDateField`); «Категорія» (EXPENSE, free text);
  «Місяць» (SALARY); «Примітки». Footer «Скасувати» / «Зберегти» («Збереження…»), disabled while pending,
  cascade-blocked or stale. Toasts «Рахунок не перевипущено — збережіть транзакцію ще раз» and «Рахунок
  розійшовся із сумою — потрібна ручна звірка».
- `EditSeniorIncomeDialog` (SENIOR author, SENIOR_INCOME with status REJECTED): amount, currency, receipt
  (sent only if changed), notes through `financeApi.updateSeniorIncome`; invalidates `['transactions']`
  and `['finance-summary']`.
- `AttachReceiptSheet`: `PATCH /transactions/:id/receipt`, gated by `canAttachReceipt` — ADMIN /
  ACCOUNTANT on any transaction; the author attaches when there is none and replaces while status ≠ PAID.

### Dual-mount pairs

- `CascadeImpactPanel` renders a mobile-only row (`sm:hidden`, test id prefix
  `cascade-derivative-mobile-row-`) inside its table next to the desktop columns. This is the one pair in
  these dialogs; the new sheet mounts one layout (see "Layout per device class").

### Baseline captures

- Device captures of today's dialogs: **pending** (Capture step, done separately).
- Network baseline (requests per open / submit): **pending** (Capture step, done separately).
