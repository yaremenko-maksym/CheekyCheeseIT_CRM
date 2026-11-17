# Transaction sheet (add / edit with receipt) — finance

> Per-screen artifact (CRM redesign v2, Task 1.3). Coder-ready spec on our shadcn/ui + tokens.
> Headless agents rely ONLY on this file + `assets/` (they have no browser access). Template:
> `docs/design/screens/_TEMPLATE.md`. Plan: `docs/superpowers/plans/2026-11-11-crm-redesign-v2.md`
> (Task 1.3). Spec: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` §4.5b / §4.6.

| Field              | Value                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Screen             | `transaction-sheet` — the receipt-first add / edit transaction sheet                                                       |
| Route / trigger    | Opens over `/finance` (and the other entry points in "Current"); no route of its own                                       |
| Roles              | ADMIN, ACCOUNTANT, SENIOR, DROP (create); ADMIN (admin edit); SENIOR (edit of a rejected income)                           |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design is not drivable headless; HTML prototypes + Playwright)                      |
| Status             | `captured`, council round 2 fixes done (HTML mockups rendered to PNG)                                                      |
| Last synced commit | `11554c089`                                                                                                                |
| Gate               | **Task 1.1** (an idempotency key on every create) gates the keyed create path; the keyless path below holds until it ships |

**In one paragraph.** One sheet replaces the create dialog, both edit dialogs and the attach-receipt sheet.
It is a full-height `ResponsiveSheet` on the phone and a right side panel from 640 px. The form body
is the same at every width. The receipt comes first, the amount second, and everything else is
prefilled or one tap away. Two create paths exist, and the spec holds on either owner decision about
Task 1.1. **Keyed** (every kind after Task 1.1; today DIVIDEND, USDT income, SENIOR_INCOME,
DROP_INCOME and SALARY): a save closes the sheet at once and shows an optimistic row; a failed or
unknown save keeps the draft as a pinned row, a pill and a dot on «+», and an unknown draft is resent
only by hand with the same key. **Keyless** (EXPENSE, non-USDT ADMIN_INCOME, ADMIN_TRANSFER and the
company deposit until Task 1.1 ships): the sheet waits for the answer, there is no optimistic row, and
an unknown outcome is never resent: «Перевірити список» opens the foundation check sheet. Edits (admin
edit, senior edit, attach / replace receipt) are never optimistic, carry no key and keep their outcome
on the edited row. Outcome classes are the foundation's (`primitives-v2.md` §5). There is no toast. No
capability of today's dialogs is removed (see "Field parity").

## Assumptions

Master decisions for council round 2 (M1–M14) and the designer's own reversible decisions (A1). Each
line names where the body shows it.

- **M1** Outcome classes are the foundation's, word for word (`primitives-v2.md` §5). Definite = an
  answer with the app's error envelope (any 4xx; a 500 / 503 only on an endpoint Wave 1 verified to
  commit in one DB transaction) or offline before the request left. Unknown = 502 / 504 from the
  gateway, 524, a 5xx without the envelope (or an enveloped 500 / 503 on an unverified endpoint), a
  connection dropped after the request left, a client timeout. «не збережено» appears only for a
  definite failure. → "Save behaviour", Strings, `rollback-*`, `error-definite-*`,
  `confirm-discard-unknown-375`.
- **M2** Edits (admin edit, senior edit, attach / replace receipt) have their own lifecycle: not
  optimistic, no idempotency key, never retried automatically. The outcome marker sits on the edited
  transaction's own row and in the pill, never as a pinned draft row; the wording is edit wording and
  names the transaction by kind and signed amount (the finance list row-write contract, Task 1.2 §9.2).
  → "Edit lifecycle", `edit-*` frames.
- **M3** An unknown edit is never resent blind: the screen refetches the transaction and compares the
  sent fields (all match → saved; none match → not saved, the form reopens with the entered values
  and a manual save; a failed refetch keeps the marker with «Повторити»). An admin save after an
  unknown always runs a fresh cascade preview. A 400 `FINANCE_EDIT_REJECTED_ONLY` or 409
  `FINANCE_CASCADE_PREVIEW_STALE` after an unknown reads "check the row", never «не збережено».
  → "Edit lifecycle", `edit-unknown-*`, `edit-unknown-resolved-375`.
- **M4** Hard field and state parity for admin edit: date-change reason (+ its server error), receipt
  for ADMIN_INCOME / SENIOR_INCOME / EXPENSE only, stale preview (409) with refresh, preview loading
  and error, save unavailable while stale / loading / blocked, a blocked state that names the next
  step; strings from today's catalog. → "Field parity", `admin-edit-*` frames, Strings.
- **M5** Senior edit keeps today's field set: rejection-reason panel, project as read-only text, no
  date row, no defaults row. → `senior-edit-rejected-*`.
- **M6** Attach receipt keeps today's shape: no project field; title and primary switch to the replace
  wording when a receipt exists; «Замінити наявний чек?» confirms a replace; the primary uses the armed
  label while uploading. → `attach-receipt-*`, `attach-replace-375`, `attach-replace-confirm-375`.
- **M7** Task 1.1 gates the keyed create path; the keyless contingency is drawn (no optimistic close,
  no resend, «Перевірити список» → check sheet). → header, "Save behaviour", `unknown-keyless-*`,
  `unknown-check-375`.
- **M8** Tablet is its own class: no bare dash in the 640–1023 column; 900–1023 rendered
  (`default-1000`, `edit-unknown-1000`); the panel stays modal below 1440 under the foundation rule,
  and the self-score quotes the anchor. → States, "Layout per device class", Self-score.
- **M9** A reload or tab kill while a write is in flight is reported at the next boot (foundation page
  kill). → States, `reload-while-saving-375`.
- **M10** Two plan test names are replaced (open point 10); the plan file is not edited here.
- **M11** Every `{amount}` in an outcome, pill, pinned-row, armed-button and confirm string is signed;
  a field's own value and an "old → new" pair are unsigned on purpose. → Strings.
- **M12** A locked (sent) draft is a record: sent values at full contrast, an absolute date and the send
  time, no «змінити». → `inflight-*`, `unknown-resubmit-*`, `unknown-keyless-*`; open point 12.
- **M13** Fixtures: one date constant (11 листопада 2026, the foundation list's «сьогодні») for sheet
  and list; the shell shows the viewer's role; the highlighted row behind an edit is the edited
  transaction; 422 frames keep the entered values; DROP frames show only DROP's rows; invented names.
- **M14** Foundation files are not edited; each deviation is an open point with a recommendation.
- **A1-1** Frames render with Inter from `@fontsource/inter` (`INTER_DIR`), the product font; the round 1
  PNGs had fallen back to system-ui. Every frame is re-rendered, so line breaks moved.
- **A1-2** A partial match after an unknown edit (some sent fields equal, some not, or the row changed
  since) is "check the row", like a 400 / 409 after an unknown (open point 13).
- **A1-3** An unknown edit closes the sheet, as a finance-list row write does; the entered values stay in
  memory under the row marker until it is resolved.
- **A1-4** The permission-limited fixture is a PAYOUT row (label «Виплата», `−` sign), so «це виплата»
  is literally true.
- **A1-5** Round 1 wording the council did not flag is kept (senior edit «Виправити дохід» /
  «Зберегти й надіслати», admin edit «Редагування» / «Зберегти зміни»). Attach takes today's pair
  «Прикріпити чек» / «Замінити чек» with the primaries «Прикріпити» / «Замінити», because M6 needs the
  replace wording and round 1's «Додати чек» had no replace form.

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

Mockups: `assets/transaction-sheet/<state>-<width>.png` (76 frames). The sample role is ADMIN and the
sample kind EXPENSE unless the row says otherwise. Widths: 320 and 375 (phone), 768 (tablet portrait,
the 640–899 layout), 1024 and 1440 (desktop). A dash in the 640–1023 column means the frame is the
desktop body in the 400 px tablet panel with nothing tablet-specific to show; the "Layout per device
class" table is the rule for it.

| State                            | < 640                                         | 640–1023                 | ≥ 1024                         | Notes                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------- | ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default (empty form)             | `default-320` (full length), `default-375`    | `default-768`            | `default-1024`, `default-1440` | Receipt tile first, amount placeholder `0,00`, currency + kind pills, «Категорія» text field with suggestion chips, defaults row. Submit enabled: a tap on an invalid form focuses the first invalid field.                                                                                                                                                    |
| receipt uploading                | `receipt-uploading-375`                       | —                        | `receipt-uploading-1440`       | Upload row with a progress bar; the rest of the form stays editable. Primary «Зберегти після завантаження чека»: a tap arms the save.                                                                                                                                                                                                                          |
| armed save                       | `armed-320`, `armed-375`                      | —                        | `armed-1440`                   | «Збережеться −1 250,50 USD після завантаження чека» + «Не зберігати автоматично». Lead «Згорнути»; the save fires when the upload ends.                                                                                                                                                                                                                        |
| in flight (draft reopened)       | `inflight-375`                                | —                        | `inflight-1440`                | Only reachable by reopening a saving draft from its pill. Lead «Згорнути», the muted lock line «Зберігаємо… · змінити не можна», the form locked, primary with a spinner and `aria-disabled="true"`. No «Видалити чернетку».                                                                                                                                   |
| saving (sheet closed)            | `optimistic-row-375`                          | `optimistic-row-768`     | `optimistic-row-1440`          | Optimistic row in place, status «Зберігаємо…» in `--muted-fg` (no opacity, `aria-busy="true"`), pill «Зберігаємо −1 250,50 USD… · Відкрити».                                                                                                                                                                                                                   |
| saved                            | `saved-375`                                   | `saved-768`              | `saved-1440`                   | The server row replaces the optimistic one; pill «Збережено −1 250,50 USD · Відкрити».                                                                                                                                                                                                                                                                         |
| failed (sheet closed)            | `rollback-375`                                | `rollback-768`           | `rollback-1440`                | The optimistic row is removed. Pill «Не збережено −1 250,50 USD · Відкрити», a pinned draft row «−1 250,50 USD · Не збережено · Витрата · Відкрити» on top of the list, a dot on «+». No toast.                                                                                                                                                                |
| unknown outcome (sheet closed)   | `unknown-closed-375`                          | `unknown-closed-768`     | `unknown-closed-1440`          | Pill «Результат невідомий · −1 250,50 USD · Відкрити» (the foundation «?» icon in `--primary`), a pinned warning row «Результат невідомий · Витрата», a dot on «+». The optimistic row is removed: it is not known to exist.                                                                                                                                   |
| error 422 (validation)           | `error-422-375`                               | `error-422-768`          | `error-422-1440`               | The draft reopened: the message sits inline on the field («Жовтень уже закрито. Оберіть дату від 1 листопада.»), values kept, no retry button, **no «Видалити чернетку»**. Reopening turns the draft back into an ordinary dirty form: the pill and pinned row clear, the lead is «Скасувати», and closing asks «Вийти без збереження?» (leaving discards it). |
| error, not sent                  | `error-definite-320`, `error-definite-375`    | —                        | `error-definite-1440`          | The draft reopened after the request never left (offline, DNS, refused): alert «Транзакцію не надіслано» + «Повторити збереження» (manual) + «Видалити чернетку».                                                                                                                                                                                              |
| confirm discard                  | `confirm-discard-375`                         | —                        | `confirm-discard-1440`         | After «Видалити чернетку»: «Видалити чернетку −1 250,50 USD?» / «Сума, поля й чек зникнуть. Цю дію не можна скасувати.» / «Залишити» (initial focus) + «Видалити» (destructive). Phone: action sheet over the sheet; wider: a 420 px dialog.                                                                                                                   |
| unknown outcome (draft reopened) | `unknown-resubmit-375`                        | —                        | `unknown-resubmit-1440`        | Alert «Невідомо, чи збережено транзакцію». The form is locked: date / project / description are a read-only line with no «змінити». «Надіслати ще раз» resubmits with the same key; «Видалити чернетку» (confirm adds the unknown line). Never automatic.                                                                                                      |
| loading (form data)              | `loading-375`                                 | —                        | `loading-1440`                 | Projects, receivers or the NBU rate are loading: skeletons in the pickers and the rate line; amount and receipt stay usable.                                                                                                                                                                                                                                   |
| long content                     | `long-content-320` (full), `long-content-375` | —                        | `long-content-1440`            | UAH `1 234 567,89` fits (34 px on the phone), the NBU rate line, a long project name truncated, a long description in «», the defaults row wrapping by item.                                                                                                                                                                                                   |
| permission-limited               | `permission-limited-375`                      | —                        | `permission-limited-1440`      | A payout, or a transaction tied to a payout request: the warning banner, then a read-only label / value list (no chevrons, no inputs), lead «Закрити», no footer.                                                                                                                                                                                              |
| dirty close                      | `dirty-close-375`                             | `dirty-close-768`        | `dirty-close-1440`             | Phone: action sheet. Wider: a 420 px dialog, 44 px buttons below 1024, 36 px from 1024. «Вийти без збереження?» / «Продовжити редагування» (initial focus) + «Вийти без збереження».                                                                                                                                                                           |
| kind picker                      | `kind-picker-375`                             | `kind-picker-768`        | `kind-picker-1440`             | Phone: a picker sheet. ≥ 640: a listbox popover under the pill; coarse pointer = 56 px rows with a subtitle and no keys (`kind-picker-768`), fine pointer = 36 px rows with the keys 1–5 (`kind-picker-1440`).                                                                                                                                                 |
| ADMIN_INCOME, USDT               | `admin-income-usdt-375`                       | —                        | `admin-income-usdt-1440`       | Explorer link only, USDT locked, «Рахунок отримувача», the obligation preview.                                                                                                                                                                                                                                                                                 |
| ADMIN_INCOME, ACCOUNTANT         | `admin-income-accountant-375`                 | —                        | `admin-income-accountant-1440` | Segmented control «Власник проєкту» / «Рахунок компанії».                                                                                                                                                                                                                                                                                                      |
| EXPENSE, company funded          | `expense-company-375`                         | —                        | `expense-company-1440`         | ACCOUNTANT, USDT link, a category chip picked, the defaults row names «Рахунок компанії» with the company balance hint.                                                                                                                                                                                                                                        |
| SALARY part                      | `salary-part-375`                             | —                        | `salary-part-1440`             | Prefilled from a SALARY row: «Співробітник», «Місяць», «Уже внесено за листопад», info «Чек для зарплати додається під час виплати.» No receipt block.                                                                                                                                                                                                         |
| ADMIN_TRANSFER, ACCOUNTANT       | `transfer-375`                                | —                        | `transfer-1440`                | Two stacked picker cards «надсилає» / «отримує» with chevrons, a static ↓ between them, a separate 44 px button «Поміняти напрямок».                                                                                                                                                                                                                           |
| ADMIN_TRANSFER, ADMIN            | `transfer-admin-375`                          | —                        | `transfer-admin-1440`          | The sender is fixed «Ви · Адміністратор 1» (no chevron); only «отримує» picks; no swap button.                                                                                                                                                                                                                                                                 |
| DIVIDEND                         | `dividend-375`                                | —                        | `dividend-1440`                | USDT locked, explorer link, «Отримувач (партнер)», the company balance with the limit note.                                                                                                                                                                                                                                                                    |
| SENIOR_INCOME                    | `senior-income-375`                           | —                        | `senior-income-1440`           | SENIOR: no kind pill, title «Новий дохід», project, receipt uploading.                                                                                                                                                                                                                                                                                         |
| DROP_INCOME                      | `drop-income-375`                             | —                        | `drop-income-1440`             | DROP: title «Новий дохід», USDT link, hint «Дохід перевірить адміністратор».                                                                                                                                                                                                                                                                                   |
| admin edit + cascade             | `admin-edit-cascade-375`                      | `admin-edit-cascade-768` | `admin-edit-cascade-1440`      | Title «Редагування», subtitle «Дохід · було 1 200,00 USD», amount + currency, «Що зміниться» (first row «Ця транзакція»), «Дата», «Примітки». No project or receiver picker. Primary «Зберегти зміни».                                                                                                                                                         |
| admin edit, blocked              | `admin-edit-blocked-375`                      | —                        | `admin-edit-blocked-1440`      | Alert «Зберегти не можна» / «По відмічених рядках суму не перерахувати — потрібне ручне рішення.»; the blocked row reads «120,00 USD — залишиться без змін» + «У заявці на виплату — суму не змінити»; primary `aria-disabled`.                                                                                                                                |
| admin edit, saving               | `admin-edit-saving-375`                       | —                        | `admin-edit-saving-1440`       | Admin edit waits for the server: lead «Згорнути», the muted lock line, the form locked, primary «Зберегти зміни» with a spinner.                                                                                                                                                                                                                               |
| senior edit (rejected)           | `senior-edit-rejected-375`                    | —                        | `senior-edit-rejected-1440`    | Banner «Дохід відхилено. Після збереження він знову піде на перевірку.», primary «Зберегти й надіслати».                                                                                                                                                                                                                                                       |
| attach receipt                   | `attach-receipt-375`                          | —                        | `attach-receipt-1440`          | A transaction summary card, the receipt, the project; primary «Додати чек».                                                                                                                                                                                                                                                                                    |

There is no "empty" state: the sheet always opens on a form, and a role without kinds (JUNIOR, HR)
never sees an entry point. Whether the request left the device decides between «Повторити
збереження» (not sent) and «Надіслати ще раз» (unknown outcome).

### Coverage matrix (every kind and role that creates or edits today)

| Flow                      | ADMIN                                                           | ACCOUNTANT                | SENIOR                   | DROP                     |
| ------------------------- | --------------------------------------------------------------- | ------------------------- | ------------------------ | ------------------------ |
| EXPENSE                   | `default`, error states, lifecycle                              | `expense-company`         | —                        | —                        |
| ADMIN_INCOME              | `admin-income-usdt`                                             | `admin-income-accountant` | —                        | —                        |
| SALARY (new, no prefill)  | spec-only ¹                                                     | spec-only ¹               | —                        | —                        |
| SALARY part (row prefill) | spec-only ¹                                                     | `salary-part`             | —                        | —                        |
| ADMIN_TRANSFER            | `transfer-admin`                                                | `transfer`                | —                        | —                        |
| DIVIDEND                  | `dividend`                                                      | —                         | —                        | —                        |
| SENIOR_INCOME             | —                                                               | —                         | `senior-income`          | —                        |
| DROP_INCOME               | —                                                               | —                         | —                        | `drop-income`            |
| Admin edit                | `admin-edit-cascade`, `admin-edit-blocked`, `admin-edit-saving` | —                         | —                        | —                        |
| Edit of a rejected income | —                                                               | —                         | `senior-edit-rejected`   | —                        |
| Attach / replace receipt  | `attach-receipt`                                                | same sheet                | same sheet (own, ≠ PAID) | same sheet (own, ≠ PAID) |
| Non-editable transaction  | `permission-limited`                                            | —                         | —                        | —                        |

¹ SALARY without a prefill is the `salary-part` layout with empty «Співробітник» / «Місяць» pickers,
the same for both roles. The swap control stays ACCOUNTANT-only, as today; ADMIN always sends.

## Layout per device class

One layout is mounted at a time. The **form body is identical** in every class; only the container,
the header hints and the initial focus change. There is no `sm:hidden` / `hidden sm:block` pair
anywhere in the sheet (today's `CascadeImpactPanel` mobile row is replaced by one list, see below).

| Class                       | Container                                                                                                                                                                                                        | Header                                                                                                                          | Initial focus                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| < 640 (phone)               | `ResponsiveSheet` bottom sheet at full height over the role's «Фінанси» tab, grabber, safe-area insets, a sticky submit bar above the home indicator; the decimal keyboard pushes the bar up.                    | Lead «Скасувати» / «Згорнути» / «Закрити». Below 360 the lead is a 44 px icon button with the same name: ✕, or ⌄ for «Згорнути» | The receipt tile; the keyboard does not open itself |
| 640–899 (tablet portrait)   | Right side panel, 400 px, **modal**: scrim, focus trap, Esc closes. The list behind is dimmed, not reachable.                                                                                                    | Text lead, title left-aligned and truncated with an ellipsis                                                                    | The receipt tile                                    |
| 900–1023 (tablet landscape) | The same 400 px modal panel, laid over the detail pane: the list column stays visible (dimmed) on its left, so the user keeps their place.                                                                       | Same as 640–899                                                                                                                 | The receipt tile                                    |
| 1024–1439                   | Right side panel, 420 px, modal. Fine pointer: hints «Esc» and «⌘↵», receipt hint «Перетягніть файл сюди або оберіть».                                                                                           | Lead + `Esc` chip                                                                                                               | The amount field                                    |
| ≥ 1440                      | Right side panel, 480 px, **non-modal**: no scrim, no `aria-modal`; the list reflows to the left of the panel and stays usable. Clicking another row while the form is dirty first asks «Вийти без збереження?». | Same as 1024                                                                                                                    | The amount field                                    |

**Pointer, not width, decides the input hints.** Hints that need a keyboard (`Esc`, `⌘↵`, the keys 1–5
in the kind popover) and the drop-zone hint show only under `(pointer: fine)`. The kind picker is a
picker sheet below 640; from 640 it is a listbox popover under the pill, with 56 px rows, a one-line
subtitle and no key hints under `(pointer: coarse)`, and 36 px rows with the keys 1–5 under
`(pointer: fine)`. A tablet with a keyboard and trackpad therefore gets the fine-pointer variant.

**Closed-sheet slots** (foundation money-draft model): the pill sits left of the «+» FAB above the
tab bar on the phone, and bottom-right (24 px inset, 320 × 52, above the content) on tablet and desktop.
Pinned draft rows sit at the top of the list on phone and tablet, and as a 40 px first table row on
desktop. The attention dot sits on the phone FAB, the tablet rail «+», and the desktop header
«Нова транзакція».

The panel width is a container, not a breakpoint inside the form: the form never switches to two
columns.

## Form (field order and behaviour)

1. **Receipt** — segmented «Файл» / «Посилання». The tile «Додати чек» opens the system picker with
   `accept="image/*,application/pdf"` and **no `capture`**, so the phone offers the camera, the photo
   library and Files. Under a fine pointer the tile is also a drop zone. USDT accepts an explorer link
   only («Чек для USDT — лише посилання на транзакцію»). SALARY has no receipt block (attached at pay
   time, unchanged).
2. **Amount** — 44 px tabular figures (34 px on the phone when long), `inputmode="decimal"`, the
   placeholder `0,00`. The NBU rate line for a non-USD / non-USDT currency: «Курс НБУ на 17.11: 1 USD =
   41,20 UAH · ≈ 30,35 USD»; a skeleton while `['exchange-rate', date]` loads.
3. **Currency pill + kind pill** — the currency is locked (lock icon) for a USDT project and for
   DIVIDEND. The kind pill is shown only to roles with more than one kind; SENIOR and DROP get the
   title «Новий дохід» instead.
4. **The kind block** — only the fields the kind requires (see "Field parity"). Two rules worth
   stating here:
   - EXPENSE «Категорія» is a **free-text field** (placeholder «Категорія витрати»), as today. The chips
     under it («Оплата послуги», «Банківський збір», «Інше» — the `EXPENSE_CATEGORY_MESSAGES` labels) are
     44 px suggestions that fill the field; they are not a closed choice.
   - ADMIN_TRANSFER: two stacked cards «надсилає» / «отримує», each a picker trigger with a chevron
     (`aria-haspopup="listbox"`), and a static ↓ between them that does nothing. ACCOUNTANT gets a
     separate 44 px ghost button «Поміняти напрямок» under the cards. ADMIN always sends: the sender card
     is a fixed «Ви · <ім’я>» with no chevron, and there is no swap button.
5. **Defaults row** — «Сьогодні · без проєкту · без опису · змінити». Each item («Сьогодні», «без
   проєкту», a description in «») is a no-wrap unit, so a line breaks only between items, never inside
   one. When EXPENSE is funded by the company account the row names it: «Сьогодні · Рахунок компанії ·
   без опису». «змінити» is a `<button>` with a 44 × 44 px target at every width (the text is smaller,
   the hit area is not). It expands the row in place to «Дата», «Проєкт», «Джерело коштів» (EXPENSE
   only) and «Опис». A kind that requires a project shows the project picker in the kind block instead.
   In a locked state (in flight, unknown outcome) the row is plain text with no «змінити».

**Smart prefill (device-local, no new business data).** The last kind, currency and project used on
this device are remembered in local storage and prefilled on the next open; the date defaults to
today. Nothing is sent to the server for it. A remembered project that the user can no longer see is
dropped silently. The SALARY row action prefills employee, month and kind exactly as today's
`salaryPrefill` does.

## Save behaviour

**Gate: Task 1.1** (an idempotency key on every create) decides which create path a kind takes; the
spec holds either way. Today DIVIDEND, USDT ADMIN_INCOME, SENIOR_INCOME, DROP_INCOME and SALARY are
keyed; EXPENSE, non-USDT ADMIN_INCOME, ADMIN_TRANSFER and the company deposit are keyless. After Task
1.1 every create kind is keyed, EXPENSE included, so the `unknown-resubmit-*` frames (drawn on EXPENSE)
show the post-1.1 state and the `unknown-keyless-*` frames show the same EXPENSE draft before it.

- **Submit is never `disabled` for validity.** A tap on an invalid form moves focus to the first
  invalid field and shows its inline message. A tap while a write is in flight does nothing: the
  primary is `aria-disabled="true"` and announces «Зберігаємо…» (one request per tap).
- **A tap while form data loads** (projects, receivers, the NBU rate: `loading-*`) validates what is
  loaded. A required picker that is still loading counts as empty: focus moves to it and its inline
  line reads «Список ще завантажується». No request leaves until the picker has a value.
- **Armed save.** A save tapped while the receipt uploads (primary «Зберегти після завантаження чека»)
  is queued: «Збережеться −1 250,50 USD після завантаження чека» with «Не зберігати автоматично» to
  cancel the queue. The lead becomes «Згорнути»; collapsing keeps the draft and the upload.

**Outcome classes** (foundation `primitives-v2.md` §5, word for word; every write on this sheet uses
them, create and edit):

| Class    | What the client saw                                                                                                                                                                                       | Was anything written? |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 422      | A validation error on a field                                                                                                                                                                             | No                    |
| Definite | Another 4xx with the app's error envelope; a 500 / 503 with the envelope on an endpoint Wave 1 verified (one DB transaction, post-commit errors swallowed); or the app knew it was offline before sending | No                    |
| Unknown  | A 502 / 504 from the gateway, a Cloudflare 524, a 5xx without the envelope, an enveloped 500 / 503 on an unverified endpoint, a connection dropped after the request left, a client timeout               | Maybe                 |

«Транзакцію не збережено» and «Зміни не збережено» appear only for a definite failure (and the
checked "not saved" result of an unknown edit, below). An unknown outcome never says «не збережено».

**The closed-sheet lifecycle (keyed create).** One model at 375, 768, 1000 and 1440; only the slots
differ (see "Layout per device class"). Amounts carry the sign the list row uses: `−` for EXPENSE,
SALARY, DIVIDEND and PAYOUT, `+` for incomes, no sign for ADMIN_TRANSFER (money moves between admins).

| Step    | When                                          | List                                                                                                                                            | Pill                                                                      | Dot on «+» |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| saving  | Save tapped on a valid form; the sheet closes | Optimistic row in its date group, status «Зберігаємо…» in `--muted-fg` (no opacity), `aria-busy="true"`                                         | «Зберігаємо −1 250,50 USD… · Відкрити», spinner                           | no         |
| saved   | 2xx                                           | The server row replaces the optimistic row in place (no jump)                                                                                   | «Збережено −1 250,50 USD · Відкрити» until tapped or dismissed (✕, swipe) | no         |
| failed  | A definite failure (table above)              | The optimistic row collapses (200 ms). A pinned draft row on top: «−1 250,50 USD · Не збережено · Витрата · 14:32 · Відкрити», destructive tone | «Не збережено −1 250,50 USD · Відкрити»                                   | yes        |
| unknown | An unknown outcome (table above)              | The optimistic row collapses: it is not known to exist. A pinned warning row «−1 250,50 USD · Результат невідомий · Витрата · 14:32 · Відкрити» | «Результат невідомий · −1 250,50 USD · Відкрити», «?» icon in `--primary` | yes        |

The pinned-row subtitle ends with the send time («· 14:32»), so two drafts of the same amount differ.
The foundation row has no time slot; the time rides in the subtitle (open point 14).

**The keyless create** (before Task 1.1). Nothing is shown optimistically: the sheet stays open in
the locked `inflight` state while the request runs, and «Згорнути» turns it into the saving pill with
a pinned «Зберігаємо…» draft row (no list row). Saved and definite failure follow the table above. An
unknown outcome keeps the draft read-only (`unknown-keyless-375`, `unknown-keyless-1440`): the
foundation alert «Невідомо, чи транзакцію збережено» / «Відповідь не надійшла. Форма й чек
залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.», the sent values
as a record under «Надіслано 11 листопада о 14:32 · змінити не можна», **no resend button**, the
filled primary «Перевірити список» and «Видалити чернетку» under it. «Перевірити список» opens the
foundation check sheet «Нові записи» over the kept form (`unknown-check-375`): «Шукаємо: −1 250,50 USD
· Витрата · без опису · надіслано 14:32», «Лише ваші записи з 14:27», the row tags and the two exits
«Є в списку — закрити чернетку» / «Немає — створити ще раз» (gated, foundation §5).

- **No toast** at any step. The pill and the pinned row are the whole signal; a toast would duplicate
  them and time out before it is read. The DROP and DIVIDEND success toasts of today become the saved
  pill. A pill never times out: a result stays until it is tapped or dismissed (foundation §11).
- **«Відкрити»** on a failed or unknown draft reopens the sheet in the matching state:
  - 422 → `error-422`: inline on the field; the draft becomes an ordinary dirty form (pill and pinned row
    clear, lead «Скасувати», closing asks «Вийти без збереження?» and leaving discards the draft);
  - definite, offline before sending → `error-definite`: «Транзакцію не надіслано» / «Немає
    з’єднання…», «Повторити збереження»;
  - definite, an enveloped answer (403, 409, a 4xx, a verified 500 / 503) → the same `error-definite`
    layout with the title «Транзакцію не збережено» and the catalog message for the server's error
    code; «Повторити збереження» stays (nothing was written, so a manual resend is safe), and so does
    «Видалити чернетку»;
  - unknown, keyed → `unknown-resubmit` («Надіслати ще раз», the same key, by hand only);
  - unknown, keyless → `unknown-keyless` («Перевірити список», no resend).

  On a saving draft it reopens `inflight`.

- **The title of a saved row.** The row title is the description; without one, the EXPENSE category;
  without either, the kind label. The sample has no description, so the row reads «Оплата послуги».
- **Nothing retries automatically.** Not a definite failure, not an unknown outcome, not a reconnect.
- **A reload or tab kill while a write is in flight** (`reload-while-saving-375`). The draft lives in
  memory, so it is gone; the foundation page-kill marker `{t, phase}` (no amount) survives in local
  storage. At the next boot «Фінанси» shows the foundation alert for the phase: `armed` → «Транзакцію
  не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.» + «Зрозуміло»;
  `sent` → «Результат збереження транзакції о 14:32 невідомий. Вона могла зберегтися: перевірте нові
  записи, перш ніж створювати її знову.» + «Закрити» / «Оновити список» (the foundation boot check
  sheet). An edit in flight leaves no marker: the server row is the truth, and the list refetches on
  boot.

**«Видалити чернетку» (discard).** Shown only in `error-definite`, `unknown-resubmit` and
`unknown-keyless`, as a ghost destructive button under the primary. Never in 422 (the draft is an
ordinary form again; closing it asks «Вийти без збереження?»), never in flight. A tap opens a confirm:
«Видалити чернетку −1 250,50 USD?» / «Сума, поля й чек зникнуть. Цю дію не можна скасувати.», buttons
«Залишити» (initial focus) and «Видалити» (destructive) (`confirm-discard-*`). For an unknown draft the
description reads «Сума, поля й чек зникнуть із пристрою. Якщо транзакцію вже збережено, вона
залишиться в списку.» (`confirm-discard-unknown-375`). Phone: an action sheet over the sheet; wider: a
420 px dialog.

### Edit lifecycle (admin edit, senior edit, attach / replace receipt)

Edits are not creates: **never optimistic** (today's behaviour), **no idempotency key**, **never
retried automatically**. Their outcome lives on the edited transaction's own row and in the pill;
an edit never makes a pinned draft row and never puts a dot on «+». The row marker is the finance
list's (Task 1.2 §9.2: «Зберігається…», «Результат невідомий»). The pill names the kind and the signed
amount of the edited transaction (the new amount when the edit changed it). Sample: admin edit of an
income, «Дохід +1 250,50 USD» (was 1 200,00).

| Step              | When                             | Sheet                                                                                                                                                                                                                      | Pill (sheet collapsed or closed)                                | Row marker                             |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| saving            | «Зберегти зміни» on a valid form | Stays open, locked: lead «Згорнути», «Зберігаємо… · змінити не можна», primary spinner `aria-disabled` (`admin-edit-saving-*`). «Згорнути» closes it into the pill                                                         | «Зберігаємо зміни… · Дохід +1 250,50 USD»                       | «Зберігається…» (spinner)              |
| saved             | 2xx                              | Closes; focus returns to the row, which shows the new values                                                                                                                                                               | «Зміни збережено · Дохід +1 250,50 USD · Відкрити»              | none                                   |
| failed (definite) | A definite failure               | Stays open with the values: inline alert «Зміни не збережено» + the cause («Нічого не змінено. Дані у формі залишились — спробуйте ще раз.» or the catalog message), primary «Зберегти зміни» (manual) (`edit-failed-375`) | «Зміни не збережено · Дохід +1 250,50 USD · Відкрити»           | «Зміни не збережено» (destructive)     |
| unknown           | An unknown outcome               | Closes (A1-3); the entered values stay in memory under the marker                                                                                                                                                          | «Невідомо, чи збережено зміни · Дохід +1 250,50 USD · Відкрити» | «Результат невідомий» + «Перевіряємо…» |

**Resolving an unknown edit** (M3). The screen refetches that one transaction at once; this is a read,
never a resend. It compares the fields the edit sent:

- **all match → saved** (`edit-unknown-resolved-375`): the marker clears, the pill turns into «Зміни
  збережено · Дохід +1 250,50 USD · Відкрити» (it waits to be dismissed, like every result);
- **none match → not saved**: the marker reads «Зміни не збережено», and «Відкрити» reopens the form
  unlocked with the entered values and the alert «Зміни не збережено» / «Транзакцію перевірено: змін у
  ній немає. Введене залишилось — збережіть ще раз.» The save is manual; for admin edit it is
  unavailable until a fresh cascade preview has loaded;
- **some match, or the row changed since** (A1-2), **or** the refetch or a later save returns 400
  `FINANCE_EDIT_REJECTED_ONLY` / 409 `FINANCE_CASCADE_PREVIEW_STALE` → "check the row": the marker
  reads «Перевірте транзакцію», the pill «Перевірте транзакцію · Дохід +1 250,50 USD · Відкрити», and
  «Відкрити» opens the sheet on the server's current values with the alert «Перевірте транзакцію» /
  «Частину змін могли зберегти, або транзакцію змінили. Звірте значення, перш ніж зберігати ще раз.»;
  never «не збережено»;
- **the refetch fails**: the marker stays «Результат невідомий» with a 44 px «Повторити» (it repeats the
  refetch, not the edit); the pill stays unknown.

| Flow           | Saving                                    | Notes                                                                                                                                                           |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin edit     | Waits, sheet locked (`admin-edit-saving`) | The server recomputes the derivatives (shares, invoice). A save after an unknown always runs a fresh cascade preview first.                                     |
| Senior edit    | Waits, sheet locked                       | `PATCH` of a REJECTED SENIOR_INCOME; a 400 `FINANCE_EDIT_REJECTED_ONLY` is definite when it is the first answer («Редагувати можна лише відхилені транзакції»). |
| Attach receipt | Waits, sheet locked                       | `PATCH /transactions/:id/receipt`; saved pill «Чек прикріплено · Витрата −1 250,50 USD» or «Чек замінено · …» (today's toasts).                                 |

**Cascade block.** When a derivative row cannot be recomputed, the server marks the save as blocked:
alert «Зберегти не можна» / «По відмічених рядках суму не перерахувати — потрібне ручне рішення.»,
the blocked row keeps its old value («120,00 USD — залишиться без змін») with the reason «У заявці на
виплату — суму не змінити» (destructive), and the primary is `aria-disabled` (`admin-edit-blocked`).
The reason line comes from today's `CASCADE_BLOCKED_REASON_OWN_MESSAGES`. A row that will not be
recomputed but does not block (an invoice) reads «… — залишиться без змін» + «Не перерахується
автоматично — потрібна ручна звірка» (warning).

## Closing

| Situation                                                          | Phone                                                      | Panel < 1440                             | Panel ≥ 1440 (non-modal)                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| Clean form                                                         | Drag down, scrim tap or «Скасувати» close                  | Esc, scrim, «Скасувати»                  | Esc, «Скасувати», or a click on another row                     |
| Dirty form (typed, not saved; also 422)                            | Action sheet «Вийти без збереження?»                       | Dialog, 420 px, 44 px buttons below 1024 | Dialog (36 px buttons); on a row click it asks before switching |
| In flight (draft reopened from the saving pill, admin edit saving) | Lead «Згорнути»: closes, no confirm; the saving pill stays | Same                                     | Same                                                            |
| A money draft (armed, failed, unknown outcome)                     | «Згорнути» keeps the draft, no confirm                     | Same                                     | Same                                                            |

Focus returns to the element that opened the sheet (the header button, the row, or the pill). After a
create it moves to the optimistic row.

## Interaction and motion

- Phone sheet: slides up 280 ms `cubic-bezier(0.32, 0.72, 0, 1)`, follows the finger on drag, dismiss
  over 30 % of the height or a fast flick. Panel: slides in from the right 220 ms ease-out, scrim fades
  150 ms.
- The optimistic row fades in 150 ms. A failure collapses it 200 ms, then the pinned row slides in
  and the pill changes; there is no toast.
- The defaults row expands with a 180 ms height transition.
- `prefers-reduced-motion: reduce` replaces every slide and collapse with a 100 ms opacity fade; the
  upload progress bar keeps moving because it carries information.
- Keyboard (fine pointer): `⌘↵` / `Ctrl+↵` submits, `Esc` closes (or asks), the keys 1–5 pick a kind in
  the open kind popover.

## Field parity (no capability removed)

| Today                                                                                                             | In the sheet                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| «Тип операції» select                                                                                             | Kind pill (picker sheet / listbox popover), prefilled with the last kind                                                                        |
| `ProjectSelectSection`                                                                                            | «Проєкт» picker (kind block when required, the defaults row otherwise)                                                                          |
| `AmountCurrencyInput`, USDT lock for a USDT project                                                               | Amount field + currency pill, lock icon on the pill                                                                                             |
| «Дата транзакції», `TxDateField` (edit)                                                                           | «Дата» in the defaults row (create) or a field (admin edit); inline error for a closed month                                                    |
| `ReceiptField` / `ReceiptInput` (file XOR link, USDT link only)                                                   | The receipt block, same XOR and USDT rule; the upload no longer dies with the dialog                                                            |
| NBU rate                                                                                                          | The rate line under the amount                                                                                                                  |
| «Рахунок отримувача» + company balance (ADMIN_INCOME, ADMIN)                                                      | Same picker; picking «Рахунок компанії» shows its balance                                                                                       |
| `ObligationPreviewBanner`                                                                                         | Obligation card under the receiver                                                                                                              |
| ACCOUNTANT receiver toggle                                                                                        | Segmented «Власник проєкту» / «Рахунок компанії»                                                                                                |
| SALARY «Співробітник», «Місяць», `ExistingSalaryParts`                                                            | Same fields + the list «Уже внесено за <місяць>» (manual / automatic parts)                                                                     |
| EXPENSE «Джерело коштів», «Категорія» (free text) + suggestion chips                                              | «Категорія» free-text field + suggestion chips; «Джерело коштів» in the expanded defaults, named in the row                                     |
| ADMIN_TRANSFER direction + ACCOUNTANT swap                                                                        | Stacked picker cards + «Поміняти напрямок» (ACCOUNTANT only); ADMIN's sender fixed                                                              |
| DIVIDEND balance, partner, amount ≤ balance                                                                       | Same, with the limit note under the balance                                                                                                     |
| «Примітки (необов’язково)»                                                                                        | «Опис» in the defaults row (the same `notes` field); «Примітки» in admin edit                                                                   |
| Field-error summary «Заповніть виділені поля»                                                                     | Focus moves to the first invalid field; the summary stays for screen readers (`role="alert"`)                                                   |
| `AdminEditTransactionDialog` fields: amount, currency, date, «Категорія» (EXPENSE), «Місяць» (SALARY), «Примітки» | Exactly that set; no project, receiver or kind picker. Subtitle «<kind> · було <old> <CODE>»; amount lock note and PAID currency lock unchanged |
| `CascadeImpactPanel` (table + `sm:hidden` mobile row)                                                             | One list «Що зміниться» at every width, first row «Ця транзакція»; the blocking message unchanged                                               |
| Non-editable banner                                                                                               | `permission-limited` read-only view                                                                                                             |
| Admin edit toasts (invoice not reissued / diverged)                                                               | Unchanged (they report a server-side follow-up, not the save itself)                                                                            |
| Senior edit: receipt sent only if changed                                                                         | Unchanged                                                                                                                                       |
| DROP toast «Дохід зареєстровано, очікує валідації», DIVIDEND toast                                                | Replaced by the saved pill; the DROP row carries its pending-validation status in the list                                                      |

## Data (what each layout reads)

Every layout reads exactly the same queries; the container is the only difference. No new endpoint,
no new business field, no new KPI.

| Query                                           | Used for                                          | Notes                                                                                   |
| ----------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `['transactions']` (the finance list, Task 1.2) | The optimistic row and its rollback               | The sheet writes into that cache through 1.2's key; this spec does not define its shape |
| `['projects']`                                  | «Проєкт» picker, USDT lock                        | Unchanged                                                                               |
| `['exchange-rate', date]`                       | NBU rate line                                     | Unchanged; only for a non-USD / non-USDT currency                                       |
| The users / admins / partners queries of today  | Receiver, employee, partner, transfer cards       | Unchanged hooks                                                                         |
| `['company-account']`                           | Company balance (ADMIN_INCOME, EXPENSE, DIVIDEND) | Unchanged                                                                               |
| Existing salary parts of today                  | «Уже внесено за <місяць>»                         | Unchanged                                                                               |

**Invalidations after a resolved save (exact keys).** Today `useCreateTransactionMutation`
invalidates `['transactions']` and `['finance-summary']`, plus `['company-account']` for DIVIDEND and
company-funded EXPENSE. The sheet keeps that and adds the creator's dashboard summary:

| Kind                       | Keys invalidated on success                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXPENSE (ordinary)         | `['transactions']`, `['finance-summary']`, role summary                                                                                                         |
| EXPENSE (company-funded)   | `['transactions']`, `['finance-summary']`, `['company-account']`, role summary                                                                                  |
| ADMIN_INCOME               | `['transactions']`, `['finance-summary']`, `['company-account']` (receiver may be the company), role summary                                                    |
| SALARY / SALARY part       | `['transactions']`, `['finance-summary']`, role summary                                                                                                         |
| ADMIN_TRANSFER             | `['transactions']`, `['finance-summary']`, `['company-account']` (partner balances), role summary                                                               |
| DIVIDEND                   | `['transactions']`, `['finance-summary']`, `['company-account']`, `['admin','summary']`                                                                         |
| SENIOR_INCOME, senior edit | `['transactions']`, `['finance-summary']`, `['senior','summary']`                                                                                               |
| DROP_INCOME                | `['transactions']`, `['finance-summary']`, `['drop','summary']`                                                                                                 |
| Admin edit                 | `['transactions']`, `['finance-summary']`, `['transaction', id]`, `['company-account']`, `['invoices']`, `['documents']` (today's set), + `['admin','summary']` |
| Attach receipt             | `['transactions']`, `['transaction', id]` (today's set; no amount changes)                                                                                      |

"Role summary" is the creator's key: `['admin','summary']` or `['accountant','summary']`. The plan's
words map to these keys as: balance → `['company-account']`; partner stats → `['finance-summary']` +
`['company-account']` (`CompanyAndPartnersCard` reads both); dashboard → the role summary key.
`['pending']` is not touched: `/pending` carries no transaction items. Smart prefill is device-local
storage only.

## Components (mapping to our stack)

| Visual block                         | Our component                                                             | New?                                              |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Sheet / side panel                   | `ResponsiveSheet` (foundation)                                            | no                                                |
| Receipt tile, upload row, link input | `ReceiptInput` restyled to the foundation money form                      | no (restyle)                                      |
| Amount, currency pill                | Foundation money-form amount + pill                                       | no                                                |
| Kind pill + picker / listbox         | Pill + `ResponsiveSheet` picker (phone) / Radix `Popover` listbox (≥ 640) | **yes, foundation** — open point 7                |
| Category field + suggestion chips    | Foundation input + chips                                                  | no                                                |
| Segmented controls                   | Foundation segmented control                                              | no                                                |
| Defaults row                         | Foundation money-form defaults row (item-wise wrap, 44 px «змінити»)      | no (rule added)                                   |
| Transfer cards                       | Two picker-trigger cards + ghost button, screen-local                     | yes, screen-local                                 |
| «Що зміниться» list                  | Foundation grouped list rows, screen-local content                        | yes, screen-local                                 |
| Read-only list                       | `<dl>` of label / value rows in a foundation group                        | no                                                |
| Info / warning / error cards         | Foundation `Alert` variants                                               | no                                                |
| Dirty-close and discard confirms     | Foundation action sheet (phone) / `CrmDialog` confirm (wide)              | no                                                |
| Pill, pinned draft row, dot          | Foundation money-draft model                                              | no (signed amounts: change request, open point 8) |

## Token-map

Foundation tokens only, no new token: `--popover` (sheet and panel surface), `--card` / `--raised`
(cards, upload row), `--border` / `--separator` / `--input-border`, `--fg` / `--muted-fg` /
`--placeholder` (text, `0,00`, the optimistic row status, the lock line), `--primary` / `--primary-fg`
(submit, «змінити», the unknown pill's «?» icon), `--yellow-subtle` (armed bar), `--warning`
(non-editable banner, «Не перерахується автоматично», the unknown pinned row), `--destructive` (422, failed pill and pinned
row, the dot, «Видалити», «Вийти без збереження»), `--positive` (saved pill icon), `--info` (salary
receipt note), `--scrim`, radii `--r-sheet` / `--r-lg` / `--r-md`.

## A11y (WCAG 2.2 AA)

- Every interactive target is ≥ 44 × 44 px on touch: chips, pills, the icon lead below 360, the
  transfer cards and «Поміняти напрямок», «змінити» in the defaults row (a 44 px hit area around smaller
  text), the confirm buttons below 1024. Inputs use 16 px text so iOS does not zoom.
- The sheet is `role="dialog"` with `aria-labelledby` the title; `aria-modal="true"` and a focus trap
  below 1440 only. The non-modal panel keeps the page reachable and returns focus on close.
- Every field has a visible `<label>`; errors are linked with `aria-describedby` and `aria-invalid`.
  The first invalid field receives focus on submit. The EXPENSE category chips are buttons that fill
  the labelled text field; the field, not the chip group, is the form control.
- The upload progress bar is `role="progressbar"` with `aria-valuenow`, **not** a live region (no
  chatter). Lifecycle changes are announced once by the pill (`role="status"`): «Транзакцію
  збережено», «Транзакцію не збережено», «Невідомо, чи збережено транзакцію». The definite and
  unknown-outcome alerts inside a reopened draft use `role="alert"`.
- The optimistic row is `aria-busy="true"` and readable at full contrast: its status is `--muted-fg`
  text, never a dimmed row.
- The dot on «+» is decorative; the button's name carries it: «Нова транзакція, 1 чернетка потребує
  уваги» («Створити, …» on the tablet rail).
- Submit in flight uses `aria-disabled="true"` (stays focusable and announced), never `disabled`. The
  locked form sets `aria-readonly` on its controls and shows the lock line as plain text.
- Confirms are `role="alertdialog"`; initial focus is on the safe button («Продовжити редагування»,
  «Залишити»).
- The read-only view (`permission-limited`) is a `<dl>`: each label is a `<dt>`, each value a `<dd>`; no
  chevrons, nothing that looks pressable.
- Colour is never the only signal: errors carry an icon and text; the locked currency carries a lock
  icon and an accessible name «USDT, змінити не можна»; failed and unknown pinned rows carry their state
  in words.
- Contrast: body text on `--popover` ≥ 4.5:1; the `0,00` placeholder is a placeholder, not content.

## Strings (uk / en)

New or changed strings only; unchanged strings keep their current catalog entries. `{amount}` is the
signed, locale-formatted amount with its code (`−1 250,50 USD` in uk, `−1,250.50 USD` in en).

| Key idea                     | uk                                                                                          | en                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Create title                 | Нова транзакція                                                                             | New transaction                                                                          |
| Single-kind title            | Новий дохід                                                                                 | New income                                                                               |
| Salary part title            | Частина зарплати                                                                            | Salary part                                                                              |
| Admin edit title             | Редагування                                                                                 | Edit transaction                                                                         |
| Admin edit subtitle          | {kind} · було {amount}                                                                      | {kind} · was {amount}                                                                    |
| Senior edit title            | Виправити дохід                                                                             | Fix income                                                                               |
| Receipt tile                 | Додати чек                                                                                  | Add receipt                                                                              |
| Receipt hint, touch          | Камера, фото або файл · до 10 МБ                                                            | Camera, photo or file · up to 10 MB                                                      |
| Receipt hint, fine pointer   | Перетягніть файл сюди або оберіть · до 10 МБ                                                | Drop a file here or choose one · up to 10 MB                                             |
| Category placeholder         | Категорія витрати                                                                           | Expense category                                                                         |
| Defaults row                 | Сьогодні · без проєкту · без опису · змінити                                                | Today · no project · no description · change                                             |
| Defaults row, company source | Рахунок компанії                                                                            | Company account                                                                          |
| Description field            | Опис                                                                                        | Description                                                                              |
| Save while uploading         | Зберегти після завантаження чека                                                            | Save once the receipt uploads                                                            |
| Armed save                   | Збережеться {amount} після завантаження чека                                                | {amount} will save once the receipt uploads                                              |
| Cancel armed save            | Не зберігати автоматично                                                                    | Don’t save automatically                                                                 |
| Collapse                     | Згорнути                                                                                    | Minimise                                                                                 |
| Optimistic row status        | Зберігаємо…                                                                                 | Saving…                                                                                  |
| Lock line                    | Зберігаємо… · змінити не можна                                                              | Saving… · can’t be changed                                                               |
| Pill, saving                 | Зберігаємо {amount}…                                                                        | Saving {amount}…                                                                         |
| Pill, saved                  | Збережено {amount}                                                                          | {amount} saved                                                                           |
| Pill, failed                 | Не збережено {amount}                                                                       | {amount} not saved                                                                       |
| Pill, unknown                | Результат невідомий · {amount}                                                              | Outcome unknown · {amount}                                                               |
| Pill / pinned row action     | Відкрити                                                                                    | Open                                                                                     |
| Pinned row, failed           | Не збережено · {kind}                                                                       | Not saved · {kind}                                                                       |
| Pinned row, unknown          | Результат невідомий · {kind}                                                                | Outcome unknown · {kind}                                                                 |
| «+» with a draft (SR)        | {label}, 1 чернетка потребує уваги                                                          | {label}, 1 draft needs attention                                                         |
| Not sent                     | Транзакцію не надіслано                                                                     | Transaction not sent                                                                     |
| Server refused (403/409/5xx) | Транзакцію не збережено                                                                     | Transaction not saved                                                                    |
| Manual retry                 | Повторити збереження                                                                        | Try saving again                                                                         |
| Unknown outcome title        | Невідомо, чи збережено транзакцію                                                           | Not sure the transaction was saved                                                       |
| Unknown outcome body         | Відповідь не надійшла. Надішліть ще раз: якщо транзакцію вже збережено, друга не з’явиться. | No response came back. Send it again: if it was already saved, no duplicate will appear. |
| Unknown outcome action       | Надіслати ще раз                                                                            | Send again                                                                               |
| Discard draft                | Видалити чернетку                                                                           | Delete draft                                                                             |
| Discard confirm title        | Видалити чернетку {amount}?                                                                 | Delete the {amount} draft?                                                               |
| Discard confirm body         | Сума, поля й чек зникнуть. Цю дію не можна скасувати.                                       | The amount, fields and receipt will be gone. This can’t be undone.                       |
| Discard confirm, unknown     | Якщо транзакцію вже збережено, вона залишиться в списку.                                    | If it was already saved, it stays in the list.                                           |
| Discard confirm actions      | Залишити / Видалити                                                                         | Keep / Delete                                                                            |
| Dirty close                  | Вийти без збереження?                                                                       | Leave without saving?                                                                    |
| Dirty close body             | Сума {amount} і чек не збережуться.                                                         | The {amount} and the receipt won’t be saved.                                             |
| Dirty close actions          | Продовжити редагування / Вийти без збереження                                               | Keep editing / Leave without saving                                                      |
| Non-editable banner          | Транзакцію не можна редагувати: це виплата або вона прив’язана до заявки на виплату.        | This transaction can’t be edited: it is a payout or is linked to a payout request.       |
| Cascade list                 | Що зміниться                                                                                | What will change                                                                         |
| Cascade first row            | Ця транзакція · {kind}                                                                      | This transaction · {kind}                                                                |
| Cascade row unchanged        | {amount} — залишиться без змін                                                              | {amount} — stays as is                                                                   |
| Cascade row note             | Не перерахується автоматично — потрібна ручна звірка                                        | Won’t be recalculated automatically — needs a manual check                               |
| Cascade blocked title        | Зберегти не можна                                                                           | Can’t save                                                                               |
| Cascade blocked body         | По відмічених рядках суму не перерахувати — потрібне ручне рішення.                         | The marked rows can’t be recalculated — they need a manual decision.                     |
| Edit primary                 | Зберегти зміни                                                                              | Save changes                                                                             |
| Senior resubmit banner       | Дохід відхилено. Після збереження він знову піде на перевірку.                              | Income rejected. Once saved, it goes back for review.                                    |
| Senior resubmit primary      | Зберегти й надіслати                                                                        | Save and resubmit                                                                        |
| Salary receipt note          | Чек для зарплати додається під час виплати.                                                 | The salary receipt is added at payout.                                                   |
| Existing parts               | Уже внесено за {month}                                                                      | Already entered for {month}                                                              |
| Transfer sender, ADMIN       | Ви · {name}                                                                                 | You · {name}                                                                             |
| Transfer swap                | Поміняти напрямок                                                                           | Swap direction                                                                           |
| DROP hint                    | Дохід перевірить адміністратор                                                              | An admin will review this income                                                         |
| Locked currency (SR)         | {currency}, змінити не можна                                                                | {currency}, can’t be changed                                                             |

Removed from the previous revision: the rollback toast title / body and «Зберігаємо… змінити не
можна» (the keyless banner). The en column is written for meaning, not translated word by word;
copy-reviewer gives the per-language verdict.

## For the coder

- Build from this file and the PNGs; the HTML under `assets/src/` is a rendering tool, not code to copy.
- Do not start before Task 1.1 has merged: every create needs its idempotency key.
- Mount one layout: `ResponsiveSheet` decides the container by width; the form component is shared.
  Input hints and the kind-picker row style follow `(pointer: fine)` / `(pointer: coarse)`, not width.
- Submit in flight: `aria-disabled="true"` and exactly one request per tap (the plan's test asserts
  both).
- Never add an automatic retry, a retry timer or a retry-on-reconnect.
- The closed-sheet lifecycle uses the foundation money-draft store (pill, pinned row, dot); no toast.
- Admin edit waits for the server; every other write closes the sheet at once.
- The receipt upload must outlive the sheet (draft-scoped, not dialog-scoped).
- Invalidate the exact keys in "Data"; do not add `['pending']`.

## Rendering notes

- `design-gate: degraded`: no Claude Design export; HTML prototypes built only from the
  `_foundation/assets/src` helpers and rendered by Playwright (`assets/src/render.mjs [filter]`).
- PNGs are quantised to a 256-colour palette (ImageMagick, or sharp through `SHARP_MODULE` as the
  fallback). The font is a locally installed Inter; the web-font links are stripped so a render needs
  no network. `render.mjs` never deletes a PNG; remove a renamed frame by hand.
- `default-320` (1010 px) and `long-content-320` (1180 px) are drawn on a taller canvas than the 568 px
  device so the whole scrolled sheet is in one image; the other 320 frames are the device height.
- In the mockup tool the fine-pointer variant is chosen by width (1024 and up); the product chooses it
  by `(pointer: fine)` as specified above. The 768 frames show the coarse variant.
- The 900–1023 landscape layout is specified, not rendered: it is the 768 panel over a wider list.
- The rendered HTML is regenerated by `render.mjs` and not committed (the foundation precedent).
- The foundation `tablet()` / `desktop()` frames hard-code the ADMIN role; `transaction-sheet.mjs`
  patches a temporary copy to pass the role (`withRole`). The foundation files are untouched.
- The table behind the 1440 panel is the foundation sample list, not filtered by role.

## Self-score (`docs/design/rubric-calibration.md`)

Criterion 8 (data viz) does not apply and is dropped; the weights are renormalised over 93. Task 1.1
is a prerequisite, so every create is optimistic; admin edit is the one write that waits, with a
non-blocking state («Згорнути» turns it into a pill), which is the 9.5 anchor of criterion 2.

Council round 1 gave phone 8.9 / 8.8 / 9.1, tablet 8.8 / 8.6 / 8.8, desktop 9.1 / 8.9 / 9.2. My round 0
self-score (9.3 / 9.2 / 9.5) ran 0.3–0.6 above the council, so the numbers below are an upper bound,
not a forecast.

| Criterion (weight)  | < 640   | 640–1023 | ≥ 1024  |
| ------------------- | ------- | -------- | ------- |
| 1 Time-to-task (15) | 9       | 9        | 9.5     |
| 2 Never blocks (15) | 9.5     | 9.5      | 9.5     |
| 3 Navigation (10)   | 9       | 9        | 9.5     |
| 4 Forms (10)        | 9.5     | 9.5      | 9.5     |
| 5 Lists (10)        | 9       | 9        | 9.5     |
| 6 Sheets (8)        | 9.5     | 9        | 9       |
| 7 States (10)       | 9.5     | 9.5      | 9.5     |
| 9 Platform (8)      | 9       | 9        | 9.5     |
| 10 A11y (7)         | 9       | 9        | 9       |
| **Weighted**        | **9.2** | **9.2**  | **9.4** |

Weighted exactly: phone 858.5 / 93 = 9.23; tablet 854.5 / 93 = 9.19; desktop 876 / 93 = 9.42.

**Weakest criterion per class.**

- **Phone — 10 A11y (9).** The 320 icon lead relies on its accessible name alone, and the pill above
  the tab bar must not cover the last list row (the list needs bottom padding equal to the pill; the
  mockups show it but no frame proves it at the end of a long list).
- **Tablet — 9 Platform fit (9), with 6 Sheets (9).** The 400 px modal panel still dims the list it
  opened from in portrait, and the 900–1023 landscape layout is specified but not rendered. This is
  the class closest to the 9.0 gate; if the council marks it down again, the next step is a non-modal
  panel at 900–1023.
- **Desktop — 6 Sheets (9).** Between 1024 and 1439 the 420 px panel is modal and hides the list; only
  ≥ 1440 is non-modal.

## Open points

1. **Task 1.1 is a hard prerequisite.** Every create needs an idempotency key before 1.3 ships; the
   keyless waiting branch is deleted from this spec. _Keyless contingency, recorded so it is not
   re-invented:_ if 1.3 ever has to ship first, the keyless kinds (EXPENSE, non-USDT ADMIN_INCOME,
   ADMIN_TRANSFER) still close optimistically, but their unknown-outcome draft gets **no «Надіслати ще
   раз»** (a resend without a key can create a duplicate); it offers «Перевірити список» (close onto the
   list so the user sees whether the row exists) and «Видалити чернетку». Rejected: keeping a keyless
   waiting sheet — it blocks the main flow (criterion 2 drops to 8).
2. **SALARY has no receipt at create.** Kept as today (the receipt is attached at payout).
   Recommendation: keep; the info line explains it.
3. **Quick add (Task 0.12).** The FAB / «+» entry should open this same sheet. Recommendation: point
   0.12 at this spec instead of a separate quick-add form.
4. **Pay / settle / payout dialogs** are out of scope (they are not create/edit). Recommendation: a
   separate screen task that reuses the receipt block.
5. **Other entry points** (DROP cabinet, the dashboard «В роботі» panel) open the same sheet with the
   same role rules. Recommendation: no separate mockups; verify them in User Testing.
6. **Prefill source.** Device-local storage loses the prefill across devices. Recommendation: keep it
   local (no new business data); revisit only if users ask.
7. **Missing foundation primitive: the kind pill + picker** (picker sheet below 640, listbox popover
   from 640 with coarse / fine rows). Recommendation: the orchestrator adds it to the foundation
   primitives when 1.3 is approved. The transfer cards and «Що зміниться» stay screen-local.
8. **Foundation change requests** (each is a change to `_foundation/`, which this task does not edit):
   1. Sheet header at 320: `.sheethead` reserves 96 px per side and truncates a 15-character title.
      Adopt a 44 px icon lead below 360 (✕ for «Скасувати» / «Закрити», ⌄ for «Згорнути») with the
      text as its accessible name.
   2. Signed amounts in the money pill and the pinned draft row (`−1 250,50 USD`), matching the list row.
   3. Armed copy «після чека» → «після завантаження чека».
   4. Unknown-outcome title word order: «Невідомо, чи транзакцію збережено» → «Невідомо, чи збережено
      транзакцію».
   5. For a create, the optimistic list row replaces the foundation's in-flight pinned draft row; the
      saving pill stays.
   6. Defaults row: each item is a no-wrap unit, and «змінити» is a 44 × 44 px button.
   7. `tablet()` / `desktop()` take a `role` parameter, so the mockup tool can drop the `withRole`
      patch (it reads the foundation frame's source text and throws if it changes).
9. **The 1440 table behind the panel** is the foundation sample, not role-filtered, and the finance
   list itself is Task 1.2's design. Recommendation: reconcile once 1.2 is approved.
10. **The plan's invalidation names are not query keys.** The plan says "balance", "partner stats" and
    "dashboard"; the real keys and the mapping are in "Data". Recommendation: the plan's Task 1.3 text
    cites the keys.
11. **900–1023 is not rendered.** Recommendation: manual-qa checks it on a landscape tablet during User
    Testing; render it if the council asks.

## Council round 1

| Item | Verdict | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | done    | One closed-sheet lifecycle (saving → saved / failed / unknown) in "Save behaviour" and the States table; 12 frames `optimistic-row` / `saved` / `rollback` / `unknown-closed` at 375 / 768 / 1440. Failed: pill + pinned draft row + dot, no toast. Unknown: pinned warning row + warning pill.                                                                                                                                                                                                       |
| B    | done    | Lead «Згорнути» in flight; an in-flight row in "Closing"; mockup and spec share the muted lock line «Зберігаємо… · змінити не можна». Keyless contingency without «Надіслати ще раз» in open point 1. Edit flows: attach receipt and senior edit optimistic, admin edit waits.                                                                                                                                                                                                                        |
| C    | done    | «Видалити чернетку» opens a confirm (`confirm-discard-375/1440`), is hidden in 422 and in flight; label, confirm copy and placement in "Save behaviour".                                                                                                                                                                                                                                                                                                                                              |
| D    | done    | Admin edit field set = `AdminEditTransactionDialog` (no project / receiver picker); subtitle «Дохід · було 1 200,00 USD»; «Що зміниться» starts with «Ця транзакція», every value `<amount> <CODE>`; new `admin-edit-blocked` and `admin-edit-saving` frames.                                                                                                                                                                                                                                         |
| E    | done    | Tablet: 400 px modal panel at 640–1023 (over the detail pane from 900), pointer-based kind picker, 44 px dirty-close dialog, pill / pinned-row slots; a 640–1023 column in States; 768 frames for kind-picker, error-422, dirty-close, optimistic-row, rollback, unknown-closed, admin-edit-cascade (plus default and saved).                                                                                                                                                                         |
| F    | done    | `default-320` full length; new `long-content-320`, `error-definite-320`, `armed-320`; the defaults row wraps by item and «змінити» keeps a 44 px target.                                                                                                                                                                                                                                                                                                                                              |
| G    | done    | Category free text with chip suggestions; «Зберегти після завантаження чека»; `unknown-resubmit` read-only defaults; transfer cards as stacked pickers with chevrons, a static arrow, a labelled 44 px «Поміняти напрямок», `transfer-admin-375/1440`; `permission-limited` as a `<dl>`; optimistic status in `--muted-fg`; saved-row title rule; «Рахунок компанії» in the defaults row; exact query keys; the copy fixes; open point 7 narrowed; foundation change requests listed in open point 8. |

One deviation inside G: the transfer arrow is ↓ between **stacked** cards, not → between side-by-side
cards, because side-by-side cards truncated the names at 375. Rejected items: none.
