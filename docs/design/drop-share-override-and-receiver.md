# Design Spec — Per-project Drop Share Override + Payment-type Income Routing

> **Design tier:** 2 (edit of existing screens)
> **design-gate:** degraded (Tier 2 conformance, Claude Design not used — a text spec)
> **Status:** coder-ready
> **Feature branch:** `feature/drop-share-override-and-receiver`
> **Brief reference:** `.claude/briefs/pm-brief-drop-share-override-and-receiver.md`
> **ADR reference:** `docs/architecture/2026-07-13-payment-type-income-routing.md`
> **Designer task:** `task-drop-share-design`

---

## ⚠️ ADDENDUM (2026-07-13) — read first

This spec was written **before** the contract was finalized (the first version — commit `1c66d2a0`). The owner
fixed the final contract in the ADR `2026-07-13-payment-type-income-routing.md` — it changes
**Surface B** and adds **Surface C**. Below is the current version of the document in full.

What changed vs the first version:

1. **Surface A** (the "Доля дропа (%)" slider) — **unchanged**, correct from the first pass.
2. **Surface B** ("Получатель прихода") — **MOVED**. Previously a mandatory receiver
   selector was planned inside the `DROP_INCOME` dialog (the drop declares their income and chooses
   to whom it actually arrived — themselves or the admin). **This is outdated.** Now: `DROP_INCOME` (like
   `SENIOR_INCOME`) on FOP/gig projects stays **without any receiver selector** — the lifecycle
   does not change. The receiver appears in a **new, separate ADMIN-only flow** for declaring
   USDT income (`USDT_INCOME` — a synthetic UI type in `CreateTransactionDialog`, the ledger type
   stays `ADMIN_INCOME`).
3. **Surface C** (NEW) — the project's "Тип оплаты" Select (`FOP` / `GIG_CONTRACT` / `USDT`),
   replaces the existing free-text `paymentType` field in the project form.
4. Added a **gate-hide** for SENIOR/DROP on USDT projects (empty states/hints inside
   `CreateTransactionDialog`).

The Coder implements per the sections below (the only source of truth now). The old Surface B draft
("receiver selector in DROP_INCOME") is **not to be implemented** — it was removed from this version of the document;
the history is in the git blame of commit `1c66d2a0`, if context is needed.

---

## ⚠️ ADDENDUM 2 (2026-07-14) — The receipt for `USDT_INCOME` is mandatory again

The "Чек / подтверждение" section inside **Surface B** below described the ADR Q1 decision ("direct credit, no
receipt at all" for an admin USDT income). **The owner reversed this decision** — `USDT_INCOME` now carries a
**mandatory receipt as an explorer link**, on a par with all other transaction create/pay flows. The full
contract (domain allowlist, the `explorerOnly` mechanism of `ReceiptInput`, unified `showReceipt`) —
`docs/design/transaction-receipts.md` (task `task-receipts-design`, branch
`feature/transaction-receipts`). The "Чек / подтверждение" section below is updated inline, the old ADR Q1 text
is kept under `<details>` for history only.

---

## Context and UX principle

All three surfaces are **conformance to already existing patterns**, not a new visual language:

- **Surface A** (the `dropSharePercentOverride` slider) repeats the `seniorSharePercentOverride` ShareSlider.
  The difference is only in label/role/hint. No new components.
- **Surface B** (the receiver of an admin USDT income) repeats the structure of the existing `DIVIDEND` branch
  in `CreateTransactionDialog.tsx` (:801-883) — a self-contained "balance/receiver (grouped
  Select)/amount" block, ADMIN-only, plus reuses the already existing `isUsdtLocked` mechanism
  of forced currency (:211-215, used for `ADMIN_INCOME`+`COMPANY_ACCOUNT`).
- **Surface C** (the project payment type) replaces the already existing free-text `paymentType` field
  (currently — a plain `Input` inside the generic field loop in `ProjectEditFields` and in the project
  creation form) with a `Select` with 3 values — the same disabled/hidden RBAC pattern as
  `seniorSharePercentOverride`.

The Coder builds strictly per the reference patterns from `$projectId.tsx`, `projects/index.tsx` and
`CreateTransactionDialog.tsx`. `design-gate: degraded` — generating a new mockup is not required.

---

## Token map

Only existing semantic tokens from `apps/web/app/styles/globals.css` are used.
No new tokens are introduced — this includes the addendum surfaces (Surface B v2 and C reuse
the identical set, no new CSS variables).

| Purpose                            | Tailwind / CSS token                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Page background / canvas           | `bg-background`                                                                                                                       |
| Raised surface (card)              | `bg-card` / `border-border`                                                                                                           |
| Secondary / captions               | `text-muted-foreground`                                                                                                               |
| Primary text                       | `text-foreground`                                                                                                                     |
| Error / destructive                | `text-destructive` / `border-destructive`                                                                                             |
| Brand / CTA                        | `bg-primary` / `text-primary`                                                                                                         |
| Input / border                     | `border-input` / `bg-background` / `bg-muted`                                                                                         |
| Radius                             | `rounded-md` (nested controls) / `rounded-lg` (cards)                                                                                 |
| Disabled state                     | `opacity-60` (as in ShareSlider) / `opacity-50` (SelectItem disabled — component)                                                     |
| Slider visual accent (company-bar) | `bg-primary/20 text-primary`                                                                                                          |
| Slider visual accent (role-bar)    | `bg-emerald-500/20 text-emerald-400` (ShareSlider reference)                                                                          |
| Info-hint (company-balance box)    | `border-blue-500/20 bg-blue-500/5 text-blue-400` (existing pattern, `CreateTransactionDialog.tsx:702`, `:804`)                        |
| Hint text                          | `text-xs text-muted-foreground`                                                                                                       |
| Validation error                   | `text-[11px] text-destructive` (CreateTransactionDialog pattern)                                                                      |
| Type card (selected/unselected)    | `border-primary bg-primary/8 text-foreground` / `border-border bg-muted/20 text-muted-foreground` (`type` selector pattern, :508-513) |
| Select group label                 | `text-sm font-semibold` (built into `SelectLabel`, `ui/select.tsx:102`)                                                               |

---

## Surface A — the "Доля дропа (%)" slider in the project edit form

**Unchanged** — the section below is identical to the first version of the spec, conformant to the final contract.

### Reference pattern

`apps/web/app/routes/_authenticated/projects/$projectId.tsx` — `ProjectEditFields` (lines 339–397),
the `seniorSharePercentOverride` field with `ShareSlider`.

`apps/web/app/components/ui/share-slider.tsx` — the `ShareSlider` component (lines 41–126). The component
**already supports** `role="DROP"` (`ROLE_LABELS.DROP`, share-slider.tsx:38) — use as is,
without modifying the component.

### Component

The existing `ShareSlider` from `@/components/ui/share-slider` is used.
**No new components are required.**

`ShareSlider` call parameters for the drop share:

```tsx
<ShareSlider
  value={sliderValue} // dropSharePercentOverride ?? effectiveDropSharePercent
  min={0}
  max={100}
  disabled={!canEditOverride} // canEditOverride = role ADMIN | ACCOUNTANT
  onChange={(v) => field.handleChange(v)}
  onBlur={field.handleBlur}
  error={!!err}
  inputTestId="project-edit-drop-share-override"
  role="DROP"
/>
```

### Placement in `ProjectEditFields`

Place the new section **right after** the `seniorSharePercentOverride` section (line 392 in `$projectId.tsx`).

```tsx
{/* Per-project DROP share — only for drop projects, only ADMIN/ACCOUNTANT.
    The pattern is a full analog of seniorSharePercentOverride above. */}
{viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && project.dropId != null && (
  <form.Field name="dropSharePercentOverride" validators={...}>
    {(field) => {
      const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
      const raw = field.state.value as number | null
      const hasOverride = raw !== null && raw !== undefined
      const sliderValue = hasOverride ? (raw as number) : effectiveDropSharePercent
      return (
        <div className="space-y-2" data-testid="project-edit-drop-share-section">
          <Label className={cn(err && 'text-destructive')}>Доля дропа (%)</Label>
          <ShareSlider
            value={sliderValue}
            min={0}
            max={100}
            disabled={!canEditOverride}
            onChange={(v) => field.handleChange(v)}
            onBlur={field.handleBlur}
            error={!!err}
            inputTestId="project-edit-drop-share-override"
            role="DROP"
          />
          <p className="text-xs text-muted-foreground">
            По умолчанию: {effectiveDropSharePercent}%. Установите те же значение, чтобы сбросить
            переопределение.
          </p>
          {!canEditOverride && (
            <p className="text-xs text-muted-foreground italic">
              Менять может только ADMIN или ACCOUNTANT.
            </p>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      )
    }}
  </form.Field>
)}
```

### Visibility condition (RBAC)

| Role       | Show condition                            | State                         |
| ---------- | ----------------------------------------- | ----------------------------- |
| ADMIN      | `dropId != null`                          | enabled                       |
| ACCOUNTANT | `dropId != null`                          | enabled                       |
| SENIOR     | `dropId != null`                          | disabled (`!canEditOverride`) |
| DROP       | `dropId != null`                          | disabled (`!canEditOverride`) |
| HR         | hidden (filter `viewerRole !== 'HR'`)     | —                             |
| JUNIOR     | hidden (filter `viewerRole !== 'JUNIOR'`) | —                             |

Non-drop projects (`project.dropId == null`): the section is hidden completely for all roles.

### Value for the form

- `dropSharePercentOverride` = `null | number` (analogous to `seniorSharePercentOverride`).
- `effectiveDropSharePercent` — the current effective share, resolved by the backend hierarchy from ADR D4:
  `project.dropSharePercentOverride ?? user.dropSharePercent ?? 5` (WITHOUT a team level — a drop has no
  team-membership override, unlike a senior).
- **Implicit-null-reset:** if the user sets a value === `effectiveDropSharePercent`,
  the frontend sends `null` (or the backend resolves this as a reset). Strictly the same pattern as the senior.

### info-row "Доля дропа" in the Overview

Next to the `InfoRow` "Доля синьора" (line 1028 in `$projectId.tsx`) add a row for drop projects:

```tsx
{
  canSeeProjectFinance && project.dropId != null && (
    <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля дропа">
      <ProjectDropShareInfo project={project} />
    </InfoRow>
  )
}
```

`ProjectDropShareInfo` — a component modeled on `ProjectShareInfo` (the existing one for the senior, line
429). Shows: the current effective share + the source (`PROJECT` / `USER_DEFAULT`), an "Override" badge
when an override is present. Pattern: `text-sm font-medium tabular-nums` for the number.

### The `ProjectDropDistribution` panel

The component (`$projectId.tsx:1520`) already reads `project.dropSharePercent ?? 5`. After the backend task
the DTO will return the effective share (accounting for the override). **No UI edits are required** — the data
will arrive updated in the DTO. The designer notes: the panel shows the effective share (a snapshot at the moment
of rendering), not the stored override separately.

---

## Surface B — Receiver of an admin USDT income (a NEW flow, replaces the old Surface B)

> **DROP_INCOME / SENIOR_INCOME on FOP/gig — UNCHANGED.** The drop/senior declare their income
> strictly as today — project, amount+currency, receipt, date. No receiver selector is added there.
> The gate-hide for these roles on USDT projects — see the subsection below.

### Reference patterns (3 existing places, combined)

1. **Synthetic UI type of the dialog** — `DIVIDEND` (`CreateTransactionDialog.tsx:42-45,84,90,801-883`).
   `DIVIDEND` is not a `TransactionType` value but a UI-only branch of `DialogTxType`, because the real
   ledger type is created by a separate company-account endpoint. **The same pattern** for the new
   `USDT_INCOME`: a UI-only synthetic type, the real ledger type on the backend — `ADMIN_INCOME`
   (reused, see ADR D3) via a separate method/endpoint `declareUsdtProjectIncome`.
   This means `USDT_INCOME` is **not included** in `constants.ts` `TYPE_LABELS`/`TYPE_COLORS` (those stay
   `Record<TransactionType, …>` — zero blast radius, like `DIVIDEND`).
2. **Grouped receiver Select** — the ADR requires 2 option groups ("Админы" + "Счёт компании"). The
   `Select` component from `@/components/ui/select` already exports `SelectGroup` + `SelectLabel` +
   `SelectSeparator` (`ui/select.tsx:9,96-106,130-140`) — **currently not used anywhere in the
   app**, but they are part of the canonical shadcn/ui set of this same file. The first use
   in this feature is not a new component, but the first inclusion of an already existing primitive.
3. **Forced USDT currency without new UI** — the existing `isUsdtLocked` (:211-215) already hides the currency
   selector of `AmountCurrencyInput` (`disableCurrency` prop, :887-901) for `ADMIN_INCOME` when
   `fundingSource === 'COMPANY_ACCOUNT'`. Extend this boolean — `USDT_INCOME` is **always**
   locked (not by a toggle but unconditionally, since the currency for this type is always USDT).

### "Тип операции" type card

Add `'USDT_INCOME'` to `availableTypes` **for ADMIN only** (ADR Q4 — ACCOUNTANT does NOT declare
USDT income):

```tsx
const availableTypes: DialogTxType[] = isAdmin
  ? ['ADMIN_INCOME', 'USDT_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER', 'DIVIDEND']
  : isAccountant
    ? ['ADMIN_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']
    : isSenior
      ? ['SENIOR_INCOME']
      : isDrop
        ? ['DROP_INCOME']
        : []
```

Icon/description — modeled on `TYPE_ICONS`/`TYPE_DESCRIPTIONS` + `typeLabel()`/`DIVIDEND_LABEL`
(:42-49,71-91):

```tsx
const USDT_INCOME_LABEL = 'USDT-приход'
const USDT_INCOME_DESCRIPTION = 'Приход по USDT-проекту — получатель + авто-обязательства'

// extend typeLabel():
function typeLabel(t: DialogTxType): string {
  if (t === 'DIVIDEND') return DIVIDEND_LABEL
  if (t === 'USDT_INCOME') return USDT_INCOME_LABEL
  return TYPE_LABELS[t]
}

// TYPE_ICONS / TYPE_DESCRIPTIONS — add the key 'USDT_INCOME' (Record<string, …>,
// not Record<TransactionType, …> — safe, like DIVIDEND):
TYPE_ICONS.USDT_INCOME = <TrendingUp className="h-4 w-4" /> // income semantics, like the other income types
TYPE_DESCRIPTIONS.USDT_INCOME = USDT_INCOME_DESCRIPTION
```

The type card's `data-testid` is generated by the existing pattern
`` `create-transaction-type-${t.toLowerCase()}` `` (:514) → `create-transaction-type-usdt_income`
automatically, without a manual edit.

### Project selector — extend the existing block

The existing "Project selector" block (:532-570) is already conditionally rendered for
`SENIOR_INCOME | ADMIN_INCOME | DROP_INCOME`. Extend the condition + the pool to `USDT_INCOME`:

```tsx
{(type === 'SENIOR_INCOME' ||
  type === 'ADMIN_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'USDT_INCOME') && (
  <div className="space-y-1.5">
    <Label className="text-xs text-muted-foreground">Проект</Label>
    <Select value={projectId} onValueChange={...}>
      <SelectTrigger data-testid="create-transaction-project-trigger" ...>
        <SelectValue placeholder="Выберите проект" />
      </SelectTrigger>
      <SelectContent>
        {(type === 'ADMIN_INCOME'
          ? adminProjects
          : type === 'DROP_INCOME'
            ? dropProjects
            : type === 'USDT_INCOME'
              ? usdtProjects
              : myProjects
        ).map((p) => (
          <SelectItem key={p.id} value={p.id} className="text-sm">
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {/* the existing error paragraph without changes */}
  </div>
)}
```

`usdtProjects` — a new derived array: **any** active USDT project (not only "own", ADR D3:
"The project — ANY USDT project"):

```tsx
const usdtProjects = isAdmin ? projects.filter((p) => p.paymentType === 'USDT') : []
```

**Data requirement:** the local type `ProjectOption` (:65) is extended with the field `paymentType?: string | null`
— the backend already returns `paymentType` in `GET /projects` (verified, `projectSchema.paymentType`,
`packages/shared/src/schemas/projects.ts:147`), the frontend only needs to add the field to the local type.

### Receiver — a new grouped Select (the heart of Surface B)

Place it **right after** the project selector, in its own block `type === 'USDT_INCOME'`
(structurally — next to the existing `DIVIDEND` branch :801, at the same nesting level):

```tsx
{
  type === 'USDT_INCOME' && (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Получатель прихода</Label>
      <Select
        value={receiverId}
        onValueChange={(v) => {
          setReceiverId(v)
          clearFieldError('receiver')
        }}
      >
        <SelectTrigger
          className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
          data-testid="usdt-income-receiver-trigger"
        >
          <SelectValue placeholder="Выберите получателя" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Админы</SelectLabel>
            {adminUsers.map((u) => (
              <SelectItem key={u.id} value={u.id} className="text-sm">
                {u.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Счёт компании</SelectLabel>
            <SelectItem value="COMPANY_ACCOUNT" className="text-sm">
              Счёт компании
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Весь приход (gross) уйдёт выбранному получателю. Компания автоматически создаст
        обязательства выплатить синьору и дропу их доли.
      </p>
      {fieldErrors.receiver && (
        <p className="text-[11px] text-destructive" data-testid="usdt-income-error-receiver">
          {fieldErrors.receiver}
        </p>
      )}
    </div>
  )
}
```

Rationale for the design decision: the existing `receiverId` state is reused (already shared across
SALARY/DIVIDEND/ADMIN_TRANSFER, :138) with the sentinel string `'COMPANY_ACCOUNT'` for "Счёт компании" —
this is exactly the same value that is already sent in the payload when company funding is selected for
`ADMIN_INCOME`/`EXPENSE` (:326,363), so the backend contract `createUsdtIncomeSchema.receiverId:
uuid | 'COMPANY_ACCOUNT'` (ADR D3) resolves without additional mapping on the frontend — the value from the Select goes
into the payload as is.

### Receiver default

**Do NOT preselect** (the ADR — a deliberate choice). The existing reset `setReceiverId('')` on type change
(:498) already provides this — no additional logic is required (unlike the old version of the spec, where for
the DROP role an auto-preselect was assumed — that was part of the outdated contract, not applicable here:
`USDT_INCOME` is available only to ADMIN).

### Amount — forced USDT currency

Extend the existing `isUsdtLocked` (:211-215; do NOT create a new variable):

```tsx
const isUsdtLocked =
  type === 'USDT_INCOME' ||
  ((type === 'EXPENSE' || type === 'ADMIN_INCOME') && fundingSource === 'COMPANY_ACCOUNT')
```

`AmountCurrencyInput` (:887-901) is already conditionally rendered for `type !== 'DIVIDEND'` — `USDT_INCOME`
passes through the same shared block with no JSX edits, only via `isUsdtLocked`. The currency selector
inside the component is hidden automatically (`disableCurrency={isUsdtLocked}`).

### Receipt / confirmation

> **⚠️ ADDENDUM 2 (2026-07-14) — read on top of the text below.** The owner **reversed** the ADR Q1 decision
> "direct credit without tx-link verification" for an admin USDT income. The current decision (fixed
> by the task `task-receipts-design`, `docs/design/transaction-receipts.md`): **`USDT_INCOME` NOW carries a
> MANDATORY receipt — as an explorer link** (domain allowlist, a file is NOT accepted), like all other
> create/pay transaction flows. The text of the section below (describing "no receipt at all") is **outdated**,
> kept only for the history of the ADR Q1 decision (git blame/context, IF needed). The Coder implements the
> `USDT_INCOME` receipt per `docs/design/transaction-receipts.md` §3.1/§4 (the unified `showReceipt`/
> `effectiveCurrency`/`explorerOnly` mechanism for ALL 7 receipt types of `CreateTransactionDialog`,
> `USDT_INCOME` is one of them, ALWAYS `explorerOnly=true` since its currency is `z.literal('USDT')`).
> `createUsdtIncomeSchema` (ADR D3) **adds** `receiptFields`+`receiptXor` (previously: deliberately without
> them) — the backend contract is coordinated in the same task.

<details>
<summary>Outdated text (ADR Q1, reversed by the owner 2026-07-14) — kept for history</summary>

Previously: the owner chose **(a) direct credit, without on-chain tx-link verification** for an admin USDT income
(not the "direct + optional link" option). It followed that `USDT_INCOME` — without a receipt/confirmation
at all, not "optional, like `ADMIN_INCOME`". `showReceipt` (:456-460) was NOT extended to `USDT_INCOME`;
`createUsdtIncomeSchema` (ADR D3) did not contain the fields `receiptDocumentId`/`receiptExternalUrl`,
the submit payload did not send them:

```tsx
const showReceipt =
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'EXPENSE'
// USDT_INCOME was NOT included here (ADR Q1) — a trusted ADMIN, direct credit,
// without receipt proof for this flow. REVERSED 2026-07-14, see the addendum above.
```

</details>

### Validation

Extend `validate()` (:278-306). **Updated by addendum 2** — the `hasReceipt` check for `USDT_INCOME`
now goes through the SINGLE `showReceipt` mechanism of `transaction-receipts.md` §3.1 (not a separate branch):

```tsx
if (
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'USDT_INCOME'
) {
  if (!projectId) errors.project = 'Выберите проект'
}
if (type === 'USDT_INCOME') {
  if (!receiverId) errors.receiver = 'Выберите получателя'
}
// Receipt — the single showReceipt gate (transaction-receipts.md §3.1), USDT_INCOME included:
// if (showReceipt) { if (!hasReceipt) errors.receipt = '...'; else if (isExplorerOnly && ...) ... }
```

### Submit

A new branch in `mutation.mutationFn` (next to `ADMIN_INCOME`/`DROP_INCOME`, :315-352), calls a
**new** `financeApi` method (the frontend task adds the function + imports the DTO type from
`@crm/shared` after the backend contract). **Updated by addendum 2** — `receiptDocumentId`/
`receiptExternalUrl` ARE NOW sent (they were explicitly excluded before the reversal of ADR Q1):

```tsx
if (type === 'USDT_INCOME') {
  return financeApi.declareUsdtProjectIncome({
    projectId,
    amount: amt,
    currency: 'USDT',
    receiverId, // uuid OR 'COMPANY_ACCOUNT' — as is from the Select
    receiptDocumentId, // MANDATORY (addendum 2) — as an explorer link, currency='USDT' forces explorerOnly
    receiptExternalUrl, // XOR with receiptDocumentId; for USDT_INCOME this path is in practice always the one filled in (a file is not accepted)
    notes: notes || null,
    txDate: txDate || null,
  })
}
```

The exact endpoint path (`POST /api/finance/usdt-income` per ADR D3 vs the existing convention
`/transactions/*`) — the backend task's contract; the frontend calls via `financeApi.declareUsdtProjectIncome`
regardless of the final path. The receipt contract (mandatory, explorer-only allowlist) —
`docs/design/transaction-receipts.md` §2.2/§4.2.

### Gate-hide for SENIOR/DROP on USDT projects (ADR D2)

The FOP/gig lifecycle of SENIOR_INCOME/DROP_INCOME does not change, but the project pool for these types **excludes**
USDT projects (only ADMIN declares):

```tsx
const myProjects = isSenior
  ? projects.filter((p) => p.seniorId === user?.id && p.paymentType !== 'USDT')
  : projects
const dropProjects = isDrop
  ? projects.filter((p) => p.dropId === user?.id && p.paymentType !== 'USDT')
  : []
```

**Empty state** when the SENIOR/DROP have projects but ALL of them are of the USDT type (the list is empty after
the filter although the original is not) — show a hint under the project selector instead of a silently empty
Select:

```tsx
{
  type === 'SENIOR_INCOME' &&
    projects.some((p) => p.seniorId === user?.id) &&
    myProjects.length === 0 && (
      <p
        className="text-xs text-muted-foreground italic"
        data-testid="senior-income-usdt-gate-hint"
      >
        На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к администратору.
      </p>
    )
}
{
  type === 'DROP_INCOME' &&
    projects.some((p) => p.dropId === user?.id) &&
    dropProjects.length === 0 && (
      <p className="text-xs text-muted-foreground italic" data-testid="drop-income-usdt-gate-hint">
        На всех ваших проектах приход декларирует администратор (USDT). Обратитесь к администратору.
      </p>
    )
}
```

If the SENIOR/DROP have a mix of FOP/gig + USDT projects — the USDT projects simply do not appear in the
Select (silent filtering, no hint), declaration on the remaining projects works as usual.

---

## Surface C — "Тип оплаты" Select in the project form (NEW)

### Reference pattern

The `paymentType` field already exists **as a free-text `Input`** in two places, both part of the same
generic loop of 6 fields:

- Project creation: `apps/web/app/routes/_authenticated/projects/index.tsx:758-786`.
- Project editing: `apps/web/app/routes/_authenticated/projects/$projectId.tsx:268-303`.

Both locations are **literally identical code** (`['techStack','teamSize','benefits','paymentType',
'salaryReview','corpTech']` + a `labels` record + `form.Field` + `Input`). The RBAC pattern for field-scoped
disable — `seniorSharePercentOverride` (`canEditOverride`, `$projectId.tsx:516`).

### Enum values

`FOP → 'ФОП'`, `GIG_CONTRACT → 'гіг-контракт'`, `USDT → 'USDT'` (see ADR D1,
`projectPaymentTypeSchema = z.enum(['FOP','GIG_CONTRACT','USDT'])`).

### Change in the generic loop (edit form and create form — identical)

Inside `.map((fieldName) => ...)` split out `paymentType` with a special branch (the other 5 fields stay
`Input` without changes):

```tsx
{
  ;(['techStack', 'teamSize', 'benefits', 'paymentType', 'salaryReview', 'corpTech'] as const).map(
    (fieldName) => {
      const labels: Record<string, string> = {
        techStack: 'Стек технологий',
        teamSize: 'Состав команды',
        benefits: 'Бенефиты',
        paymentType: 'Тип оплаты',
        salaryReview: 'Пересмотр ЗП',
        corpTech: 'Корп. технологии',
      }
      if (fieldName === 'paymentType') {
        return (
          <form.Field key="paymentType" name="paymentType">
            {(field: AnyField) => (
              <div className="space-y-1.5">
                <Label>Тип оплаты</Label>
                <Select
                  value={field.state.value as string}
                  onValueChange={(v) => field.handleChange(v)}
                  disabled={!canEditPaymentType}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="project-payment-type-trigger">
                    <SelectValue placeholder="Выберите тип оплаты" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FOP" className="text-sm">
                      ФОП
                    </SelectItem>
                    <SelectItem value="GIG_CONTRACT" className="text-sm">
                      гіг-контракт
                    </SelectItem>
                    <SelectItem value="USDT" className="text-sm">
                      USDT
                    </SelectItem>
                  </SelectContent>
                </Select>
                {!canEditPaymentType && (
                  <p className="text-xs text-muted-foreground italic">
                    Менять может только ADMIN или ACCOUNTANT.
                  </p>
                )}
              </div>
            )}
          </form.Field>
        )
      }
      return (
        <form.Field key={fieldName} name={fieldName}>
          {(field: AnyField) => (
            <div className="space-y-1.5">
              <Label>{labels[fieldName]}</Label>
              <Input
                value={field.state.value as string}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  field.handleChange(e.target.value)
                }
                placeholder=""
              />
            </div>
          )}
        </form.Field>
      )
    },
  )
}
```

`canEditPaymentType` = the same expression as `canEditOverride` (ADMIN | ACCOUNTANT) — **in the edit form
reuse the existing variable `canEditOverride`** (`$projectId.tsx:516`) directly, without
duplication. **In the create form** (`index.tsx`) declare an analog `const canEditPaymentType =
user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'` — note that `canCreate` there = ADMIN||HR
(:136), i.e. **HR can create a project but cannot choose the payment type** on creation: the Select
shows the default `ФОП` (corresponds to the backend default `DEFAULT 'FOP'`, ADR D1) in the disabled state
with the same hint "Менять может только ADMIN или ACCOUNTANT." ACCOUNTANT physically does not see the create form
(`canCreate` does not let them in) — the RBAC variable stays symmetric for conformance with the edit form,
it does not create extra state.

### Read-only view — InfoRow "Тип оплаты"

The existing `InfoRow` (`$projectId.tsx:989-995`) currently renders `project.paymentType` as
free text **without an RBAC gate** (visible to all roles, including HR/JUNIOR). Update:

```tsx
{
  viewerRole !== 'JUNIOR' && (
    <InfoRow icon={<CreditCard className="h-3.5 w-3.5" />} label="Тип оплаты">
      {project.paymentType ? (
        <span className="font-medium">{PAYMENT_TYPE_LABELS[project.paymentType]}</span>
      ) : (
        <span className="text-muted-foreground/40 italic">—</span>
      )}
    </InfoRow>
  )
}
```

`PAYMENT_TYPE_LABELS` — a constant mapping enum→Russian label (`{ FOP: 'ФОП', GIG_CONTRACT:
'гіг-контракт', USDT: 'USDT' }`), shared by the Select options and the read view (do not duplicate the strings).

**Important (Q5 — hiding from JUNIOR):** this is the only RBAC edit of the read view in this feature — previously the
row was visible to everyone. Now `viewerRole !== 'JUNIOR'` explicitly excludes JUNIOR, HR **keeps
seeing the value** (the Q5 table in the task: HR = read (value), only JUNIOR = hidden entirely). If the
backend decides to mask the field as `null` in the JUNIOR DTO (rather than simply not distinguishing the role), the frontend
still must not render the row for JUNIOR by an explicit condition (defense-in-depth, do not rely only
on `project.paymentType == null`, since HR could theoretically get null for another reason too).

### data-testid

| Element                                               | `data-testid`                  |
| ----------------------------------------------------- | ------------------------------ |
| SelectTrigger "Тип оплаты" (edit + create — the same) | `project-payment-type-trigger` |

---

## Responsive (4 device classes)

**Approach: mobile-first.** All three surfaces inherit the behavior of their reference patterns —
ShareSlider (Surface A), the `CreateTransactionDialog`/`CrmDialog` dialog (Surface B), the project form in
a dialog (Surface C).

### Surface A — ShareSlider in the project edit dialog

| Class           | Behavior                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mobile 320–639  | `space-y-2` = a standard vertical stack. The visual bar is 100% of the container width — adapts automatically. The numeric input `w-16` does not change. Slider hit area: `h-2` track → the thumb is the native browser one (≥44px in most mobile browsers). Range input `accent-primary`. The whole block is not clipped — no fixed horizontal sizes. |
| Tablet 640–1023 | Identical to mobile, the container width is larger — the bar reads better.                                                                                                                                                                                                                                                                             |
| Laptop 1024+    | Full width inside the form's `space-y-3`. The numeric values are crisp.                                                                                                                                                                                                                                                                                |
| Large 1440+     | The form's content column with `max-w` — no stretching.                                                                                                                                                                                                                                                                                                |

**No clipping on mobile:** `ShareSlider` uses `flex items-center gap-3` for the row
with the range + numeric input — adapts. The visual bar — `overflow-hidden rounded-md` —
adapts to the parent's width.

### Surface B — type card + project Select + grouped receiver Select in `CreateTransactionDialog`

| Class          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile 320–639 | `CrmDialog` full-screen (`max-h-[90dvh]`, the body scrolls). Type cards (`grid grid-cols-1`) — a stack in 1 column, each ≥ 44px tall (`px-3 py-2` + text+description ⇒ the actual card height ~52-56px, comfortably ≥44px touch target). The project Select and Receiver Select — `SelectTrigger h-9` (36px) when closed — on mobile it is fine since `SelectTrigger` is the full width of the container (the wide touch target on X compensates for the height on Y); the open `SelectContent` — a Radix Portal, covers the viewport, `SelectItem` `py-1.5` (~32px) is readable and scrollable. `SelectGroup`/`SelectLabel` ("Админы"/"Счёт компании") do not break the layout — `px-2 py-1.5 text-sm font-semibold`, an ordinary block-level element. |
| Tablet 640+    | Dialog 90dvh, Select normal, type cards — the same 1-column grid (not expanded into 2 columns — conformant with the existing pattern :490).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Laptop 1024+   | Standard dialog (`sm:max-w-lg`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Large 1440+    | Unchanged — the dialog does not stretch beyond `sm:max-w-lg`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Long ADMIN names in SelectItem:** Radix `SelectItem` does not truncate text by default (no
`overflow: hidden` on `ItemText`) — long `displayName`s wrap, they are not truncated on any
device class.

### Surface C — "Тип оплаты" Select in the project form (create + edit)

| Class          | Behavior                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile 320–639 | The project form already renders inside a full-screen `Dialog`/`Sheet` on mobile (existing behavior of the create/edit dialogs). The Select is the full width of the container (`space-y-1.5` section) — touch target `h-9` in height, full width on X. The disabled state (`opacity-50` built into `SelectTrigger`, the component) — readable, does not look like an active control. |
| Tablet 640+    | The form may go in 1-2 columns (the existing layout) — the Select does not change.                                                                                                                                                                                                                                                                                                    |
| Laptop 1024+   | Standard.                                                                                                                                                                                                                                                                                                                                                                             |
| Large 1440+    | The form's `max-w` — the Select does not stretch beyond the field container.                                                                                                                                                                                                                                                                                                          |

---

## Edge cases

### Surface A

| Case                                                           | Behavior                                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-drop project (`dropId == null`)                            | The "Доля дропа" section is hidden completely for all roles                                                                                                                              |
| Drop project, but `dropSharePercent` did not arrive in the DTO | Show `effectiveDropSharePercent` = `5` (the default `DEFAULT_DROP_SHARE_PERCENT`); hint: «По умолчанию: 5%»                                                                              |
| Override = null (reset)                                        | The slider shows `effectiveDropSharePercent` (from the user default), not 0                                                                                                              |
| User is not ADMIN/ACCOUNTANT                                   | The slider is `disabled` (opacity-60), hint «Менять может только ADMIN или ACCOUNTANT.»                                                                                                  |
| HR / JUNIOR                                                    | The `dropSharePercentOverride` section is hidden (`viewerRole !== 'HR' && viewerRole !== 'JUNIOR'`)                                                                                      |
| Value > 100 or < 0                                             | Validator: «Введите целое число от 0 до 100» (senior pattern)                                                                                                                            |
| **USDT project without a senior's non-bank link — n/a**        | Surface A does not depend on `paymentType` at all — the slider is visible on a drop project regardless of the payment type (FOP/gig/USDT); the drop share resolves the same in all cases |

### Surface B (admin-USDT flow)

| Case                                                                                                                          | Behavior                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Empty ADMIN list (edge case — theoretically impossible, there is always at least 1 ADMIN, including the declarant themselves) | `adminUsers` includes the declaring ADMIN themselves — the list is never empty in practice; the UI does not rely on this rigidly, it simply does not render an empty `SelectGroup`, without crashing                                 |
| ADMIN name longer than ~30 characters                                                                                         | `SelectItem` allows wrapping — the text wraps, nothing is truncated                                                                                                                                                                  |
| Project without an ADMIN senior (an ordinary drop/senior-USDT project)                                                        | The obligations are created by the standard logic of ADR D4 (the senior share — if the senior is not an ADMIN; the drop share — if `dropId` is linked); the UI does not change depending on who the senior is                        |
| USDT project WITHOUT a senior at all (hypothetically) — n/a at the UI level                                                   | A backend invariant (`projects.seniorId NOT NULL` in the schema) — the frontend does not handle this case separately                                                                                                                 |
| No USDT project in the system at all                                                                                          | `usdtProjects` — an empty array; the project Select opens empty (without helper text inside `SelectContent` — a minimal edge case, the ADMIN knows there are no USDT projects anyway); Submit is blocked by the `project` validation |
| SENIOR/DROP — ALL their projects are of the USDT type                                                                         | The gate hint under the project selector (see the "Gate-hide" section above) — `senior-income-usdt-gate-hint` / `drop-income-usdt-gate-hint`                                                                                         |
| SENIOR/DROP — a mix of FOP/gig + USDT projects                                                                                | USDT projects are silently filtered out of the Select, with no hint — the declarant simply does not see them in the list                                                                                                             |
| Dialog closed/reset                                                                                                           | `receiverId` is reset to `''` (the already existing `resetForm`/type-switch mechanism, :498) — there is no preselection by design                                                                                                    |
| Error loading the users list (`allUsers` query error)                                                                         | `adminUsers` — an empty derived array (fallback `[]`, already in the code :195 `data: allUsers = []`); the Select opens empty, the standard query error pattern — does not block the dialog                                          |

### Surface C (payment type)

| Case                                                                   | Behavior                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR opens the create form                                               | The Select is visible, **disabled**, default «ФОП»; hint «Менять может только ADMIN или ACCOUNTANT.»                                                                 |
| SENIOR/DROP see the Select in the read view (InfoRow)                  | The value is visible (read), not editable — they do not have access to the edit dialog at all (`canOpenEdit` does not include them)                                  |
| JUNIOR                                                                 | The section is hidden entirely, both in the edit form (JUNIOR does not open edit at all) and in the read view InfoRow (an explicit gate `viewerRole !== 'JUNIOR'`)   |
| `project.paymentType` did not arrive in the DTO (legacy/pre-migration) | InfoRow shows `—` (the existing fallback pattern `text-muted-foreground/40 italic`); the Select in the form — falls back to `'FOP'` as the value                     |
| Changing the type from USDT to FOP/gig with pending obligations        | No special handling is needed as a UI-level edge case — a backend invariant (existing obligations are not cancelled by changing paymentType, this is a backend task) |

---

## A11y (WCAG 2.2 AA)

### Surface A — ShareSlider

| Requirement                       | Implementation                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `aria-label` on the range input   | ShareSlider passes `aria-label={labels.aria}` = «Доля дропа в процентах» (from `ROLE_LABELS['DROP']`)                                |
| `aria-label` on the numeric input | Likewise — already in the component                                                                                                  |
| Label / for                       | The `<Label>` above the block — visual; the range and number inputs are not `id`-linked (component pattern) — aria-label compensates |
| Contrast                          | `text-muted-foreground` on `bg-card` — 4.5:1 in dark mode (verified in tokens)                                                       |
| Focus                             | Range input: the native browser `focus` + `accent-primary`; number input: `focus-visible:ring-1 focus-visible:ring-ring`             |
| Target size                       | The range thumb is native — varies by browser (usually 20–28px natively); acceptable (SC 2.5.8 minimum 24px)                         |
| Disabled state                    | `aria-disabled` is not needed — the `disabled` attribute on the inputs is sufficient; `opacity-60` — the visual indicator            |

### Surface B — type card + both Selects (project / receiver)

| Requirement                            | Implementation                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type card (`button`)                   | A native `<button type="button">` — focusable via Tab, activated by Enter/Space without extra ARIA                                                          |
| Radix Select a11y (project + receiver) | `Select` (Radix) automatically: `role="combobox"`, `aria-expanded`, `aria-haspopup`, `role="option"` on items                                               |
| `SelectGroup`/`SelectLabel`            | Radix `Group`/`Label` — the screen reader announces the group before enumerating the options inside (`aria-labelledby` auto-link, built into the primitive) |
| Focus trap                             | Radix `SelectContent` traps focus inside itself — standard Radix UI behavior                                                                                |
| Escape close                           | Radix closes the Select on Escape — standard                                                                                                                |
| Contrast                               | `text-muted-foreground` hints — ≥4.5:1; `text-destructive` errors — ≥4.5:1; `text-blue-400` company-hint box — verified in the existing pattern             |
| Target size SelectTrigger              | `h-9` = 36px height; the width of the full-width container — more than 44px wide → ok. On mobile: the tap target is large (full-width)                      |
| SelectItem target size                 | Radix `py-1.5` ≈ 32px element height — acceptable (SC 2.5.8 minimum 24px); on mobile the Radix SelectContent — an overlay allows a comfortable tap          |
| Required field (receiver)              | `aria-required` is not added explicitly — validation error via `fieldErrors.receiver` + the screen reader reads the error paragraph                         |
| Error message                          | `<p data-testid="usdt-income-error-receiver">` — visual + screen reader (inline after the trigger)                                                          |

### Surface C — "Тип оплаты" Select

| Requirement                         | Implementation                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Label>` above the selector        | `<Label>Тип оплаты</Label>` — visual, a standard link by positioning (the pattern of the other form fields)                                          |
| Radix Select a11y                   | As in Surface B — built into the primitive                                                                                                           |
| Disabled state                      | The `disabled` prop on `Select` (Radix) → `aria-disabled` auto, `data-disabled` for styling (`opacity-50` built in)                                  |
| Contrast                            | The disabled text is still ≥3:1 (not completely invisible) — the component does not override the text color, only the opacity                        |
| Target size                         | `h-9` (36px) + full-width — the same pattern as everywhere in the project form                                                                       |
| Screen reader on hiding from JUNIOR | The section is not rendered at all for JUNIOR (`viewerRole !== 'JUNIOR'`) — correct, not "visually hidden" but removed entirely from the DOM/AT tree |

---

## Component list

| Component                                                               | Type                                   | Source                                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ShareSlider`                                                           | Existing                               | `apps/web/app/components/ui/share-slider.tsx`                                                     |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue` | Existing                               | `apps/web/app/components/ui/select.tsx` (shadcn/Radix)                                            |
| `SelectGroup`, `SelectLabel`, `SelectSeparator`                         | Existing, **first use in the app**     | `apps/web/app/components/ui/select.tsx` (already exported, not used anywhere before this feature) |
| `Label`                                                                 | Existing                               | `apps/web/app/components/ui/label.tsx`                                                            |
| `AmountCurrencyInput`                                                   | Existing (extended via `isUsdtLocked`) | `apps/web/app/components/ui/amount-currency-input.tsx`                                            |
| `ProjectDropShareInfo`                                                  | **NEW** component (if needed)          | Modeled on `ProjectShareInfo` — a read-only drop share row with a badge                           |
| `PAYMENT_TYPE_LABELS`                                                   | **NEW** constant (not a component)     | An enum→label mapping, shared by the Surface C Select options and the read-view InfoRow           |

### `ProjectDropShareInfo` — API sketch

```tsx
// Modeled on the existing ProjectShareInfo
function ProjectDropShareInfo({ project }: { project: ProjectDetailDto }) {
  const override = project.dropSharePercentOverride
  const effective = project.dropSharePercent ?? 5 // effective from the DTO
  return (
    <span className="text-sm font-medium tabular-nums">
      {effective}%
      {override !== null && override !== undefined && (
        <Badge variant="outline" className="ml-1.5 text-[10px]">
          Override
        </Badge>
      )}
    </span>
  )
}
```

If it is architecturally simpler to embed inline — acceptable, a separate component is not mandatory.

---

## data-testid — summary table (all surfaces)

| Element                                          | `data-testid`                                   | Surface |
| ------------------------------------------------ | ----------------------------------------------- | ------- |
| Drop share slider (numeric input)                | `project-edit-drop-share-override`              | A       |
| Slider section (wrapper)                         | `project-edit-drop-share-section`               | A       |
| "USDT-приход" type card (auto from the pattern)  | `create-transaction-type-usdt_income`           | B       |
| Project Select (reused by all 4 income types)    | `create-transaction-project-trigger` (existing) | B       |
| Receiver Select trigger                          | `usdt-income-receiver-trigger`                  | B (new) |
| Receiver — validation error                      | `usdt-income-error-receiver`                    | B (new) |
| SENIOR gate hint (all projects USDT)             | `senior-income-usdt-gate-hint`                  | B (new) |
| DROP gate hint (all projects USDT)               | `drop-income-usdt-gate-hint`                    | B (new) |
| "Тип оплаты" Select (project create + edit form) | `project-payment-type-trigger`                  | C (new) |

---

## Motion

No additional motion. The slider transitions (bar width) — `transition-all duration-150` already
in ShareSlider (lines 72 and 80). Select animations, type cards (`transition-all`) — from
shadcn/Radix/the existing dialog pattern (standard `fade-in`). Do not add new animations —
this applies to all three surfaces, including the new grouped Select and the "Тип оплаты" Select.

---

## Instructions for the coder (CRITICAL)

1. **Build with our components** per this spec — `ShareSlider`, `Select`/`SelectGroup`/`SelectLabel`/
   `SelectSeparator` from shadcn/ui. Do **NOT** copy generic HTML, do **NOT** introduce new CSS variables /
   hardcoded hex.
2. **Surface A** — a full analog of `seniorSharePercentOverride` (lines 339–397 in `$projectId.tsx`).
   Differences: the field name, label, `role="DROP"`, the condition `project.dropId != null`. **Unchanged from
   the first version of the spec.**
3. **Surface B — do NOT add a receiver selector to `DROP_INCOME`/`SENIOR_INCOME`.** This is an outdated
   requirement from the first version of the spec. The receiver — only in the new branch `type === 'USDT_INCOME'`
   (a synthetic UI type, ADMIN-only, the ledger type on the backend stays `ADMIN_INCOME`). The model — the `DIVIDEND`
   branch (:801-883) as a structural reference + the grouped `SelectGroup`/`SelectLabel`.
4. **Gate-hide for SENIOR/DROP** — filter `myProjects`/`dropProjects` by `paymentType !==
'USDT'`; the hint only when the list became empty AFTER the filter (not when it was empty initially).
5. **Surface C** — replaces the existing free-text `Input` for `paymentType` (does NOT add a new
   field) in TWO places: `projects/index.tsx` (create) and `$projectId.tsx` (edit) — identical
   generic loops, find both. RBAC: disabled for non-ADMIN/ACCOUNTANT (reuse `canEditOverride` in
   the edit form); hide the read-view InfoRow from JUNIOR (`viewerRole !== 'JUNIOR'`).
6. **Do NOT insert `receiverId` into the `createDropIncomeSchema`/`createDropIncome` payload** (ADR C14 — this
   was a bug of the M1 draft, reverted on the backend side; the frontend simply does not add this field to the
   DROP_INCOME submit).
7. **`ProjectDropShareInfo`** — an optional component modeled on `ProjectShareInfo`. If
   `ProjectShareInfo` is already abstracted enough, use it with a `role="DROP"` parameter.
8. **data-testid** strictly per the summary table above — AutoTest uses them (especially
   `usdt-income-error-receiver` and `project-payment-type-trigger` — the exact names from the task).
9. **Responsive** — no fixed widths, no overflow, on any of the 3 surfaces. Check at 320px
   (ShareSlider bar, type cards in 1 column, both Selects full-width).
10. **Implicit-null-reset for Surface A** — logic on the frontend/backend per the brief (the backend task
    sets the contract).
11. **Dependency on the backend contract:** `ProjectOption.paymentType`, `financeApi.declareUsdtProjectIncome`,
    the DTO type for USDT income — come from the backend task (`task-drop-share-backend`, model opus).
    The frontend task does NOT start before this contract is ready (see `pm-brief` — a sequential
    single-pipeline, the frontend waits for the backend).

---

## Fidelity references (for Mode B after implementation)

`design-gate: degraded` — Claude Design is not used, `design.png` is not created for this feature
(Tier 2 conformance to existing patterns). The Mode B fidelity audit after implementation is checked
against **this spec + the existing reference components** (`ShareSlider`, the `DIVIDEND` branch,
`seniorSharePercentOverride`), not against a mockup — per the rule `design-fidelity-review.md` §Degradation
("fidelity-diff against the spec docs/design/<slug>.md + foundation.md"). The responsive check of all 4
classes on localhost remains mandatory.
