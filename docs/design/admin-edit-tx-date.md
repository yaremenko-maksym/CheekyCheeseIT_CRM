# Design Spec — Transaction Business Date in Admin Edit Dialog (PR #1213)

## 1. Brief

The admin "Edit transaction" dialog (`AdminEditTransactionDialog.tsx`) allows administrators to adjust the business date (`txDate`) of recorded transactions. Because transactions older than 31 days affect past financial statements, backdating them requires an audit reason (`backdateReason`). Furthermore, transactions with immutable ledger commitments (confirmed on-chain, funded from company accounts, or having settlements) cannot have their date altered.

The feature introduces `TxDateField`:

- Displays the business date using `DatePickerField` pre-filled with the stored date.
- Dynamically reveals an explanation input field («Причина зміни дати») when the selected day differs from the stored transaction day.
- Positioned in `AdminEditTransactionDialog` directly between the Amount/Currency/Cascade section and contextual fields (Expense Category, Salary Month, Receipt, Notes).
- Surfaces backend validation errors in the dialog's shared error banner.
- Dark theme only; mobile-first responsive layout from 320px to 1920px.

## 2. Token Map (globals.css)

All color, surface, and typography tokens map strictly to `apps/web/app/styles/globals.css` dark theme tokens:

| UI Element / Role            | CSS Custom Property         | Tailwind Class               | Semantic Purpose                                            |
| :--------------------------- | :-------------------------- | :--------------------------- | :---------------------------------------------------------- |
| **Canvas / Backdrop**        | `--background`              | `bg-background`              | Dialog backdrop / page background (`oklch(0.08 0 0)`)       |
| **Dialog Modal**             | `--card`                    | `bg-card`                    | `CrmDialogContent` container surface (`oklch(0.12 0 0)`)    |
| **Input / Trigger Surface**  | `--surface` / `--input`     | `bg-surface`, `bg-input`     | Date picker trigger and reason input surface                |
| **Borders / Separators**     | `--border`                  | `border-border`              | Field boundaries and dividers (`oklch(0.22 0.004 85)`)      |
| **Focus Indicator**          | `--ring`                    | `ring-ring`                  | Focus ring on buttons and inputs (`oklch(0.84 0.183 85.3)`) |
| **Primary Text**             | `--foreground`              | `text-foreground`            | Value text and primary labels (`oklch(0.97 0 0)`)           |
| **Secondary / Caption Text** | `--muted-foreground`        | `text-muted-foreground`      | Field labels, hint text, placeholders (`oklch(0.58 0 0)`)   |
| **Active / Brand CTA**       | `--primary`                 | `bg-primary`, `text-primary` | Selected calendar day, Save CTA (`oklch(0.84 0.183 85.3)`)  |
| **On-Primary Text**          | `--primary-foreground`      | `text-primary-foreground`    | Text on brand yellow elements (`oklch(0.08 0 0)`)           |
| **Hover / Current Day**      | `--accent`                  | `bg-accent`, `text-accent`   | Calendar cell hover, current date highlight                 |
| **Error Banner Surface**     | `--destructive` (5% alpha)  | `bg-destructive/5`           | Dialog error banner background                              |
| **Error Banner Border**      | `--destructive` (30% alpha) | `border-destructive/30`      | Dialog error banner outline                                 |
| **Error Banner Text / Icon** | `--destructive`             | `text-destructive`           | Validation error messages (`oklch(0.65 0.21 22.2)`)         |
| **Popover Surface**          | `--popover`                 | `bg-popover`                 | Calendar dropdown surface (`oklch(0.13 0 0)`)               |
| **Popover Text**             | `--popover-foreground`      | `text-popover-foreground`    | Calendar text and weekday headers (`oklch(0.97 0 0)`)       |
| **Control Radius**           | `--radius-md`               | `rounded-md`                 | Inputs, date picker trigger, error banner                   |

_Note: Raw hex values are strictly forbidden; all styling resolves to the CSS variables above._

## 3. Component List

### Existing Components Reused

- `CrmDialogContent`, `CrmDialogHeader`, `CrmDialogBody`, `CrmDialogFooter` (`apps/web/app/components/ui/crm-dialog.tsx`): Dialog shell with scrollable body (`max-h-[90dvh]`).
- `DatePickerField` (`apps/web/app/components/ui/date-picker.tsx`): Popover-based date picker trigger button with `CalendarIcon` and localized date display (`dd MMM yyyy`).
- `Calendar` (`apps/web/app/components/ui/calendar.tsx`): `react-day-picker` wrapper with `CustomMonthCaption` for month/year quick selection.
- `Input` (`apps/web/app/components/ui/input.tsx`): Text input primitive.
- `Label` (`apps/web/app/components/ui/label.tsx`): Form label component.
- `AlertCircle` (`lucide-react`): Icon for server error banner.

### New Components

- `TxDateField` (`apps/web/app/routes/_authenticated/finance/components/dialogs/TxDateField.tsx`):
  Renders the transaction date picker, monitors whether `value !== stored`, and manages the reason input disclosure.

## 4. Layout Per Device Class

`AdminEditTransactionDialog` provides a responsive single-column layout centered on desktop and full-width on mobile:

| Device Class      | Viewport Width  | Dialog Container                              | Body Padding & Width           | Field Dimensions & Touch Targets                      |
| :---------------- | :-------------- | :-------------------------------------------- | :----------------------------- | :---------------------------------------------------- |
| **Mobile XS**     | 320px           | Full width (`w-full`), `max-h-[90dvh]`        | `px-6` (272px available)       | Full-width inputs; touch target height `min-h-[44px]` |
| **Mobile SM**     | 375px–390px     | Full width (`w-full`), `max-h-[90dvh]`        | `px-6` (327px–342px available) | Full-width inputs; touch target height `min-h-[44px]` |
| **Tablet**        | 768px           | Modal `sm:max-w-md` (~448px), `sm:rounded-xl` | `px-6` (400px available)       | Full-width inputs; desktop height `h-9` (36px)        |
| **Laptop**        | 1024px / 1280px | Modal `sm:max-w-md` (~448px), `sm:rounded-xl` | `px-6` (400px available)       | Full-width inputs; desktop height `h-9` (36px)        |
| **Large Desktop** | 1440px / 1920px | Modal `sm:max-w-md` (~448px), `sm:rounded-xl` | `px-6` (400px available)       | Full-width inputs; desktop height `h-9` (36px)        |

### Structural Hierarchy in Dialog

1. **Header**: Title «Редагувати транзакцію», Type badge, Amount badge, Close button.
2. **Amount & Currency Block**: `AmountCurrencyInput` with currency/amount lock hints if row is paid.
3. **Cascade Impact Panel**: `CascadeImpactPanel` (mounted when cascade calculation is active).
4. **Transaction Business Date Block (`TxDateField`)**:
   - Label: «Дата транзакції» (`text-xs text-muted-foreground`).
   - Trigger: `DatePickerField` button (`w-full justify-start text-left font-normal min-h-[44px] sm:min-h-0 sm:h-9`).
   - Conditional Disclosure: «Причина зміни дати» + Reason `Input` (`maxLength={500}`, min height 44px on mobile, 36px on desktop).
5. **Contextual Form Fields**:
   - Expense Category input with pill suggestions (`tx.type === 'EXPENSE'`).
   - Salary Month input (`tx.type === 'SALARY'`).
   - Receipt Input (`ReceiptInput`).
   - Notes (`Textarea`).
6. **Error Banner**: Mounts directly above footer when `submitError` is present.
7. **Footer**: «Зберегти» primary CTA, «Скасувати» secondary button.

## 5. Component States

### 5.1 Default State (Stored Date)

- Date picker displays the stored date formatted as `dd MMM yyyy` (e.g. `20 жовт. 2026` or `20 Oct 2026`).
- Reason field is hidden.
- Date picker button has default border (`border-input` / `border-border`).
- Saving the form leaves `txDate` and `backdateReason` out of the mutation payload.

### 5.2 Date Changed State (Reason Revealed)

- Triggered when the operator picks a date where `value !== stored`.
- Reason field transitions smoothly below the date picker.
- Label: «Причина зміни дати» (`text-xs text-muted-foreground`).
- Input: Text input with placeholder «Для дат давніших за 31 день» (EN: "For dates older than 31 days"), `maxLength={500}`.
- Saving the form transmits `{ txDate, backdateReason: reason.trim() }`.

### 5.3 Paid / Locked Row State

- The server returns `isDateLocked` on the transaction DTO (ADMIN viewers only; every other role gets `false`) from the same predicate the save guard uses.
- When `isDateLocked` is true the date trigger is disabled and a muted helper note (`admin-edit-tx-date-locked-note`) explains why; no reason field is shown, and saving other fields still works without `txDate`.
- The server guard still enforces the lock on submit (`FINANCE_TX_DATE_LOCKED_ROW`), covering stale clients.

### 5.4 Server Error States

Server errors returned upon save failure render in the dialog's shared error banner (`rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive flex items-start gap-2`):

1. **`FINANCE_TX_DATE_LOCKED_ROW`**:
   - Cause: Attempted date change on an immutable row.
   - Ukrainian: _«Дату цієї транзакції не можна змінити: оплату підтверджено в блокчейні, її проведено з рахунку компанії або за нею вже є розрахунки»_
   - English: _"This transaction's date can't be changed: its payment is confirmed on-chain, comes from the company account, or already has settlements"_
2. **`FINANCE_TX_DATE_EDIT_REASON_REQUIRED`** (edit screen; the create flows keep `FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED`):
   - Cause: Backdating beyond 31 days without providing a reason.
   - Rendered inline under the reason field (`role="alert"`, focus + `aria-invalid` + `aria-describedby`); the bottom banner is not shown for this code.
   - Ukrainian: _«Дата надто далеко в минулому — вкажіть причину в полі «Причина зміни дати»»_
   - English: _"This date is too far back — enter a reason in the “Reason for changing the date” field"_
3. **`FINANCE_TX_DATE_IN_FUTURE`**:
   - Cause: Attempted future date on an executed transaction.
   - Ukrainian: _«Для виконаної операції дата не може бути в майбутньому»_
   - English: _"A completed operation can't have a future date"_

### 5.5 Mobile Calendar Popover Open State

- Trigger button gains focus ring (`ring-2 ring-ring`).
- Popover renders in portal above modal backdrop (`z-50`).
- Calendar width is 276px, fitting inside 320px viewports without horizontal clipping.
- Selected date: `bg-primary text-primary-foreground`.
- Current date: `bg-accent text-accent-foreground`.

## 6. Accessibility Notes (WCAG 2.2 AA)

1. **SC 1.3.1 Info and Relationships & SC 4.1.2 Name, Role, Value**:
   - Explicit label associations:
     - Date picker label must provide `htmlFor="admin-edit-tx-date-trigger"`, bound to `DatePickerField` button `id="admin-edit-tx-date-trigger"`.
     - Reason label must provide `htmlFor="admin-edit-tx-date-reason-field"`, bound to `Input` `id="admin-edit-tx-date-reason-field"`.
   - Date picker trigger must include `aria-haspopup="dialog"` and `aria-expanded="true|false"`.
2. **SC 2.4.3 Focus Order**:
   - Logical tab flow: Amount -> Currency -> Date Picker -> Reason (when revealed) -> Category / Salary / Receipt / Notes -> Save -> Cancel.
   - Reason input mounts directly after the date picker in the DOM sequence, preserving predictable keyboard navigation.
3. **SC 1.4.3 Contrast (Minimum)**:
   - Primary text (`--foreground` on `--card`): ~16:1 (exceeds 4.5:1 AA standard).
   - Secondary text (`--muted-foreground` on `--card`): ~5.5:1.
   - Active day selection (`--primary-foreground` on `--primary`): ~14:1.
   - Error banner text (`--destructive` on dark card surface): > 4.5:1.
4. **SC 2.5.8 Target Size (Minimum) & Mobile Touch Requirements**:
   - Mobile touch targets must measure `>= 44x44px` on viewports < 640px.
   - Date picker trigger and Reason input must utilize `min-h-[44px] sm:min-h-0 sm:h-9`.
   - Calendar navigation buttons and date cells require adequate tap target spacing.
5. **SC 4.1.3 Status Messages**:
   - The dialog error banner must have `role="alert"` and `aria-live="polite"` so screen readers automatically announce validation failures upon save.

## 7. Motion & Transitions

The reason field revelation must be smooth, layout-stable, and fully respectful of user motion preferences:

### Implementation Guidelines

- **Reveal Transition**:
  Use Framer Motion or CSS Grid row interpolation to prevent layout jumping:
  ```tsx
  <AnimatePresence initial={false}>
    {changed && (
      <motion.div
        key="tx-date-reason"
        initial={{ opacity: 0, height: 0, y: -4 }}
        animate={{ opacity: 1, height: 'auto', y: 0 }}
        exit={{ opacity: 0, height: 0, y: -4 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden space-y-1.5"
      >
        {/* Reason Label and Input */}
      </motion.div>
    )}
  </AnimatePresence>
  ```
- **Reduced Motion (`prefers-reduced-motion: reduce`)**:
  When reduced motion is requested, animation duration drops to `0s`, displaying or hiding the field instantly without transition.

## 8. Edge Cases

1. **Narrow 320px Viewport**:
   - Inside `CrmDialogBody` (`px-6`), available width is 272px.
   - The formatted date string («20 жовт. 2026») takes ~120px, leaving ample room for the calendar icon and button padding.
   - Reason placeholder «Для дат давніших за 31 день» and English «For dates older than 31 days» (28 chars) fit within the 272px input without overflow.
   - Popover Calendar (276px wide) aligns properly via Radix Popover viewport collision bounds.
2. **500-Character Long Reason String**:
   - Handled via native horizontal text scrolling within the single-line input. The container width remains fixed and does not cause horizontal page overflow.
3. **Multi-line Error Banner Wrapping**:
   - Long server errors (`FINANCE_TX_DATE_LOCKED_ROW` at 125 chars) wrap to 4 lines on 320px/375px screens.
   - The error banner must use `items-start` rather than `items-center` so `AlertCircle` remains anchored to the top line instead of floating in the vertical center.
4. **Locale Switches (UK / EN)**:
   - Date formats automatically adjust between Ukrainian (`uk`: «20 жовт. 2026») and English (`en`: «20 Oct 2026») via `date-fns/locale`.
   - All strings localized through Lingui macros (`t` and `<Trans>`).
