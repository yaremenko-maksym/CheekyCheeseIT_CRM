# Design Spec — Company-share payout CTA + two-step payout modal

> **Design tier:** 1 (new surface: call-to-action strip + new modal)
> **design-gate:** degraded (Tier 1, without a Claude Design/Chrome-MCP session — the ui-ux-designer agent
> has no access to browser-based generation in this environment; see `design-gate.md` §Fallback).
> Compensated: designer-authored HTML mockups, rendered and photographed by Playwright
> **on the real token values** from `apps/web/app/styles/globals.css` (`.dark`, default theme) —
> not abstract sketches, but pixel-accurate referenced states. The `design.png` equivalent = the set of
> PNGs in `docs/design/assets/company-share-cta/` (see §Fidelity references).
> **Status:** coder-ready
> **Task reference:** `.claude/tasks/task-company-share-cta.md`
> **Dialog being replaced:** `apps/web/app/routes/_authenticated/finance/components/dialogs/PayoutDialog.tsx`

---

## 1. Context and direction

**Purpose.** A senior declares incomes per project; the accountant verifies them (`VALIDATED`). The senior
accumulates verified incomes not yet included in any request — for each of them he
must pay the CheekyCheeseIT share. Today the entry into this flow is hidden in an ordinary button inside a
dense transaction list; the owner wants a noticeable but not loud CTA + a modal that does not
lose the request state on unexpected closing.

**Audience.** SENIOR (several times a week), scans the list, acts quickly. The money path has
a raised cost of error (double submission, loss of request state, confusion between "created" and "paid").

**Tone.** Inherits `docs/design/foundation.md` §1 in full: dense · quiet · scannable · operations
console. The call-to-action strip is an ACCENT, but not a marketing, element: one yellow spotlight on the screen,
not a fill.

**Memorable detail.** An explicit separation of the two states of one request — "created" (orange badge,
the existing `STATUS_LABELS.PENDING_PAYMENT`) vs "paid" (emerald badge, the existing
`STATUS_LABELS.PAID`) — plus a persistent green confirmation line right under the modal header at
step 2: «Заявка создана · Деньги ещё не отправлены». This is the only NEW micro-detail of the design;
everything else is a reuse of the existing status vocabulary.

**Constraints.** Tailwind v4 + shadcn/ui + Radix, Russian UI, WCAG 2.2 AA, responsive 320–1440,
only existing tokens (`globals.css`), no new visual language.

---

## 2. Token map

Nothing new is introduced. Only existing semantic tokens are used:

| Purpose                                 | Token / class                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page canvas                             | `bg-background`                                                                                                                                                                             |
| Card / dialog                           | `bg-card` + `border-border`                                                                                                                                                                 |
| CTA strip — background/border           | `bg-primary/8` (hover `bg-primary/12`) + `border-primary/25` (the `hiring-strip.tsx` pattern from `apps/landing`, adapted to the dense tone of the CRM — see §4.1)                          |
| CTA strip — icon tile                   | `bg-primary/15 text-primary`                                                                                                                                                                |
| Text — primary / secondary              | `text-foreground` / `text-muted-foreground`                                                                                                                                                 |
| Brand / CTA                             | `bg-primary text-primary-foreground` (the existing `Button` `default` variant)                                                                                                              |
| Amounts / numbers                       | `tabular-nums` (mandatory everywhere — foundation.md §4)                                                                                                                                    |
| Status «Ожидает выплаты»                | the existing `STATUS_COLORS.PENDING_PAYMENT` + `STATUS_LABELS.PENDING_PAYMENT` (`finance/constants.ts`) — `bg-orange-500/15 text-orange-400 border-orange-500/30`                           |
| Status «Оплачено»                       | the existing `STATUS_COLORS.PAID` + `STATUS_LABELS.PAID` — `bg-emerald-500/15 text-emerald-400 border-emerald-500/30`                                                                       |
| "Request created" confirmation (line)   | the existing emerald-confirmed pattern `PayoutDetailDialog.tsx:532-547` (`border-emerald-500/30 bg-emerald-500/10`) — reused for a NEW meaning (request creation, not payment confirmation) |
| Error                                   | `text-destructive` / `border-destructive` (the existing `status-box.error` pattern `PayoutDetailDialog.tsx:549-567`)                                                                        |
| Indeterminate/selected project checkbox | `accent-primary` on a native `<input type="checkbox">` (the existing pattern `PayoutDialog.tsx:174`)                                                                                        |
| Radius                                  | `rounded-lg` (dialog/project cards) / `rounded-md` (icon tile, inputs)                                                                                                                      |
| Stepper — active / done / future step   | `bg-primary text-primary-foreground` / `border-emerald-500/30 bg-emerald-500/15 text-emerald-400` / `border-border text-muted-foreground`                                                   |

---

## 3. Component list

| Component                                       | Type                                  | Source / note                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `Badge`, `Card`/`CardContent`         | Existing                              | shadcn/ui, unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Dialog`, `CrmDialogContent/Header/Body/Footer` | Existing                              | `apps/web/app/components/ui/crm-dialog.tsx` — **used with a new `className` on `CrmDialogContent`** (see §6.1), the `maxWidth` prop does not change                                                                                                                                                                                                                                                                                                                          |
| `STATUS_LABELS` / `STATUS_COLORS`               | Existing (reused)                     | `finance/constants.ts` — the source of the «Ожидает выплаты» / «Оплачено» badges at step 2                                                                                                                                                                                                                                                                                                                                                                                   |
| `fmtAmount`                                     | Existing                              | `finance/constants.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| checkbox (native `<input type="checkbox">`)     | Existing pattern                      | `PayoutDialog.tsx:170-175` — reused 1:1, including the project tri-state (new: `.indeterminate` via `ref`, a standard DOM API, not a new component)                                                                                                                                                                                                                                                                                                                          |
| **`CompanySharePayoutStrip`**                   | **NEW**                               | The call-to-action strip. Presentational, `null` on empty input. Proposed path: `apps/web/app/routes/_authenticated/finance/components/CompanySharePayoutStrip.tsx`                                                                                                                                                                                                                                                                                                          |
| **`CompanySharePayoutModal`**                   | **NEW** (replaces `PayoutDialog.tsx`) | Two-step modal. Path: `apps/web/app/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal.tsx`                                                                                                                                                                                                                                                                                                                                                            |
| **`PayoutPaymentForm`**                         | **EXTRACTED existing**                | The payment form body — extracted from `PayoutDetailDialog.tsx` (lines 300-677: instruction-card / tx-hash input / dev-simulate / on-chain status / manual-confirm) into a separate presentational component WITHOUT changing logic. Used by BOTH: (a) `PayoutDetailDialog.tsx` (a `<Dialog>` wrapper, the existing "Оплатить" path on an already created request — **no behavior change**) and (b) `CompanySharePayoutModal` (step 2, embedded, without its own `<Dialog>`) |
| Stepper (①Выбор → ②Оплата)                      | **NEW, minimal**                      | A non-clickable progress indicator of 2 segments inside `CompanySharePayoutModal`. Does NOT reuse `SegmentedToggle` (that one is a mutually-exclusive, clickable **choice**; here it is **sequential progress**, not clickable "back" from step 2 to step 1). Built from the same tokens (primary/emerald/border/muted), no new CSS variables                                                                                                                                |
| Confirmation-strip «Заявка создана»             | **NEW layout, existing tokens**       | `div role="status"` — reuses the emerald `status-box` pattern `PayoutDetailDialog.tsx:532-547`, new text for the new semantics                                                                                                                                                                                                                                                                                                                                               |

**Summary:** 2 new components (`CompanySharePayoutStrip`, `CompanySharePayoutModal`) + 1 extraction of
existing logic without rewriting (`PayoutPaymentForm`) + 1 small new non-clickable
pattern (the stepper), built from existing tokens. `PayoutDialog.tsx` is deleted entirely.
`PayoutDetailDialog.tsx` **is not deleted** — it becomes a thin wrapper over `PayoutPaymentForm`
(behavior for the existing "Оплатить" entry points on an already created request does not change, see §7).

---

## 4. Surface A — CTA strip (`CompanySharePayoutStrip`)

### 4.1 Pattern rationale

The owner pointed to the "hiring strip" on the landing page (`apps/landing/app/components/marketing/hiring-strip.tsx`)
as a tone reference. The structure carries over one-to-one: **the whole block is one clickable element**,
a thin tinted background + border, no decorative weight. Three differences, mandatory because of the change of
context (marketing announcement → operations CTA):

1. **No dismiss cross.** A financial obligation cannot be "closed forever" — unlike
   a marketing announcement it is not noise but a current fact. The strip disappears by itself anyway when there is
   nothing to pay (see §4.4).
2. **Not full-bleed / not centered.** The CRM is not a landing page: the strip is an ordinary block in the content column
   (`rounded-lg border`, like the other cards), left-aligned, dense tone.
3. **Contains data** (project counter + amount), not only call-to-action text — the CRM pattern
   of `info-hint` blocks (`CreateTransactionDialog.tsx:702`, `DropBalanceCard`) already shows numbers
   inside tinted boxes.

### 4.2 Where it renders and why

| Place                                   | Position                                                                              | Rationale                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SeniorDashboard.tsx`                   | **The very top** of the `space-y-6` container — BEFORE the KPI grid (before line 134) | A "noticeable call" (the owner's wording) — the first thing a senior with an outstanding debt sees. Below KPI/EarningsStatsBlock/InProgressPanel the strip would risk getting lost |
| `finance/index.tsx`                     | The first element inside `space-y-6`, BEFORE the `Card` wrapping `TransactionsTable`  | Literally "at the top of the list" (the task's wording) — the transaction list starts right under it                                                                               |
| `DropDashboard.tsx` / `DropFinancePage` | **NOT added**                                                                         | Out of the task's scope (SENIOR only); see §9. `InProgressPanel` (shared with DropDashboard) is NOT touched by this surface — the strip is not embedded inside it                  |

### 4.3 Data (client-derived, no new endpoint)

The source is the `['transactions']` query already loaded in both places (`financeApi.getTransactions()`,
self-scoped by the backend to the current user). No new API is required (the task already
allows this as the main path):

```
outstanding = transactions.filter(t =>
  t.type === 'SENIOR_INCOME' &&
  t.status === 'VALIDATED' &&
  t.payoutRequestId == null
)
```

**Critical — the amount payable, NOT the gross income.** The strip shows the COMPANY SHARE (`payable`), not
the sum of incomes. The formula is a 1:1 copy of the calculation that already exists in `PayoutDialog.tsx:81-92`
(`previewRows`); this is NOT new business logic, but a transfer:

```
sharePercent = tx.seniorSharePercent ?? user.seniorSharePercent ?? 26   // existing default
payable      = amount * (1 - sharePercent / 100)
```

Grouping — by `projectId`: `projectsCount = new Set(outstanding.map(t => t.projectId)).size`.
The amount — per currency (see the "mixed currencies" edge case below). `outstanding.length === 0` →
`CompanySharePayoutStrip` returns `null` (the component decides itself, not the parent — a 1:1 pattern with
`HiringStrip`'s `count <= 0` guard).

### 4.4 Visual design

Reference screenshots: `docs/design/assets/company-share-cta/banner-320.png`,
`docs/design/assets/company-share-cta/banner-1440.png` (Playwright render on the real oklch values
from `globals.css`).

A single clickable `<button type="button">` (not `<a>` — it opens a modal, does not navigate):

```tsx
<button
  type="button"
  onClick={onOpen}
  data-testid="company-share-cta-strip"
  className="flex w-full min-h-11 items-center gap-3 rounded-lg border border-primary/25 bg-primary/8 px-4 py-3 text-left transition-colors hover:bg-primary/12"
>
  <span className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
    <Coins className="h-[18px] w-[18px]" aria-hidden="true" />
  </span>
  <span className="min-w-0 flex-1">
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">Доля CheekyCheeseIT к оплате</span>
      <Badge
        variant="outline"
        className="rounded-full border-orange-500/30 bg-orange-500/15 text-orange-400"
      >
        {projectsCount} {pluralizeProjects(projectsCount)}
      </Badge>
    </span>
    <span className="mt-0.5 block text-xs text-muted-foreground">
      По проверенным приходам, ещё не включённым в заявку на выплату
    </span>
  </span>
  {/* amount + «Оплатить» — below <480px this is the SECOND row (see §8 responsive) */}
  <span className="flex shrink-0 items-center gap-3 max-[479px]:w-full">
    <span className="text-[17px] font-bold tabular-nums text-primary">{amountLabel}</span>
    <span className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground max-[479px]:flex-1">
      Оплатить
    </span>
  </span>
</button>
```

**Icon — `Coins`, not `Wallet`.** A deliberate choice: `Wallet` is already reserved in the codebase for
"your personal money" actions (the `finance/index.tsx:824` header, `InProgressPanel` buttons, the body
of `PayoutDetailDialog`). `Coins` is already the existing anchor specifically of the "COMPANY account"
(`PayoutDetailDialog.tsx:56`, `MANUAL_METHODS.COMPANY_ACCOUNT`). Reusing this anchor for
"company share" is semantically more precise and does not introduce a new icon into the vocabulary.

The inner "Оплатить" is NOT a nested `<button>` (invalid HTML inside a `<button>`), but a `<span>`
styled as a button — a 1:1 pattern with the `MANUAL_METHODS` tiles in `PayoutDetailDialog.tsx:600-618`
(a clickable `role="radio"` `<button>`, a visual "button" inside — the same nesting-inversion trick).
The outer `<button>` handles the whole click.

### 4.5 States

| State                      | Behavior                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty (`outstanding = []`) | The component does not render at all — `null`, not a single DOM node, not even a section title                                                                                                                                      |
| Filled, 1 currency         | `amountLabel = fmtAmount(sum, currency)` — see `banner-1440.png` context A/B                                                                                                                                                        |
| Filled, mixed currencies   | `amountLabel = "820 USDT + 300 EUR"` (join by currency, up to 3 values; 4+ → `"3+ валюты — точная сумма в модалке"`); the caption changes to «Несколько валют — точная сумма в модалке» — see the `banner-1440.png` edge-case block |
| Loading transactions       | The strip does not render until `['transactions']` has loaded (`isLoading`) — avoids a "empty→filled" flicker                                                                                                                       |

---

## 5. Modal — shared frame (`CompanySharePayoutModal`)

A single `<Dialog>` with ONE mounted `<CrmDialogContent>`, the internal `step: 'select' | 'submitting' | 'pay'`
drives the content. The component does NOT unmount/recreate the `<Dialog>` between steps — this is the
mechanism of "the modal does not close" (owner: "после сабмита модалка не закрывается").

### 5.1 Mobile shell — full-screen override

`CrmDialogContent` by default (`crm-dialog.tsx:41-51`) is already `w-full` + `sm:rounded-xl` (on mobile —
no radius, edge-to-edge in width), but the height is always a centered `max-h-[90dvh]` — on a small
screen with a long project list this leaves dead margins at the top/bottom. The task explicitly requires
full-screen/bottom-sheet on mobile — a minimal point fix (NOT a new component, the `className`
prop is already supported):

```tsx
<CrmDialogContent
  maxWidth="sm:max-w-lg"
  className="max-h-[100dvh] sm:max-h-[90dvh]"
  data-testid="company-share-payout-modal"
>
```

At `<640px` this gives a genuine full-screen (100dvh, edge-to-edge, no radius — already the component default);
`sm:` and above — the existing centered behavior unchanged. Reference:
`modal-step1-320.png` (mobile, full-screen) vs `modal-step1-1440.png` (desktop, centered card).

### 5.2 Title — one `<DialogTitle>`, the text changes, not the element

Radix requires exactly one `DialogTitle` per dialog. Between steps the TITLE text is updated (a different element
is not recreated) — this avoids a brief hole in the a11y tree:

- "Select" step: `Оплата доли CheekyCheeseIT`
- "Pay" step: `Заявка на выплату` + a status `Badge` next to it (see §7.2)

### 5.3 Stepper (persistent, both steps)

```tsx
<div className="mb-4 flex items-center gap-2" role="status" aria-label={stepAriaLabel}>
  <StepDot state={step === 'select' ? 'active' : 'done'} label="1" />
  <span className="text-xs font-medium">Выбор</span>
  <span className={cn('h-px w-8', step !== 'select' ? 'bg-emerald-500/30' : 'bg-border')} />
  <StepDot state={step === 'select' ? 'upcoming' : step === 'pay' ? 'active' : 'done'} label="2" />
  <span className="text-xs font-medium">Оплата</span>
</div>
```

`StepDot` — an inline helper (20×20px circle), 3 visual states: `upcoming` (`border-border
text-muted-foreground`), `active` (`bg-primary text-primary-foreground`, the current step),
`done` (`bg-emerald-500/15 text-emerald-400 border-emerald-500/30`, a checkmark instead of the number). **NOT
clickable** — unlike `SegmentedToggle` this is not a switch: from step 2 you cannot click "1"
and go back (the request is already created on the server, "back" makes no sense — see §7.4).

### 5.4 A11y — focus transfer and announcing the step change (a mandatory task requirement)

A `step` change inside one mounted dialog — the Radix `focus-trap` works at the level of the whole dialog,
but does NOT know about an internal "sub-screen" change. Two mechanisms, both mandatory:

1. **Focus transfer.** The step 2 container is `<div ref={step2ContainerRef} tabIndex={-1}>`, a `useEffect`
   on `step === 'pay'` calls `step2ContainerRef.current?.focus()`. Focus moves from the "Создать
   выплату" button (which logically "disappeared" under the new content) to the start of the new content, rather than
   staying on an invisible/irrelevant element.
2. **Live announcement region.** One persistent (not recreated) element:
   ```tsx
   <div aria-live="polite" className="sr-only" data-testid="company-share-step-announcer">
     {step === 'pay' ? 'Шаг 2 из 2. Заявка на выплату создана. Деньги ещё не отправлены.' : ''}
   </div>
   ```
   The text appears ONLY at the moment of transition (empty at step 1) — the screen reader announces it once
   on change, not on every re-render.

### 5.5 Closing at any moment

`onOpenChange={(open) => !open && handleClose()}` — a single point for Escape / overlay click /
the `CrmDialogContent` cross. `handleClose` resets the LOCAL UI state (`step` → `'select'`,
`selected` → `new Set()`, `payoutId` → `null`) — it **never rolls back** a request already created on the server
(see §7.5).

---

## 6. Surface B — Step 1: selection (`step === 'select'`)

References: `modal-step1-320.png` / `-768.png` / `-1024.png` / `-1440.png` (filled list,
partial selection), `modal-step1-empty-320.png` / `-1440.png` (empty selection → submit button
disabled).

### 6.1 Data grouping

```
projects: Map<projectId, { name: string; incomes: TransactionDto[] }>
```

Built from `validatedTxs` (the same prop `PayoutDialog` had — `SENIOR_INCOME`, `VALIDATED`,
`payoutRequestId == null`), `groupBy(t => t.projectId)`. Project order — by the date of the most recent
income within it (newest-first), as everywhere in the app.

### 6.2 Project checkbox — tri-state

```tsx
const projectRef = useRef<HTMLInputElement>(null)
const projectIncomeIds = incomes.map((t) => t.id)
const selectedCount = projectIncomeIds.filter((id) => selected.has(id)).length
const allSelected = selectedCount === projectIncomeIds.length
const noneSelected = selectedCount === 0

useEffect(() => {
  if (projectRef.current) projectRef.current.indeterminate = !allSelected && !noneSelected
}, [allSelected, noneSelected])

function toggleProject() {
  setSelected((prev) => {
    const next = new Set(prev)
    if (allSelected) projectIncomeIds.forEach((id) => next.delete(id))
    else projectIncomeIds.forEach((id) => next.add(id))
    return next
  })
}
```

A native `<input type="checkbox">` + `.indeterminate` via ref — the same primitive that is already in
`PayoutDialog.tsx:170-175`, WITHOUT a new `Checkbox` component (it is not in the shadcn/ui inventory —
introducing it for a single feature would mean a new visual language; the native checkbox with `accent-primary`
is ALREADY the only existing selection pattern in this flow).

### 6.3 Row markup — touch target ≥44px

```tsx
<div className="overflow-hidden rounded-lg border border-border">
  <label className="flex min-h-11 cursor-pointer items-center gap-3 p-3 hover:bg-muted/30">
    <input ref={projectRef} type="checkbox" checked={allSelected} onChange={toggleProject}
           className="h-4 w-4 shrink-0 accent-primary"
           aria-label={`Выбрать все приходы проекта ${project.name}`} />
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="truncate text-sm font-medium">{project.name}</span>
      <span className="shrink-0 tabular-nums text-sm font-medium">{fmtAmount(projectTotal, cur)}</span>
    </span>
  </label>
  {incomes.map((tx) => (
    <label key={tx.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-border py-2.5 pl-10 pr-3 hover:bg-muted/20">
      <input type="checkbox" checked={selected.has(tx.id)} onChange={() => toggleTx(tx.id)}
             className="h-4 w-4 shrink-0 accent-primary"
             aria-label={`Приход от ${fmtDate(tx.txDate ?? tx.createdAt)}`} />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">Приход от {fmtDate(...)}</span>
        <span className="shrink-0 tabular-nums text-xs">{fmtAmount(tx.amount, tx.currency)}</span>
      </span>
    </label>
  ))}
</div>
```

The touch target is the whole `<label>` row (`min-h-11` = 44px + `p-3`/`py-2.5` give an actual height
≥44px), not the bare checkbox (16px) — a 1:1 pattern with the rationale of `drop-share-override-and-receiver.md`
§Surface B responsive ("the full width of the container compensates for the height").

### 6.4 Live total

The existing block `PayoutDialog.tsx:190-313` is reused IN FULL (single-currency /
mixed-currency branches, `previewRows`, `hasMixedCurrencies`) — **no change to the calculation**, only
the source of `selected` can now include items from different projects (this does not change the formula). An empty
selection → the total block is hidden entirely (`{selected.size > 0 && (...)}`), NOT shown with zero amounts —
behavior 1:1 with the old dialog.

### 6.5 Empty selection → submit disabled

`disabled={selected.size === 0 || createMutation.isPending}` — the same pattern as
`PayoutDialog.tsx:325`. Reference: `modal-step1-empty-320.png`/`-1440.png`.

### 6.6 Selection default on open (a change relative to the old dialog — justified below)

| Entry point                                                                          | Default                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| CTA strip (`CompanySharePayoutStrip`)                                                | **EVERYTHING selected** (all projects, all incomes)         |
| Finance header «Выплатить (N)» (was: `finance/index.tsx:815-827`)                    | **EVERYTHING selected** (changed — see the rationale below) |
| Point button «Создать выплату» on a single row (`InProgressPanel`, `TransactionRow`) | Only this one income (as before, `preselectedTxIds`)        |

**A departure from the current behavior.** The old `PayoutDialog` when opened from the header always
started with an EMPTY selection (`preselectedTxIds` undefined → `new Set()`). The CTA strip, by its
nature, ALREADY asserts "you have N projects totaling X to pay" — opening the modal and seeing
an empty list would contradict the banner's own promise and add an extra "select
all" click in the most frequent scenario (paying all accumulated incomes at once). Re-grouping by project
(this feature) makes the result of the selection visually transparent, so the "everything" default does not risk an accidental
blind overpayment — the user SEES the whole list before submitting and can deselect extras. For the sake of
consistency of one and the same screen the same behavior is carried over to the header button as well
(the only entry point without a preselection). The point button on a single row is deliberately NOT touched:
there the user explicitly specified ONE income, changing the default there would be a surprise in the opposite
direction.

### 6.7 Double-submit protection

`createMutation.isPending` disables the button (existing pattern). Additionally — for the duration of submission,
disable the whole list of checkboxes (`<fieldset disabled={createMutation.isPending}>` around the list
of projects) — this prevents the selection from changing at the moment the request is already in flight with the previous set of ids.

---

## 7. Surface C — Step 2: payment (`step === 'pay'`), the modal does NOT close

References: `modal-step2-fresh-320.png`/`-1440.png` (right after the transition), `-validating-1440.png`,
`-error-1440.png`, `-confirmed-1440.png`.

### 7.1 Transition mechanism (without closing — the key requirement)

```tsx
const createMutation = useMutation({
  mutationFn: () => financeApi.createPayoutRequest({ transactionIds: [...selected] }),
  onSuccess: (payout) => {
    // Seed the cache with the mutation response — PayoutPaymentForm uses the SAME
    // query key as PayoutDetailDialog, so step 2 renders without
    // a skeleton flicker (the data is already there), but remains independently
    // refetch-able (e.g. after clicking «Подтвердить оплату»).
    qc.setQueryData(['payout-request', payout.id], payout)
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    setPayoutId(payout.id)
    setStep('pay') // ← NOT onClose()
  },
})
```

`CrmDialogContent`, `<Dialog open>` — are not touched. The only thing that changes is the internal JSX
driven by `step`. This is the "does not close" mechanism: the component then renders
`<PayoutPaymentForm payoutId={payoutId} variant="embedded" />` instead of the step 1 content.

### 7.2 Separating "created" vs "paid" (the owner's main requirement)

Three independent, mutually reinforcing signals — deliberately redundant, because the cost of error
(a person decides they have already paid) is high:

1. **A status Badge next to the title** — reuses the existing status vocabulary, which the
   user already sees in the transaction table every day:
   - Right after creation: `<Badge className={STATUS_COLORS.PENDING_PAYMENT}>{STATUS_LABELS.PENDING_PAYMENT}</Badge>`
     → «Ожидает выплаты» (orange).
   - After successful payment confirmation (`onChainStatus === 'confirmed'` inside `PayoutPaymentForm`,
     the existing logic `PayoutDetailDialog.tsx:186`): the badge switches to
     `STATUS_COLORS.PAID` / `STATUS_LABELS.PAID` → «Оплачено» (emerald).
2. **A persistent confirmation line** right under the header, WHILE the status is `PENDING_PAYMENT`:
   ```tsx
   <div
     role="status"
     className="flex gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
   >
     <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
     <div>
       <p className="text-xs font-medium text-emerald-400">Заявка создана</p>
       <p className="text-[11px] text-muted-foreground">
         Деньги ещё не отправлены — переведите сумму и укажите хеш транзакции ниже.
       </p>
     </div>
   </div>
   ```
   The wording deliberately puts two facts side by side in one sentence — "created" AND "not sent" —
   so that neither reads in isolation. This line **disappears** when the status moves to
   `PAID` (replaced by the existing confirmed block `PayoutDetailDialog.tsx:532-547` — «Транзакция
   подтверждена»), so at any moment there is exactly ONE statement about the state on screen, not two
   contradicting ones.
3. **Stepper** (§5.3) — the step "1 Выбор" is marked ✓ (done), the step "2 Оплата" is active UNTIL the status is
   `PAID`; when `PAID` — both segments are ✓. A secondary, peripheral signal (for those who
   navigate by progress rather than by text).

### 7.3 `PayoutPaymentForm` — extraction, not rewriting

All the contents of `PayoutDetailDialog.tsx:300-677` (instruction-card / the list of transactions included in the request /
tx-hash input / dev-simulate radio group / on-chain status block / manual-confirm section for
ADMIN/ACCOUNTANT) are moved "as is" into `PayoutPaymentForm({ payoutId, onPaid? })`. The mutation logic
(`payMutation`, `manualMutation`), `useQuery(['payout-request', payoutId])` — unchanged.
The only difference in usage:

- **`PayoutDetailDialog.tsx`** (existing, not deleted) — wraps `PayoutPaymentForm` in
  its OWN `<Dialog><CrmDialogContent>`, as today. The "Оплатить" entry points on an already created
  row (`TransactionRow`, `InProgressPanel`, `DropDashboard`) keep opening exactly it —
  **behavior does not change**, this is an explicit preservation from the task ("существующее поведение, сохранить").
- **`CompanySharePayoutModal`** — renders `PayoutPaymentForm` WITHOUT its own `<Dialog>`
  (`variant="embedded"` simply means "without an outer `<Dialog>`/`<CrmDialogContent>` wrapper and without
  its own „Закрыть“ button — the footer buttons come from the modal's shared footer", see §7.6).

### 7.4 No way back to step 1

No UI element of step 2 allows returning to the selection. Rationale: the request already exists on the
server (a `payout_request` with status `PENDING_PAYMENT` + the selected transactions moved to the same
status) — "cancelling the selection" from the user's point of view should mean an explicit action
(cancel/delete the request), which is not in the task's scope. The footer button at step 2 is `Закрыть`
(not "Отмена" — semantically different: it closes the window, does not cancel the request).

### 7.5 Closing at step 2 does not lose data

Explicitly inherited from `PayoutDetailDialog` (it already works this way): `onClose` does NOT call deletion/cancellation
of the request. The created `payout_request` is visible as an ordinary `PAYOUT` / `PENDING_PAYMENT` row in the
transaction table and in `InProgressPanel` (existing rendering, `TransactionRow`/`InProgressPanel` already know how to
show such rows with an «Оплатить» button → opens `PayoutDetailDialog`). Re-entry to
complete the payment goes through THIS existing path, not through reopening
`CompanySharePayoutModal` — it is intended only for the one-directional "select → create" flow
(see the §7.4 rationale).

### 7.6 Step 2 footer

```tsx
<CrmDialogFooter>
  <Button variant="outline" onClick={handleClose}>
    {isPaid || onChainStatus === 'confirmed' ? 'Закрыть' : 'Закрыть'}
  </Button>
  {!isPaid && onChainStatus !== 'confirmed' && (
    <Button
      data-testid="company-share-submit-payment"
      onClick={submitPayment}
      disabled={submitDisabled}
    >
      {payMutation.isPending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Проверка…
        </>
      ) : (
        'Подтвердить оплату'
      )}
    </Button>
  )}
</CrmDialogFooter>
```

A 1:1 copy of the existing logic `PayoutDetailDialog.tsx:681-717` (gating by `simulateMode`/hash length/
`isPending`) — `PayoutPaymentForm` exports the needed computed flags (`submitDisabled`,
`isPaid`, `onChainStatus`) outward via a children render-prop OR the modal simply reads them from a shared
payment-state hook (an implementation detail — left to the coder's discretion, as long as the buttons do not
duplicate the logic but reuse the existing one).

### 7.7 Error at step 2

Unchanged from the existing `PayoutDetailDialog` behavior: a `role="alert"` red block under the
hash input (`PayoutDetailDialog.tsx:549-567`), the request stays `PENDING_PAYMENT`, re-submission is available immediately.
The error text additionally explicitly reminds that the request is not rolled back —
see `modal-step2-error-1440.png` («Заявка остаётся в статусе «Ожидает выплаты» — данные не
потеряны.»), this is a MINOR wording reinforcement on top of the existing text, not new logic.

---

## 8. Responsive — summary table (4 classes)

| Class                | CTA strip (`CompanySharePayoutStrip`)                                                                                                                                                                 | Modal, step 1                                                                                                                                                                                            | Modal, step 2                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **320–375 (mobile)** | Column layout (`<480px`): the icon is hidden (`hidden`, saves horizontal space), title+badge, description, then amount+full-width «Оплатить» on a separate row. Min-height 44px. See `banner-320.png` | `CrmDialogContent` full-screen (`className="max-h-[100dvh]"`, §5.1) — edge-to-edge, no radius. The list scrolls in `CrmDialogBody`, footer sticky. Touch targets ≥44px (§6.3). See `modal-step1-320.png` | The same full-screen shell. Instruction-card/inputs — full-width, unchanged from `PayoutDetailDialog` (already responsive). See `modal-step2-fresh-320.png` |
| **768 (tablet)**     | Full horizontal layout (icon visible), as on desktop, within the content column                                                                                                                       | `CrmDialogContent` a centered `sm:max-w-lg` card, `sm:max-h-[90dvh]` — the same list, more breathing room                                                                                                | A centered card, unchanged                                                                                                                                  |
| **1024 (laptop)**    | Unchanged from 768                                                                                                                                                                                    | Unchanged from 768                                                                                                                                                                                       | Unchanged from 768                                                                                                                                          |
| **1440+ (large)**    | The strip does not stretch beyond the content column (`max-w`, inherits the page container — foundation.md §2)                                                                                        | The dialog does not stretch beyond `sm:max-w-lg` (the existing `CrmDialogContent` cap). See `modal-step1-1440.png`                                                                                       | Unchanged. See `modal-step2-fresh-1440.png`, `-validating-1440.png`, `-error-1440.png`, `-confirmed-1440.png`                                               |

**Verification (Playwright, mandatory before the PR):** at each of the test widths 320/375/768/1024/1280/1440/1920
— `document.documentElement.scrollWidth <= document.documentElement.clientWidth` on the dashboard
AND finance pages with the strip open; inside the modal — the same check on `CrmDialogContent`; at 320 —
all `<label>` rows and footer buttons measured ≥44px in height.

---

## 9. RBAC / scope boundaries

| Role                 | CTA strip                                                                                                                                                                                                            | Modal (this feature)                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SENIOR**           | Visible on `SeniorDashboard` + `finance/index.tsx`                                                                                                                                                                   | `CompanySharePayoutModal` — all entry points (strip, header, point button)                                                                                                                                |
| **ADMIN**            | `SeniorDashboard` renders for ADMIN as well (self-scoped, see the `SeniorDashboard.tsx` doc-comment) — the strip appears if the ADMIN has their own `SENIOR_INCOME` (usually none in prod, present in dev test data) | The same path as SENIOR — no new RBAC branches required, self-scope is already on the backend                                                                                                             |
| **DROP**             | **NOT added** (out of the task's scope, explicitly stipulated)                                                                                                                                                       | `InProgressPanel`/`DropDashboard` keep working via the EXISTING `PayoutDetailDialog` for «Оплатить»; the «Создать выплату» buttons on these screens that TODAY opened `PayoutDialog` — see the note below |
| HR/JUNIOR/ACCOUNTANT | Do not see it (do not declare `SENIOR_INCOME`)                                                                                                                                                                       | Not applicable                                                                                                                                                                                            |

**An important fork for the coder — `InProgressPanel` (shared by SeniorDashboard/DropDashboard).**
`InProgressPanel.tsx` today renders `PayoutDialog` (toolbar button «Создать выплату» + per-row)
for BOTH roles — SENIOR and DROP. `PayoutDialog.tsx` is deleted entirely (task AC6), so
`InProgressPanel` must get a replacement. The task explicitly forbids silently expanding the DROP scope, but does not
prescribe breaking the existing DROP button. Recommendation: `InProgressPanel` switches to
`CompanySharePayoutModal` for BOTH roles (preserves the status-quo functionality one-to-one — the same
button, the same result, no NEW surface appears for DROP, since `CompanySharePayoutStrip`
is not added there). This is NOT a scope expansion — merely a continuation of the existing entry point through
the only remaining modal component. If the reviewer decides otherwise (e.g. keep DROP on
a separate fork of the old modal) — explicitly flag it as an open question in the PR body, do not decide silently in
the opposite direction.

---

## 10. Edge cases

| Case                                                                                     | Behavior                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Long project name                                                                        | `truncate` on the name `<span>` (project row and in the live total), the full string is available via the `title` attribute OR a `Tooltip` (by analogy with `TransactionDetailDialog` — at the coder's discretion). The checkbox/amount do not shrink (`shrink-0`). See `modal-step1-*.png`, the third group |
| Many projects / many incomes inside a project                                            | The list is NOT virtualized (the volume is small in practice — one senior's incomes for the period before a request) — ordinary vertical scroll inside `CrmDialogBody` (`flex-1 overflow-y-auto`, already in the component). Footer and title stay sticky                                                    |
| Mixed currencies in the selected basket                                                  | The existing `hasMixedCurrencies` branch is reused (`PayoutDialog.tsx:251-281`) — a per-currency breakdown instead of a misleading single amount. For the strip — see §4.5                                                                                                                                   |
| Amount overflow on a small screen (many digits in `tabular-nums`)                        | The `text-primary` amount in the step-1 total has no fixed width — wraps to a new line inside the `flex justify-between` container (already works in the existing `PayoutDialog` pattern, visually tested at 320px)                                                                                          |
| No `contractAddress` (company wallet not configured)                                     | The existing behavior `PayoutDetailDialog.tsx:352-359` (a destructive block «Адрес не настроен») — inherited automatically via `PayoutPaymentForm`, no extra work                                                                                                                                            |
| Double click on «Создать выплату»                                                        | The button + `<fieldset disabled>` for the duration of `isPending` (§6.7) — a second click is impossible until the first request resolves                                                                                                                                                                    |
| Network error while creating the request (the step 1 → step 2 transition did not happen) | `createMutation.isError` — inline `text-destructive` under the button (existing pattern `PayoutDialog.tsx:315`), the modal stays on step 1, the selection is NOT reset, re-submission is available                                                                                                           |
| Closing at step 2, then opening the strip again                                          | The strip is recomputed from fresh `['transactions']` (invalidated in `onSuccess`, §7.1) — the already paid/submitted request disappears from `outstanding`, the new strip (if there is a remainder) — from scratch                                                                                          |
| 0 projects, but the user somehow got into the modal (data race)                          | `CompanySharePayoutModal` does not open without a caller — but just in case: `validatedTxs.length === 0` → the step 1 body shows `«Нет проверенных приходов»` (text 1:1 with `PayoutDialog.tsx:159-162`), the button is disabled                                                                             |

---

## 11. Motion

Inherits `foundation.md` §7 — compositor-friendly properties only, no new language:

- Dialog open/close — the existing Radix animation of `CrmDialogContent` (`fade+zoom+slide`,
  150-200ms), unchanged.
- The `step: 'select' → 'pay'` transition — **no content-change motion effect** (just a JSX replacement).
  Reason: any fade/slide animation between two steps that are DIFFERENT in meaning risks reading as
  "something smoothly transformed", which contradicts the goal of "a clearly new state", rather than continuity.
  An abrupt but not jerky content change + focus transfer (§5.4) is a more honest signal of "this is a different
  screen" than a smooth cross-fade.
- `status-box` (confirmation strip, error, on-chain) — the existing `animate-in fade-in-0
slide-in-from-bottom-1 duration-200` (`PayoutDetailDialog.tsx:515`), unchanged.
- `prefers-reduced-motion` — respected automatically via the existing Radix/tailwind-animate
  primitives, requires no additional work (this feature has no new keyframe animations).

---

## 12. data-testid — summary table

| Element                                     | `data-testid`                                       |
| ------------------------------------------- | --------------------------------------------------- |
| CTA strip (container)                       | `company-share-cta-strip`                           |
| Modal (`CrmDialogContent` container)        | `company-share-payout-modal`                        |
| Live region announcing the step change      | `company-share-step-announcer`                      |
| Project checkbox                            | `` `company-share-project-checkbox-${projectId}` `` |
| Income checkbox                             | `` `company-share-income-checkbox-${txId}` ``       |
| Live total block (step 1)                   | `company-share-selection-total`                     |
| «Создать выплату» button (step 1)           | `company-share-create-payout`                       |
| «Подтвердить оплату» button (step 2)        | `company-share-submit-payment`                      |
| Confirmation line «Заявка создана» (step 2) | `company-share-created-notice`                      |

---

## 13. Fidelity references (for Mode B after implementation)

All PNGs are a Playwright render of designer-authored HTML on the REAL token values from `globals.css`
(see the document header, degraded Tier 1). Use as the fidelity reference on a par with a regular
`design.png` (rule `design-fidelity-review.md` — degradation means "the reference is not from Claude Design",
but the requirement to cover device classes is not lowered — all 4 classes are covered):

```
docs/design/assets/company-share-cta/
├── tokens.css                          — tokens (a link to the source in the file's comment)
├── banner.html / banner-320.png / banner-1440.png
├── modal-step1.html / modal-step1-{320,768,1024,1440}.png
├── modal-step1-empty.html / modal-step1-empty-{320,1440}.png
└── modal-step2.html (#fresh|#validating|#error|#confirmed)
    / modal-step2-fresh-{320,1440}.png
    / modal-step2-{validating,error,confirmed}-1440.png
```

---

## 14. Instructions for the coder (CRITICAL)

1. **Build with our components.** `Dialog`/`CrmDialogContent`/`Badge`/`Button` from shadcn/ui, a native
   `<input type="checkbox">` (the `PayoutDialog.tsx` pattern) — the `design.html` mockups in `assets/` are PURELY
   a visual reference for screenshots, **NOT code to paste** (it is hand-rolled CSS imitating
   Tailwind classes by hand — the real code must use real Tailwind utilities and real
   components, not what is in the mockup).
2. **`PayoutDialog.tsx` is deleted**, `PayoutDetailDialog.tsx` **stays** (a thin wrapper over the new
   `PayoutPaymentForm`) — do not confuse these two files with each other (§7.3).
3. **The amount-payable formula** — `amount * (1 - sharePercent/100)`, NOT the gross income (§4.3). This is
   the highest cost-of-error point of the spec — it is easy to accidentally show gross instead of payable.
4. **Selection default "everything"** on open without a preselection (§6.6) — a deliberate departure from the old
   `PayoutDialog`, do not forget to carry it over to the `finance/index.tsx` header button too.
5. **The step1→step2 transition — WITHOUT `onClose()`.** The most frequent potential implementation mistake is accidentally
   calling the existing `handleClose()` pattern out of inertia from the old code. `setStep('pay')`, not
   closing.
6. **Focus + `aria-live`** on the step change — both mechanisms are mandatory (§5.4), not just one of them.
7. **DROP entry points** (`InProgressPanel`) — keep working via `CompanySharePayoutModal`
   (§9), but do NOT add `CompanySharePayoutStrip` to `DropDashboard`/`DropFinancePage`.
8. **`Coins` for the strip, `Wallet` — does not change anywhere** elsewhere (§4.4) — do not mix up the
   icons, the semantics differ.
9. **Responsive** — `className="max-h-[100dvh] sm:max-h-[90dvh]"` on `CrmDialogContent` for THIS
   modal (§5.1); do not carry this override over to other dialogs of the app — only here, since
   this modal in particular potentially has a long list.
10. **data-testid** — strictly per the §12 table, AutoTest relies on them.
