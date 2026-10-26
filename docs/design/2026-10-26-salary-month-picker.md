# Salary-month picker (QA-LOW-2, backlog 338)

Status: spec for coder. Design tier: 3 (conformance note, see Gate). No product code in this PR.

## Problem

`SalaryFields.tsx` (create-transaction dialog, `data-testid="create-transaction-salary-month"`) renders a
native `<input type="month">`. Chromium draws it from the browser locale and ignores `lang`, so the `uk`
UI shows "October 2026". It is the only `type="month"` in `apps/web`. The current input has **no** `min`/`max`.
`showPicker()` is called on click and focus (auto-opens on Tab, a keyboard-trap-like annoyance).

## Decision: Option B, two `Select`s (month + year)

| Criterion     | A popover picker                              | **B two Selects**                                               | C caption beside native input  |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| Fixes the bug | yes                                           | yes                                                             | no (native text still English) |
| New code      | new MonthPicker grid + popover + roving focus | one small component, zero new primitives                        | tiny                           |
| Keyboard + SR | must build grid semantics ourselves           | Radix Select: listbox, type-ahead, Esc, focus return for free   | native, but inconsistent       |
| Mobile 320px  | popover over a dialog = nested layers         | Radix Select portal, already used in the same dialog (receiver) | n/a                            |
| Consistency   | new pattern                                   | same control as the neighbouring "Співробітник" field           | inconsistent                   |

Salary month is a 2-step choice (pick month, rarely change year). Selects are the denser, scannable
operations-tool answer; A adds a nested overlay and custom a11y for no gain. C does not fix the bug.

**Memorable detail:** month names come from `Intl`, so they match the UI language everywhere; the year
select is narrow and tabular (`tabular-nums`) so digits do not jitter.

## Component

New file (coder): `apps/web/app/components/ui/month-picker.tsx`, exports `MonthPickerField`.

```ts
interface MonthPickerFieldProps {
  value: string // 'YYYY-MM' or '' (nothing chosen)
  onChange: (v: string) => void // only ever emits a complete 'YYYY-MM'
  minMonth?: string // 'YYYY-MM' inclusive; undefined = no lower bound (current behaviour)
  maxMonth?: string // 'YYYY-MM' inclusive; undefined = no upper bound (current behaviour)
  disabled?: boolean
  id?: string // applied to the month trigger (label target)
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'data-testid'?: string // root, default consumer passes 'create-transaction-salary-month'
}
```

Behaviour:

- Locale via `useLocale()` (`apps/web/app/lib/i18n.ts`). Month names:
  `new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m, 1)))`,
  first letter upper-cased with `toLocaleUpperCase(locale)`. `uk` gives standalone nominative ("жовтень"), good.
  No hardcoded month list.
- Value format stays `YYYY-MM`; parse by `split('-')`, no `Date` round-trip (avoids TZ drift).
- Year options: `minMonth..maxMonth` years if given; otherwise `currentYear-3 .. currentYear+1`; always
  union the year of `value` so a stored out-of-range value still renders.
- Month options outside `[minMonth, maxMonth]` for the selected year: `SelectItem disabled`.
- Selecting a month with no year yet uses the current year; selecting a year with no month yet uses the
  current month (clamped to bounds). So `onChange` never emits a partial value, and the parent's
  `salaryMonth` validation is unchanged. Empty `value` shows both placeholders.
- Year change that makes the selected month illegal (bounds): clamp month to nearest legal one.
- Drop `showPicker()` auto-open entirely (focus no longer opens anything; fixes Tab annoyance).

## Layout and tokens (no new tokens)

Root: `<div role="group" aria-labelledby={labelId} className="flex gap-2" data-testid=...>`.

- Month `SelectTrigger`: `h-9 text-sm flex-1 min-w-0` (matches receiver trigger, `select.tsx` base classes).
- Year `SelectTrigger`: `h-9 text-sm w-[5.5rem] shrink-0 tabular-nums`.
- Error: add `border-destructive` to both triggers when `aria-invalid`; error text stays the existing
  `text-[11px] text-destructive` line with its current testid (add a non-color cue: the message text itself).
- Items: `SelectItem className="text-sm"`; selected check mark comes from `select.tsx`.
- Dark theme only (project decision 2026-08-16): colors only via `border-input`, `ring-ring`,
  `text-muted-foreground`, `text-destructive`. No `[color-scheme:dark]`, no webkit indicator hacks (deleted).
- Motion: none added; Radix Select's existing open/close animation only (`transition-colors` scope, no `all`).

Dialog grid change in `SalaryFields.tsx`: `grid grid-cols-2 gap-3` becomes
`grid grid-cols-1 sm:grid-cols-2 gap-3` so at 320px the month field gets a full row (a half column,
~138px, cannot fit month + year selects). At >=640px (`sm`) it stays two columns; the month cell is
~200-260px, enough for "Вересень" + year (verify, see checks).

## Copy (Lingui, uk source + en)

Wrap with `t`/`<Trans>`; `uk` is the source text, add `en` to catalog (`pnpm i18n:extract`).

| Where                | uk                                                        | en           |
| -------------------- | --------------------------------------------------------- | ------------ |
| Field label (exists) | Місяць                                                    | Month        |
| Month placeholder    | Місяць                                                    | Month        |
| Year placeholder     | Рік                                                       | Year         |
| Month trigger aria   | Місяць зарплати                                           | Salary month |
| Year trigger aria    | Рік зарплати                                              | Salary year  |
| Missing-value error  | reuse the existing salary-month error key; do not add one |

Both languages say the same thing (a month/year of the salary); no longer strings than "Місяць зарплати"
(15 chars), fine at 320px.

## Accessibility (WCAG 2.2 AA)

- Group has `role="group"` named by the visible "Місяць" `Label`; the `Label htmlFor` targets the month
  trigger (`id`). Triggers also get the aria-labels above so SR hears "Місяць зарплати, жовтень".
- Keyboard: Tab month -> Tab year; Enter/Space/ArrowDown opens; arrows move; type-ahead jumps by month
  name; Esc closes and returns focus to the trigger (Radix). No auto-open on focus.
- Target size: `h-9` = 36px >= 24 (SC 2.5.8). Focus ring `focus:ring-1 ring-ring` from `select.tsx` (SC 2.4.11);
  verify contrast >= 3:1 against the dialog background.
- Disabled months are `aria-disabled` via Radix; still announced.
- Error: `aria-invalid` + `aria-describedby` to the error `<p>`; error is text, not color only (SC 1.4.1).
- Reflow: 320px and 400% zoom, no horizontal scroll (single column below `sm`).

## Edge cases

- Empty value: placeholders in `text-muted-foreground` (`data-[placeholder]` from select.tsx).
- Out-of-range stored value: year unioned in; month shown; if disabled by bounds it still displays.
- `disabled`: both triggers `opacity-50`, `cursor-not-allowed` (select.tsx).
- Long uk month names ("Вересень", "Листопад"): `[&>span]:line-clamp-1` truncation already in trigger.
- No loading state (pure client, synchronous).

## Test ids

- Root: `create-transaction-salary-month` (kept; E2E anchor now a group, not an input).
- `create-transaction-salary-month-select` (month trigger), `create-transaction-salary-year-select` (year trigger).
- Items: `salary-month-option-<MM>` (01-12), `salary-year-option-<YYYY>`.
- Any E2E that did `fill()` on the old input must switch to select-by-testid (AutoTest zone; grep in
  `apps/e2e` found no use of `salary-month` at spec time, re-check).

## Tests the coder adds (Vitest, apps/web)

- Renders `uk` month names for `2026-10` ("Жовтень") and `en` ("October").
- Emits `YYYY-MM` only (never partial); month-first and year-first selection paths.
- Bounds: disabled months outside `minMonth`/`maxMonth`; year change clamps month.
- No `type="month"` input in the DOM; `showPicker` not called.

## Acceptance checks (coder + manual-qa)

Run create-transaction dialog -> type SALARY, at **320 / 768 / 1280**, in **uk and en**:

1. Month names match UI language (uk: "Жовтень 2026"; en: "October 2026"); no English in uk.
2. At 320: month field is a full row, no horizontal scroll, no clipped trigger; at 768/1280: two columns, both selects fully visible.
3. Keyboard only: Tab reaches month then year; open/choose/Esc works; focus returns to trigger; focus ring visible.
4. Screen reader (VoiceOver or a11y snapshot): names "Місяць зарплати" / "Рік зарплати" and the value.
5. Submit sends `salaryMonth: "YYYY-MM"` identical to before (check network payload); existing server errors unchanged.
6. Error state (submit empty): both triggers show destructive border plus the text message.
7. Disabled and pre-filled (edit flow if reused) render correctly; digits in year do not shift (tabular-nums).
8. Touch target >= 24px, ideally the 36px shown; no auto-open on focus.

## Gate

Design-gate tier 3 equivalent: existing screen, reuses existing primitives (`Select`, `Label`), no new
tokens, no new visual language, so no Claude Design generation is required. Coder PR still needs Mode B
fidelity audit across all device classes (`design-fidelity-review.md`) and a `copy-reviewer` verdict for
the new strings.
