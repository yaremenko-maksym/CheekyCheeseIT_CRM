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

## Layout per device class

One layout is mounted at a time. The **form body is identical** in every class; only the container,
the header hints and the initial focus change. There is no `sm:hidden` / `hidden sm:block` pair
anywhere in the sheet (today's `CascadeImpactPanel` mobile row is replaced by one list, see below).

| Class         | Container                                                                                                                                                                                                        | Header                                                                    | Initial focus                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| < 640 (phone) | `ResponsiveSheet` bottom sheet at full height over the role's «Фінанси» tab, grabber, safe-area insets, a sticky submit bar above the home indicator; the decimal keyboard pushes the bar up.                    | Lead «Скасувати» (an icon button with the same accessible name below 360) | The receipt tile; the keyboard does not open itself |
| 640–1023      | Right side panel, 400 px, modal: scrim, focus trap, Esc closes.                                                                                                                                                  | Lead «Скасувати», title left-aligned and truncated with an ellipsis       | The receipt tile                                    |
| 1024–1439     | Right side panel, 420 px, modal. Fine pointer: hints «Esc» and «⌘↵», receipt hint «Перетягніть файл сюди або оберіть».                                                                                           | Lead «Скасувати» + `Esc` chip                                             | The amount field                                    |
| ≥ 1440        | Right side panel, 480 px, **non-modal**: no scrim, no `aria-modal`; the list reflows to the left of the panel and stays usable. Clicking another row while the form is dirty first asks «Вийти без збереження?». | Same as 1024                                                              | The amount field                                    |

Hints that need a keyboard (`Esc`, `⌘↵`, the keys 1–5 in the kind popover) show only under
`(pointer: fine)`. The panel width is a container, not a breakpoint inside the form: the form never
switches to two columns.

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
4. **The kind block** — only the fields the kind requires (see "Field parity").
5. **Defaults row** — «Сьогодні · без проєкту · без опису · змінити». «змінити» expands it in place to
   «Дата», «Проєкт», «Джерело коштів» (EXPENSE only) and «Опис». A kind that requires a project shows the
   project picker in the kind block instead.

**Smart prefill (device-local, no new business data).** The last kind, currency and project used on
this device are remembered in local storage and prefilled on the next open; the date defaults to
today. Nothing is sent to the server for it. A remembered project that the user can no longer see is
dropped silently. The SALARY row action prefills employee, month and kind exactly as today's
`salaryPrefill` does.

## Save behaviour

- **Submit is never `disabled` for validity.** A tap on an invalid form moves focus to the first
  invalid field and shows its inline message. While a write is in flight the button carries
  `aria-disabled="true"`, a 16 px spinner, and further taps are ignored: one request per tap.
- **Keyed kinds (all kinds once Task 1.1 ships):** the sheet closes at once, the list inserts an
  optimistic row «Зберігаємо…» (`aria-busy="true"`), and the phone shows the pill «Зберігаємо
  1 250,50 USD…». Success replaces the row with the server row. Failure removes the row, shows the
  persistent toast «Не збережено 1 250,50 USD» with «Відкрити», and pins the draft.
- **Keyless kinds until Task 1.1** (EXPENSE, non-USDT ADMIN_INCOME, ADMIN_TRANSFER): no optimistic row.
  The sheet stays open with the banner «Зберігаємо… змінити не можна» (`inflight` frame) and waits for
  the server, because a resubmit without a key could create a duplicate.
- **Armed save:** a save tapped while the receipt uploads is queued: «Збережеться 1 250,50 USD після
  чека» with «Не зберігати автоматично» to cancel the queue. The sheet can be collapsed («Згорнути»);
  the draft and the upload continue.
- **Errors.** 422: inline on the field, values kept, no retry button. Not sent: «Транзакцію не
  надіслано» + «Повторити збереження». Unknown outcome: the form is locked, «Надіслати ще раз» resends
  with the **same** idempotency key, «Видалити чернетку» discards.
- **Nothing retries automatically.** Not a definite failure, not an unknown outcome, not a reconnect.
- **Edit flows** (admin edit, senior edit, attach receipt) wait for the server with the same inline
  pending state; they do not insert optimistic rows, because a cascade may change other rows.
- **Cascade block:** when a derivative row cannot be recomputed and the server marks the save as
  blocked, today's message stays: «Зберегти не можна — по відмічених рядках суму не перерахувати,
  потрібне ручне рішення», and the primary is `aria-disabled`. The mockup shows the non-blocking case
  (an invoice that will not be reissued automatically).

## Closing

| Situation                                      | Phone                                     | Panel < 1440            | Panel ≥ 1440 (non-modal)                                |
| ---------------------------------------------- | ----------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Clean form                                     | Drag down, scrim tap or «Скасувати» close | Esc, scrim, «Скасувати» | Esc, «Скасувати», or a click on another row             |
| Dirty form (typed, not saved)                  | Action sheet «Вийти без збереження?»      | Confirm dialog, 420 px  | Confirm dialog; on a row click it asks before switching |
| A money draft (armed, failed, unknown outcome) | «Згорнути» keeps the draft, no confirm    | Same                    | Same                                                    |

Focus returns to the element that opened the sheet (the header button or the row). After a keyed save
it moves to the optimistic row.

## Interaction and motion

- Phone sheet: slides up 280 ms `cubic-bezier(0.32, 0.72, 0, 1)`, follows the finger on drag, dismiss
  over 30 % of the height or a fast flick. Panel: slides in from the right 220 ms ease-out, scrim fades
  150 ms.
- The optimistic row fades in 150 ms; a rollback collapses the row 200 ms, then the toast appears.
- The defaults row expands with a 180 ms height transition.
- `prefers-reduced-motion: reduce` replaces every slide and collapse with a 100 ms opacity fade; the
  upload progress bar keeps moving because it carries information.
- Keyboard (fine pointer): `⌘↵` / `Ctrl+↵` submits, `Esc` closes (or asks), the keys 1–5 pick a kind in
  the open kind popover.

## Field parity (no capability removed)

| Today                                                              | In the sheet                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| «Тип операції» select                                              | Kind pill (picker sheet / listbox popover), prefilled with the last kind                        |
| `ProjectSelectSection`                                             | «Проєкт» picker (kind block when required, the defaults row otherwise)                          |
| `AmountCurrencyInput`, USDT lock for a USDT project                | Amount field + currency pill, lock icon on the pill                                             |
| «Дата транзакції», `TxDateField` (edit)                            | «Дата» in the defaults row; inline error for a closed month                                     |
| `ReceiptField` / `ReceiptInput` (file XOR link, USDT link only)    | The receipt block, same XOR and USDT rule; the upload no longer dies with the dialog            |
| NBU rate                                                           | The rate line under the amount                                                                  |
| «Рахунок отримувача» + company balance (ADMIN_INCOME, ADMIN)       | Same picker; picking «Рахунок компанії» shows its balance                                       |
| `ObligationPreviewBanner`                                          | Obligation card under the receiver                                                              |
| ACCOUNTANT receiver toggle                                         | Segmented «Власник проєкту» / «Рахунок компанії»                                                |
| SALARY «Співробітник», «Місяць», `ExistingSalaryParts`             | Same fields + the list «Уже внесено за <місяць>» (manual / automatic parts)                     |
| EXPENSE «Джерело коштів», «Категорія» + suggestion chips           | Category chips (`EXPENSE_CATEGORY_MESSAGES` labels) + «Джерело коштів» in the expanded defaults |
| ADMIN_TRANSFER direction + ACCOUNTANT swap                         | «надсилає → отримує» cards + «Поміняти напрямок» (ACCOUNTANT only)                              |
| DIVIDEND balance, partner, amount ≤ balance                        | Same, with the limit note under the balance                                                     |
| «Примітки (необов’язково)»                                         | «Опис» in the defaults row (the same `notes` field)                                             |
| Field-error summary «Заповніть виділені поля»                      | Focus moves to the first invalid field; the summary stays for screen readers (`role="alert"`)   |
| Admin edit: subtitle, amount lock note, PAID currency lock         | Same, in the edit variant of the sheet                                                          |
| `CascadeImpactPanel` (table + `sm:hidden` mobile row)              | One list «Що зміниться» at every width; the blocking message unchanged                          |
| Non-editable banner                                                | `permission-limited` read-only view                                                             |
| Admin edit toasts (invoice not reissued / diverged)                | Unchanged                                                                                       |
| Senior edit: receipt sent only if changed                          | Unchanged                                                                                       |
| DROP toast «Дохід зареєстровано, очікує валідації», DIVIDEND toast | Unchanged (shown when the optimistic row resolves)                                              |

## Data (what each layout reads)

Every layout reads exactly the same queries; the container is the only difference. No new endpoint,
no new business field, no new KPI.

| Query                                          | Used for                                          | Notes                                                                                   |
| ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The finance list query (owned by Task 1.2)     | The optimistic row and its rollback               | The sheet writes into that cache through 1.2's key; this spec does not define its shape |
| `['projects']`                                 | «Проєкт» picker, USDT lock                        | Unchanged                                                                               |
| `['exchange-rate', date]`                      | NBU rate line                                     | Unchanged; only for a non-USD / non-USDT currency                                       |
| The users / admins / partners queries of today | Receiver, employee, partner, transfer cards       | Unchanged hooks                                                                         |
| `['company-account']`                          | Company balance (ADMIN_INCOME, EXPENSE, DIVIDEND) | Unchanged                                                                               |
| Existing salary parts of today                 | «Уже внесено за <місяць>»                         | Unchanged                                                                               |

Invalidations after a resolved save are today's set, unchanged: `['transactions']`,
`['finance-summary']`, plus `['company-account']` for DIVIDEND and company-funded expenses. Smart prefill
is device-local storage only.

## Components (mapping to our stack)

| Visual block                         | Our component                                                     | New?                             |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------- |
| Sheet / side panel                   | `ResponsiveSheet` (foundation)                                    | no                               |
| Receipt tile, upload row, link input | `ReceiptInput` restyled to the foundation money form              | no (restyle)                     |
| Amount, currency pill                | Foundation money-form amount + pill                               | no                               |
| Kind pill + picker / listbox         | Pill + `ResponsiveSheet` picker (phone) / Radix `Popover` listbox | **yes** — open point 7           |
| Category chips, segmented controls   | Foundation chips / segmented control                              | no                               |
| Defaults row                         | Foundation money-form defaults row                                | no                               |
| Transfer cards «надсилає → отримує»  | Two cards + swap icon button                                      | **yes** — open point 7           |
| «Що зміниться» list                  | Foundation grouped list rows                                      | **yes** (content) — open point 7 |
| Info / warning / error cards         | Foundation `Alert` variants                                       | no                               |
| Dirty-close confirm                  | Foundation action sheet (phone) / `CrmDialog` confirm (wide)      | no                               |
| Error toast with action              | Foundation toast with action                                      | no                               |

## Token-map

Foundation tokens only, no new token: `--popover` (sheet and panel surface), `--card` / `--raised`
(cards, upload row), `--border` / `--separator` / `--input-border`, `--fg` / `--muted-fg` /
`--placeholder` (text, `0,00`), `--primary` / `--primary-fg` (submit, «змінити»), `--yellow-subtle`
(armed bar, optimistic row tint), `--warning` (non-editable banner, «Не перерахується автоматично»),
`--destructive` (422, rollback toast, «Вийти без збереження»), `--info` (salary receipt note), `--scrim`,
radii `--r-sheet` / `--r-lg` / `--r-md`.

## A11y (WCAG 2.2 AA)

- Every interactive target is ≥ 44 × 44 px on touch (chips, pills, the icon lead below 360, the swap
  button); inputs use 16 px text so iOS does not zoom.
- The sheet is `role="dialog"` with `aria-labelledby` the title; `aria-modal="true"` and a focus trap
  below 1440 only. The non-modal panel keeps the page reachable and returns focus on close.
- Every field has a visible `<label>`; errors are linked with `aria-describedby` and `aria-invalid`.
  The first invalid field receives focus on submit.
- The upload progress bar is `role="progressbar"` with `aria-valuenow`, **not** a live region (no
  chatter). Status changes that matter are announced once: the optimistic pill and the rollback toast
  via `role="status"`; the definite and unknown-outcome alerts via `role="alert"`.
- Submit in flight uses `aria-disabled="true"` (stays focusable and announced), never `disabled`.
- Colour is never the only signal: errors carry an icon and text; the locked currency carries a lock
  icon and an accessible name «USDT, змінити не можна».
- Contrast: body text on `--popover` ≥ 4.5:1; the `0,00` placeholder is a placeholder, not content.

## Strings (uk / en)

New or changed strings only; unchanged strings keep their current catalog entries.

| Key idea                   | uk                                                                                   | en                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Create title               | Нова транзакція                                                                      | New transaction                                                                    |
| Single-kind title          | Новий дохід                                                                          | New income                                                                         |
| Salary part title          | Частина зарплати                                                                     | Salary part                                                                        |
| Admin edit title           | Редагування                                                                          | Edit transaction                                                                   |
| Senior edit title          | Виправити дохід                                                                      | Fix income                                                                         |
| Receipt tile               | Додати чек                                                                           | Add receipt                                                                        |
| Receipt hint, touch        | Камера, фото або файл · до 10 МБ                                                     | Camera, photo or file · up to 10 MB                                                |
| Receipt hint, fine pointer | Перетягніть файл сюди або оберіть · до 10 МБ                                         | Drop a file here or choose one · up to 10 MB                                       |
| Defaults row               | Сьогодні · без проєкту · без опису · змінити                                         | Today · no project · no description · change                                       |
| Description field          | Опис                                                                                 | Description                                                                        |
| Armed save                 | Збережеться {amount} після чека                                                      | Saves {amount} once the receipt is up                                              |
| Cancel armed save          | Не зберігати автоматично                                                             | Don’t save automatically                                                           |
| Collapse                   | Згорнути                                                                             | Minimise                                                                           |
| Optimistic row             | Зберігаємо…                                                                          | Saving…                                                                            |
| Optimistic pill            | Зберігаємо {amount}…                                                                 | Saving {amount}…                                                                   |
| Keyless in flight          | Зберігаємо… змінити не можна                                                         | Saving… editing is locked                                                          |
| Rollback toast title       | Не збережено {amount}                                                                | {amount} not saved                                                                 |
| Rollback toast body        | Рядок прибрано зі списку. Сума й чек у чернетці.                                     | The row was removed. The amount and receipt are in the draft.                      |
| Rollback action            | Відкрити                                                                             | Open                                                                               |
| Not sent                   | Транзакцію не надіслано                                                              | Transaction not sent                                                               |
| Manual retry               | Повторити збереження                                                                 | Try saving again                                                                   |
| Unknown outcome action     | Надіслати ще раз                                                                     | Send again                                                                         |
| Unknown outcome hint       | Якщо транзакцію вже збережено, друга не з’явиться.                                   | If it was already saved, no duplicate will appear.                                 |
| Discard draft              | Видалити чернетку                                                                    | Delete draft                                                                       |
| Dirty close                | Вийти без збереження?                                                                | Leave without saving?                                                              |
| Dirty close actions        | Продовжити редагування / Вийти без збереження                                        | Keep editing / Leave without saving                                                |
| Read-only                  | Лише перегляд                                                                        | View only                                                                          |
| Non-editable banner        | Транзакцію не можна редагувати: це виплата або вона прив’язана до заявки на виплату. | This transaction can’t be edited: it is a payout or is linked to a payout request. |
| Cascade list               | Що зміниться                                                                         | What will change                                                                   |
| Cascade row note           | Не перерахується автоматично                                                         | Won’t be recalculated automatically                                                |
| Edit primary               | Зберегти зміни                                                                       | Save changes                                                                       |
| Senior resubmit banner     | Дохід відхилено. Після збереження він знову піде на перевірку.                       | Income rejected. Once saved, it goes back for review.                              |
| Senior resubmit primary    | Зберегти й надіслати                                                                 | Save and resubmit                                                                  |
| Salary receipt note        | Чек для зарплати додається під час виплати.                                          | The salary receipt is added at payout.                                             |
| Existing parts             | Уже внесено за {month}                                                               | Already entered for {month}                                                        |
| Transfer swap              | Поміняти напрямок                                                                    | Swap direction                                                                     |
| DROP hint                  | Дохід піде на валідацію адміністратору                                               | The income goes to an admin for validation                                         |
| Locked currency (SR)       | {currency}, змінити не можна                                                         | {currency}, can’t be changed                                                       |

`{amount}` is formatted by the locale (`1 250,50 USD` in uk, `1,250.50 USD` in en). The en column is
written for meaning, not translated word by word; copy-reviewer gives the per-language verdict.

## For the coder

- Build from this file and the PNGs; the HTML under `assets/src/` is a rendering tool, not code to copy.
- Mount one layout: `ResponsiveSheet` decides the container by width; the form component is shared.
- Submit in flight: `aria-disabled="true"` and exactly one request per tap (the plan's test asserts
  both).
- Never add an automatic retry, a retry timer or a retry-on-reconnect.
- Keyless kinds keep the waiting flow until Task 1.1 adds keys; then switch them to the optimistic flow.
- The receipt upload must outlive the sheet (draft-scoped, not dialog-scoped).

## Rendering notes

- `design-gate: degraded`: no Claude Design export; HTML prototypes built only from the
  `_foundation/assets/src` helpers and rendered by Playwright (`assets/src/render.mjs`).
- PNGs are quantised to a 256-colour palette (ImageMagick, or sharp as the fallback). The font is a
  locally installed Inter; the web-font links are stripped so a render needs no network.
- The rendered HTML is regenerated by `render.mjs` and not committed (the foundation precedent).
- The foundation `tablet()` / `desktop()` frames hard-code the ADMIN role; `transaction-sheet.mjs`
  patches a temporary copy to pass the role (`withRole`). The foundation files are untouched.
- The table behind the 1440 panel is the foundation sample list, not filtered by role.

## Self-score (`docs/design/rubric-calibration.md`)

Criterion 8 (data viz) does not apply and is dropped; the weights are renormalised over 93. Scores
assume Task 1.1 has shipped (keys on every create), which the plan orders before 1.3.

| Criterion (weight)  | < 640   | 640–1023 | ≥ 1024  |
| ------------------- | ------- | -------- | ------- |
| 1 Time-to-task (15) | 9       | 9        | 9.5     |
| 2 Never blocks (15) | 10      | 10       | 10      |
| 3 Navigation (10)   | 9       | 9        | 9.5     |
| 4 Forms (10)        | 9.5     | 9.5      | 9.5     |
| 5 Lists (10)        | 9       | 9        | 9.5     |
| 6 Sheets (8)        | 9.5     | 9        | 9       |
| 7 States (10)       | 9.5     | 9.5      | 9.5     |
| 9 Platform (8)      | 9       | 8.5      | 9.5     |
| 10 A11y (7)         | 9       | 9        | 9       |
| **Weighted**        | **9.3** | **9.2**  | **9.5** |

**Weakest criterion: 2 (Never blocks), conditionally.** If 1.3 ships before Task 1.1, the keyless
kinds keep the waiting flow, criterion 2 drops to 8 and the scores fall to 8.99 (phone) and 8.90
(tablet), under the 9.0 gate; desktop stays above it at 9.18. Unconditionally weakest: criterion 9 on tablets (8.5) — a coarse-pointer tablet gets no
drag-and-drop hint and no keyboard hints, and the 400 px modal panel hides the list it opened from.

## Open points

1. **Task 1.1 dependency.** EXPENSE, non-USDT ADMIN_INCOME and ADMIN_TRANSFER are keyless today, so
   they cannot get the optimistic flow or a safe resubmit. Recommendation: ship 1.1 first; until then
   keep the waiting flow for those kinds as specified.
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
7. **Missing primitives:** the kind pill + picker, the transfer cards and the «Що зміниться» list are
   not in `_foundation`. Recommendation: the orchestrator adds them to the foundation primitives when
   1.3 is approved.
8. **Foundation sheet header at 320.** `.sheethead` reserves 96 px per side, which truncates a
   15-character title at 320; this mockup overrides it locally with an icon lead. Recommendation: adopt
   the icon lead below 360 in the foundation sheet.
9. **The 1440 table behind the panel** is the foundation sample, not role-filtered, and the finance
   list itself is Task 1.2's design. Recommendation: reconcile once 1.2 is approved.
10. **`withRole` patch** in the mockup tool depends on the foundation frame's source text and throws if
    it changes. Recommendation: the foundation `tablet()` / `desktop()` take a `role` parameter.
