# Primitives v2 — Foundation (Wave 0)

> Per-screen artifact (CRM redesign v2). Coder-ready spec of the shared primitives every v2 screen reuses.
> Visual and interaction language: `docs/design/foundation.md` v2 (tokens §7, containers §8, motion §9,
> interaction rules §11). Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md`.
> Scoring: `docs/design/rubric-calibration.md`.
>
> **The mockups are a visual reference, not code to paste.** Build on the existing `components/ui/*`
> (shadcn/ui) where one fits; the "Build on" column says which.

| Field         | Value                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope         | Sheets, list rows, section headers, forms, side panel, confirm, table rows, toasts / inline errors, uploads, skeletons, charts, pull-to-refresh, transitions |
| Showcase      | a Wave 0 showcase route renders every primitive in every state (spec §7, Wave 0)                                                                             |
| design-gate   | **degraded** — Playwright renders of HTML prototypes (`assets/src/`), Claude Design not driven                                                               |
| Status        | `captured` (mockups done; mockup-gate council pending)                                                                                                       |
| Sample data   | invented (names, amounts, projects)                                                                                                                          |
| Contact sheet | `assets/primitives-v2/_contact-sheet.png`                                                                                                                    |

---

## 1. Component map

| Primitive                 | Build on                                                    | New?                         | Frames                                                                   |
| ------------------------- | ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Bottom sheet (detents)    | Base UI Drawer (approved stack change, spec §4)             | NEW `Sheet` mobile variant   | `sheet-medium-375`, `sheet-medium-320`, `sheet-large-375`                |
| Action sheet (confirm)    | Base UI Drawer + `ui/alert-dialog.tsx` semantics            | NEW variant                  | `sheet-confirm-375`                                                      |
| Side panel                | `ui/sheet.tsx` (side = right)                               | restyle                      | `sheet-panel-768`, `sheet-panel-1024`, `sheet-panel-1440`                |
| Confirm dialog            | `ui/alert-dialog.tsx`                                       | restyle                      | `sheet-confirm-dialog-1024`                                              |
| List row                  | —                                                           | NEW `ListRow`                | `listrow-variants-375`, `listrow-swipe-375`, `listrow-sticky-320`        |
| Section header            | —                                                           | NEW `ListSection`            | `section-header-375`                                                     |
| Table row states          | `ui/table.tsx`                                              | restyle                      | `listrow-table-desktop`                                                  |
| Form field                | `ui/input.tsx`, `ui/label.tsx`                              | restyle (16 px, 48 h mobile) | `form-states-375`                                                        |
| Money field + receipt     | `ui/amount-currency-input.tsx`, `ui/image-upload-field.tsx` | restyle                      | `form-money-375`, `form-keyboard-375`                                    |
| Segmented control, switch | `ui/segmented-toggle.tsx`, `ui/switch.tsx`                  | restyle                      | `form-money-375`, `sheet-medium-375`                                     |
| Undo toast                | `ui/sonner.tsx`                                             | restyle                      | `toast-undo-375`                                                         |
| Save error (inline)       | `ui/alert.tsx`                                              | restyle                      | `toast-error-375`                                                        |
| Upload states + indicator | `ui/upload-progress.tsx`                                    | restyle + global pill (NEW)  | `upload-states-375`                                                      |
| Skeletons                 | `ui/skeleton.tsx`                                           | restyle                      | `skeleton-mobile-375`, `skeleton-table-desktop`                          |
| Charts                    | the existing chart library on `--chart-*` tokens            | restyle                      | `chart-mobile-375`, `chart-mobile-320`, `chart-desktop`                  |
| Pull-to-refresh           | —                                                           | NEW `PullToRefresh`          | `ptr-pulling-375`, `ptr-armed-375`, `ptr-refreshing-375`, `ptr-done-375` |
| Transitions               | View Transitions API + `motion` (`m.*`, LazyMotion)         | NEW                          | `transition-storyboard`                                                  |

---

## 2. Sheets and panels

**Medium sheet** (`sheet-medium-*`): filters and short forms (≤ 4 fields). Top at ≈ 46% of the
viewport (36% at 320 so the content fits), `--radius-sheet` corners, drag handle (36 × 5, hit area
44), title row with «Скинути» and «Готово». Drag up expands to large; drag down past 30% or a fling
dismisses. Scrim `--scrim`.

**Large sheet** (`sheet-large-375`): long forms and edit. Full height minus the status bar, nav row
«Скасувати» / title / «Готово» (Готово is the primary, disabled until the form is valid and dirty).
**A dirty form asks before it closes** (drag, scrim, Скасувати) with an action sheet.

**Action sheet** (`sheet-confirm-375`): destructive confirm on touch. Message names the object
(«Видалити транзакцію «Оренда офісу»?»), destructive action in `text-destructive`, «Скасувати» as a
separate bold group. `role="alertdialog"`, focus starts on «Скасувати».

**Side panel** (`sheet-panel-*`): preview and edit on tablet / desktop. Width 400 (tablet, touch
heights 48 / 44), 420 (1024), 480 (≥ 1440). Header with title + close; sticky footer with the primary
action and the hints «Esc» / «⌘↵». The table stays interactive next to it at ≥ 1440.

**Confirm dialog** (`sheet-confirm-dialog-1024`): 420 px centred alert dialog; initial focus on
«Скасувати»; Enter does not trigger the destructive action.

---

## 3. Lists

**List row** (`listrow-variants-375`): 56 px single-line / 64 px two-line, inset separator at 16.
Leading: 40 px avatar or 32 px icon tile. Primary line 16/22; secondary 15/20 muted; trailing value
right-aligned, `tabular-nums`, with sign (`+` positive, `−` destructive) and a status word or badge.
Pressed state `bg-accent`. Variants: navigation (chevron), value, toggle, destructive.

**Swipe actions** (`listrow-swipe-375`): trailing edge only (no leading swipe: it collides with system
back). Revealed actions «Змінити» (secondary) and «Видалити» (destructive), each ≥ 72 × row height. A
full swipe does **not** delete; it asks with the action sheet. **Single-pointer alternative**
(SC 2.5.1 / 2.5.7): long-press or the «…» button opens the same actions as a context menu.

**Sticky section header** (`listrow-sticky-320`, `section-header-375`): overline 12/16 uppercase, 92%
translucent bar with blur while stuck; date sections show the day total on the right (`tabular-nums`).
Long titles truncate on one line with the full text as the accessible name.

---

## 4. Forms

**Field states** (`form-states-375`): label above (15/20), input 48 h (mobile) / 36 h (desktop), 16 px
text, `--input-border` outline, `--placeholder` text. Focus: yellow border + 3 px soft ring. Error:
destructive border + icon + message under the field (`aria-describedby`, `aria-invalid`). Disabled:
50% opacity + dashed border + a reason line («Роль змінює адміністратор»). Helper text 13/18 muted.
Validation on blur for format, on submit for required.

**Money field** (`form-money-375`): amount 24/700 `tabular-nums`, `inputmode="decimal"`, currency suffix;
type as a segmented control over the role's existing create types (the frame shows the ADMIN set
Витрата / Дохід / Переказ = `EXPENSE` / `ADMIN_INCOME` / `ADMIN_TRANSFER`; the Wave 1 finance spec owns
the exact set per role); date defaults to today;
receipt as one dashed drop tile «Додати чек — Камера, фото або файл · до 10 МБ». One file input without
`capture`, so iOS offers its native chooser (camera, library, files).

**Keyboard** (`form-keyboard-375`): the content scrolls so the focused field sits above the keyboard;
the accessory bar carries ˄ ˅ (previous / next field) and «Готово». The submit bar («Зберегти») rides on
the keyboard. Fields above the focused one collapse into a summary line («Сума 1 250,50 USD · Витрата»).

**Submit:** disabled while in flight (no double submit); label stays, a 16 px spinner replaces the icon.

---

## 5. Feedback

**Undo toast** (`toast-undo-375`): bottom, above the tab bar, 14 radius, «Співбесіду архівовано» +
«Скасувати» (44 h), thin progress line for the remaining time. `role="status"`. Only for actions that
are already reversible in the product.

**Save error** (`toast-error-375`): for money creates the error is an **inline `role="alert"` above the
form**, never a floating toast over a field: «Транзакцію не збережено» + the cause + "values kept". The
primary button becomes «Повторити збереження». **No auto-retry.** A retry after an unknown outcome
reuses the same idempotency key (spec §4.5b; four forms gain the key in the first Wave 1 task).

**Uploads** (`upload-states-375`): per-file row with a progress ring and a cancel ✕ (uploading 62%,
compressing), done («Готово» with a check), and failed (the reason wraps; «Інший файл» for a rejected
file, «Повторити» for a dropped connection). A global pill «Завантаження 2 чеків · 40%» stays above the
tab bar on any screen while uploads run. Uploads are in-memory: closing the app loses them; the UI says
so only when the user tries to close a sheet with uploads running.

**Skeletons** (`skeleton-mobile-375`, `skeleton-table-desktop`): blocks match the final layout (row
heights, avatar circles, right-aligned values); shimmer 1.2 s, off under reduced motion.

---

## 6. Charts

`chart-mobile-375` / `chart-mobile-320`: one question per chart («Чистий прибуток»); bars in `--chart-1`;
**negative months hatched with a `−` label below zero**; zero line `--chart-grid`; tap a bar for a
tooltip with the exact value; swipe the period. A second, smaller chart (partners) is allowed below the
fold only. `chart-desktop`: hover tooltip, keyboard focus on bars (arrow keys), series swatches carry
token names, the chart follows the table filters.

---

## 7. Pull-to-refresh and transitions

**Pull-to-refresh** (`ptr-*`): pulling (arrow), armed at 64 px (arrow rotates 180°, turns yellow, light
haptic), refreshing (spinner, content held at 50 px), done («Оновлено щойно», 1 s, then collapses).
Only on tab-root lists. Under reduced motion the arrow does not rotate; the state text changes instead.

**Transitions** (`transition-storyboard`): push / back 280 ms slide + fade (View Transitions), tab switch
instant, sheet 280 ms up / 150 ms down, desktop 150 ms crossfade, reduced motion = 120 ms crossfade.

---

## 8. Frames (all PNG under `assets/primitives-v2/`)

`sheet-medium-375` · `sheet-medium-320` · `sheet-large-375` · `sheet-confirm-375` ·
`listrow-variants-375` · `listrow-swipe-375` · `listrow-sticky-320` · `section-header-375` ·
`form-states-375` · `form-money-375` · `form-keyboard-375` · `sheet-panel-768` · `sheet-panel-1024` ·
`sheet-panel-1440` · `sheet-confirm-dialog-1024` · `listrow-table-desktop` · `toast-undo-375` ·
`toast-error-375` · `upload-states-375` · `skeleton-mobile-375` · `skeleton-table-desktop` ·
`chart-mobile-375` · `chart-mobile-320` · `chart-desktop` · `ptr-pulling-375` · `ptr-armed-375` ·
`ptr-refreshing-375` · `ptr-done-375` · `transition-storyboard` (29 frames + `_contact-sheet.png`).

Re-render: `node assets/src/render.mjs primitives [filter]`, then `assets/src/contact-sheet.sh primitives`.

## 9. A11y critical paths

- Sheets, panels and dialogs: focus trap, Esc closes, focus returns to the trigger; drag has a button
  alternative.
- Swipe and long-press actions have a visible «…» alternative.
- Errors: `aria-invalid` + `aria-describedby`; save error `role="alert"`; toasts and uploads
  `role="status"`.
- Charts: a text summary («Чистий прибуток за 6 місяців: …») as the accessible name; bars focusable.
- All touch targets ≥ 44 px; inputs ≥ 16 px; contrast per foundation §7.

## 10. Edge cases

- 320 width: medium sheet starts higher (36%); the FAB is hidden only in the static 320 chart frame so the
  chart is visible (the live screen scrolls under it).
- Long titles and amounts: titles truncate, amounts never truncate (the title yields).
- Upload failure reasons wrap to two lines.
- Empty list: the section header is hidden; the empty state carries the primary action.

## 11. Assumptions (A1, Task 0.8)

- The money-create error shows inline above the form instead of a toast: the toast covered the amount
  field at 375.
- A full trailing swipe asks before deleting (no instant destructive swipe).
- The FAB is hidden in the 320 chart frame only (static-frame artefact, not a product rule).
- Pull-to-refresh arm distance 64 px and the 1 s "done" hold are proposals for the implementation.
