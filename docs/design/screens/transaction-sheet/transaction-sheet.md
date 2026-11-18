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
  a field's own value, an "old → new" pair, a cascade row's value, a salary part and an amount
  quoted inside a rejection reason are unsigned on purpose. → Strings.
- **M12** A locked (sent) draft is a record: sent values at full contrast, an absolute date and the send
  time, no «змінити». → `inflight-*`, `unknown-resubmit-*`, `unknown-keyless-*`; open point 20 and
  request 8.11.
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
- **A1-4** The permission-limited fixture is a PAYOUT row in the glossary's direction (M20): a senior
  pays the company, «Сеньйор 1 → CheekyCheeseIT», so the banner's payout reason is literally true. The
  `+` sign is the designer's reading (money into the company); the code shows the direction, not a sign.
- **A1-5** Round 1 wording the council did not flag is kept (senior edit «Виправити дохід» /
  «Зберегти й надіслати», admin edit «Редагування» / «Зберегти зміни»). Attach takes today's pair
  «Прикріпити чек» / «Замінити чек» with the primaries «Прикріпити» / «Замінити», because M6 needs the
  replace wording and round 1's «Додати чек» had no replace form.
- **A1-6** The 422 frames use a real catalog error, `FINANCE_TX_DATE_IN_FUTURE` («Для виконаної
  операції дата не може бути в майбутньому»), on a date of 14 листопада 2026. The foundation's
  «Жовтень уже закрито…» text is marked invented in `primitives-v2.md`, so it is not copied (open point
  15). → `error-422-*`.
- **A1-7** `edit-failed-375` is the senior edit, definite failure (offline before send): the sheet stays
  open with the values and the primary «Зберегти й надіслати». Admin edit's definite failure is
  `admin-edit-error-*`. → "Edit lifecycle".
- **A1-8** The blocked admin edit names a next step and offers it as one tap: «Повернути +1 200,00
  USD» puts the old amount back, so the other changes can be saved. Today's dialog has no such
  action; the wording is new (open point 16). → `admin-edit-blocked-*`.
- **A1-9** An unavailable save (blocked, stale or loading preview) is a flat `--secondary` fill with
  `--muted-fg` text (about 5:1), not a dimmed primary. The foundation has no `--muted` surface token.
  → `admin-edit-blocked-*`, `admin-edit-stale-*`, `admin-edit-preview-*`.

Master decisions for council round 3 (M15–M30). M1–M14 stay in force.

- **M15** The pinned draft row and its pill always carry the send time «· 14:32», visibly and in the
  accessible name («…, надіслано о 14:32»). Drawn on the amount line of the pinned row and in the
  pill's second line, because the foundation status line is truncated and full at 375. Open point 14
  closes; the accessible-name half is foundation request 8.8. → "Save behaviour", `rollback-*`,
  `unknown-closed-*`, `keyless-saving-375`.
- **M16** The in-flight primary reads «Зберігаємо…» on every class and in every write kind (create,
  admin edit, senior edit, attach). → `inflight-*`, `admin-edit-saving-*`, Strings.
- **M17** The lifecycle sections ("Save behaviour", "Edit lifecycle") are the only source for what a
  write does after submit; "For the coder" points to them and restates nothing. → "For the coder".
- **M18** Target size follows the pointer, not the width: confirm-dialog buttons are 44 px under
  `(pointer: coarse)` on every width and 36 px under `(pointer: fine)`. The foundation already says so
  (`foundation.md`, "Density follows the pointer, not the width" and "Coarse-pointer hit areas
  (binding)"); no change request. The mockup tool draws the pointer by width (1024 and up = fine) as a
  stand-in. → "Layout per device class", `dirty-close-*`, `confirm-discard-*`.
- **M19** A dirty form, an upload in flight and a write in flight each hold the service-worker reload
  through the plan's Task 0.6 guard; no `beforeunload` prompt. A user-initiated reload keeps M9.
  → "Closing", "Data".
- **M20** A `PAYOUT` row is a senior paying the company (`CONTEXT.md`); money given to a person is a
  settlement and is not drawn here. → `permission-limited-*`, A1-4.
- **M21** Tablet: `admin-edit-cascade`, `admin-edit-date-reason`, `transfer-admin`,
  `admin-income-accountant`, `dividend`, `senior-edit-rejected` and `long-content` are drawn at 768.
  Every 640–1023 cell that stays a rule names the frame that proves it; loading, permission-limited,
  attach and replace stay rules. The panel is 400 / 420 / 480 px (`primitives-v2.md` §2, Side panel).
  → States, "Layout per device class".
- **M22** «Опис» (and admin edit «Примітки») is a multi-line field that grows with its content up to 6
  lines, then scrolls inside itself. The dividend subtitle is «Дивіденд адміністратору з рахунку
  компанії» and wraps. → "Form", `long-content-*`, `kind-picker-768`.
- **M23** EXPENSE has no «Проєкт» (`createExpenseSchema`): not in the defaults row, the expanded row,
  the record, the saved row or "Field parity". "An expense attributed to a project" is open point 19
  (the owner's, not drawn).
- **M24** Closed-sheet outcome states are drawn: edit saving, edit failed, edit «Перевірте
  транзакцію», refetch failed with «Повторити», keyless create saving. One sentence ranks the edit pill
  against the draft pills (request 8.9). → States, "Edit lifecycle", A11y, `edit-*-closed-375`,
  `edit-check-375`, `edit-refetch-failed-375`, `keyless-saving-375`.
- **M25** The check «Нові записи» is the shell-v2 dialog from 640: "A centred 560 px dialog «Нові
  записи» over the side panel; the panel stays mounted and keeps the draft" (`shell-v2.md` §4).
  → `unknown-check-768`, `unknown-check-1440`.
- **M26** At ≥ 1440 the list beside the non-modal panel reflows: «Проєкт» goes first (the foundation
  table shows it only from a 1280 px window, `desktop.mjs`, and the list beside a 480 px panel at 1440
  is narrower than the list of a 1024 window), then the title truncates; «Сума», the amount and the
  code are never clipped (`primitives-v2.md` §10: titles truncate, amounts never truncate). Open point 9
  closes. → every 1440 open-panel frame.
- **M27** «Причина зміни дати» appears once the day differs from the stored one, with the 31-day hint;
  it is required past the 31-day window (`FINANCE_TX_DATE_EDIT_REASON_REQUIRED`); a locked row never
  shows it (`FINANCE_TX_DATE_LOCKED_ROW`). Source: `TxDateField.tsx` and its test. → "Admin edit, the
  other preview and date states".
- **M28** The page-kill marker extends to edits: the transaction id and the send time, never an amount
  or a field value. After boot the row carries «Перевірте транзакцію» until a refetch settles it; the
  entered values are lost. → "Edit lifecycle".
- **M29** The obligation preview reads «буде створено частку {amount}» / "a share of {amount} will be
  created"; the glossary's `_Avoid_` term is gone from the spec and the mockups. → `admin-income-usdt-*`,
  Strings.
- **M30** One fixture world: project «Альфа», category «Оплата послуги», no date after 11.11 (except the
  14.11 that is the 422 error itself), and no empty required field in an armed, saving, failed or
  confirm frame of a valid draft. Mockup profile cards show a role label, never a personal name.

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

Mockups: `assets/transaction-sheet/<state>-<width>.png` (127 frames). The sample role is ADMIN and the
sample kind EXPENSE unless the row says otherwise. Widths: 320 and 375 (phone), 768 (tablet portrait,
the 640–899 layout), 1000 (tablet landscape, the 900–1023 layout), 1024 and 1440 (desktop). A cell that
names a **rule** instead of a frame names the two frames that prove it: the frame that draws the body,
and the frame that draws the container of that class (for the tablet, the 400 px panel of
`default-768`; for 1024–1439, the 420 px panel of `default-1024`; for ≥ 1440, the 480 px panel of
`default-1440`). Nothing else differs (M21).

| State                               | < 640                                                                            | 640–1023                                                                                                                            | ≥ 1024                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default (empty form)                | `default-320` (full length), `default-375`                                       | `default-768`, `default-1000` (the panel over the detail pane, list column dimmed on the left)                                      | `default-1024`, `default-1440`                                                            | Receipt tile first, amount placeholder `0,00`, currency + kind pills, «Категорія» text field with suggestion chips, defaults row. Submit enabled: a tap on an invalid form focuses the first invalid field.                                                                                                                                                                                                                                                                                                                        |
| loading (form data)                 | `loading-375`                                                                    | rule: the `loading-1440` body in the 400 px panel of `default-768`; 44 px targets                                                   | `loading-1440`                                                                            | Projects, receivers or the NBU rate are loading: skeletons in the pickers and the rate line; amount and receipt stay usable. A tap on the primary validates what is loaded: a required picker still loading counts as empty, takes focus and reads «Список ще завантажується»; no request leaves (R2-17).                                                                                                                                                                                                                          |
| long content                        | `long-content-320` (full), `long-content-375`, `long-content-collapsed-375`      | `long-content-768`                                                                                                                  | `long-content-1440`                                                                       | UAH `1 234 567,89` fits (34 px on the phone), the NBU rate line, a long description: «Опис» grows with its text up to 6 lines on every class, then scrolls inside the field (M22); `long-content-1440` shows the whole text. Collapsed: the defaults row wraps between items, never inside one, and «змінити» stays a 44 × 44 px target.                                                                                                                                                                                           |
| receipt uploading                   | `receipt-uploading-375`                                                          | rule: the `receipt-uploading-1440` body in the 400 px panel of `default-768`; no drop-zone hint (coarse pointer)                    | `receipt-uploading-1440`                                                                  | Upload row with a progress bar; the percent is never truncated; the rest of the form stays editable. Primary «Зберегти після завантаження чека»: a tap arms the save.                                                                                                                                                                                                                                                                                                                                                              |
| armed save                          | `armed-320`, `armed-375`                                                         | `armed-768`                                                                                                                         | `armed-1440`                                                                              | «Збережеться −1 250,50 USD після завантаження чека» + «Не зберігати автоматично». Lead «Згорнути»; the save fires when the upload ends.                                                                                                                                                                                                                                                                                                                                                                                            |
| in flight                           | `inflight-375`                                                                   | `inflight-768`                                                                                                                      | `inflight-1440`                                                                           | Reached two ways: a keyless create or an edit waits here with the sheet open after submit (lead «Згорнути» closes it into its pill); a keyed create closes at once and its saving draft reopens here from the pill. The sent values as a record under «Надіслано 11 листопада о 14:32 · змінити не можна» (full contrast, no inputs, M12); primary «Зберігаємо…» with a spinner and `aria-disabled="true"` (M16). No «Видалити чернетку».                                                                                          |
| saving, keyed (sheet closed)        | `optimistic-row-375`                                                             | `optimistic-row-768`                                                                                                                | `optimistic-row-1440`                                                                     | Optimistic row in its date group, status «Зберігаємо…» in `--muted-fg` (no opacity, `aria-busy="true"`), pill «Зберігаємо −1 250,50 USD… · Відкрити».                                                                                                                                                                                                                                                                                                                                                                              |
| saving, keyless (sheet closed)      | `keyless-saving-375`                                                             | rule: the pill and pinned-row slots of `rollback-768`                                                                               | rule: the slots of `rollback-1440` (the pinned first table row)                           | Until Task 1.1 merges, after «Згорнути» from `inflight`: pill «Зберігаємо −1 250,50 USD…» / «Витрата · 14:32 · Відкрити»; a pinned row «−1 250,50 USD · 14:32» / «Зберігаємо… · Витрата» + «Відкрити»; no row in the list until the server answers, no dot on «+» (M24).                                                                                                                                                                                                                                                           |
| saved                               | `saved-375`                                                                      | `saved-768`                                                                                                                         | `saved-1440`                                                                              | The server row replaces the optimistic one in place; pill «Збережено −1 250,50 USD · Відкрити».                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| failed (sheet closed)               | `rollback-375`                                                                   | `rollback-768`                                                                                                                      | `rollback-1440`                                                                           | The optimistic row is removed. Pill «Не збережено −1 250,50 USD» / «Витрата · 14:32 · Відкрити»; a pinned draft row «−1 250,50 USD · 14:32» / «Не збережено · Витрата» + «Відкрити» on top of the list (desktop: the first table row); a dot on «+». The send time is in each accessible name («…, надіслано о 14:32», M15). No toast.                                                                                                                                                                                             |
| unknown outcome (sheet closed)      | `unknown-closed-375`, `unknown-closed-long-375`                                  | `unknown-closed-768`                                                                                                                | `unknown-closed-1440`                                                                     | Pill «Результат невідомий» / «−1 250,50 USD · 14:32 · Відкрити» (the foundation «?» icon in `--primary`), a pinned warning row «−1 250,50 USD · 14:32» / «Результат невідомий · Витрата», a dot on «+». The optimistic row is removed: it is not known to exist. `unknown-closed-long-375`: the list scrolled to its end; the last row clears the pill and «+».                                                                                                                                                                    |
| error 422 (validation)              | `error-422-375`                                                                  | `error-422-768`                                                                                                                     | `error-422-1440`                                                                          | The draft reopened: the catalog message `FINANCE_TX_DATE_IN_FUTURE` inline on «Дата» (14 листопада 2026): «Для виконаної операції дата не може бути в майбутньому» (A1-6). Values kept, no retry button, **no «Видалити чернетку»**. The draft is an ordinary dirty form again: pill and pinned row clear, lead «Скасувати», closing asks «Вийти без збереження?».                                                                                                                                                                 |
| error, not sent (definite)          | `error-definite-320` (full), `error-definite-375`, `error-definite-keyboard-375` | `error-definite-768`                                                                                                                | `error-definite-1440`                                                                     | The request never left (offline): alert «Транзакцію не надіслано» / «Немає з’єднання…» + «Повторити збереження» (manual) + «Видалити чернетку». With the keyboard up the alert stays above it, the primary stays reachable and «Видалити чернетку» is hidden until the keyboard closes (R3-05). An enveloped definite answer uses this layout with «Транзакцію не збережено» and the catalog message.                                                                                                                              |
| confirm discard                     | `confirm-discard-375`, `confirm-discard-unknown-375`                             | `confirm-discard-768` (420 px dialog)                                                                                               | `confirm-discard-1440`                                                                    | «Видалити чернетку −1 250,50 USD?» / «Сума, поля й чек зникнуть. Цю дію не можна скасувати.» / «Залишити» (initial focus) + «Видалити» (destructive). Unknown draft: «Сума, поля й чек зникнуть із пристрою. Якщо транзакцію вже збережено, вона залишиться в списку.» Phone: action sheet over the sheet. Wider: buttons 44 px under a coarse pointer, 36 px under a fine one (M18, "Layout per device class").                                                                                                                   |
| unknown outcome, keyed              | `unknown-resubmit-375`                                                           | `unknown-resubmit-768`                                                                                                              | `unknown-resubmit-1440`                                                                   | Foundation alert «Невідомо, чи транзакцію збережено» / «Відповідь не надійшла. Надішліть ще раз: якщо транзакцію вже збережено, друга не з’явиться.»; the sent values as a locked record (M12). «Надіслати ще раз» resubmits with the same key; «Видалити чернетку». Never automatic.                                                                                                                                                                                                                                              |
| unknown outcome, keyless            | `unknown-keyless-375`                                                            | rule: the `unknown-keyless-1440` body in the 400 px panel of `default-768`; 44 px buttons                                           | `unknown-keyless-1440`                                                                    | Until Task 1.1 merges. Alert «Невідомо, чи транзакцію збережено» / «Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.»; the locked record; **no resend**; primary «Перевірити список» + «Видалити чернетку».                                                                                                                                                                                                                                                   |
| check (keyless)                     | `unknown-check-375`                                                              | `unknown-check-768`                                                                                                                 | `unknown-check-1440`                                                                      | Phone: the foundation check sheet «Нові записи» over the kept form. Tablet and desktop: the shell-v2 dialog, "a centred 560 px dialog «Нові записи» over the side panel; the panel stays mounted and keeps the draft" (`shell-v2.md` §4) (M25). «Шукаємо: −1 250,50 USD · Витрата · без опису · надіслано 14:32», «Лише ваші записи з 14:27», rows tagged «нова» / «раніше», exits «Є в списку — закрити чернетку» / «Немає — створити ще раз» (gated, foundation §5).                                                             |
| reload while saving                 | `reload-while-saving-375`                                                        | `reload-while-saving-768`                                                                                                           | `reload-while-saving-1440`                                                                | The page-kill marker (phase `sent`) survived a reload: «Результат збереження транзакції о 14:32 невідомий. Вона могла зберегтися: перевірте нові записи, перш ніж створювати її знову.» + «Закрити» / «Оновити список». No draft form behind it. Phone: above the list; tablet: above «Сьогодні»; desktop: above the filters.                                                                                                                                                                                                      |
| permission-limited                  | `permission-limited-375`                                                         | rule: the `permission-limited-1440` body in the 400 px panel of `default-768`                                                       | `permission-limited-1440`                                                                 | A payout (a senior paying the company, M20: «Виплата · сеньйор → компанія», «Від» «Сеньйор 1», «Кому» «CheekyCheeseIT»), or a transaction tied to a payout request: the warning banner («Це рядок виплати — сума підтверджена виконаним переказом, вона не редагується, виправляйте сторнувальною транзакцією» for a payout, «Транзакцію не можна редагувати: вона прив’язана до заявки на виплату.» for a tied row, e.g. a paid salary), then a read-only label / value list (no chevrons, no inputs), lead «Закрити», no footer. |
| dirty close                         | `dirty-close-375`                                                                | `dirty-close-768`                                                                                                                   | `dirty-close-1440`                                                                        | Phone: action sheet. Wider: a 420 px dialog; buttons 44 px under a coarse pointer, 36 px under a fine one (M18). «Вийти без збереження?» / «Продовжити редагування» (initial focus) + «Вийти без збереження».                                                                                                                                                                                                                                                                                                                      |
| kind picker                         | `kind-picker-375`                                                                | `kind-picker-768`                                                                                                                   | `kind-picker-1440`                                                                        | Phone: a picker sheet. ≥ 640: a listbox popover anchored under the kind pill; coarse pointer = 56 px rows with a subtitle and no keys (`kind-picker-768`), fine pointer = 36 px rows with the keys 1–5 (`kind-picker-1440`).                                                                                                                                                                                                                                                                                                       |
| ADMIN_INCOME, USDT                  | `admin-income-usdt-375`                                                          | rule: the `admin-income-usdt-1440` body in the 400 px panel of `admin-income-accountant-768`                                        | `admin-income-usdt-1440`                                                                  | Explorer link only, USDT locked, «Рахунок отримувача», the obligation preview «буде створено частку …» (M29).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ADMIN_INCOME, ACCOUNTANT            | `admin-income-accountant-375`                                                    | `admin-income-accountant-768`                                                                                                       | `admin-income-accountant-1440`                                                            | Segmented control «Власник проєкту» / «Рахунок компанії».                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| EXPENSE, company funded             | `expense-company-top-375`, `expense-company-375`                                 | rule: the `expense-company-1440` body in the 400 px panel of `default-768`                                                          | `expense-company-1440`                                                                    | ACCOUNTANT, USDT link, the currency pill locked to USDT, a category chip picked. `expense-company-top-375`: the top of the sheet (amount, locked USDT pill); `expense-company-375`: scrolled to the expanded defaults, «Джерело коштів» = «Рахунок компанії» with the company balance hint on one line.                                                                                                                                                                                                                            |
| SALARY part                         | `salary-part-375`                                                                | rule: the `salary-part-1440` body in the 400 px panel of `default-768`                                                              | `salary-part-1440`                                                                        | Prefilled from a SALARY row: «Співробітник», «Місяць», «Уже внесено за листопад», info «Чек для зарплати додається під час виплати.» No receipt block.                                                                                                                                                                                                                                                                                                                                                                             |
| ADMIN_TRANSFER, ACCOUNTANT          | `transfer-375`                                                                   | `transfer-768`                                                                                                                      | `transfer-1440`                                                                           | Two stacked picker cards «надсилає» / «отримує» with chevrons, a static ↓ between them, a separate 44 px button «Поміняти напрямок».                                                                                                                                                                                                                                                                                                                                                                                               |
| ADMIN_TRANSFER, ADMIN               | `transfer-admin-375`                                                             | `transfer-admin-768`                                                                                                                | `transfer-admin-1440`                                                                     | The sender is fixed «Ви · Адміністратор 1» (no chevron); only «отримує» picks; no swap button.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DIVIDEND                            | `dividend-375`                                                                   | `dividend-768`                                                                                                                      | `dividend-1440`                                                                           | USDT locked, explorer link, «Отримувач (партнер)», the company balance with the limit note.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SENIOR_INCOME                       | `senior-income-375`                                                              | rule: the `senior-income-1440` body in the 400 px panel of `senior-edit-rejected-768` (the SENIOR shell)                            | `senior-income-1440`                                                                      | SENIOR: no kind pill, title «Новий дохід», project, receipt uploading.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DROP_INCOME                         | `drop-income-375`                                                                | rule: the `drop-income-1440` body in the 400 px panel of `default-768`                                                              | `drop-income-1440`                                                                        | DROP: title «Новий дохід», USDT link, hint «Дохід очікуватиме валідації».                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| admin edit + cascade                | `admin-edit-cascade-375`                                                         | `admin-edit-cascade-768`                                                                                                            | `admin-edit-cascade-1440`                                                                 | Title «Редагування», subtitle «Дохід · було +1 200,00 USD», amount + currency, «Що зміниться» (first row «Ця транзакція»), «Дата транзакції», «Примітки». No project or receiver picker. Primary «Зберегти зміни».                                                                                                                                                                                                                                                                                                                 |
| admin edit, date changed            | `admin-edit-date-reason-375`                                                     | `admin-edit-date-reason-768`                                                                                                        | `admin-edit-date-reason-1440`                                                             | «Причина зміни дати» appears as soon as the day differs from the stored one (today's `TxDateField`), with the placeholder «Для дат давніших за 31 день». It is required only when the new date is older than the 31-day window (`BACKDATE_LIMIT_DAYS`; the server refuses with `FINANCE_TX_DATE_EDIT_REASON_REQUIRED`) (M27). The frame moves the date to 2 жовтня 2026, past the window; the field is focused.                                                                                                                    |
| admin edit, reason missing          | `admin-edit-reason-error-375`                                                    | rule: `admin-edit-date-reason-768` with the field in the error state of `admin-edit-reason-error-375`                               | rule: `admin-edit-date-reason-1440` with the same error state                             | The server's `FINANCE_TX_DATE_EDIT_REASON_REQUIRED`: the field focused with «Дата надто далеко в минулому — вкажіть причину в полі «Причина зміни дати»».                                                                                                                                                                                                                                                                                                                                                                          |
| admin edit, preview loading         | `admin-edit-preview-loading-375`                                                 | rule: the skeletons of `admin-edit-preview-loading-375` in the «Що зміниться» block of `admin-edit-cascade-768`                     | rule: the same, in the block of `admin-edit-cascade-1440`                                 | `role="status"` «Перераховуємо пов’язані виплати…» + row skeletons; the primary is `aria-disabled` and `aria-describedby` that status.                                                                                                                                                                                                                                                                                                                                                                                             |
| admin edit, preview failed          | `admin-edit-preview-error-375`                                                   | rule: the alert of `admin-edit-preview-error-375` in place of the «Що зміниться» rows of `admin-edit-cascade-768`                   | rule: the same, in `admin-edit-cascade-1440`                                              | Alert «Перегляд недоступний — спробуйте ще раз» + «Повторити»; the primary is `aria-disabled` and points at the alert.                                                                                                                                                                                                                                                                                                                                                                                                             |
| admin edit, preview stale           | `admin-edit-stale-375`                                                           | rule: the `admin-edit-stale-1440` body in the 400 px panel of `admin-edit-cascade-768`                                              | `admin-edit-stale-1440`                                                                   | 409 `FINANCE_CASCADE_PREVIEW_STALE`: the catalog alert + «Оновити перегляд»; the primary is `aria-disabled` until a fresh preview loads.                                                                                                                                                                                                                                                                                                                                                                                           |
| admin edit, blocked                 | `admin-edit-blocked-375`                                                         | `admin-edit-blocked-768`                                                                                                            | `admin-edit-blocked-1440`                                                                 | Alert «Зберегти не можна» / «По відмічених рядках суму не перерахувати — потрібне ручне рішення. Поверніть попередню суму, щоб зберегти інші зміни, або спершу вирішіть заявку на виплату.» + «Повернути +1 200,00 USD» (A1-8); the blocked row «120,00 USD — залишиться без змін» + «У заявці на виплату — суму не змінити»; primary `aria-disabled`.                                                                                                                                                                             |
| admin edit, saving                  | `admin-edit-saving-375`                                                          | `admin-edit-saving-768`                                                                                                             | `admin-edit-saving-1440`                                                                  | Admin edit waits for the server with the sheet open: lead «Згорнути», the sent values as a locked record, primary «Зберігаємо…» with a spinner, `aria-disabled` (M16).                                                                                                                                                                                                                                                                                                                                                             |
| admin edit, not saved (definite)    | `admin-edit-error-375`                                                           | rule: the `admin-edit-error-1440` body in the 400 px panel of `admin-edit-cascade-768`                                              | `admin-edit-error-1440`                                                                   | Alert «Зміни не збережено» / «Нічого не змінено. Дані у формі залишились — спробуйте ще раз.»; the form stays editable with the values; «Зберегти зміни» is manual.                                                                                                                                                                                                                                                                                                                                                                |
| edit, unknown (sheet closed)        | `edit-unknown-375`                                                               | `edit-unknown-768`, `edit-unknown-1000`                                                                                             | `edit-unknown-1440`                                                                       | The edited row carries «Результат невідомий · Перевіряємо…» (`aria-busy`); pill «Невідомо, чи збережено зміни» / «Дохід +1 250,50 USD · Відкрити». No pinned draft row, no dot on «+».                                                                                                                                                                                                                                                                                                                                             |
| edit, unknown resolved as saved     | `edit-unknown-resolved-320`, `edit-unknown-resolved-375`                         | rule: the marker and pill slots of `edit-unknown-768`                                                                               | rule: the slots of `edit-unknown-1440`                                                    | The refetch matched every sent field: the marker clears, the row shows +1 250,50; pill «Зміни збережено» / «Дохід +1 250,50 USD · Відкрити» (below 360 px the second line is «+1 250,50 USD»), kept until dismissed.                                                                                                                                                                                                                                                                                                               |
| edit, saving (sheet closed)         | `edit-saving-closed-375`                                                         | rule: the marker and pill slots of `edit-unknown-768`                                                                               | rule: the slots of `edit-unknown-1440`                                                    | After «Згорнути» from `admin-edit-saving`: the row marker «Зберігаємо зміни…» (`aria-busy`), the amount still the server's +1 200,00; pill «Зберігаємо зміни…» / «Дохід +1 250,50 USD · Відкрити» (M24).                                                                                                                                                                                                                                                                                                                           |
| edit, failed (sheet closed)         | `edit-failed-closed-375`                                                         | rule: the slots of `edit-unknown-768`                                                                                               | rule: the slots of `edit-unknown-1440`                                                    | A definite failure after the sheet closed: the row marker «Зміни не збережено»; pill «Зміни не збережено» / «Дохід +1 250,50 USD · Відкрити»; a tap reopens the edit with the values and the alert of `admin-edit-error`. No pinned draft row, no dot (M24).                                                                                                                                                                                                                                                                       |
| edit, check the row (sheet closed)  | `edit-check-375`                                                                 | rule: the slots of `edit-unknown-768`                                                                                               | rule: the slots of `edit-unknown-1440`                                                    | The refetch settled but the row does not match every sent field: the marker «Перевірте транзакцію»; pill «Перевірте транзакцію» / «Дохід +1 250,50 USD · Відкрити»; a tap opens the row as the server has it (M24).                                                                                                                                                                                                                                                                                                                |
| edit, refetch failed (sheet closed) | `edit-refetch-failed-375`                                                        | rule: the slots of `edit-unknown-768`                                                                                               | rule: the slots of `edit-unknown-1440`                                                    | The refetch itself failed: the marker «Перевірте транзакцію»; pill «Не вдалося перевірити» / «Дохід +1 250,50 USD» with a separate 44 px «Повторити» on its second row; the pill body opens the row (M24).                                                                                                                                                                                                                                                                                                                         |
| senior edit (rejected)              | `senior-edit-rejected-375`                                                       | `senior-edit-rejected-768`                                                                                                          | `senior-edit-rejected-1440`                                                               | Title «Виправити дохід». Banner «Дохід відхилено. Після збереження він знову піде на валідацію.» + «Причина відмови: у чеку інша сума — 2 040,00 USD.»; the project as text; amount, receipt, «Примітки»; primary «Зберегти й надіслати».                                                                                                                                                                                                                                                                                          |
| senior edit, not saved              | `edit-failed-375`                                                                | rule: the alert of `edit-failed-375` over the `senior-edit-rejected-768` body                                                       | rule: the same over `senior-edit-rejected-1440`                                           | Offline before send (A1-7): alert «Зміни не збережено» / «Немає з’єднання. Нічого не змінено, дані у формі залишились.»; values kept; manual save.                                                                                                                                                                                                                                                                                                                                                                                 |
| attach receipt                      | `attach-receipt-375`                                                             | rule: the `attach-receipt-1440` body in the 400 px panel of `default-768`                                                           | `attach-receipt-1440`                                                                     | Title «Прикріпити чек». A summary card «+2 400,00 USD · Дохід · Проєкт «Альфа» · 9 листопада», the receipt (uploading), no project field; primary «Прикріпити після завантаження чека».                                                                                                                                                                                                                                                                                                                                            |
| replace receipt                     | `attach-replace-375`, `attach-replace-confirm-375`                               | rule: the `attach-replace-375` body in the 400 px panel of `default-768`; the confirm is the 420 px dialog of `confirm-discard-768` | rule: the same body in the panel of `default-1440`; the confirm as `confirm-discard-1440` | Title «Замінити чек», primary «Замінити». Confirm «Замінити наявний чек?» / «Старий файл або посилання буде видалено без можливості відновлення.» with the cancel focused.                                                                                                                                                                                                                                                                                                                                                         |

There is no "empty" state: the sheet always opens on a form, and a role without kinds (JUNIOR, HR)
never sees an entry point. Whether the request left the device, and whether the create is keyed,
decide between «Повторити збереження» (not sent), «Надіслати ще раз» (unknown, keyed) and «Перевірити
список» (unknown, keyless).

### Coverage matrix (every kind and role that creates or edits today)

| Flow                      | ADMIN                                                                                                                                                                                                                                                                                                                                                            | ACCOUNTANT                               | SENIOR                                                                                                                                                           | DROP                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| EXPENSE                   | `default`, `loading`, `kind-picker`, `long-content(-collapsed)`, `armed`, `inflight`, `optimistic-row`, `saved`, `receipt-uploading`, `error-definite(-keyboard)`, `error-422`, `rollback`, `unknown-resubmit`, `unknown-closed(-long)`, `unknown-keyless`, `unknown-check`, `confirm-discard(-unknown)`, `dirty-close`, `reload-while-saving`, `keyless-saving` | `expense-company`                        | —                                                                                                                                                                | —                                    |
| ADMIN_INCOME              | `admin-income-usdt`                                                                                                                                                                                                                                                                                                                                              | `admin-income-accountant`                | —                                                                                                                                                                | —                                    |
| SALARY (new, no prefill)  | spec-only ¹                                                                                                                                                                                                                                                                                                                                                      | spec-only ¹                              | —                                                                                                                                                                | —                                    |
| SALARY part (row prefill) | spec-only ¹                                                                                                                                                                                                                                                                                                                                                      | `salary-part`                            | —                                                                                                                                                                | —                                    |
| ADMIN_TRANSFER            | `transfer-admin`                                                                                                                                                                                                                                                                                                                                                 | `transfer`                               | —                                                                                                                                                                | —                                    |
| DIVIDEND                  | `dividend`                                                                                                                                                                                                                                                                                                                                                       | —                                        | —                                                                                                                                                                | —                                    |
| SENIOR_INCOME             | —                                                                                                                                                                                                                                                                                                                                                                | —                                        | `senior-income`                                                                                                                                                  | —                                    |
| DROP_INCOME               | —                                                                                                                                                                                                                                                                                                                                                                | —                                        | —                                                                                                                                                                | `drop-income`                        |
| Admin edit                | `admin-edit-cascade`, `-date-reason`, `-reason-error`, `-preview-loading`, `-preview-error`, `-stale`, `-blocked`, `-saving`, `-error`, `edit-unknown`, `edit-unknown-resolved`, `edit-saving-closed`, `edit-failed-closed`, `edit-check`, `edit-refetch-failed`                                                                                                 | —                                        | —                                                                                                                                                                | —                                    |
| Edit of a rejected income | —                                                                                                                                                                                                                                                                                                                                                                | —                                        | `senior-edit-rejected`, `edit-failed`                                                                                                                            | —                                    |
| Attach / replace receipt  | same sheet (any transaction, any status)                                                                                                                                                                                                                                                                                                                         | same sheet (any transaction, any status) | `attach-receipt`, `attach-replace(-confirm)` (own rows: attach while there is no receipt, any status; replace while the status is not PAID — `canAttachReceipt`) | same sheet (own rows, the same rule) |
| Non-editable transaction  | `permission-limited`                                                                                                                                                                                                                                                                                                                                             | —                                        | —                                                                                                                                                                | —                                    |

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
| 900–1023 (tablet landscape) | The same 400 px modal panel, laid over the detail pane: the list column stays visible (dimmed) on its left, so the user keeps their place. Drawn: `default-1000`, `edit-unknown-1000`.                           | Same as 640–899                                                                                                                 | The receipt tile                                    |
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
   placeholder `0,00`. The NBU rate line for a non-USD / non-USDT currency: «Курс НБУ на 11.11: 1 USD =
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

| Step              | When                             | Sheet                                                                                                                                                                                                                                                         | Pill (sheet collapsed or closed)                                | Row marker                             |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| saving            | «Зберегти зміни» on a valid form | Stays open, locked: lead «Згорнути», the sent values as a record under «Надіслано 11 листопада о 14:32 · змінити не можна», primary spinner `aria-disabled` (`admin-edit-saving-*`). «Згорнути» closes it into the pill                                       | «Зберігаємо зміни… · Дохід +1 250,50 USD»                       | «Зберігається…» (spinner)              |
| saved             | 2xx                              | Closes; focus returns to the row, which shows the new values                                                                                                                                                                                                  | «Зміни збережено · Дохід +1 250,50 USD · Відкрити»              | none                                   |
| failed (definite) | A definite failure               | Stays open with the values: inline alert «Зміни не збережено» + the cause («Нічого не змінено. Дані у формі залишились — спробуйте ще раз.» or the catalog message), primary «Зберегти зміни» (manual) (`admin-edit-error-*`; senior edit: `edit-failed-375`) | «Зміни не збережено · Дохід +1 250,50 USD · Відкрити»           | «Зміни не збережено» (destructive)     |
| unknown           | An unknown outcome               | Closes (A1-3); the entered values stay in memory under the marker                                                                                                                                                                                             | «Невідомо, чи збережено зміни · Дохід +1 250,50 USD · Відкрити» | «Результат невідомий» + «Перевіряємо…» |

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
| Attach receipt | Waits, sheet locked                       | `PATCH /transactions/:id/receipt`; saved pill «Чек прикріплено · Дохід +2 400,00 USD» or «Чек замінено · …» (today's toasts).                                   |

**Cascade block.** When a derivative row cannot be recomputed, the server marks the save as blocked:
alert «Зберегти не можна» / «По відмічених рядках суму не перерахувати — потрібне ручне рішення. Поверніть попередню суму, щоб зберегти інші зміни, або спершу вирішіть заявку на виплату.» with the one-tap next step «Повернути +1 200,00 USD» (it restores the old amount and reruns the preview; A1-8, open point 16),
the blocked row keeps its old value («120,00 USD — залишиться без змін») with the reason «У заявці на
виплату — суму не змінити» (destructive), and the primary is `aria-disabled` (`admin-edit-blocked`).
The reason line comes from today's `CASCADE_BLOCKED_REASON_OWN_MESSAGES`. A row that will not be
recomputed but does not block (an invoice) reads «… — залишиться без змін» + «Не перерахується
автоматично — потрібна ручна звірка» (warning).

**Admin edit, the other preview and date states.** «Зберегти зміни» needs a loaded, fresh preview.
While it loads, «Що зміниться» shows `role="status"` «Перераховуємо пов’язані виплати…» and row
skeletons (`admin-edit-preview-loading-375`). When it fails it shows the alert «Перегляд недоступний —
спробуйте ще раз» + «Повторити» (`admin-edit-preview-error-375`). After a 409
`FINANCE_CASCADE_PREVIEW_STALE` it shows the catalog alert «Дані змінилися після попереднього
перегляду — оновіть його і збережіть ще раз» + «Оновити перегляд» (`admin-edit-stale-*`). In all three
the primary is a flat `--secondary` fill with `aria-disabled="true"` and `aria-describedby` on the
status or alert, never a dimmed primary (A1-9). A date moved past the 31-day window adds «Причина
зміни дати» (placeholder «Для дат давніших за 31 день») under «Дата транзакції»
(`admin-edit-date-reason-*`). A save without it returns `FINANCE_TX_DATE_EDIT_REASON_REQUIRED`, and the
field shows «Дата надто далеко в минулому — вкажіть причину в полі «Причина зміни дати»»
(`admin-edit-reason-error-375`). A definite failure keeps the form editable under «Зміни не збережено»
(`admin-edit-error-*`).

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

| Today                                                                                                                                                                     | In the sheet                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Тип операції» select                                                                                                                                                     | Kind pill (picker sheet / listbox popover), prefilled with the last kind                                                                                                                                                                                                                                                                                                              |
| `ProjectSelectSection`                                                                                                                                                    | «Проєкт» picker (kind block when required, the defaults row otherwise)                                                                                                                                                                                                                                                                                                                |
| `AmountCurrencyInput`, USDT lock for a USDT project                                                                                                                       | Amount field + currency pill, lock icon on the pill                                                                                                                                                                                                                                                                                                                                   |
| «Дата транзакції», `TxDateField` (edit)                                                                                                                                   | «Дата» in the defaults row (create) or a field (admin edit); inline error for a closed month                                                                                                                                                                                                                                                                                          |
| `ReceiptField` / `ReceiptInput` (file XOR link, USDT link only)                                                                                                           | The receipt block, same XOR and USDT rule; the upload no longer dies with the dialog                                                                                                                                                                                                                                                                                                  |
| NBU rate                                                                                                                                                                  | The rate line under the amount                                                                                                                                                                                                                                                                                                                                                        |
| «Рахунок отримувача» + company balance (ADMIN_INCOME, ADMIN)                                                                                                              | Same picker; picking «Рахунок компанії» shows its balance                                                                                                                                                                                                                                                                                                                             |
| `ObligationPreviewBanner`                                                                                                                                                 | Obligation card under the receiver                                                                                                                                                                                                                                                                                                                                                    |
| ACCOUNTANT receiver toggle                                                                                                                                                | Segmented «Власник проєкту» / «Рахунок компанії»                                                                                                                                                                                                                                                                                                                                      |
| SALARY «Співробітник», «Місяць», `ExistingSalaryParts`                                                                                                                    | Same fields + the list «Уже внесено за <місяць>» (manual / automatic parts)                                                                                                                                                                                                                                                                                                           |
| EXPENSE «Джерело коштів», «Категорія» (free text) + suggestion chips                                                                                                      | «Категорія» free-text field + suggestion chips; «Джерело коштів» in the expanded defaults, named in the row                                                                                                                                                                                                                                                                           |
| ADMIN_TRANSFER direction + ACCOUNTANT swap                                                                                                                                | Stacked picker cards + «Поміняти напрямок» (ACCOUNTANT only); ADMIN's sender fixed                                                                                                                                                                                                                                                                                                    |
| DIVIDEND balance, partner, amount ≤ balance                                                                                                                               | Same, with the limit note under the balance                                                                                                                                                                                                                                                                                                                                           |
| «Примітки (необов’язково)»                                                                                                                                                | «Опис» in the defaults row (the same `notes` field); «Примітки» in admin edit                                                                                                                                                                                                                                                                                                         |
| Field-error summary «Заповніть виділені поля»                                                                                                                             | Focus moves to the first invalid field; the summary stays for screen readers (`role="alert"`)                                                                                                                                                                                                                                                                                         |
| `AdminEditTransactionDialog` fields: amount, currency, date, «Категорія» (EXPENSE), «Місяць» (SALARY), «Примітки»; the receipt for ADMIN_INCOME / SENIOR_INCOME / EXPENSE | Exactly that set; no project, receiver or kind picker. The receipt card shows for those three kinds only, with the text button «Замінити» and a 44 px ✕ icon button named «Видалити чек» (today «Видалити файл»). Removing only clears the field; nothing is saved before «Зберегти». Subtitle «<kind> · було <signed old> <CODE>»; amount lock note and PAID currency lock unchanged |
| `CascadeImpactPanel` (table + `sm:hidden` mobile row)                                                                                                                     | One list «Що зміниться» at every width, first row «Ця транзакція»; the blocking message unchanged                                                                                                                                                                                                                                                                                     |
| Non-editable banner                                                                                                                                                       | `permission-limited` read-only view                                                                                                                                                                                                                                                                                                                                                   |
| Admin edit toasts (invoice not reissued / diverged)                                                                                                                       | Unchanged (they report a server-side follow-up, not the save itself)                                                                                                                                                                                                                                                                                                                  |
| Senior edit: receipt sent only if changed                                                                                                                                 | Unchanged                                                                                                                                                                                                                                                                                                                                                                             |
| DROP toast «Дохід зареєстровано, очікує валідації», DIVIDEND toast                                                                                                        | Replaced by the saved pill; the DROP row carries its pending-validation status in the list                                                                                                                                                                                                                                                                                            |
| **Admin edit** (`AdminEditTransactionDialog`, against today's code)                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                                       |
| Title «Редагувати транзакцію» + inline «<kind> · <amount>»; sr-only description «Редагування транзакції»                                                                  | Title «Редагування» + subtitle «Дохід · було +1 200,00 USD». Shortened so the phone header fits beside the lead (open point 12)                                                                                                                                                                                                                                                       |
| Amount + currency; amount lock note; currency locked on a PAID row                                                                                                        | Unchanged                                                                                                                                                                                                                                                                                                                                                                             |
| `TxDateField` + date-move reason                                                                                                                                          | «Дата транзакції» + «Причина зміни дати» past the 31-day window (`admin-edit-date-reason`, `admin-edit-reason-error`)                                                                                                                                                                                                                                                                 |
| «Категорія» (EXPENSE, placeholder «Категорія витрати»), «Місяць» (SALARY)                                                                                                 | Unchanged, shown only for those kinds                                                                                                                                                                                                                                                                                                                                                 |
| «Примітки», placeholder «Додаткова інформація…»                                                                                                                           | Unchanged                                                                                                                                                                                                                                                                                                                                                                             |
| `CascadeImpactPanel`: loading «Перераховуємо пов’язані виплати…» (Russian today), stale «Обновить предпросмотр» (Russian today), blocked «Зберегти не можна — …»          | The same three states in uk: `admin-edit-preview-loading`, `admin-edit-stale` («Оновити перегляд»), `admin-edit-blocked`, plus the preview error with «Повторити» and the one-tap «Повернути +1 200,00 USD»                                                                                                                                                                           |
| Footer «Скасувати» / «Зберегти» («Збереження…»), `disabled` while pending, blocked or stale                                                                               | Lead «Скасувати»; primary «Зберегти зміни», `aria-disabled` with `aria-describedby` on the reason, never `disabled` (A1-9)                                                                                                                                                                                                                                                            |
| Toast «Зміни збережено»                                                                                                                                                   | The saved pill «Зміни збережено · Дохід +1 250,50 USD · Відкрити»                                                                                                                                                                                                                                                                                                                     |
| **Senior edit** (`EditSeniorIncomeDialog`)                                                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                       |
| Title «Виправити транзакцію», sr-only «Виправлення транзакції»                                                                                                            | Title «Виправити дохід»: the only kind it edits is an income (open point 17)                                                                                                                                                                                                                                                                                                          |
| Rejection panel «Причина відмови:» + `rejectionReason`                                                                                                                    | Banner «Дохід відхилено. Після збереження він знову піде на валідацію.» + «Причина відмови:» + the reason                                                                                                                                                                                                                                                                             |
| «Проєкт» as plain text                                                                                                                                                    | Unchanged (text, no picker)                                                                                                                                                                                                                                                                                                                                                           |
| Amount + currency, `ReceiptInput` (sent only if changed), «Примітки» / «Додаткова інформація…»                                                                            | Unchanged                                                                                                                                                                                                                                                                                                                                                                             |
| Primary «Надіслати повторно» («Збереження…»), `disabled` while pending                                                                                                    | «Зберегти й надіслати» (open point 17: keep today's «Надіслати повторно» if the owner prefers the catalog), `aria-disabled` while saving                                                                                                                                                                                                                                              |
| **Attach / replace receipt** (`AttachReceiptSheet`)                                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                                       |
| Title «Прикріпити чек» / «Замінити чек»                                                                                                                                   | Unchanged                                                                                                                                                                                                                                                                                                                                                                             |
| No transaction context in the sheet                                                                                                                                       | A summary card «+2 400,00 USD · Дохід · Проєкт «Альфа» · 9 листопада» (read-only), so the user sees what the receipt belongs to                                                                                                                                                                                                                                                       |
| `ReceiptInput` (file XOR link)                                                                                                                                            | The receipt block, same XOR and USDT rule                                                                                                                                                                                                                                                                                                                                             |
| Primary «Прикріпити» / «Замінити», `disabled` until a new receipt is set                                                                                                  | «Прикріпити» / «Замінити», never `disabled`: a tap without a receipt focuses the tile with today's «Прикріпіть чек або вкажіть посилання на підтвердження»; while uploading «Прикріпити після завантаження чека» (armed)                                                                                                                                                              |
| Confirm «Замінити наявний чек?» / «Старий файл/посилання буде видалено без можливості відновлення.»                                                                       | Unchanged (`attach-replace-confirm-375`), cancel focused                                                                                                                                                                                                                                                                                                                              |
| Toasts «Чек прикріплено» / «Чек замінено»                                                                                                                                 | The saved pill «Чек прикріплено · Дохід +2 400,00 USD» / «Чек замінено · …»                                                                                                                                                                                                                                                                                                           |

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

Every string a frame shows, in three tables by source. Not strings: fixture values (names, amounts,
dates, descriptions, file names, sizes; M13), the device chrome (status bar, keyboard), and the shell,
list and detail-pane text behind the sheet (tab bar, list rows, the `*-1000` detail pane), which
`shell-v2.md` owns. `{amount}` is the signed, locale-formatted amount with its code (`−1 250,50 USD`
in uk, `−1,250.50 USD` in en, M11); `{value}` is a form field's own value, unsigned. Also unsigned: the «Що зміниться» rows (each
row's own value and its "old → new" pair; the row label names the kind), the salary parts list, and an
amount quoted inside a rejection reason (the validator's text). The en column is
written for meaning, not translated word by word; copy-reviewer gives the per-language verdict.

**New or changed strings**

| Key idea                      | uk                                                                                                                                                            | en                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create title                  | Нова транзакція                                                                                                                                               | New transaction                                                                                                                                                  |
| Single-kind title             | Новий дохід                                                                                                                                                   | New income                                                                                                                                                       |
| Admin edit title              | Редагування                                                                                                                                                   | Edit transaction                                                                                                                                                 |
| Admin edit subtitle           | {kind} · було {amount}                                                                                                                                        | {kind} · was {amount}                                                                                                                                            |
| Senior edit title             | Виправити дохід                                                                                                                                               | Fix income                                                                                                                                                       |
| Read-only title               | Транзакція                                                                                                                                                    | Transaction                                                                                                                                                      |
| Receipt segments              | Файл / Посилання                                                                                                                                              | File / Link                                                                                                                                                      |
| Receipt hint, touch           | Камера, фото або файл · до 10 МБ                                                                                                                              | Camera, photo or file · up to 10 MB                                                                                                                              |
| Receipt hint, fine pointer    | Перетягніть файл сюди або оберіть · до 10 МБ                                                                                                                  | Drop a file here or choose one · up to 10 MB                                                                                                                     |
| Receipt uploading             | Завантаження чека / Завантаження · {percent}%                                                                                                                 | Uploading receipt / Uploading · {percent}%                                                                                                                       |
| Receipt done                  | Чек додано                                                                                                                                                    | Receipt added                                                                                                                                                    |
| Receipt actions (✕ name)      | Замінити / Видалити чек                                                                                                                                       | Replace / Remove receipt                                                                                                                                         |
| Kind pill (SR)                | Тип: {kind}                                                                                                                                                   | Type: {kind}                                                                                                                                                     |
| Currency pill (SR)            | Валюта: {currency}                                                                                                                                            | Currency: {currency}                                                                                                                                             |
| Locked currency (SR)          | Валюта: {currency}, змінити не можна                                                                                                                          | Currency: {currency}, can’t be changed                                                                                                                           |
| Kind subtitles                | Оренда, сервіси, збори · Оплата від клієнта за проєкт · Частина зарплати співробітника · Між адміністраторами · Виплата партнеру з рахунку компанії           | Rent, services, fees · Client payment for a project · Part of an employee’s salary · Between admins · Payout to a partner from the company account               |
| Category chips (SR group)     | Підказки категорії                                                                                                                                            | Category suggestions                                                                                                                                             |
| Category chips                | Оплата послуги / Банківський збір / Інше                                                                                                                      | Service payment / Bank fee / Other                                                                                                                               |
| Defaults row                  | Сьогодні · без проєкту · без опису · змінити                                                                                                                  | Today · no project · no description · change                                                                                                                     |
| Defaults row, company source  | Рахунок компанії                                                                                                                                              | Company account                                                                                                                                                  |
| Date field value, today       | Сьогодні, {date}                                                                                                                                              | Today, {date}                                                                                                                                                    |
| Project, none                 | Без проєкту                                                                                                                                                   | No project                                                                                                                                                       |
| Description field             | Опис                                                                                                                                                          | Description                                                                                                                                                      |
| Optional field hint           | Необов’язково                                                                                                                                                 | Optional                                                                                                                                                         |
| Picker still loading          | Список ще завантажується                                                                                                                                      | The list is still loading                                                                                                                                        |
| Company balance hint          | Списується з рахунку компанії ({currency}) · баланс {balance}                                                                                                 | Paid from the company account ({currency}) · balance {balance}                                                                                                   |
| Save while uploading          | Зберегти після завантаження чека                                                                                                                              | Save once the receipt uploads                                                                                                                                    |
| Armed save                    | Збережеться {amount} після завантаження чека                                                                                                                  | {amount} will save once the receipt uploads                                                                                                                      |
| Cancel armed save             | Не зберігати автоматично                                                                                                                                      | Don’t save automatically                                                                                                                                         |
| Collapse                      | Згорнути                                                                                                                                                      | Minimise                                                                                                                                                         |
| In-flight primary             | Зберігаємо…                                                                                                                                                   | Saving…                                                                                                                                                          |
| Locked record line            | Надіслано {date} о {time} · змінити не можна                                                                                                                  | Sent on {date} at {time} · can’t be changed                                                                                                                      |
| Pinned row, failed            | Не збережено · {kind} · {time}                                                                                                                                | Not saved · {kind} · {time}                                                                                                                                      |
| Pinned row, unknown           | Результат невідомий · {kind} · {time}                                                                                                                         | Outcome unknown · {kind} · {time}                                                                                                                                |
| Not sent                      | Транзакцію не надіслано                                                                                                                                       | Transaction not sent                                                                                                                                             |
| Server refused (enveloped)    | Транзакцію не збережено                                                                                                                                       | Transaction not saved                                                                                                                                            |
| Manual retry                  | Повторити збереження                                                                                                                                          | Try saving again                                                                                                                                                 |
| Unknown, keyed body           | Відповідь не надійшла. Надішліть ще раз: якщо транзакцію вже збережено, друга не з’явиться.                                                                   | No response came back. Send it again: if it was already saved, no second one will appear.                                                                        |
| Unknown, keyed action         | Надіслати ще раз                                                                                                                                              | Send again                                                                                                                                                       |
| Discard draft                 | Видалити чернетку                                                                                                                                             | Delete draft                                                                                                                                                     |
| Discard confirm title         | Видалити чернетку {amount}?                                                                                                                                   | Delete the {amount} draft?                                                                                                                                       |
| Discard confirm body          | Сума, поля й чек зникнуть. Цю дію не можна скасувати.                                                                                                         | The amount, fields and receipt will be gone. This can’t be undone.                                                                                               |
| Discard confirm body, unknown | Сума, поля й чек зникнуть із пристрою. Якщо транзакцію вже збережено, вона залишиться в списку.                                                               | The amount, fields and receipt will be gone from this device. If it was already saved, it stays in the list.                                                     |
| Discard confirm actions       | Залишити / Видалити                                                                                                                                           | Keep / Delete                                                                                                                                                    |
| Dirty close                   | Вийти без збереження?                                                                                                                                         | Leave without saving?                                                                                                                                            |
| Dirty close body              | Сума {amount} і чек не збережуться.                                                                                                                           | The {amount} and the receipt won’t be saved.                                                                                                                     |
| Dirty close actions           | Продовжити редагування / Вийти без збереження                                                                                                                 | Keep editing / Leave without saving                                                                                                                              |
| Non-editable banner, payout   | Транзакцію не можна редагувати: це виплата.                                                                                                                   | This transaction can’t be edited: it is a payout.                                                                                                                |
| Non-editable banner, request  | Транзакцію не можна редагувати: вона прив’язана до заявки на виплату.                                                                                         | This transaction can’t be edited: it is linked to a payout request.                                                                                              |
| Cascade list                  | Що зміниться                                                                                                                                                  | What will change                                                                                                                                                 |
| Cascade first row             | Ця транзакція · {kind}                                                                                                                                        | This transaction · {kind}                                                                                                                                        |
| Cascade row                   | {label} · {name} ({percent}%) {old} → {new}                                                                                                                   | {label} · {name} ({percent}%) {old} → {new}                                                                                                                      |
| Cascade row unchanged         | {value} — залишиться без змін                                                                                                                                 | {value} — stays as is                                                                                                                                            |
| Cascade row note              | Не перерахується автоматично — потрібна ручна звірка                                                                                                          | Won’t be recalculated automatically — needs a manual check                                                                                                       |
| Cascade loading (status)      | Перераховуємо пов’язані виплати…                                                                                                                              | Recalculating linked payouts…                                                                                                                                    |
| Cascade preview failed        | Перегляд недоступний — спробуйте ще раз / Повторити                                                                                                           | Preview unavailable — try again / Retry                                                                                                                          |
| Cascade preview stale         | Дані змінилися після попереднього перегляду — оновіть його і збережіть ще раз / Оновити перегляд                                                              | The data changed since the last preview — refresh it and save again / Refresh preview                                                                            |
| Cascade blocked title         | Зберегти не можна                                                                                                                                             | Can’t save                                                                                                                                                       |
| Cascade blocked body          | По відмічених рядках суму не перерахувати — потрібне ручне рішення. Поверніть попередню суму, щоб зберегти інші зміни, або спершу вирішіть заявку на виплату. | The marked rows can’t be recalculated — they need a manual decision. Restore the previous amount to save the other changes, or resolve the payout request first. |
| Cascade blocked next step     | Повернути {amount}                                                                                                                                            | Restore {amount}                                                                                                                                                 |
| Date field (admin edit)       | Дата транзакції                                                                                                                                               | Transaction date                                                                                                                                                 |
| Date-move reason              | Причина зміни дати / Для дат давніших за 31 день                                                                                                              | Reason for the date change / For dates more than 31 days back                                                                                                    |
| Date-move reason missing      | Дата надто далеко в минулому — вкажіть причину в полі «Причина зміни дати»                                                                                    | The date is too far back — give a reason in “Reason for the date change”                                                                                         |
| Edit primary                  | Зберегти зміни                                                                                                                                                | Save changes                                                                                                                                                     |
| Edit not saved                | Зміни не збережено                                                                                                                                            | Changes not saved                                                                                                                                                |
| Edit not saved, offline       | Немає з’єднання. Нічого не змінено, дані у формі залишились.                                                                                                  | No connection. Nothing changed; your entries are still in the form.                                                                                              |
| Edit not saved, server        | Нічого не змінено. Дані у формі залишились — спробуйте ще раз.                                                                                                | Nothing changed. Your entries are still in the form — try again.                                                                                                 |
| Edit pill, saving             | Зберігаємо зміни… · {kind} {amount}                                                                                                                           | Saving changes… · {kind} {amount}                                                                                                                                |
| Edit pill / marker, unknown   | Невідомо, чи збережено зміни · {kind} {amount}                                                                                                                | Not sure the changes were saved · {kind} {amount}                                                                                                                |
| Edit row marker, checking     | Результат невідомий · Перевіряємо…                                                                                                                            | Outcome unknown · Checking…                                                                                                                                      |
| Edit pill, saved              | Зміни збережено · {kind} {amount}                                                                                                                             | Changes saved · {kind} {amount}                                                                                                                                  |
| Edit pill, not saved          | Зміни не збережено · {kind} {amount}                                                                                                                          | Changes not saved · {kind} {amount}                                                                                                                              |
| Edit pill (SR)                | {pill title}, {kind, lowercase} {amount}. Відкрити                                                                                                            | {pill title}, {kind, lowercase} {amount}. Open                                                                                                                   |
| Edit check result             | Транзакцію перевірено: змін у ній немає. Введене залишилось — збережіть ще раз.                                                                               | Transaction checked: it has no changes. Your entries are kept — save again.                                                                                      |
| Edit check the row            | Перевірте транзакцію / Частину змін могли зберегти, або транзакцію змінили. Звірте значення, перш ніж зберігати ще раз.                                       | Check the transaction / Some changes may have been saved, or it was changed. Compare the values before saving again.                                             |
| Senior resubmit banner        | Дохід відхилено. Після збереження він знову піде на валідацію.                                                                                                | Income rejected. Once saved, it goes back for validation.                                                                                                        |
| Senior resubmit primary       | Зберегти й надіслати                                                                                                                                          | Save and resubmit                                                                                                                                                |
| Attach summary                | {amount} · {kind} · {project} · {date}                                                                                                                        | {amount} · {kind} · {project} · {date}                                                                                                                           |
| Attach while uploading        | Прикріпити після завантаження чека                                                                                                                            | Attach once the receipt uploads                                                                                                                                  |
| Attach pill                   | Чек прикріплено · {kind} {amount} / Чек замінено · {kind} {amount}                                                                                            | Receipt attached · {kind} {amount} / Receipt replaced · {kind} {amount}                                                                                          |
| Salary receipt note           | Чек для зарплати додається під час виплати.                                                                                                                   | The salary receipt is added at payout.                                                                                                                           |
| Existing parts                | Уже внесено за {month}                                                                                                                                        | Already entered for {month}                                                                                                                                      |
| Existing part row             | {date} · Внесено вручну / {date} · Внесено автоматично                                                                                                        | {date} · Entered manually / {date} · Entered automatically                                                                                                       |
| Transfer group (SR)           | Напрямок переказу                                                                                                                                             | Transfer direction                                                                                                                                               |
| Transfer cards                | надсилає / отримує                                                                                                                                            | sends / receives                                                                                                                                                 |
| Transfer cards (SR)           | надсилає: {name} / отримує: {name}                                                                                                                            | sends: {name} / receives: {name}                                                                                                                                 |
| Transfer sender, ADMIN        | Ви · {name}                                                                                                                                                   | You · {name}                                                                                                                                                     |
| Transfer swap                 | Поміняти напрямок                                                                                                                                             | Swap direction                                                                                                                                                   |
| Dividend balance              | Баланс рахунку компанії: {balance}. Сума не може його перевищувати.                                                                                           | Company account balance: {balance}. The amount can’t exceed it.                                                                                                  |
| DROP hint                     | Дохід очікуватиме валідації                                                                                                                                   | The income will wait for validation                                                                                                                              |
| Keyless check action          | Перевірити список                                                                                                                                             | Check the list                                                                                                                                                   |

**Unchanged catalog strings the frames show** (kept as today; listed so the frames and the catalog can
be matched)

| Key idea                   | uk                                                                                                 | en                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Kind labels                | Витрата / Дохід / Зарплата / Переказ / Дивіденди / Виплата                                         | Expense / Income / Salary / Transfer / Dividends / Payout                               |
| Role labels                | Адміністратор / Бухгалтер / Сеньйор / Дроп                                                         | Admin / Accountant / Senior / Drop                                                      |
| Lead / close               | Скасувати / Закрити                                                                                | Cancel / Close                                                                          |
| Fine-pointer hints         | Esc / ⌘↵                                                                                           | Esc / ⌘↵                                                                                |
| Category placeholder       | Категорія витрати                                                                                  | Expense category                                                                        |
| Fields                     | Категорія / Проєкт / Дата / Джерело коштів / Отримувач                                             | Category / Project / Date / Funding source / Recipient                                  |
| Receiver                   | Рахунок отримувача                                                                                 | Receiving account                                                                       |
| ACCOUNTANT receiver toggle | Власник проєкту / Рахунок компанії                                                                 | Project owner / Company account                                                         |
| Obligation preview         | Після збереження · {name} — буде нараховано {amount} (частка {percent}%, джерело: проєкт)          | After saving · {name} — {amount} will be accrued ({percent}% share, source: project)    |
| NBU rate                   | Курс НБУ на {date}: 1 USD = {rate} UAH · ≈ {usd} USD                                               | NBU rate on {date}: 1 USD = {rate} UAH · ≈ {usd} USD                                    |
| USDT link                  | Посилання на транзакцію в блокчейн-експлорері                                                      | Link to the transaction in a blockchain explorer                                        |
| USDT receipt rule          | Чек для USDT — лише посилання на транзакцію                                                        | A USDT receipt is a transaction link only                                               |
| Receipt link field         | Посилання на чек                                                                                   | Receipt link                                                                            |
| SALARY fields              | Співробітник / Місяць                                                                              | Employee / Month                                                                        |
| DIVIDEND receiver          | Отримувач (партнер)                                                                                | Recipient (partner)                                                                     |
| Admin edit notes           | Примітки / Додаткова інформація… / Без приміток                                                    | Notes / Additional information… / No notes                                              |
| Senior rejection reason    | Причина відмови:                                                                                   | Rejection reason:                                                                       |
| Attach / replace titles    | Прикріпити чек / Замінити чек                                                                      | Attach receipt / Replace receipt                                                        |
| Replace confirm            | Замінити наявний чек? / Старий файл/посилання буде видалено без можливості відновлення. / Замінити | Replace the current receipt? / The old file or link will be deleted for good. / Replace |
| Definite failure body      | Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.                               | No connection. Nothing was saved; the amount and receipt are still in the form.         |
| Create primary             | Зберегти                                                                                           | Save                                                                                    |
| Catalog 422 (date)         | Для виконаної операції дата не може бути в майбутньому                                             | A completed operation can’t be dated in the future                                      |

**Foundation strings the sheet uses** (owned by `primitives-v2.md`; the sheet passes the values)

| Key idea                      | uk                                                                                                                                                                                                                                                   | Source          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Pill, create                  | Зберігаємо {amount}… / Збережено {amount} / Не збережено {amount} / Результат невідомий · {amount}; action Відкрити                                                                                                                                  | §11 money draft |
| Optimistic row status         | Зберігаємо…                                                                                                                                                                                                                                          | §11             |
| «+» with a draft (SR)         | {label}, 1 чернетка потребує уваги                                                                                                                                                                                                                   | §11             |
| Pill (SR) / saved live region | {pill text}. Відкрити / Транзакцію збережено                                                                                                                                                                                                         | §11             |
| Pinned row (SR)               | Відкрити чернетку {amount}                                                                                                                                                                                                                           | §11             |
| Unknown title                 | Невідомо, чи транзакцію збережено                                                                                                                                                                                                                    | §5              |
| Unknown, keyless body         | Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.                                                                                                                                | §5              |
| Check sheet                   | Нові записи / Шукаємо: {amount} · {kind} · {description} · надіслано {time} / Лише ваші записи з {time} / Оновлено о {time} / Оновити                                                                                                                | §5              |
| Check sheet rows and exits    | нова / раніше · Збігів немає · Сервер міг зберегти транзакцію із запізненням. Через хвилину після помилки список оновиться сам, і тоді її можна буде створити ще раз. · Є в списку — закрити чернетку / Немає — створити ще раз / Можна через {m:ss} | §5              |
| Page-kill alert, `sent`       | Результат збереження транзакції о {time} невідомий. Вона могла зберегтися: перевірте нові записи, перш ніж створювати її знову. / Закрити / Оновити список                                                                                           | §5 boot check   |
| Page-kill alert, `armed`      | Транзакцію не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз. / Зрозуміло                                                                                                                                              | §5 boot check   |

The en for the foundation rows is the foundation's own; the sheet adds none.

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
  fallback). The web-font links are stripped so a render needs no network. The font is Inter: a
  locally installed copy, or the `@fontsource/inter` files named by `INTER_DIR` on a host without it
  (this round was rendered with `INTER_DIR`). `render.mjs` never deletes a PNG; remove a renamed
  frame by hand.
- `default-320` (1010 px), `long-content-320` (1180 px) and `error-definite-320` (800 px) are drawn on a
  taller canvas than the 568 px device so the whole scrolled sheet is in one image; the other 320
  frames are the device height.
- In the mockup tool the fine-pointer variant is chosen by width (1024 and up); the product chooses it
  by `(pointer: fine)` as specified above. The 768 and 1000 frames show the coarse variant.
- The 900–1023 landscape layout is rendered at 1000 (`default-1000`, `edit-unknown-1000`).
- The rendered HTML is regenerated by `render.mjs` and not committed (the foundation precedent).
- The foundation `tablet()` / `desktop()` frames hard-code the ADMIN role; `transaction-sheet.mjs`
  patches a temporary copy to pass the role (`withRole`). The foundation files are untouched.
- The table behind the 1440 panel is the foundation sample list; for an edit the highlighted row is
  the edited transaction (M13).

## Self-score (`docs/design/rubric-calibration.md`)

Criterion 8 (data viz) does not apply and is dropped; the weights are renormalised over 93. Council
round 2 gave phone 9.2 / 9.1 / 9.1, tablet 9.1 / 9.0 / 9.0, desktop 9.2 / 9.3 / 9.3. My earlier
self-scores ran 0.3–0.6 above the council, so these numbers are an upper bound, not a forecast.

**Criterion 6 below 1440.** The panel is modal at 640–1439 because the foundation sets it: "Below 1440
the panel is modal: focus trap, scrim, Esc closes" (`primitives-v2.md` §2, Side panel; council R12's
all-modal proposal was rejected there). The 9.5 anchor of criterion 6 reads "As 10; one detent height
or panel width is slightly off for its content", and 10 is "Right container for the job (foundation
§8) … D: side panel for preview, dialog for confirm, Esc closes". A modal side panel with Esc,
scrim and a dialog for every confirm is the foundation's container for this job, so it meets 9.5. The
point off 10 is the 400 px tablet panel, which is narrow for the cascade list.

| Criterion (weight)  | < 640   | 640–1023 | ≥ 1024  |
| ------------------- | ------- | -------- | ------- |
| 1 Time-to-task (15) | 9.5     | 9.5      | 9.5     |
| 2 Never blocks (15) | 9.5     | 9.5      | 9.5     |
| 3 Navigation (10)   | 9.5     | 9.5      | 9.5     |
| 4 Forms (10)        | 9.5     | 9.5      | 9.5     |
| 5 Lists (10)        | 9.5     | 9.5      | 9.5     |
| 6 Sheets (8)        | 9.5     | 9.5      | 9.5     |
| 7 States (10)       | 9.5     | 9.5      | 9.5     |
| 9 Platform (8)      | 9       | 9        | 9.5     |
| 10 A11y (7)         | 9       | 9        | 9       |
| **Weighted**        | **9.4** | **9.4**  | **9.5** |

Weighted exactly: phone 876 / 93 = 9.42; tablet 876 / 93 = 9.42; desktop 880 / 93 = 9.46. None of
the three is at 9.5 exactly; desktop rounds to it.

**Weakest criterion per class, and the frame that shows it.**

- **Phone — 9 Platform fit (9).** At 320 the lead is a 44 px icon button (✕ / ⌄) rather than the
  iOS text lead, and the keyboard-up state is drawn for one state only (`default-320`,
  `error-definite-keyboard-375`).
- **Tablet — 9 Platform fit (9).** Twenty-six of the 44 640–1023 cells are rules, not frames; the 768 and 1000
  frames cover the states where the tablet differs, but a reviewer must read the rule for the rest
  (`default-768`, `default-1000`, the States table).
- **Desktop — 10 A11y (9).** The pinned draft row's accessible name is the foundation's «Відкрити
  чернетку {amount}»: two drafts of the same amount are told apart only by the visible send time,
  not by their names (`unknown-closed-1440`; open point 14). The same holds on phone and tablet.

## Open points

1. **Task 1.1 (an idempotency key on every create) is a gate, not an assumption.** The spec holds
   either way: the keyed path is `unknown-resubmit-*`, the keyless path is drawn as `unknown-keyless-375`,
   `unknown-keyless-1440` and `unknown-check-375` ("Save behaviour"). Recommendation: ship 1.1 first;
   until then EXPENSE, non-USDT ADMIN_INCOME, ADMIN_TRANSFER and the company deposit use the keyless
   path.
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
   4. Withdrawn: the sheet now uses the foundation's unknown title «Невідомо, чи транзакцію збережено»
      as is.
   5. For a create, the optimistic list row replaces the foundation's in-flight pinned draft row; the
      saving pill stays.
   6. Defaults row: each item is a no-wrap unit, and «змінити» is a 44 × 44 px button.
   7. `tablet()` / `desktop()` take a `role` parameter, so the mockup tool can drop the `withRole`
      patch (it reads the foundation frame's source text and throws if it changes).
   8. Send time in the pinned draft row and the pill (M15): a `{time}` slot in both, and in their
      accessible names («Відкрити чернетку −1 250,50 USD, надіслано о 14:32»). The foundation pinned
      row has no time slot; the sheet draws it on the amount line. Recommendation: adopt.
   9. Edit pills in the one-slot rank (M24). The foundation ranks drafts only («unknown > failed > in
      flight > armed > saved», `money-form.mjs`, `RANK`). The screen's order: an unknown or
      «Перевірте транзакцію» edit ranks with an unknown draft, a failed edit with a failed draft, a
      saving edit with an in-flight draft, a saved edit with a saved draft; on a tie the newer write
      shows, and the hidden one keeps its row marker, so it is never lost. Recommendation: the
      foundation adds the edit states to `RANK`.
   10. No toast on a rolled-back write: `foundation.md` ("Finance writes") says a keyed form is shown
       "optimistically, with rollback and a visible error", and the matching frames are toasts
       (`toast-error-*`); the sheet's visible error is the pill + pinned row + dot (M10, open point
       10). Recommendation: the foundation names that as the visible error and drops the toast.
   11. The locked record: the foundation's read-only unknown draft has "every control dimmed and
       `aria-disabled`" (`primitives-v2.md` §5); the sheet draws the sent values at full contrast as a
       record (M12, open point 20). Recommendation: the foundation adopts the full-contrast record.
   12. A second save that completes while another draft's pill is failed or unknown: the foundation
       shows "a normal success toast stacked above it" (`primitives-v2.md` §5); the sheet shows no
       toast. The new list row appears in place (the
       saved row is its own confirmation), the unresolved pill keeps the slot, and the saved write
       is announced once in the screen's polite live region («Транзакцію збережено»).
       Recommendation: the foundation replaces the toast with this.
9. **Closed (M26).** The list beside the 1440 panel reflows: «Проєкт» goes first, then the title
   truncates; «Сума», the amount and the code are never clipped. Drawn in every 1440 open-panel frame.
   Reconciling the list itself with Task 1.2 stays Task 1.2's job.
10. **The plan's Task 1.3 test names are replaced by the spec's** (M10; the plan file is Master's to
    amend). "rolled back with an error toast" → **"rolled back to a pill and a pinned row, no toast"**.
    "submit is disabled while in flight" → **"submit is `aria-disabled` and announces «Зберігаємо…»
    while in flight (one request per tap)"**. Separately, the plan says "balance", "partner stats" and
    "dashboard" where "Data" lists the real query keys; recommendation: the plan text cites the keys.
11. **Closed.** 900–1023 is rendered (`default-1000`, `edit-unknown-1000`).
12. **Admin edit title shortened.** Today «Редагувати транзакцію»; the sheet says «Редагування»,
    because the longer title collides with the lead «Скасувати» on the phone header. The en stays «Edit
    transaction». Recommendation: accept; the subtitle names the kind and amount.
13. **"Some fields match" after an unknown edit** is treated as "check the row", not as saved or not
    saved (A1-2). Recommendation: accept; a partial match is the one case the client cannot settle.
14. **Closed (M15).** The pinned row and the pill carry «· 14:32» visibly and in their accessible
    names; the foundation half is request 8.8.
15. **The 422 sample uses the catalog text** `FINANCE_TX_DATE_IN_FUTURE` («Для виконаної операції дата
    не може бути в майбутньому»). The foundation's 422 sample text for a closed month is not a catalog
    string (A1-6). Recommendation: the foundation replaces it with a catalog string.
16. **The blocked next step «Повернути {amount}»** is new: today's dialog only says the save is
    blocked (A1-8). It restores the old amount and reruns the preview; nothing is saved by the tap.
    Recommendation: accept; confirm with the owner that restoring the amount is the right default.
17. **Senior edit wording.** Today the title is «Виправити транзакцію» and the primary «Надіслати
    повторно»; the sheet says «Виправити дохід» and «Зберегти й надіслати», so the button says that it
    saves and sends for validation. Recommendation: accept; if the owner prefers the catalog, keep
    today's primary — the frames change only in that label.
18. **No `--muted` token.** The foundation has no `--muted`, so an unavailable primary uses
    `--secondary` with `--muted-fg` text (about 5:1, A1-9). Recommendation: the foundation names a
    token for an unavailable primary.
19. **An expense attributed to a project** (M23, the owner's). Today `createExpenseSchema` has no
    project, so the sheet shows none for EXPENSE. Whether an expense should name a project is a product
    question; nothing is drawn for it. Recommendation: none from design; it changes the schema first.
20. **The locked record** (M12). A sent draft reopens as a record, not a disabled form: the sent values
    at full contrast, «Надіслано 11 листопада о 14:32 · змінити не можна», no «змінити», no inputs.
    Recommendation: accept; the foundation half is request 8.11.

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

## Council round 2

Contract: Master decisions M1–M14 (each a line in "Assumptions") and findings R2-01..R2-18. Rejected:
none.

| Id    | Verdict | Where it shows                                                                                                                                                                                                                                                                                                                   |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01 | fixed   | "Save behaviour" outcome classes (M1, foundation §5 word for word); reopen rules per class; `error-definite-*` captions; `confirm-discard-unknown-375`; Strings «Server refused (enveloped)».                                                                                                                                    |
| R2-02 | fixed   | "Edit lifecycle" (row marker + pill, no pinned row, edit wording, refetch resolution); `edit-failed-375`, `edit-unknown-375`, `-768`, `-1000`, `-1440`, `edit-unknown-resolved-375`.                                                                                                                                             |
| R2-03 | fixed   | "Admin edit, the other preview and date states"; `admin-edit-date-reason-375`, `-1440`, `admin-edit-reason-error-375`, `admin-edit-stale-375`, `-1440`, `admin-edit-preview-loading-375`, `admin-edit-preview-error-375`, `admin-edit-error-375`, `-1440`; the blocked next step in `admin-edit-blocked-*`.                      |
| R2-04 | fixed   | Field parity: the receipt for ADMIN_INCOME / SENIOR_INCOME / EXPENSE only, with the text «Замінити» and an ✕ icon button named «Видалити чек» (specified, not removed); `admin-edit-cascade-*`.                                                                                                                                  |
| R2-05 | fixed   | `senior-edit-rejected-375`, `-1440`: rejection reason, project as text, no date or defaults row (M5); Field parity, senior rows.                                                                                                                                                                                                 |
| R2-06 | fixed   | `attach-receipt-*` (no project field, armed «Прикріпити після завантаження чека»), `attach-replace-375`, `attach-replace-confirm-375`; `senior-income-*` uses the armed label; Field parity, attach rows.                                                                                                                        |
| R2-07 | fixed   | "Save behaviour" gate paragraph (which kinds are keyed after Task 1.1); `unknown-keyless-375`, `-1440`, `unknown-check-375`; open point 1.                                                                                                                                                                                       |
| R2-08 | fixed   | 768 frames `error-definite`, `inflight`, `unknown-resubmit`, `armed`, `confirm-discard`, `transfer`, `admin-edit-blocked`, `admin-edit-saving`; `default-1000`, `edit-unknown-1000`; a rule in every other 640–1023 cell; Self-score, criterion 6.                                                                               |
| R2-09 | fixed   | Signed amounts in `armed-*`, `dirty-close-*`, `permission-limited-*`, «Сума −1 250,50 USD і чек не збережуться», the admin subtitle «Дохід · було +1 200,00 USD»; Strings intro (M11) names where a value is unsigned.                                                                                                           |
| R2-10 | fixed   | Locked record under «Надіслано 11 листопада о 14:32 · змінити не можна» (absolute date, full contrast, no «змінити»): `inflight-*`, `unknown-resubmit-*`, `unknown-keyless-*`, `admin-edit-saving-*`.                                                                                                                            |
| R2-11 | fixed   | "Save behaviour", reload paragraph; `reload-while-saving-375`.                                                                                                                                                                                                                                                                   |
| R2-12 | fixed   | Open point 10 (the two replacement test names).                                                                                                                                                                                                                                                                                  |
| R2-13 | fixed   | `unknown-closed-long-375` (scrolled to the end; the last row clears the pill and «+»).                                                                                                                                                                                                                                           |
| R2-14 | fixed   | `error-definite-320` full length; amount and code as one no-wrap unit in `long-content-*`; `long-content-collapsed-375`.                                                                                                                                                                                                         |
| R2-15 | fixed   | Unavailable primary is a flat `--secondary` fill (A1-9); safe-area inset under action sheets (`confirm-discard-375`, `dirty-close-375`); `error-definite-keyboard-375`. Sub-point rejected: `safeBottom` stays 0 at 320, because the foundation's 320 device has a home button and no home indicator (`base.mjs`, `safeBottom`). |
| R2-16 | fixed   | Fixtures per M13: the viewer's role in the shell, the edited row highlighted, the 422 frame keeps the category, one date (11.11) for sheet and list, DROP sees only its rows, `expense-company-375` shows «Джерело коштів».                                                                                                      |
| R2-17 | fixed   | `loading` row and "Save behaviour" (one rule for a tap while loading); `kind-picker-768`, `-1440` anchored under the pill; the timeout clause deleted; send time in the pinned-row subtitle (open point 14).                                                                                                                     |
| R2-18 | fixed   | Strings complete (three tables, checked against every frame); «піде на валідацію» per `CONTEXT.md`; the non-editable banner names its reason (payout vs payout request).                                                                                                                                                         |
