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
| Status             | `captured` (HTML mockups rendered to PNG; awaiting owner review)                                      |
| Last synced commit | `11554c089`                                                                                           |

**In one paragraph.** One sheet replaces the create dialog, both edit dialogs and the attach-receipt sheet.
It is a full-height `ResponsiveSheet` on the phone and a right side panel from 640 px. The form body
is the same at every width. The receipt comes first, the amount second, and everything else is
prefilled or one tap away. A keyed save closes the sheet at once and shows an optimistic row. A failed
save rolls the row back with a visible error, and the draft is kept. An unknown outcome is never
retried automatically: the user decides to resubmit with the same idempotency key. No capability of
today's dialogs is removed (see "Field parity").

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

## States

Mockups: `assets/transaction-sheet/<state>-<width>.png`. The main state is rendered at 320, 375, 768,
1024 and 1440; every other state at 375 (phone) and 1440 (desktop, non-modal panel). The sample role
is ADMIN and the sample kind EXPENSE unless the row says otherwise.

| State                    | Screenshots                          | Notes                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default (empty form)     | `default-{320,375,768,1024,1440}`    | Receipt tile first, amount placeholder `0,00`, currency + kind pills, category chips, defaults row. Submit enabled: a tap on an invalid form focuses the first invalid field.                                                      |
| receipt uploading        | `receipt-uploading-{375,1440}`       | Upload row with a progress bar; the rest of the form stays editable. The user can save (armed) or collapse the sheet; the draft keeps the upload.                                                                                  |
| armed save               | `armed-{375,1440}`                   | Save tapped while the receipt uploads: «Збережеться 1 250,50 USD після чека» + «Не зберігати автоматично». The lead becomes «Згорнути»; the save fires when the upload ends.                                                       |
| in flight                | `inflight-{375,1440}`                | Keyless kinds only (see "Save behaviour"): banner «Зберігаємо… змінити не можна», the form locked, submit `aria-disabled="true"` with a spinner.                                                                                   |
| optimistic row           | `optimistic-row-{375,1440}`          | Keyed save: the sheet is closed; the list shows the row with «Зберігаємо…» and `aria-busy="true"`; the phone also shows the pill «Зберігаємо 1 250,50 USD…».                                                                       |
| rollback (save failed)   | `rollback-{375,1440}`                | The optimistic row is removed; a persistent error toast «Не збережено 1 250,50 USD» / «Рядок прибрано зі списку. Сума й чек у чернетці.» with «Відкрити», which reopens the pinned draft.                                          |
| error 422 (validation)   | `error-422-{375,1440}`               | Server validation: the message sits inline on the field («Жовтень уже закрито. Оберіть дату від 1 листопада.»), values kept, no retry button.                                                                                      |
| error, not sent          | `error-definite-{375,1440}`          | The request never left (offline, DNS, refused): alert «Транзакцію не надіслано» + «Повторити збереження» (manual) + «Видалити чернетку».                                                                                           |
| unknown outcome          | `unknown-resubmit-{375,1440}`        | Timeout after the request left: the form is locked, the alert explains it, «Надіслати ще раз» resubmits with the same idempotency key («якщо транзакцію вже збережено, друга не з’явиться»), «Видалити чернетку». Never automatic. |
| loading (form data)      | `loading-{375,1440}`                 | Projects, receivers or the NBU rate are loading: skeletons in the pickers and the rate line; amount and receipt stay usable.                                                                                                       |
| long content             | `long-content-{375,1440}`            | UAH `1 234 567,89` fits at 34 px on the phone, NBU rate line, a long project name truncated with an ellipsis, a long description on one line.                                                                                      |
| permission-limited       | `permission-limited-{375,1440}`      | A payout, or a transaction tied to a payout request: read-only view, a banner, «Лише перегляд», lead «Закрити», no footer.                                                                                                         |
| dirty close              | `dirty-close-{375,1440}`             | Phone: an action sheet «Вийти без збереження?»; desktop: a 420 px confirm dialog. Buttons «Продовжити редагування» / «Вийти без збереження».                                                                                       |
| kind picker              | `kind-picker-{375,1440}`             | Phone: a picker sheet with the role's kinds; desktop: a listbox popover with the keys 1–5.                                                                                                                                         |
| ADMIN_INCOME, USDT       | `admin-income-usdt-{375,1440}`       | Explorer link only, USDT locked, «Рахунок отримувача», the obligation preview (who is credited, which share, which source).                                                                                                        |
| ADMIN_INCOME, ACCOUNTANT | `admin-income-accountant-{375,1440}` | Segmented control «Власник проєкту» / «Рахунок компанії».                                                                                                                                                                          |
| EXPENSE, company funded  | `expense-company-{375,1440}`         | ACCOUNTANT, USDT link, a category chip selected, «Джерело коштів» = «Рахунок компанії» with the company balance hint.                                                                                                              |
| SALARY part              | `salary-part-{375,1440}`             | Prefilled from a SALARY row: «Співробітник», «Місяць», «Уже внесено за листопад», info «Чек для зарплати додається під час виплати.» No receipt block.                                                                             |
| ADMIN_TRANSFER           | `transfer-{375,1440}`                | ACCOUNTANT: cards «надсилає → отримує» with the swap control «Поміняти напрямок».                                                                                                                                                  |
| DIVIDEND                 | `dividend-{375,1440}`                | USDT locked, explorer link, «Отримувач (партнер)», the company balance with the limit note.                                                                                                                                        |
| SENIOR_INCOME            | `senior-income-{375,1440}`           | SENIOR: no kind pill, title «Новий дохід», project, receipt uploading.                                                                                                                                                             |
| DROP_INCOME              | `drop-income-{375,1440}`             | DROP: title «Новий дохід», USDT link, hint «Дохід піде на валідацію адміністратору».                                                                                                                                               |
| admin edit + cascade     | `admin-edit-cascade-{375,1440}`      | Title «Редагування», the list «Що зміниться» (one mount at every width); a row that cannot be recomputed reads «Не перерахується автоматично». Primary «Зберегти зміни».                                                           |
| senior edit (rejected)   | `senior-edit-rejected-{375,1440}`    | Banner «Дохід відхилено. Після збереження він знову піде на перевірку.», primary «Зберегти й надіслати».                                                                                                                           |
| attach receipt           | `attach-receipt-{375,1440}`          | A transaction summary card, the receipt, the project; primary «Додати чек».                                                                                                                                                        |

There is no "empty" state: the sheet always opens on a form, and a role without kinds (JUNIOR, HR)
never sees an entry point. "Offline" and "unknown outcome" share one visual pattern; whether the
request left the device decides between «Повторити збереження» and «Надіслати ще раз».

### Coverage matrix (every kind and role that creates or edits today)

| Flow                      | ADMIN                   | ACCOUNTANT                | SENIOR                   | DROP                     |
| ------------------------- | ----------------------- | ------------------------- | ------------------------ | ------------------------ |
| EXPENSE                   | `default`, error states | `expense-company`         | —                        | —                        |
| ADMIN_INCOME              | `admin-income-usdt`     | `admin-income-accountant` | —                        | —                        |
| SALARY (new, no prefill)  | spec-only ¹             | spec-only ¹               | —                        | —                        |
| SALARY part (row prefill) | spec-only ¹             | `salary-part`             | —                        | —                        |
| ADMIN_TRANSFER            | spec-only ²             | `transfer`                | —                        | —                        |
| DIVIDEND                  | `dividend`              | —                         | —                        | —                        |
| SENIOR_INCOME             | —                       | —                         | `senior-income`          | —                        |
| DROP_INCOME               | —                       | —                         | —                        | `drop-income`            |
| Admin edit                | `admin-edit-cascade`    | —                         | —                        | —                        |
| Edit of a rejected income | —                       | —                         | `senior-edit-rejected`   | —                        |
| Attach / replace receipt  | `attach-receipt`        | same sheet                | same sheet (own, ≠ PAID) | same sheet (own, ≠ PAID) |
| Non-editable transaction  | `permission-limited`    | —                         | —                        | —                        |

¹ SALARY without a prefill is the `salary-part` layout with empty «Співробітник» / «Місяць» pickers,
the same for both roles. ² ADMIN_TRANSFER for ADMIN is the `transfer` layout without the swap
control: the swap is ACCOUNTANT-only today and stays so.
