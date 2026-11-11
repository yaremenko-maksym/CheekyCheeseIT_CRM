# Primitives v2 — Foundation (Wave 0)

> Per-screen artifact (CRM redesign v2). Coder-ready spec of the shared primitives every v2 screen reuses.
> Visual and interaction language: `docs/design/foundation.md` v2 (tokens §7, containers §8, motion §9,
> interaction rules §11). Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md`.
> Scoring: `docs/design/rubric-calibration.md`.
>
> **The mockups are a visual reference, not code to paste.** Build on the existing `components/ui/*`
> (shadcn/ui) where one fits; the "Build on" column says which.

| Field          | Value                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope          | Sheets, list rows, section headers, forms, side panel, confirm, table rows, toasts / inline errors, uploads, skeletons, charts, pull-to-refresh, transitions |
| Showcase       | a Wave 0 showcase route renders every primitive in every state (spec §7, Wave 0)                                                                             |
| design-gate    | **degraded** — Playwright renders of HTML prototypes (`assets/src/`), Claude Design not driven                                                               |
| Status         | `captured` (mockups done; mockup-gate council pending)                                                                                                       |
| Sample data    | invented (names, amounts, projects)                                                                                                                          |
| Contact sheets | `assets/primitives-v2/_contact-sheet{,-wide,-detail}.png`                                                                                                    |

---

## 1. Component map

| Primitive                 | Build on                                                                                                      | New?                         | Frames                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bottom sheet (detents)    | Base UI Drawer (approved stack change, spec §4)                                                               | NEW `Sheet` mobile variant   | `sheet-medium-375`, `sheet-medium-320`, `sheet-large-375`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Action sheet (confirm)    | Base UI Drawer + `ui/alert-dialog.tsx` semantics                                                              | NEW variant                  | `sheet-confirm-375`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PickerSheet               | Base UI Drawer + `ui/command.tsx` (search, listbox); replaces `ui/select.tsx` / `ui/role-select.tsx` on touch | NEW variant                  | `picker-sheet-375`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TextEditor                | `ui/textarea.tsx` (autosize) + a chip row on `visualViewport`                                                 | NEW composite                | `form-longtext-375`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Side panel                | `ui/sheet.tsx` (side = right)                                                                                 | restyle                      | `sheet-panel-768`, `sheet-panel-1024`, `sheet-panel-1440`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Confirm dialog            | `ui/alert-dialog.tsx`                                                                                         | restyle                      | `sheet-confirm-dialog-1024`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| List row                  | —                                                                                                             | NEW `ListRow`                | `listrow-variants-375`, `listrow-swipe-375`, `listrow-sticky-320`, `listrow-empty-error-375`, `listrow-768`, `listrow-1440`                                                                                                                                                                                                                                                                                                                                              |
| Section header            | —                                                                                                             | NEW `ListSection`            | `section-header-375`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pushed detail page        | —                                                                                                             | NEW `DetailPage`             | `detail-txn-375`, `detail-person-375`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Receipt viewer            | Base UI Dialog (full screen)                                                                                  | NEW                          | `detail-txn-receipt-375`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Table row states          | `ui/table.tsx`                                                                                                | restyle                      | `listrow-table-desktop`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Form field                | `ui/input.tsx`, `ui/label.tsx`                                                                                | restyle (16 px, 48 h mobile) | `form-states-375`, `form-add-user-375`, `formfield-768`, `formfield-1440`                                                                                                                                                                                                                                                                                                                                                                                                |
| Money field + receipt     | `ui/amount-currency-input.tsx`, `ui/image-upload-field.tsx`                                                   | restyle                      | `form-money-375`, `form-receipt-link-375`, `form-receipt-usdt-375`, `form-receipt-usdt-empty-375`, `form-receipt-usdt-file-375`, `form-receipt-failed-375`, `form-keyboard-375`, `sheet-large-375` (one canonical form: `assets/src/money-form.mjs`)                                                                                                                                                                                                                     |
| Segmented control, switch | `ui/segmented-toggle.tsx`, `ui/switch.tsx`                                                                    | restyle                      | `form-money-375`, `sheet-medium-375`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Undo toast                | `ui/sonner.tsx`                                                                                               | restyle                      | `toast-undo-375`, `toast-undo-768`, `toast-undo-1440`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Save error (inline)       | `ui/alert.tsx`                                                                                                | restyle                      | `toast-error-definite-375`, `toast-error-offline-375`, `toast-error-unknown-375`, `toast-error-unknown-list-375`, `toast-error-unknown-match-375`, `toast-error-unknown-empty-375`, `toast-error-unknown-refetch-failed-375`, `alert-pagekill-failed-375`, `check-dialog-1024`                                                                                                                                                                                           |
| Upload states + indicator | `ui/upload-progress.tsx`                                                                                      | restyle + global pill (NEW)  | `upload-states-375`, `upload-pill-armed-375`, `upload-pill-saved-375`, `upload-pill-failed-375`, `upload-pill-multi-375`, `upload-pill-inflight-375`, `upload-pill-unknown-375`, `quick-add-drafts-375`, `drafts-desktop-1440`, `drafts-two-375`, `drafts-two-unresolved-375`, `toast-pill-stack-375`, `state-page-kill-375`, `alert-pagekill-sent-375`, `confirm-recreate-375`, `confirm-discard-draft-375`, `listrow-draft-375`, `upload-pill-768`, `upload-pill-1440` |
| Skeletons                 | `ui/skeleton.tsx`                                                                                             | restyle                      | `skeleton-mobile-375`, `skeleton-768`, `skeleton-1440`, `skeleton-table-desktop`                                                                                                                                                                                                                                                                                                                                                                                         |
| Charts                    | the existing chart library on `--chart-*` tokens                                                              | restyle                      | `chart-mobile-375`, `chart-mobile-scrolled-375`, `chart-mobile-320`, `chart-desktop`                                                                                                                                                                                                                                                                                                                                                                                     |
| Pull-to-refresh           | —                                                                                                             | NEW `PullToRefresh`          | `ptr-pulling-375`, `ptr-armed-375`, `ptr-refreshing-375`, `ptr-done-375`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Transitions               | View Transitions API + `motion` (`m.*`, LazyMotion)                                                           | NEW                          | `transition-storyboard`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 2. Sheets and panels

**Medium sheet** (`sheet-medium-*`): filters and short forms (≤ 4 fields). Top at ≈ 46% of the
viewport (36% at 320 so the content fits), `--radius-sheet` corners, drag handle (36 × 5, hit area
44), title row with «Скинути» on the left (resets the filters to their defaults) and a 44 px ✕ on the
right (closes and **discards unapplied filter changes**); the apply action «Показати 48» sits in the
bottom bar. Drag up expands to large; drag down past 30% or a fling dismisses. Scrim
`--scrim`.

**Large sheet / `ResponsiveSheet`** (`sheet-large-375`): long forms and edit. Full height minus the
status bar. Chrome, the same on every mobile form: «Скасувати» top-left, title centred, **nothing
top-right**; the primary («Зберегти зміни») sits in a bottom bar above the home indicator, or on the
keyboard when it is open. The pushed form page (`form-money-375`) uses the same bottom bar. The primary
is **always enabled** except while its own request is in flight (§4 Submit). **A dirty form asks
before it closes** (drag, scrim, Скасувати) with an action sheet. A **money draft** is the exception:
while it is armed, failed or unknown the leading control reads **«Згорнути»**, and drag, scrim and
«Згорнути» all close the sheet and **keep** the draft, with no confirm. Discarding a failed or unknown
draft is its own 44 px control «Видалити чернетку» under the primary, which opens the named confirm
(§4; foundation §11).

**PickerSheet** (`picker-sheet-375`, project picker over the money form, keyboard closed): one medium
sheet for every single choice from a long list: **project, user, currency, role**. Title names the field
(«Проєкт»), 44 px ✕ on the right (closes, nothing changes). A **sticky 44 px search** (16 px text) sits
under the title; rows are 56 px `role="option"` inside a `role="listbox"`; the current value carries a
yellow checkmark and `aria-selected="true"`. Order: for project, the «Без проєкту» row first; then
«Нещодавні» (last used on this device, newest first); then the full list alphabetically. A tap selects
and closes the sheet; focus returns to the field. Currency and role are short: same sheet, no search
under 8 options.

**Action sheet** (`sheet-confirm-375`): destructive confirm on touch. Message names the object
(«Видалити транзакцію «Оренда офісу»?»), destructive action in `text-destructive`, «Скасувати» as a
separate bold group. `role="alertdialog"`, focus starts on «Скасувати».

**Side panel** (`sheet-panel-*`): preview and edit on tablet / desktop. Width 400 (tablet, touch
heights 48 / 44), 420 (1024), 480 (≥ 1440). Header with title + close; sticky footer with the primary
action. **The tablet money panel (`sheet-panel-768`) reuses the canonical `moneyBody()` of the phone
form** at 400 px: the same field order, segmented type, currency pill, receipt and defaults row, with
«Скасувати» on the left and «Зберегти» in the footer. The frame shows a new draft, so the receipt is
empty: the 44 px «Файл» / «Посилання» switch over the «Додати чек» tile, exactly as on the phone. Where
drafts start, where the pill lives and where «Перевірити список» opens per size: `shell-v2.md` §4
«Money drafts per size». Shortcut hints («Esc», «⌘↵») show **only
under `(pointer: fine)`**: the 1024 / 1440 panels have them, the touch tablet does not. The table stays interactive next to it at ≥ 1440.

**Confirm dialog** (`sheet-confirm-dialog-1024`): 420 px centred alert dialog; initial focus on
«Скасувати»; Enter does not trigger the destructive action.

---

## 3. Lists

**List row** (`listrow-variants-375`): 56 px single-line / 64 px two-line, inset separator at 16.
Leading: 40 px avatar or 32 px icon tile. Primary line 16/22; secondary 15/20 muted; trailing value
right-aligned, `tabular-nums`, with sign (`+` positive, `−` destructive) and a status word or badge.
Pressed state `bg-accent`. Variants: navigation (chevron), value, toggle, destructive.

**At 768 / 1440** (`listrow-768`, `listrow-1440`): the tablet keeps the touch row (56 / 64, target ≥ 44).
**640–899 is a single pane with push**: the list takes the full width and a row pushes its detail, so
there is no selected-row highlight (no `aria-current`, no `bg-raised`). From **≥ 900** list and detail
sit side by side (`shell-v2/tablet-two-pane-1000`: rail 80, list 360, detail the rest, 560 at 1000)
and only there the selected row is `bg-raised` with `aria-current`. The desktop row is a 40 px table row (states default / hover / selected / focus ring 2 px /
pending; the selected row carries a 2 px yellow leading bar plus `bg-accent` and `aria-selected`) and a
36 px sidebar row; the full row is the hit area. Under `(pointer: coarse)` the table row is 52 and the
sidebar row 44 (`shell-v2/shell-touch-1180.png`).

**Empty and error inside a list** (`listrow-empty-error-375`): a filtered-empty block («Немає транзакцій
за цим фільтром» + «Скинути фільтри»), an empty group (one muted row, no illustration) and a failed group
(`role="alert"` row + «Повторити»). That «Повторити» re-reads data only; a money write is never retried
from a list.

**List footer** (`list-footer-375`): the paging states at the end of a loaded list. The next page
loading shows 3 skeleton rows under the loaded ones (`role="status"` «Завантаження ще транзакцій», the rows
`aria-hidden`). The next page failing shows one inline row in their place, «Не вдалося завантажити ще» with a
44 px «Повторити» (`role="alert"`), and the loaded rows stay. The end of the list shows no footer. Back from a
pushed detail restores the scroll position and every loaded page; it never resets to the first page. Like the
group «Повторити», this one re-reads data only.

**Swipe actions** (`listrow-swipe-375`): trailing edge only (no leading swipe: it collides with system
back). Revealed actions «Змінити» (secondary) and «Видалити» (destructive), each ≥ 72 × row height. A
full swipe does **not** delete; it asks with the action sheet. **Single-pointer alternative**
(SC 2.5.1 / 2.5.7): a row **with a pushed detail** (a transaction, a person) carries the same actions in
its detail page, so it shows no «…» and its title never loses width to one at 375. A row **without a
pushed detail** (a file, a receipt) shows a visible 44 px «…» button (`aria-label` «Дії з файлом»,
`aria-haspopup="menu"`); it and a long-press open the same actions as a context menu. Long-press on a
row with a detail opens the same menu as a shortcut, never the only path. Rows set
`-webkit-touch-callout: none` so the long-press does not raise the iOS link / image callout.

**Pushed detail page** (`detail-txn-375`, `detail-person-375`): the target of a row with a detail, and
the home of that row's swipe actions. **No bar title at rest** (the iOS Contacts pattern): the head's
text («Оренда офісу», the person's name) is the page `h1`; once the head scrolls under the bar it
becomes the centred inline title, inset 168 px on both sides so it truncates before the trailing
actions. Back on the left (a real `<button>`, `aria-label` «Назад»); on the right a 44 px text button
«Редагувати» (the edit entry) and a 44 px «…» (`aria-label` «Інші дії», `aria-haspopup="menu"`) for the
rest (delete asks with the action sheet). **Transaction:** the description, the amount 40/46 700
`tabular-nums` (never truncated), **one status-pill slot** under it («Оплачено» here), then one
key-value group (Тип, Платник, Отримувач, Дата, Проєкт as a link row `<a>`, Створив; long values wrap,
they do not truncate), then «Чек»: a 56 px thumbnail row, a real `<button>` («торкніться, щоб
збільшити», `aria-label` «Переглянути чек на весь екран»). This body is the one detail anatomy: the
≥ 900 detail pane renders the same component (`shell-v2.md` §3). A link receipt is the
same row with the host name and opens in the browser. The tap opens the **full-screen viewer**
(`detail-txn-receipt-375`): a `role="dialog"` on black, the file name, a 44 px ✕ «Закрити» top-left,
pinch and double-tap to zoom, Esc and a swipe down also close, focus returns to the thumbnail.
**Person:** a 72 px avatar with initials, name, «роль · команда», then «Контакти» as tappable 56 px
rows (`tel:`, `mailto:`, Telegram; the accessible name says the action, «Подзвонити: …»), then
«Робота» (Роль, Команда and Проєкти as link rows).

**Sticky section header** (`listrow-sticky-320`, `section-header-375`): overline 12/16 uppercase, 92%
translucent bar with blur while stuck; date sections show the day total on the right (`tabular-nums`).
Long titles truncate on one line with the full text as the accessible name.

---

## 4. Forms

**Field states** (`form-states-375`, a profile edit «Редагувати профіль»): label above (15/20), input
48 h (mobile) / 36 h (desktop), 16 px text, `--input-border` outline, `--placeholder` text. The frame
shows filled, focus, error, a PickerSheet field (Роль, enabled: a tap opens the PickerSheet) and a
disabled field with its reason («Email для входу» · «Привʼязаний до Google-акаунта»). Focus: yellow border + 3 px soft ring. Error:
destructive border + icon + message under the field (`aria-describedby`, `aria-invalid`). Disabled:
50% opacity + dashed border + a reason line («Роль змінює адміністратор»). Helper text 13/18 muted.
Validation on blur for format, on submit for required.

**Add user** (`form-add-user-375`): a pushed form «Новий користувач»: Імʼя, Email (hint «На цю адресу
прийде запрошення»), Роль and Команда as PickerSheet fields (each a real `<button>` with
`aria-haspopup="dialog"`), the primary «Додати» in the bottom bar. **Every pushed form clears its sticky
footer:** the content's bottom padding is the footer height (8 + 44 + 8) plus the safe area plus 16,
so the last field scrolls fully above the bar.

**Field → keyboard** (every mobile input sets these; the mock inputs carry them as attributes):

| Field         | `type`   | `inputmode` | `autocomplete`  | `autocapitalize` | `enterkeyhint`    | Also                                     |
| ------------- | -------- | ----------- | --------------- | ---------------- | ----------------- | ---------------------------------------- |
| Email         | `email`  | `email`     | `email`         | `none`           | `next`            | `autocorrect=off`, `spellcheck=false`    |
| Phone         | `tel`    | `tel`       | `tel`           | —                | `next`            |                                          |
| Name          | `text`   | `text`      | `name`          | `words`          | `next`            |                                          |
| URL (receipt) | `url`    | `url`       | `off`           | `none`           | `done`            | `autocorrect=off`, `spellcheck=false`    |
| Amount        | `text`   | `decimal`   | `off`           | —                | `done`            | parsed, never `type=number` (§4 parsing) |
| Search        | `search` | `search`    | `off`           | `none`           | `search`          | `autocorrect=off`                        |
| OTP / code    | `text`   | `numeric`   | `one-time-code` | `none`           | `done`            | `pattern="[0-9]*"`                       |
| Long text     | —        | `text`      | `off`           | `sentences`      | `enter` (newline) | `textarea`; the save is a button         |

The last field of a form uses `enterkeyhint="done"`; Enter on it submits only where the form has a
single primary and no textarea.

**At 768 / 1440** (`formfield-768`, `formfield-1440`): the tablet keeps 48 h / 16 px (touch, no iOS zoom)
in two columns; the desktop field is 36 h / 14 px with a 13 px label and 12 px helper, target ≥ 24 px
(SC 2.5.8). The states are the same at every width.

**Money form — one canonical shape** (`form-money-375` pushed page, `sheet-large-375` edit,
`form-keyboard-375`, `shell-v2/quick-add-txn-*`; source `assets/src/money-form.mjs`). Order: receipt,
amount, type, then the defaults row. Amount 44/52 700 `tabular-nums`, `inputmode="decimal"`, centred;
under it a 44 px currency pill and a 44 px segmented type control (36 px visual fill inside a 44 px hit
area) over the role's existing create types (the frame shows the ADMIN set Витрата / Дохід / Переказ =
`EXPENSE` / `ADMIN_INCOME` / `ADMIN_TRANSFER`; the Wave 1 finance spec owns the exact set per role).
The optional fields are collapsed into a 44 px defaults row that names what will be saved: «Сьогодні ·
без проєкту · змінити»; a tap expands Дата / Проєкт / Опис. **The receipt is mandatory: exactly one
of a file or a link** (`receiptMandatoryError` in `packages/shared/src/schemas/finance/validation.ts`,
both at once is refused too). The empty tile has two modes, **«Файл» / «Посилання»**
(a 44 px segmented control): «Файл» is one dashed tile «Додати чек — Камера, фото або файл · до 10 МБ»
(one file input without `capture`, so iOS offers its native chooser); «Посилання» is a URL field
«Посилання на чек» (`form-receipt-link-375`; any `http(s)` link). Once a file is added, a card with the
thumbnail, the title, the status line, **«Замінити»** and **«✕»** (`aria-label` «Видалити чек»), both
44 × 44 real `<button>`s, replaces the switch (remove the file to switch to a link). **While uploading**
the title is the file name and the status line reads «Завантаження · 62%»; **«Чек додано»** appears
only at 100% (status «220 КБ», which truncates with an ellipsis before it can run under «Замінити»).
**Upload failed** (`form-receipt-failed-375`): the card stays, red, with «Не завантажено · 220 КБ», the
error «Чек не завантажився: з’єднання перервалося» and two 44 px exits «Повторити» / «Замінити»; on an
armed draft this makes the draft **failed** (foundation §11), never a silent disarm. «Повторити» re-arms it: the payload and the intent are kept, so one tap retries the upload and arms the same save again. The percent is the thumbnail ring's `progressbar`, not a
live region (the status text is `aria-hidden`). **Below 360 px** «Замінити» becomes a 44 px icon button
`refresh-cw` (`aria-label` «Замінити чек») and the status line shows only «62%»
(`shell-v2/quick-add-txn-armed-320`). **Effective currency USDT: a link only**, and it must be a
blockchain-explorer link: the file mode is gone. With an **empty** receipt the explorer-link field
renders directly, with no «Файл» / «Посилання» switch and no camera tile
(`form-receipt-usdt-empty-375`); a non-explorer link gets the inline error (`form-receipt-usdt-375`).
**A currency change is an edit:** it disarms an armed save. Switching to USDT with a file attached,
uploading or armed **keeps the file card** with a red border, the inline error «Для USDT потрібне
посилання на транзакцію в експлорері» (the card's `aria-describedby`) and two 44 px exits,
**«Замінити посиланням»** (opens the explorer-link field in place of the card) and **«Видалити чек»**
(`form-receipt-usdt-file-375`). **Nothing is deleted silently**; the upload is not aborted by the
currency switch. Leaving USDT keeps the explorer link: a link is valid for any currency. The link field is `type=url`,
`inputmode=url`, `autocapitalize=none`, `autocorrect=off`, `enterkeyhint=done`. **A save without a
receipt:** the primary stays enabled (house rule); a tap focuses the receipt and shows the inline
error «Додайте чек: файл або посилання» (USDT: «Для USDT потрібне посилання на транзакцію в
експлорері», also for a link that is not an explorer link). No path saves without a receipt. The pushed page (`form-money-375`) renders the same defaults row as the
sheet, not expanded fields.

- **Defaults** (what the defaults row names): type and currency = the last used **on this device**;
  project = the screen the form was opened from (a project page), otherwise «без проєкту»; date =
  today. The row always states the values that will be saved.
- **Date field:** a native `<input type="date">` on touch, inside the 48 px field (the OS picker, no
  custom calendar on a phone); the desktop keeps the existing date picker.
- **Amount parsing:** accept «,» and «.» as the decimal mark; strip spaces (including the narrow
  no-break space a paste may carry); at most 2 decimals (a third is refused as you type, not rounded);
  on blur re-format in uk style («1 250,50»). The value sent is the parsed number, never the display
  string.
- **Pickers** for project, user, currency and role are the PickerSheet (§2).

**TextEditor** (`form-longtext-375`, 375 × 667, keyboard open; contract templates with
`{{placeholders}}`): a pushed page; the text area **autosizes** to its content (no inner scroll; the
page scrolls), 16 / 24 text. **Token highlight technique:** a mirror layer behind a transparent
`textarea`, with the same font, size, line height, padding, wrapping and scroll position; the mirror
repeats the text with `{{tokens}}` wrapped in yellow spans and is `aria-hidden`. The `textarea` stays
the source of truth (value, caret, selection, IME, undo, spellcheck); the mirror is redrawn from its
value on every input. **Keyboard closed:** the bottom bar holds the chip row over the primary «Зберегти
шаблон». **Keyboard open:** the bar collapses to the chip row only, and the save moves into the top bar
as a 44 px text button «Зберегти» (the one place a save sits top-right, because the keyboard leaves no
room). The text window at 375 × 667 is 667 − 54 status − 44 top bar − 61 chip row − 290 keyboard =
218 px: **at least 8 lines of 24 px** stay visible. The scroller sets `scroll-padding-bottom` equal to
the bar height (61 px), so the caret line is never under the chips. The chip row «Вставити змінну»
(`role="group"`) scrolls horizontally: 44 px chips that show **the uk label only** («Клієнт»); the
token goes in the `aria-label` («Вставити змінну Клієнт, {{client_name}}»);
a tap inserts the token at the caret. **«Усі змінні»** is a 44 × 44 icon button `{ }` (`braces`,
`aria-label` «Усі змінні», `aria-haspopup="dialog"`) pinned at the row's trailing edge (it never
scrolls away), so the row shows more than one chip at 375. It opens a PickerSheet with search over every variable
(`picker-sheet-375` pattern); a pick inserts at the caret and returns focus to the `textarea`. **A dirty close asks** («Вийти без збереження?»
with «Вийти» and «Залишитися»); nothing is persisted client-side.

**Keyboard** (`form-keyboard-375`, `shell-v2/quick-add-txn-keyboard-375`): the content scrolls so the
focused field sits above the keyboard, and the submit bar rides on the keyboard. **The accessory bar
(˄ ˅ «Готово») is iOS Safari's own, not ours:** we do not design or build one; the frames draw it
labelled "system · iOS Safari" only so the layout height is honest. **Wave 0 device check:** at 320 and
375 on a real iPhone (or the iOS Simulator), the bottom submit bar tracks `visualViewport` (height and
`offsetTop`) and sits directly on the system bar with no jump while the keyboard opens, closes or
switches between decimal and text. **TextEditor with the keyboard open:** iOS pans the layout
viewport, so the top bar holding «Зберегти» is pinned to `visualViewport.offsetTop` (it follows the
pan and never scrolls off with the page); the device check confirms «Зберегти» stays visible and
tappable while the caret moves down a long template.

**Submit — always enabled.** The primary is never disabled for invalid or untouched values: a tap
validates, moves focus to the first invalid field and shows the inline errors. **While its own request
is in flight** it is `aria-disabled="true"`, never `disabled`: it ignores taps (no double submit),
keeps focus and its name, the label stays and a 16 px spinner replaces the icon (`aria-busy="true"`
on the form). `disabled` would drop focus to the body, the same reason the armed button is
`aria-disabled`.

**Armed save** (`shell-v2/quick-add-txn-armed-375`, `-320`, `upload-pill-armed-375`): the lifecycle
is the state table in foundation §11; this is the component view. While a receipt uploads, the primary
reads «Зберегти після завантаження чека». A tap **freezes the payload** and arms. The armed button (min
56 px) reads «Збережеться 1 250,50 USD після чека» with the receipt progress as a fill; «чек 62%» is a
`role="progressbar"` with `aria-valuenow`, never a live region. A visually hidden `role="status"`
announces only arm, disarm and result. **The armed primary is `aria-disabled="true"`** (never
`disabled`: it keeps focus and its name); a repeat tap toggles nothing (no `aria-pressed`) and shows
the hint «Чек ще завантажується. Транзакція збережеться сама, щойно він завантажиться». **Disarm is a
separate control**: the 44 px text button «Не зберігати автоматично» under the primary; any field edit,
and replacing or removing the receipt, also disarms. A **receipt upload that fails** on an armed draft
does not disarm: the draft becomes failed (pill «Не збережено 1 250,50 USD · Відкрити», a pinned row,
the error on the receipt card; `form-receipt-failed-375`). An armed draft blocks nothing: «+» opens a new
form. While armed the leading control reads **«Згорнути»**:
it closes the sheet and the save stays armed; a drag down and a scrim tap do the same. On the closed
sheet the global upload pill carries the save; the result then stays in the pill until tapped
(`upload-pill-saved-375`, `upload-pill-failed-375`); a sheet never opens by itself. A page kill is
reported at the next boot by the marker's phase (`state-page-kill-375` armed, `alert-pagekill-sent-375`
sent). On `sent` the alert opens the check sheet with no draft form behind it: it names the time, not an
amount, and offers no resubmit; until the late-commit guard's refetch succeeds its footer button reads
«Закрити» and keeps the markers, like ✕; after it «Зрозуміло» acknowledges the alert and removes the `sent`
markers, and ✕ still closes the sheet and keeps them, so the boot alert returns on the next boot (`check-sheet-boot-375`); a failed refetch there
reuses the «Не вдалося оновити список» alert with «Повторити». The amount never truncates: at 320 it steps 44 →
34 px, the armed label wraps to two lines, and the sheet title truncates (`quick-add-txn-armed-320`).

---

## 5. Feedback

**Undo toast** (`toast-undo-375`): bottom, above the tab bar, 14 radius, «Співбесіду архівовано» +
«Скасувати» (44 h), thin progress line for the remaining time. `role="status"`. Only for actions that
are already reversible in the product. On tablet and desktop there is one corner for
everything that floats: bottom-right, 24 px from both edges, 420 wide (`toast-undo-768`, with a 44 px
action; `toast-undo-1440`, with a 40 px action). When the upload pill is there too, toasts stack above
it in the same corner. While a pill or toast shows, the tablet and desktop scrollers get bottom padding equal to the stack height + 24, so the corner never covers the last row (`drafts-desktop-1440`); with a side panel open the corner moves left of the panel.

**Save error** — for money creates the error is an **inline `role="alert"` above the form**, never a
floating toast over a field, and the values stay in the form. **No auto-retry**, ever. Two cases that
must not share one UI (spec §4.5b):

- **422 — the values are wrong** (`toast-error-definite-375`): the error sits inline on the field
  («Жовтень уже закрито. Оберіть дату від 1 листопада.», invented reason), focus moves there, the
  optional fields expand to show it. **No retry button**: the primary stays «Зберегти».
- **Definite failure, not about a field** (`toast-error-offline-375`): another 4xx, a 500 / 503
  returned by the app itself (it carries the app's error envelope), or the app knew it was offline
  before sending. Nothing was written. «Транзакцію не надіслано» + the cause; the values and the receipt
  stay; the primary becomes «Повторити збереження» (manual). App 500/503 counts as definite only for endpoints that commit in one DB transaction and swallow post-commit errors; Wave 1 verifies this per endpoint (AC + test) before the form shows a retry.
- **Unknown outcome** (`toast-error-unknown-375`): a 502 / 504 from the gateway, a Cloudflare 524, a 5xx
  without the app's error envelope, a connection dropped after the request left, or a client timeout.
  Any of these can arrive after the origin committed. On the four forms without an idempotency key (expense, admin-income, admin-transfer, company
  deposit) the alert reads «Невідомо, чи транзакцію збережено» / «Відповідь не надійшла. Форма й чек
  залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.»; the form and the
  receipt stay and there is **no retry button on the alert**. **The unknown draft is read-only**: the
  sent values stay visible under «Надіслано о 14:32 · змінити не можна», every control dimmed and
  `aria-disabled="true"` (announced, never hidden, never `inert`); the optional fields are expanded as read-only text
  (Дата, Проєкт, Опис) with no «змінити» link, so the sent values can be matched in the check sheet;
  the check sheet and a recreate use
  exactly the sent payload, and changing a value means discarding the draft. A failed draft stays
  editable and a re-save sends one new request with no gate (nothing was saved). The leading control
  reads «Згорнути» and keeps the draft; under the footer primary sits «Видалити чернетку». The footer «Перевірити список», the filled primary of a locked unknown draft (the form is inert), opens the
  **check sheet** «Нові записи» **over the kept form** (`toast-error-unknown-list-375`), refetched on
  open. The header names what to look for, «Шукаємо: −1 250,50 USD · Витрата · надіслано 14:32», and
  the sheet lists **only the current user's own rows created from `t − 5 хв`, newest created first** («Лише ваші записи з
  14:27»: the margin absorbs a device clock that runs ahead of the server, and the sub-header names the
  real bound), without filters or date sections, each row with its business date and its server
  creation time.
  **A highlight means a match, by payload and by server time:** each refetch computes `offset = server − device` from the response `Date` header, and a row is a «збіг» only when every sent field is equal (amount, currency, type, business date, project, description or recipient) **and** its `created_at >= t + offset − 5 s`; only that row gets the
  tint, the 3 px yellow bar and «збіг · 14:33» (`toast-error-unknown-match-375`). **«схожа» means the same type, currency and amount, with at least one other sent field different**; a row with a different type or currency is «нова», whatever its amount (so «Оплата від клієнта +1 250,50 USD · Дохід» beside a 1 250,50 USD expense draft is «нова»). A «схожа» row names the field that differs: «схожа · інший опис · 14:33» (or «інший проєкт», «інша дата», «інший отримувач»; two or more: «схожа · інші дані · 14:33»); rows never open a detail inside the sheet. A row whose every sent field matches but fails the time test reads «раніше · 14:29». On a phone a tag that names the difference takes its own line under the row's meta, so the title never truncates. A «схожа» never becomes a «збіг», so «Є в списку — закрити чернетку» keeps its named confirm. **A «схожа» after the send is a warning, not noise:** an equal-amount row that passes the time test but whose payload differs (for example, the server trimmed the description) is the likeliest real commit. It takes the warning tone (`--warning`, «схожа · інший опис · 14:33», not muted), the hint names the same field («У списку є схожа о 14:33: та сама сума, інший опис. Перевірте її, перш ніж створювати ще раз.»), the status reads «Оновлено о 14:34:01. Знайдено схожу» (never the unlock), «Є в списку — закрити чернетку» becomes the one filled primary (its named confirm stays), the close confirm reads «Закрити чернетку 1 250,50 USD? Збігу немає, але є схожа о 14:33.» instead of the base «У списку її не знайдено», and the recreate confirm adds «У списку є схожа о 14:33» (`toast-error-unknown-similar-375`, `confirm-recreate-375`). A «схожа» that fails the time test stays muted («схожа · інший опис · 14:29», `toast-error-unknown-match-375`). Without a `Date` header no row is a «збіг»: every row with the same type, currency and amount is «схожа» (naming a differing field when there is one). The query still starts at `t − 5 хв`, so a fast device clock cannot hide the row. Other new rows show
  «нова · 14:33» only, in `--muted-foreground` (only «збіг» uses the brand yellow); with new rows and no match «Збігів немає» sits above the exits; with none the
  body reads «Нових записів з 14:27 немає» (`toast-error-unknown-empty-375`). Money uses one
  notation, `<amount> <CODE>` (foundation §6). A 44 px «Оновити» refetches («Оновлено о 14:33:18» is
  the one `role="status"`). **A failed refetch** (`toast-error-unknown-refetch-failed-375`) shows
  `role="alert"` «Не вдалося оновити список» with a 44 px «Повторити» in place of the status line and
  the list, never the empty text or «Збігів немає»; the hint reads «Список не оновився. Створити
  транзакцію ще раз можна лише після того, як він оновиться.». A 401 is not a failed refetch: the sheet then shows the session alert «Сесія завершилася» instead of «Повторити» (`alert-session-expired-375`, foundation §11). Two exits under the list (with a «збіг» the first becomes the filled primary, the hint names the
  row «Схоже, це ваша транзакція: −1 250,50 USD, створена о 14:33. Перевірте її, перш ніж створювати ще раз.» and the recreate confirm adds «У списку є збіг о 14:33»): «Є в списку — закрити
  чернетку» (closes the draft, sends nothing; one tap with a «збіг», otherwise the confirm «Закрити чернетку 1 250,50 USD? У списку її не знайдено», or «…? Збігу немає, але є схожа о 14:33.» with a warning «схожа»,
  `toast-error-unknown-empty-375`) and «Немає — створити ще раз», which is `aria-disabled` (described by the hint
  line) until **60 s after the failure arrived** (not after the send: nginx `proxy_read_timeout 60s`
  and Cloudflare's 100 s mean a timeout can arrive after a send-based gate while the origin may still
  commit), showing «Можна через 0:42» until then (`aria-hidden`; the countdown is **never in a live
  region**). It unlocks only after a **successful** refetch that ran at least 60 s after the failure
  arrived. At the gate one automatic refetch runs, and the status announces the unlock once
  («Оновлено о 14:34:01. Тепер можна створити ще раз»; with a «збіг» the status reads «Оновлено о 14:34:01. Знайдено збіг» and never announces the unlock; the unlock text shows only when there is no match); then a confirm «Створити 1 250,50 USD ще
  раз?» and exactly one new create. Wave 1 AC: the list API takes a created-after time and returns the current user's rows
  created from it, ordered by creation time, newest first. The list response exposes `Date` (`Access-Control-Expose-Headers` if the API is cross-origin). The check-sheet fetch is a network request with `cache: 'no-store'`, excluded from every service-worker route and from the TanStack cache: a cached or service-worker fallback never unlocks the recreate and never gives the offset. Only a 2xx response counts as a successful refetch, and `offset` comes only from that response's `Date`. «збіг» compares the server-normalised values (as the list returns them), never the values the form sent. This is a user-confirmed new
  create after seeing the refreshed list, not an automatic or one-tap resubmit (provisional; the owner
  confirms at PNG approval). Closing the sheet returns to the form. When the user reaches the Finance
  list another way, the kept draft is a pinned row at the top (`listrow-draft-375`): the amount alone
  on one line with no wrap («1 250,50 USD»), the state line «Не збережено · Витрата» (after an unknown
  outcome «Результат невідомий · Витрата») and **one** 44 px tonal «Відкрити» (no other action on the row). A pinned row is never a primary: its «Відкрити» is tonal (foundation §7.5). The 2 px leading bar, the border and the «Відкрити» tint are `--destructive` for a failed draft and `--warning` for an unknown one; armed and in-flight rows stay muted. The phone row carries no icon tile, so the state line fits on one line at 375 beside «Відкрити»; the desktop row keeps its icon. **Up to three pinned rows** show, unresolved first by the slot precedence; the block collapses only when it saves a row: from four drafts on, two show and the rest collapse into one row «Ще N чернеток · Показати» (N ≥ 2), which expands them in place; its label then toggles to «Згорнути», it keeps `aria-expanded`, and it resets to collapsed on a route change (`drafts-two-unresolved-375`; four drafts, collapsed: `drafts-four-collapsed-375`, two rows and «Ще 2 чернетки · Показати» with `aria-expanded="false"`; the count takes the Lingui plural, «Ще 5 чернеток»). Each row has two lines: the amount alone on one line with no wrap («1 250,50 USD»), then state · type («Результат невідомий · Витрата»). «+» never blocks: with unresolved drafts (failed or unknown), **on Фінанси every «+» opens a new form directly** (the FAB, the rail «+», the header «Нова транзакція» and `C`): the pinned rows and the pill already show the drafts there, and `C` stays one key on the main money page. On the other pages a money draft **never hides other actions**: the drafts join the existing «+» menus and never replace them. The quick-add sheet (phone) and the rail «+» menu (tablet) keep the role's normal action list; with unresolved drafts a «Чернетки» section sits on top, each draft row in the pinned-row format (the amount, then state · type, and «Відкрити»); **any menu shows at most 2 draft rows** (the quick-add sheet, the rail «+» menu and the header compact menu): from 3 drafts, the first 2 by the slot precedence and a last row «Усі чернетки (N)», which opens Фінанси scrolled to the pinned rows, then the normal actions in `role="group"` with a visually hidden label «Дії» (the drafts group is labelled by its «Чернетки» header), «Нова транзакція» among them (`primitives-v2/quick-add-drafts-375` from Статистика and `drafts-chooser-768` from Співбесіди, both with the 4 ADMIN actions); in the rail menu «Нова транзакція», the first normal action, takes the initial focus without a drawn ring: the tablet is touch, and the ring shows only on `:focus-visible` (a keyboard). A page FAB whose action is not money (Користувачі «Новий користувач», Співбесіди «Нова співбесіда», Вакансії «Створити вакансію») never changes and gets no dot. The header «Нова транзакція» and `C`, a money trigger by name, open a compact menu: the «Чернетки» section above, «Нова транзакція» last with the initial focus, so `C` then Enter still creates (`primitives-v2/drafts-chooser-1440` on Статистика). Every menu off the phone is `role="menu"` with the trigger `aria-haspopup="menu"`; ↑ / ↓ move between the items, and Esc closes it and returns focus to the trigger; under `(pointer: coarse)` the key hints («↑ ↓», «Enter») are hidden and a draft's state line is at least 13 px. The money FAB on Фінанси and the quick-add «+» keep their «+» and gain a red dot (with the count from two); the accessible name says the count: «Нова транзакція, 1 чернетка потребує уваги» on Фінанси, «Створити, 2 чернетки потребують уваги» on the quick-add «+» (`listrow-draft-375`,
  `upload-pill-failed-375`). After the first
  Wave 1 task ships the key, a form that has it may offer a resubmit with the same key.

**Offline** (`shell-v2/state-offline-375`): the FAB stays enabled (no dim, no `aria-disabled`). A save
while offline gives the definite alert above (`toast-error-offline-375`) with every value kept.

**Carve-out — no optimistic insert** on those four forms until the key ships: the new row appears in
the list after the server confirms, not before.

**Uploads** (`upload-states-375`): per-file row with a progress ring (`role="progressbar"`) and a 44 px cancel ✕ (uploading
62%, compressing), done («Готово» with a check), and failed (the reason wraps; 44 px «Інший файл» for a
rejected file, «Повторити» for a dropped connection). A global pill «2 чеки · 40%» (the ring is the
`progressbar`; a hidden `role="status"` says «Почалося завантаження 2 чеків» once, then only finished /
failed; 44 px chevron) stays above the tab bar on any screen while uploads run.
On a phone it sits left of the FAB (inset 12 left, 80 right, 16 above the tab bar; foundation §3), as
does the undo toast. On tablet and desktop it takes the one floating corner, bottom-right, 24 px from
both edges, and toasts stack above it (`upload-pill-768`, 320 × 52; `upload-pill-1440`, 40 px). Uploads are in-memory: closing the app loses them; the UI says
so only when the user tries to close a sheet with uploads running, and an armed money save lost this
way is reported at the next boot (`state-page-kill-375`: a persistent inline alert «Транзакцію не
збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.» with «Зрозуміло»; the
`localStorage` marker behind it is `{ t, phase }`, never an amount). A kill **after the create was
sent** shows instead «Результат збереження транзакції о 14:32 невідомий. Вона могла зберегтися: перевірте нові
записи, перш ніж створювати її знову.» (the
time is the marker's `t`) with «Зрозуміло» («Закрити» until the late-commit guard's refetch succeeds) and, on the Фінанси tab, «Оновити список» (elsewhere
«Відкрити Фінанси»), and no resubmit; either action opens the check sheet «Нові записи» (the user's own rows, each «нова» or «раніше»; there is
no «Шукаємо» line, and the exits are ✕ and «Закрити» / «Зрозуміло») filtered from the earliest `t − 5 хв` with the same server-time test: a row created before `earliest t + offset − 5 s` reads «раніше · 14:29»; when `t` is not today every boot time carries the date («10.11 о 14:32», «з 10.11 14:27», «раніше · 10.11 14:29»); no amount is known, so no row is a «збіг» or «схожа». **Late-commit guard:** app-owned from boot, sheet open or not, on any tab (foundation §11 boot rules, the one definition): one background no-store refetch at `max(boot, latest sent t + 160 s)`; «Закрити» until its 2xx, then «Зрозуміло» and the hint «…створіть її знову»; a failed refetch retries once at the next foreground
(`alert-pagekill-sent-375`). The phases and when the marker is cleared: foundation §11. **Confirms**
use the action-sheet confirm (`sheet-confirm-375`; `actionConfirm` in the mockup sources), two 56 px
rows, stacked above an open sheet: `confirm-recreate-375` («Створити 1 250,50 USD ще раз?» ·
«Створити ще раз» · «Скасувати», from the unknown-outcome exit) and `confirm-discard-draft-375`
(«Видалити чернетку 1 250,50 USD?» · «Видалити» · «Залишити», for a failed or unknown draft; for an
unknown one the description adds «Якщо транзакцію вже збережено, вона залишиться в списку.»; never
while its request is in flight). A boot with several markers shows **one alert per phase** with a
count and the earliest time («Результат збереження 2 транзакцій невідомий, перша о 14:32…»;
foundation §11).

**Money pill** (one 56 px pill, one slot): armed «Збережеться 1 250,50 USD · 62%» /
«Відкрити чернетку» (`upload-pill-armed-375`); saved «Збережено 1 250,50 USD» / «Відкрити» with a 44
px ✕ (`aria-label` «Закрити»; a swipe also dismisses, the body still opens the transaction;
`upload-pill-saved-375`); in flight «Зберігаємо 1 250,50 USD…» / «Відкрити» (between 100% and the result; `upload-pill-inflight-375`); failed
«Не збережено 1 250,50 USD» / «Відкрити» (`upload-pill-failed-375`); unknown «Результат невідомий» /
«1 250,50 USD · Відкрити» (`upload-pill-unknown-375`). A result **stays until tapped** (or
dismissed); it never times out. **Several drafts** (foundation §11): the slot shows the highest state,
**unknown > failed > in flight > armed > saved**, naming the amount for one draft and a count for more:
two armed «Збережеться 2 транзакції» / «Відкрити» (never one merged percentage: each pinned row shows
its own; `upload-pill-multi-375`); «+2 чеки» counts only uploads that belong to no draft; two or more
failed or unknown «2 потребують перевірки» / «Відкрити», which opens Фінанси at the pinned rows, and the
FAB dot carries the count (`drafts-two-unresolved-375`). A save that completes under a failed or
unknown pill shows as a normal success toast stacked above it; the pill keeps its own state. Фінанси pins a row per unsaved draft by the slot precedence, up to three; from four on, two and the rest in «Ще N чернеток · Показати» (N ≥ 2)
(`drafts-two-375`: one failed and one armed; the failed one wins the pill). Without a money draft the
slot holds the plain upload pill. **Toast + pill** (`toast-pill-stack-375`): the pill keeps the base slot (left 12,
right inset 80, left of the FAB); a toast stacks 8 px above it; at most one toast at a time. A toast
timer pauses while the page is hidden.

**Skeletons** (`skeleton-mobile-375`, `skeleton-768`, `skeleton-1440`, `skeleton-table-desktop`): blocks
match the final layout (row heights, avatar circles, right-aligned values; on the tablet the single pane below 900 and both panes from 900; on
the desktop the shell is real and only the table is skeletal); shimmer 1.2 s, off under reduced motion.

---

## 6. Charts

`chart-mobile-375` / `chart-mobile-320`: one question per viewport («Чистий прибуток»); bars in
`--chart-1`; **negative months hatched with a `−` label below zero**; zero line `--chart-grid`; tap a bar
for a tooltip with the exact value (the hit area is the full-height column band; under 44 px, as in the
12-bar «Рік», drag-scrub with a persistent value line above the chart, foundation §7.4); the period is a 44 px segmented control (swipe is an extra, not the
only way). The second, smaller chart (partners) sits **below the fold** (`chart-mobile-scrolled-375`),
with the partners' **initials** («ВК», «ОШ») directly under their bars, no legend, and the full
names in the accessible summary. Bars and ticks carry bare numbers («4,2», «8»); the caption row states
the unit once («тис. USD»), and the accessible summary says «тис. USD». `chart-desktop`: hover tooltip (values `white-space: nowrap`, min-width 176 px; it sits beside the bar, on the right when there is room and otherwise on the left, never over a bar), keyboard focus on bars (arrow keys), series swatches carry
token names, the chart follows the table filters.

---

## 7. Pull-to-refresh and transitions

**Pull-to-refresh** (`ptr-*`, drawn with the tab bar so the scroller bounds are honest): pulling
(arrow), armed at 64 px (arrow rotates 180°, turns yellow; no haptics — iOS Safari has none), refreshing (spinner, content held at 50 px), done («Оновлено щойно», 1 s, then collapses).
Only on tab-root lists. Under reduced motion the arrow does not rotate; the state text changes instead.
Rules from spec §4.2: the gesture lives on the **list scroller only** and **refetches that list's query**
(other queries on the screen are untouched); it **never reloads the page**; it is **off while a sheet is
open**. iOS Safari's own page pull-to-refresh is not reliably disabled by `overscroll-behavior`, so Wave 0
proves on the iOS Simulator that a sheet drag at `scrollTop` 0 and a pull on a list never reload the
page (acceptance criterion).

**Transitions** (`transition-storyboard`): push / back 280 ms slide + fade (View Transitions), tab switch
instant, sheet 280 ms up / 150 ms down, desktop 150 ms crossfade, reduced motion = 120 ms crossfade.

---

## 8. Frames (all PNG under `assets/primitives-v2/`)

83 frames; phones and component crops render at 2×, full 768 / 1024 / 1440 screens and the storyboard at 1×. Every
PNG is ≤ 400 KB.

| Frame                                    | Viewport (CSS px) | PNG (px)    |  KB | Round            |
| ---------------------------------------- | ----------------- | ----------- | --: | ---------------- |
| `sheet-medium-375`                       | 375 × 812         | 750 × 1624  |  33 |                  |
| `sheet-medium-320`                       | 320 × 568         | 640 × 1136  |  25 |                  |
| `sheet-large-375`                        | 375 × 812         | 750 × 1624  |  32 |                  |
| `sheet-confirm-375`                      | 375 × 812         | 750 × 1624  |  44 |                  |
| `listrow-variants-375`                   | 375 × 812         | 750 × 1624  |  38 |                  |
| `listrow-swipe-375`                      | 375 × 812         | 750 × 1624  |  40 |                  |
| `listrow-sticky-320`                     | 320 × 568         | 640 × 1136  |  45 |                  |
| `listrow-empty-error-375`                | 375 × 812         | 750 × 1624  |  41 |                  |
| `listrow-768`                            | 768 × 400         | 1536 × 800  |  47 |                  |
| `listrow-1440`                           | 1440 × 420        | 1440 × 420  |  23 |                  |
| `section-header-375`                     | 375 × 812         | 750 × 1624  |  30 |                  |
| `form-states-375`                        | 375 × 812         | 750 × 1624  |  32 |                  |
| `form-add-user-375`                      | 375 × 812         | 750 × 1624  |  22 |                  |
| `detail-txn-375`                         | 375 × 812         | 750 × 1624  |  35 |                  |
| `detail-txn-receipt-375`                 | 375 × 812         | 750 × 1624  |  31 |                  |
| `detail-person-375`                      | 375 × 812         | 750 × 1624  |  25 |                  |
| `formfield-768`                          | 768 × 500         | 1536 × 1000 |  34 |                  |
| `formfield-1440`                         | 1440 × 360        | 1440 × 360  |  15 |                  |
| `form-money-375`                         | 375 × 812         | 750 × 1624  |  27 |                  |
| `form-receipt-link-375`                  | 375 × 812         | 750 × 1624  |  30 |                  |
| `form-receipt-usdt-375`                  | 375 × 812         | 750 × 1624  |  35 |                  |
| `form-receipt-usdt-empty-375`            | 375 × 812         | 750 × 1624  |  33 |                  |
| `form-receipt-usdt-file-375`             | 375 × 812         | 750 × 1624  |  36 |                  |
| `picker-sheet-375`                       | 375 × 812         | 750 × 1624  |  37 |                  |
| `form-longtext-375`                      | 375 × 667         | 750 × 1334  |  45 |                  |
| `form-keyboard-375`                      | 375 × 812         | 750 × 1624  |  31 |                  |
| `sheet-panel-768`                        | 768 × 1024        | 768 × 1024  |  42 |                  |
| `sheet-panel-1024`                       | 1024 × 768        | 1024 × 768  |  42 |                  |
| `sheet-panel-1440`                       | 1440 × 900        | 1440 × 900  |  51 |                  |
| `sheet-confirm-dialog-1024`              | 1024 × 768        | 1024 × 768  |  49 |                  |
| `listrow-table-desktop`                  | 960 × 300         | 1920 × 600  |  32 |                  |
| `toast-undo-375`                         | 375 × 812         | 750 × 1624  |  51 |                  |
| `toast-undo-768`                         | 768 × 1024        | 768 × 1024  |  29 |                  |
| `toast-undo-1440`                        | 1440 × 900        | 1440 × 900  |  34 |                  |
| `toast-error-definite-375`               | 375 × 812         | 750 × 1624  |  38 |                  |
| `toast-error-unknown-375`                | 375 × 812         | 750 × 1624  |  46 |                  |
| `toast-error-unknown-list-375`           | 375 × 812         | 750 × 1624  |  47 |                  |
| `toast-error-unknown-match-375`          | 375 × 812         | 750 × 1624  |  55 | re-rendered (R9) |
| `toast-error-unknown-empty-375`          | 375 × 812         | 750 × 1624  |  36 |                  |
| `toast-error-unknown-refetch-failed-375` | 375 × 812         | 750 × 1624  |  31 |                  |
| `form-receipt-failed-375`                | 375 × 812         | 750 × 1624  |  36 |                  |
| `toast-error-offline-375`                | 375 × 812         | 750 × 1624  |  37 |                  |
| `upload-pill-armed-375`                  | 375 × 812         | 750 × 1624  |  58 |                  |
| `upload-pill-saved-375`                  | 375 × 812         | 750 × 1624  |  57 |                  |
| `upload-pill-failed-375`                 | 375 × 812         | 750 × 1624  |  57 |                  |
| `upload-pill-multi-375`                  | 375 × 812         | 750 × 1624  |  58 |                  |
| `upload-pill-inflight-375`               | 375 × 812         | 750 × 1624  |  58 |                  |
| `upload-pill-unknown-375`                | 375 × 812         | 750 × 1624  |  60 |                  |
| `drafts-two-375`                         | 375 × 812         | 750 × 1624  |  57 |                  |
| `drafts-two-unresolved-375`              | 375 × 812         | 750 × 1624  |  55 |                  |
| `drafts-four-collapsed-375`              | 375 × 812         | 750 × 1624  |  56 | new (R9)         |
| `quick-add-drafts-375`                   | 375 × 812         | 750 × 1624  |  45 |                  |
| `toast-pill-stack-375`                   | 375 × 812         | 750 × 1624  |  60 |                  |
| `state-page-kill-375`                    | 375 × 812         | 750 × 1624  |  54 |                  |
| `alert-pagekill-sent-375`                | 375 × 812         | 750 × 1624  |  57 |                  |
| `check-sheet-boot-375`                   | 375 × 812         | 750 × 1624  |  42 |                  |
| `alert-pagekill-failed-375`              | 375 × 812         | 750 × 1624  |  54 |                  |
| `toast-error-unknown-similar-375`        | 375 × 812         | 750 × 1624  |  50 | new (R9)         |
| `confirm-recreate-375`                   | 375 × 812         | 750 × 1624  |  53 | re-rendered (R9) |
| `alert-session-expired-375`              | 375 × 812         | 750 × 1624  |  35 | new (R9)         |
| `confirm-discard-draft-375`              | 375 × 812         | 750 × 1624  |  38 |                  |
| `listrow-draft-375`                      | 375 × 812         | 750 × 1624  |  56 |                  |
| `upload-states-375`                      | 375 × 812         | 750 × 1624  |  55 |                  |
| `upload-pill-768`                        | 768 × 1024        | 768 × 1024  |  42 |                  |
| `upload-pill-1440`                       | 1440 × 900        | 1440 × 900  |  59 |                  |
| `drafts-desktop-1440`                    | 1440 × 900        | 1440 × 900  |  60 |                  |
| `drafts-chooser-1440`                    | 1440 × 900        | 1440 × 900  |  35 |                  |
| `drafts-chooser-768`                     | 768 × 1024        | 768 × 1024  |  32 | re-rendered (R9) |
| `check-dialog-1024`                      | 1024 × 768        | 1024 × 768  |  54 | re-rendered (R9) |
| `skeleton-mobile-375`                    | 375 × 812         | 750 × 1624  |  24 |                  |
| `skeleton-768`                           | 768 × 1024        | 768 × 1024  |  18 |                  |
| `skeleton-1440`                          | 1440 × 900        | 1440 × 900  |  33 |                  |
| `skeleton-table-desktop`                 | 960 × 420         | 1920 × 904  |  23 |                  |
| `list-footer-375`                        | 375 × 600         | 750 × 1208  |  37 | new (R9)         |
| `chart-mobile-375`                       | 375 × 812         | 750 × 1624  |  35 |                  |
| `chart-mobile-scrolled-375`              | 375 × 812         | 750 × 1624  |  25 |                  |
| `chart-mobile-320`                       | 320 × 568         | 640 × 1136  |  28 |                  |
| `chart-desktop`                          | 1200 × 420        | 2400 × 934  |  49 |                  |
| `transition-storyboard`                  | 900 × 1200        | 900 × 2158  |  82 |                  |
| `ptr-armed-375`                          | 375 × 480         | 750 × 960   |  23 |                  |
| `ptr-done-375`                           | 375 × 480         | 750 × 960   |  29 |                  |
| `ptr-pulling-375`                        | 375 × 480         | 750 × 960   |  26 |                  |
| `ptr-refreshing-375`                     | 375 × 480         | 750 × 960   |  25 |                  |

Contact sheets: `_contact-sheet.png` (phones), `_contact-sheet-wide.png` (768 / 1024 / 1440 and boards),
`_contact-sheet-detail.png` (`chart-desktop` and `transition-storyboard` at native size).

Re-render: `node assets/src/render.mjs primitives [filter]`, then `assets/src/contact-sheet.sh primitives`.

## 9. A11y critical paths

- Sheets, panels and dialogs: focus trap, Esc closes, focus returns to the trigger; drag has a button
  alternative.
- Swipe and long-press actions have a single-pointer path: the row's detail page, or a visible 44 px
  «…» on rows without a detail.
- The money-form primary is never disabled for validity; a tap moves focus to the first invalid field.
  In flight it is `aria-disabled="true"` with its spinner, never `disabled`, so focus stays on it.
- Every interactive element is a native `<button>` or `<a>` (rows with a detail, contact rows, the
  receipt row, the top-bar actions, chips, the switch, PickerSheet fields); no `role="button"` /
  `role="link"` on a `div` or `span`. `prims-mobile.mjs` and `tablet.mjs` follow it; the older money
  form and shell sources (`money-form.mjs`, `mobile.mjs`, `mobile-overlays.mjs`, `base.mjs`) still
  draw 20 `role="button"` spans as drawing shorthand. The mockups are a visual reference, never markup
  to copy.
- Errors: `aria-invalid` + `aria-describedby`; save error `role="alert"`; toasts `role="status"`.
- Progress (receipt ring, upload pill, armed fill) is `role="progressbar"` with `aria-valuenow`; one
  visually hidden `role="status"` per surface announces milestones only (started, finished, failed),
  never each percent (foundation §11).
- Action-sheet rows (`actionConfirm`) are real `<button type="button">` elements, never a
  `div role="button"`.
- Charts: a text summary («Чистий прибуток за 6 місяців: …») as the accessible name; bars focusable.
- Every coarse-pointer target ≥ 44 × 44 (foundation §4), including segments, the currency pill, chips,
  search, the period control, «Скасувати» in toasts, small buttons and chevrons; inputs ≥ 16 px; contrast
  per foundation §7.

## 10. Edge cases

- 320 width: medium sheet starts higher (36%); the FAB is hidden only in the static 320 chart frame so the
  chart is visible (the live screen scrolls under it).
- Long titles and amounts: titles truncate, amounts never truncate (the title yields).
- Upload failure reasons wrap to two lines.
- Empty list: the section header is hidden; the empty state names the next step; on mobile the «+»
  stays the only create entry point (`state-empty-375`). A filtered-empty list offers «Скинути фільтри».

## 11. Assumptions (A1, Task 0.8)

- The money-create error shows inline above the form instead of a toast: the toast covered the amount
  field at 375.
- `--placeholder` (`oklch(0.6 0 0)`, foundation §7.2) colours every placeholder (`.ph` in the sources).
- The 422 date reason («Жовтень уже закрито…») is invented; Wave 1 shows whatever field error the API
  returns.
- The armed-save payload freeze and the single request at 100% are interaction rules; Wave 1 owns the
  client state that holds the draft across a sheet dismiss (in memory only).
- A full trailing swipe asks before deleting (no instant destructive swipe).
- The FAB is hidden in the 320 chart frame only (static-frame artefact, not a product rule).
- Pull-to-refresh arm distance 64 px and the 1 s "done" hold are proposals for the implementation.
- Status-code split per the Master ruling (fix round 2, supersedes round 1's "any 5xx is definite"):
  definite = 4xx + app 500 / 503; unknown = 502 / 504 / 524, a drop after send, a client timeout.
- The 768 / 1440 toast, upload pill and skeleton frames show placement and metrics; the screen specs own
  the content.
