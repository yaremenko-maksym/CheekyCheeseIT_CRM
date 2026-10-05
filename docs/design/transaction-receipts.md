# Design Spec — Mandatory receipt for all transactions + attach/replace + explorer-only USDT

> **Design tier:** 2 (edit of 9 existing dense dialogs + a new compact attach UI from the row/details)
> **design-gate:** degraded (Claude Design not used — a headless session without a browser; a text
> spec, Mode E). The fidelity audit after implementation is checked against THIS spec + the existing
> reference components (`ReceiptInput`, `ReceiptPanel`, `FundingSourceFields`, `AdminEditTransactionDialog`),
> not against `design.png`.
> **Status:** coder-ready
> **Feature branch:** `feature/transaction-receipts`
> **Brief reference:** `.claude/briefs/pm-brief-transaction-receipts.md` (§4 inventory, §5 allowlist, §6 attach contract)
> **Task file reference:** `.claude/tasks/task-receipts-design.md`

---

## Summary of UX decisions (executive summary)

1. **Compact presentation — NOT a collapse, NOT a new visual block.** `ReceiptInput` already occupies
   a compact position (tab-toggle 32px + drop-zone/URL input) in an existing place — right after
   Amount+Currency+Date, before Notes. The only change: **extend** the list of types for which
   this (already existing) block is rendered and becomes **mandatory** — no new layout,
   no accordion/collapse (an accordion for a MANDATORY field is an anti-pattern: it hides what should be
   noticeable). For `PaySalaryDialog`/`SettleSeniorPayoutDialog` — the same component **replaces**
   the existing optional «TX Hash» text field (see §2.2 — the rationale for consolidation).
2. **Explorer-only — a new `ReceiptInput.explorerOnly` prop.** When `true`: the tab-toggle («Файл»/«Ссылка»)
   is **hidden entirely** (not disabled — a single remaining tab in a 2-tab toggle looks broken),
   only the URL input with an explorer-specific hint is rendered. Auto-normalization: if the parent switches
   `explorerOnly` to `true` while `state.mode === 'file'` — the component itself resets to an empty `url` mode
   (does not leave an invalid file receipt on a USDT transaction).
3. **Attach/replace — a new `AttachReceiptSheet` component.** One reusable `Sheet` (side=right,
   `w-full sm:max-w-md`), two entry points: (a) a compact icon button in `TransactionRow` (visible from
   768px — `md:`), (b) an explicit button next to `ReceiptPanel` in `TransactionDetailDialog` (visible on ALL
   classes, **the main entry on mobile**, `h-11`=44px). The RBAC/status gate is a single shared function
   `canAttachReceipt()`, not duplicated between row/detail/sheet. Replacing an existing receipt → an `AlertDialog`
   confirm (an existing primitive, the `ValidateDialog.tsx` pattern).
4. **The empty state of old transactions** — already solved by the existing `ReceiptPanel` (a dashed placeholder,
   «Нет прикреплённого чека», #356-compatible component). New: in `TransactionRow` — a muted
   `Receipt` icon as an indicator of the presence/absence of a receipt (only when the viewer has the right
   to act — otherwise we do not render extra visual noise in an already dense table).
5. **Conformance side fixes** (low risk, the same area of code that is touched anyway):
   `showReceiptPanel` in `TransactionDetailDialog` is extended to `SALARY`/`ADMIN_TRANSFER`/`DIVIDEND_TO_ADMIN`
   and along the way closes the pre-existing gap `DROP_INCOME` (it could already have a receipt, but never
   got the split-view preview — a latent bug, not in the feature's scope in spirit, but the same `if`, the same PR).

---

## 1. Context (business)

A «receipt» (`receiptDocumentId` XOR `receiptExternalUrl`, a DB CHECK constraint, the `ReceiptInput` component)
becomes mandatory in all user create/pay flows. USDT-currency transactions require
specifically a link to a blockchain explorer (a domain allowlist), not a file. A generic attach/replace
endpoint appears for transactions that do not have a receipt yet or need it replaced. History is not migrated — old
transactions stay without a receipt, the UI does not break on an empty value. The full business context, the RBAC matrix,
assumptions (A1–A6) — `.claude/briefs/pm-brief-transaction-receipts.md`.

---

## 2. Component inventory

### 2.1 Existing (reused as is or extended)

| Component                                                                      | File                                                            | Role in this feature                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReceiptInput`                                                                 | `.../finance/components/ReceiptInput.tsx`                       | **Extended** — a new `explorerOnly` prop (+ opt. `error`), see §4.1                                                                         |
| `emptyReceiptState`, `receiptStateFromDocument`, `receiptStateFromExternalUrl` | `ReceiptInput.tsx`                                              | Unchanged — reused in `AttachReceiptSheet`                                                                                                  |
| `ReceiptPanel`, `useReceiptUrl`                                                | `.../finance/components/dialogs/receipt-panel.tsx`              | Unchanged — already solves the empty-state (§7)                                                                                             |
| `CreateTransactionDialog`                                                      | `.../finance/components/dialogs/CreateTransactionDialog.tsx`    | Extended: `showReceipt` + `validate()` + submit payload (§3.1)                                                                              |
| `PaySalaryDialog`                                                              | `.../finance/components/dialogs/PaySalaryDialog.tsx`            | «TX Hash» text input → `ReceiptInput` (§3.2)                                                                                                |
| `SettleSeniorPayoutDialog`                                                     | `.../finance/components/dialogs/SettleSeniorPayoutDialog.tsx`   | `ReceiptInput` is added (§3.3)                                                                                                              |
| `FundingSourceFields`                                                          | `.../finance/components/dialogs/FundingSourceFields.tsx`        | The source of the `currency` state for the explorer-only discriminant — unchanged                                                           |
| `TransactionRow`                                                               | `.../finance/components/TransactionRow.tsx`                     | A new «Чек» icon button/indicator in the actions cluster (§5.2)                                                                             |
| `TransactionDetailDialog`, `receipt-panel.tsx`                                 | `.../finance/components/dialogs/TransactionDetailDialog.tsx`    | `showReceiptPanel` is extended + the attach/replace button (§5.5)                                                                           |
| `AdminEditTransactionDialog`                                                   | `.../finance/components/dialogs/AdminEditTransactionDialog.tsx` | A reference pattern (1:1 replace-with-delete) — NOT replaced by the new endpoint; stays a separate ADMIN-only «edit everything» flow (§5.6) |
| `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`/`SheetFooter`                | `apps/web/app/components/ui/sheet.tsx`                          | The container of `AttachReceiptSheet`                                                                                                       |
| `AlertDialog`/`AlertDialogAction`/`AlertDialogCancel`/…                        | `apps/web/app/components/ui/alert-dialog.tsx`                   | Confirm on replacing a receipt (the `ValidateDialog.tsx:268-282` pattern)                                                                   |
| `Button`, `Badge`, `Label`, `Input`                                            | `apps/web/app/components/ui/*`                                  | Standard primitives                                                                                                                         |

### 2.2 New

| Component                           | Type                | Purpose                                                                                                                    |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AttachReceiptSheet`                | New component       | A single attach/replace point for ANY transaction; calls `PATCH /transactions/:id/receipt`                                 |
| `canAttachReceipt()`                | New shared function | RBAC+status gate — single logic for the row icon, the detail button, and the Sheet itself (§5.1)                           |
| `financeApi.attachReceipt(id, dto)` | New API method      | `api.patch<TransactionDto>(\`/transactions/${id}/receipt\`, data)`— a 1:1 pattern with`paySalary`/`adminUpdateTransaction` |

**Coordination with the backend task (§5 of the brief) — the contract has ALREADY landed** (`wip(shared): mandatory receipt
refine + explorer allowlist + attach schema`, `packages/shared/src/schemas/finance.ts`), the names below are
final, use them literally (do NOT invent alternatives):

- `attachReceiptSchema` / `AttachReceiptDto` — the body of `PATCH /transactions/:id/receipt` (XOR, mandatory).
- `BLOCKCHAIN_EXPLORER_HOSTS: ReadonlySet<string>` — the 8 allowlist domains (the same as §4.2).
- `isExplorerUrl(url: string): boolean` — https + allowlist host + non-empty path.
- `receiptMandatoryError(receipt, effectiveCurrency): string | null` — a **ready** shared pure function,
  returns a Russian error message (or `null`) by UNIFIED rules (XOR, mandatory,
  USDT→explorer-only). The frontend `validate()` calls it DIRECTLY — see §3.1 (do not reinvent
  the check from separate `isAllowedExplorerUrl`/`hasReceipt` checks, as in the first draft of this
  spec — `receiptMandatoryError` already covers everything in one call, DRY with the backend).
- `mandatoryReceiptRefine(getCurrency)` — a backend-only superRefine factory (already applied to all 7
  create/pay schemas per the §4.3 table — the discriminant expressions there are confirmed 1:1 against the real code).

### 2.3 Reconciliation with the existing `txHash` (an important design decision)

`TransactionDto.txHash` (a raw string, `TxHashLink` in `TransactionDetailDialog.tsx:125-137`) is a legacy field
from the times BEFORE this feature, it hard-codes `https://etherscan.io/tx/${hash}` (Ethereum only, not
multi-chain). It is rendered ONLY for `SALARY`/`PAYOUT`/`PAYOUT_ADMIN` — types that today have NO
`receiptDocumentId`/`receiptExternalUrl`.

**Decision:** for `SALARY` (the only one of the three that this feature touches) — **remove** the «TX Hash
(необязательно)» UI input from `PaySalaryDialog` and replace it with a mandatory `ReceiptInput` (explorer-only on
USDT). `ReceiptPanel` already correctly resolves ANY explorer domain (does not hard-code etherscan.io) — it
becomes the canonical surface for verification. The old `TxHashLink` row in `SalaryContent` is **not removed**,
but is restricted to a legacy fallback (only when there is a `tx.txHash` but NO new receipt — old PAID rows
from before the feature):

```tsx
{
  tx.txHash && !tx.receiptDocumentId && !tx.receiptExternalUrl && (
    <Row icon={<Hash className="h-4 w-4" />} label="TX Hash">
      <TxHashLink hash={tx.txHash} />
    </Row>
  )
}
```

`PAYOUT`/`PAYOUT_ADMIN` — out of scope (A5 of the brief: `payout-requests` already requires an on-chain `txHash`,
a separate receipt is not added) — do NOT touch their `TxHashLink` rows.

Backend coordination (not my zone, but it must be explicitly handed to the backend task): `paySalarySchema.txHash`
can be left in the contract as an optional legacy field (the frontend simply no longer collects it via
the UI) — the backend Coder's decision, does not block the frontend implementation.

---

## 3. Section A — compact placement of `ReceiptInput` in the 9 create/pay dialogs

### 3.1 `CreateTransactionDialog` — extending the existing block (7 of the 9 flows)

The only structural edit — extend `showReceipt` (:544-548) from 4 to 7 types. The JSX block
of ReceiptInput (:1086-1106) **already** sits outside the `type !== 'DIVIDEND'` guard (that guard applies only to
the Amount+Currency and Date blocks above) — i.e. adding `'DIVIDEND'` to the list automatically picks up
the right position (after «Сумма (USDT)», before Notes) WITHOUT moving the JSX:

```tsx
const showReceipt =
  type === 'ADMIN_INCOME' ||
  type === 'SENIOR_INCOME' ||
  type === 'DROP_INCOME' ||
  type === 'EXPENSE' ||
  // НОВОЕ — mandatory-чек добавляется этим тикетом (было: без чека вовсе)
  type === 'USDT_INCOME' ||
  type === 'ADMIN_TRANSFER' ||
  type === 'DIVIDEND'
```

**Effective currency** — a single point for the explorer-only discriminant (§4), covers ALL 7 types
with one expression (including the existing SENIOR_INCOME/DROP_INCOME — their currency is a free choice
regardless of the project's `paymentType`, see the brief's R4 «universal discriminant»):

```tsx
const effectiveCurrency: Currency = type === 'DIVIDEND' ? 'USDT' : isUsdtLocked ? 'USDT' : currency
const isExplorerOnly = effectiveCurrency === 'USDT'
```

**`validate()` (:335-372)** — mandatoriness is extended from `SENIOR_INCOME || DROP_INCOME` to ALL
`showReceipt` types. It calls the **ready** shared function `receiptMandatoryError` (§2.2) — it does NOT
reinvent the XOR/mandatory/explorer check by hand:

```tsx
if (showReceipt) {
  const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
  const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
  const receiptError = receiptMandatoryError(
    { receiptDocumentId, receiptExternalUrl },
    effectiveCurrency,
  )
  if (receiptError) errors.receipt = receiptError
}
```

`receiptMandatoryError` — imported from `@crm/shared` (`packages/shared/src/schemas/finance.ts`), THE SAME
function that the backend runs in `mandatoryReceiptRefine`/the service — the error message matches 1:1
client/server (no duplication of copy/regex on the front end).

**Render** (:1087-1106) — only a prop extension, the JSX structure is unchanged:

```tsx
{showReceipt && (
  <div className="space-y-1.5">
    <ReceiptInput
      state={receipt}
      onChange={(s) => { setReceipt(s); clearFieldError('receipt') }}
      label="Чек / подтверждение *"   {/* НОВОЕ: звёздочка ВСЕГДА теперь — поле mandatory для всех 7 типов, не только SENIOR_INCOME */}
      explorerOnly={isExplorerOnly}
      error={fieldErrors.receipt}
    />
    {fieldErrors.receipt && (
      <p className="text-[11px] text-destructive" data-testid="create-transaction-error-receipt">
        {fieldErrors.receipt}
      </p>
    )}
  </div>
)}
```

**Submit payload** — `receiptDocumentId`/`receiptExternalUrl` are already collected once at the start of
`mutationFn` (:379-381) and reused in all branches. Add them to the 3 branches where they are absent today:
`USDT_INCOME` (:426-437 — remove the comment «No receipt fields», add both fields), `ADMIN_TRANSFER`
(:465-474), `DIVIDEND` (:475-486 — today ignores the receipt entirely, add it).

### 3.2 `PaySalaryDialog` — replacing «TX Hash» with `ReceiptInput`

The current structure (:97-162): summary-card → `FundingSourceFields` → **«TX Hash (необязательно)»
Input** → Notes → error. The new structure — replace the TX Hash block (:134-143) with:

```tsx
<div className="space-y-1.5">
  <ReceiptInput
    state={receipt}
    onChange={(s) => {
      setReceipt(s)
      setFieldError(null)
    }}
    label="Чек / подтверждение *"
    explorerOnly={currency === 'USDT'}
    error={fieldError}
  />
  {fieldError && (
    <p className="text-[11px] text-destructive" data-testid="pay-salary-error-receipt">
      {fieldError}
    </p>
  )}
</div>
```

`currency` is the already existing state (:31), synchronized with `FundingSourceFields` (COMPANY_ACCOUNT
forces USDT; ADMIN_PERSONAL — a free choice, the default stays USDT until manually changed). No new
state for the currency is required — the discriminant `currency === 'USDT'` covers both cases (forced AND manual
choice).

`handleSubmit` — add a client-side gate (mirrors CreateTransactionDialog): block
`mutation.mutate()` if `!hasReceipt`, show `fieldError`. Mutation payload — add
`receiptDocumentId`/`receiptExternalUrl` to the body of `financeApi.paySalary(...)` (:51-57); remove the `txHash` field
from the payload (or leave it `null` — the backend decides).

### 3.3 `SettleSeniorPayoutDialog` — adding `ReceiptInput`

The most compact of the three — today there is neither Notes nor any receipt/hash field (:141-180: summary-card
→ `FundingSourceFields` → error). Add a block identical to the one in §3.2, between `FundingSourceFields` and
`error`:

```tsx
<FundingSourceFields ... />

<div className="space-y-1.5">
  <ReceiptInput
    state={receipt}
    onChange={(s) => { setReceipt(s); setFieldError(null) }}
    label="Чек / подтверждение *"
    explorerOnly={currency === 'USDT'}
    error={fieldError}
  />
  {fieldError && (
    <p className="text-[11px] text-destructive" data-testid="settle-senior-error-receipt">
      {fieldError}
    </p>
  )}
</div>

{error && <p ...>}
```

Likewise — a new local `[receipt, setReceipt]` state (init `emptyReceiptState()`, reset in
`resetState()`), a gate in `handleSubmit`/`mutation.mutate()`, the payload is extended with
`receiptDocumentId`/`receiptExternalUrl` in the call to `financeApi.settleSeniorPayoutFromTransaction(...)`.

### 3.4 Why this is already «compact» — without a collapse

`CrmDialogBody` is already `flex-1 overflow-y-auto` (scroll body), `CrmDialogContent` — `max-h-[90dvh]`
(`crm-dialog.tsx:42,74`) — the dialogs technically do NOT overflow from adding one `space-y-1.5` block
(tab-toggle 32px + drop-zone ~76px OR url input 36px). The only «density» risk is the subjective
scroll length, not overflow/breakage. A collapse/accordion for a MANDATORY field complicates completion
(the user must first find and expand the section before they can pass the mandatory validation) —
an antipattern for required fields (see the `accessibility` skill: do not hide required controls behind
extra interaction). Decision: do NOT introduce a collapse — compactness is already achieved by
`ReceiptInput` being a dense component by construction (no extra padding/decoration), and it is placed in the
ONLY sensible place (after amount/currency, where the currency is already known for the explorer gate).

---

## 4. Section B — Explorer-only mode for USDT

### 4.1 `ReceiptInput` — extending the public API

```tsx
interface ReceiptInputProps {
  state: ReceiptState
  onChange: (next: ReceiptState) => void
  label?: string
  ownerId?: string
  /**
   * НОВОЕ. Когда true — компонент показывает ТОЛЬКО url-режим (без
   * tab-toggle, без «Файл»). Явный explorer-hint под инпутом. Если
   * `state.mode === 'file'` в момент включения — авто-сброс в пустой
   * url-режим (см. эффект ниже).
   */
  explorerOnly?: boolean
  /**
   * НОВОЕ. Внешняя ошибка валидации (напр. non-allowlist домен) — красный
   * ring на url-инпуте. Текст ошибки родитель рендерит сам (существующий
   * паттерн `fieldErrors.receipt`) — компонент не дублирует сообщение.
   */
  error?: string
}
```

**Auto-normalization** (an effect, analogous to the existing narrowly scoped effect :119-123 — the same
pattern of triggering on a specific value, not on the whole `state`):

```tsx
useEffect(() => {
  if (explorerOnly && state.mode === 'file') {
    if (state.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(state.previewUrl)
    onChange({
      mode: 'url',
      documentId: null,
      externalUrl: '',
      fileName: '',
      previewUrl: null,
      mimeType: '',
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- триггер по explorerOnly, не по всему state (паттерн :119-123)
}, [explorerOnly])
```

**Render** — when `explorerOnly`, the tab-toggle block (:199-226) is not rendered at all, `state.mode`
is treated as always `'url'`:

```tsx
{!explorerOnly && (/* существующий tab-toggle :199-226, без изменений */)}

{(explorerOnly || state.mode === 'url') && (
  <div>
    <Input
      value={state.externalUrl}
      onChange={(e) => onChange({ ...state, mode: 'url', externalUrl: e.target.value })}
      placeholder={explorerOnly ? 'https://etherscan.io/tx/0x...' : 'https://...'}
      className={cn('h-9 text-sm', error && 'border-destructive ring-1 ring-destructive/40')}
      data-testid="receipt-input-url-field"
    />
    {explorerOnly && (
      <p className="text-[11px] text-muted-foreground mt-1" data-testid="receipt-input-explorer-hint">
        Ссылка на blockchain-explorer (etherscan.io, tronscan.org, bscscan.com и др.)
      </p>
    )}
  </div>
)}

{!explorerOnly && state.mode === 'file' && (/* существующий file-режим :229-321, без изменений */)}
```

### 4.2 Allowlist — a single source (landed, `packages/shared`)

Domains (the brief's §5, verified against `etherscan.service.ts`, USDT ERC-20 + a reasonable multi-chain
extension): `etherscan.io` (canonical) · `tronscan.org` · `bscscan.com` · `polygonscan.com` ·
`arbiscan.io` · `basescan.org` · `optimistic.etherscan.io` · `snowtrace.io`. Exported from
`packages/shared/src/schemas/finance.ts`: `BLOCKCHAIN_EXPLORER_HOSTS: ReadonlySet<string>` (the domains
themselves — for the hint text, if there is a need to enumerate them dynamically) + `isExplorerUrl(url): boolean`
(https + allowlist host + non-empty path). The frontend imports BOTH from `@crm/shared` — do NOT hard-code the
list/regex separately (drift risk). For the final field error `receiptMandatoryError` is preferable
(§2.2) — it already calls `isExplorerUrl` internally and returns a ready Russian message.

### 4.3 Discriminant per dialog (summary table)

| Dialog                        | Currency source                                                                             | `isExplorerOnly` expression                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ADMIN_INCOME`                | `currency` state (locked USDT when `fundingSource===COMPANY_ACCOUNT`)                       | `effectiveCurrency === 'USDT'` (§3.1)                                           |
| `SENIOR_INCOME`/`DROP_INCOME` | `currency` state (free choice)                                                              | `effectiveCurrency === 'USDT'` (the same formula — universal R4)                |
| `EXPENSE`                     | `currency` state (locked USDT when `fundingSource===COMPANY_ACCOUNT`)                       | `effectiveCurrency === 'USDT'`                                                  |
| `USDT_INCOME`                 | ALWAYS `'USDT'` (`z.literal('USDT')` on the schema)                                         | ALWAYS `true`                                                                   |
| `ADMIN_TRANSFER`              | `currency` state (free choice, visually defaults to USD — not locked)                       | `effectiveCurrency === 'USDT'` — becomes `true` if the user manually chose USDT |
| `DIVIDEND`                    | No currency selector — implicit USDT (a dividend = a withdrawal from the company account)   | ALWAYS `true`                                                                   |
| `PaySalaryDialog`             | `currency` state (locked USDT with account=Company; free with ADMIN_PERSONAL, default USDT) | `currency === 'USDT'`                                                           |
| `SettleSeniorPayoutDialog`    | Identical to `PaySalaryDialog`                                                              | `currency === 'USDT'`                                                           |

### 4.4 Copywriting (the only new Russian strings)

| Context                                | Text                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hint under the explorer-only URL field | «Ссылка на blockchain-explorer (etherscan.io, tronscan.org, bscscan.com и др.)»                 |
| Error — non-allowlist domain           | «Ссылка должна вести на поддерживаемый blockchain-explorer (etherscan.io, tronscan.org и т.п.)» |
| Error — receipt not attached (generic) | «Прикрепите чек или укажите ссылку на подтверждение» (existing, unchanged)                      |
| Field label (all 9 dialogs, unified)   | «Чек / подтверждение \*» (the asterisk is a visual mandatory marker, a project convention)      |

---

## 5. Section C — Attach/Replace UI from the transaction row/details

### 5.1 `canAttachReceipt()` — a single RBAC+status function (DRY)

A new small file `apps/web/app/routes/_authenticated/finance/components/receipt-permissions.ts` —
imported into `TransactionRow`, `TransactionDetailDialog`, `AttachReceiptSheet`. A single logic
rules out drift between «visible in the row» and «visible in the details» (otherwise — the classic RBAC desync bug
between two surfaces of one function):

```tsx
export function canAttachReceipt(
  tx: Pick<TransactionDto, 'createdBy' | 'receiptDocumentId' | 'receiptExternalUrl' | 'status'>,
  currentUserId: string | null | undefined,
  role: string,
): boolean {
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
  const isAuthor = !!currentUserId && tx.createdBy === currentUserId
  // Первичный attach (нет чека) — автор МОЖЕТ независимо от статуса (брифовый §6:
  // «Первичный attach — RBAC как выше», статус НЕ упомянут как ограничитель).
  // Replace (чек уже есть) при PAID — ТОЛЬКО ADMIN/ACCOUNTANT.
  return isPrivileged || (isAuthor && (!hasReceipt || tx.status !== 'PAID'))
}
```

This is a **UI gate** (visibility/interactivity) — the backend MUST implement the same logic server-side
(defense-in-depth, the brief's §6) independently of the front end; the front end is not the source of authorization.

### 5.2 Entry point 1 — an icon button/indicator in `TransactionRow`

A new prop `onAttachReceipt?: (tx: TransactionDto) => void`. Rendered in the existing actions cluster
(:477-584), after the `canAdminDelete` block, **visible from 768px** (`md:`) — on mobile the row actions cell already
scrolls horizontally (`overflow-x-auto` at the table level), adding yet another
sub-44px touch target there is a bad trade-off; the main mobile entry is §5.5 (a full-size button in
`TransactionDetailDialog`, opened by tapping the row):

```tsx
const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
const showAttach = canAttachReceipt(tx, currentUserId, role)

<div className="hidden md:inline-flex">
  {showAttach ? (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'h-7 w-7 p-0',
        hasReceipt
          ? 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
      )}
      onClick={() => onAttachReceipt?.(tx)}
      title={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
      aria-label={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
      data-testid={`tx-row-attach-receipt-${tx.id}`}
    >
      <Receipt className="h-3.5 w-3.5" />
    </Button>
  ) : hasReceipt ? (
    <span
      className="inline-flex h-7 w-7 items-center justify-center text-emerald-400/60"
      title="Чек прикреплён"
      aria-label="Чек прикреплён"
      data-testid={`tx-row-receipt-indicator-${tx.id}`}
    >
      <Receipt className="h-3.5 w-3.5" />
    </span>
  ) : null}
</div>
```

**Icon states** (summary):

| Has receipt | `canAttachReceipt`            | Render                                                                                                                                      |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| no          | yes                           | Muted `Receipt`, clickable → opens the Sheet in attach mode                                                                                 |
| yes         | yes                           | Emerald `Receipt`, clickable → opens the Sheet in replace mode                                                                              |
| yes         | no (e.g. author+PAID+replace) | Emerald `Receipt`, **not clickable** (`<span>`, not `<button>`) — honest semantics: we show the fact, we do not offer an unavailable action |
| no          | no                            | We render nothing — we do not add noise for those who have no right to act                                                                  |

The icon is `Receipt` (lucide-react), the same glyph that `receipt-panel.tsx:13` already uses (visual
consistency «this symbol = receipt» across the whole module).

### 5.3 `AttachReceiptSheet` — a new component

```tsx
interface AttachReceiptSheetProps {
  tx: TransactionDto | null // null = закрыт
  onClose: () => void
}

function AttachReceiptSheet({ tx, onClose }: AttachReceiptSheetProps) {
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const qc = useQueryClient()

  useEffect(() => {
    if (!tx) return
    setReceipt(
      tx.receiptDocumentId
        ? receiptStateFromDocument(tx.receiptDocumentId)
        : receiptStateFromExternalUrl(tx.receiptExternalUrl),
    )
    setError(null)
  }, [tx?.id])

  const hasExisting = !!(tx?.receiptDocumentId || tx?.receiptExternalUrl)
  const isExplorerOnly = tx?.currency === 'USDT'

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      return financeApi.attachReceipt(tx!.id, { receiptDocumentId, receiptExternalUrl })
    },
    onSuccess: () => {
      toast.success(hasExisting ? 'Чек заменён' : 'Чек прикреплён')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      setConfirmOpen(false)
      onClose()
    },
    onError: (err) => setError(getApiErrorMessage(err)),
  })

  function handleSubmit() {
    const hasNew =
      (receipt.mode === 'file' && receipt.documentId) ||
      (receipt.mode === 'url' && receipt.externalUrl)
    if (!hasNew) {
      setError('Прикрепите чек или укажите ссылку на подтверждение')
      return
    }
    if (hasExisting) {
      setConfirmOpen(true)
      return
    } // replace → confirm first
    mutation.mutate()
  }

  return (
    <>
      <Sheet open={!!tx} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md flex flex-col overflow-hidden"
          data-testid="attach-receipt-sheet"
        >
          <SheetHeader className="mb-2 shrink-0">
            <SheetTitle>{hasExisting ? 'Заменить чек' : 'Прикрепить чек'}</SheetTitle>
            <SheetDescription className="sr-only">
              Прикрепление подтверждающего документа к транзакции
            </SheetDescription>
          </SheetHeader>

          {tx && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between text-sm">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    TYPE_COLORS[tx.type],
                  )}
                >
                  {TYPE_LABELS[tx.type]}
                </span>
                <span className="font-medium tabular-nums">
                  {fmtAmount(tx.amount, tx.currency)}
                </span>
              </div>

              <ReceiptInput
                state={receipt}
                onChange={(s) => {
                  setReceipt(s)
                  setError(null)
                }}
                explorerOnly={isExplorerOnly}
                error={error ?? undefined}
              />
              {error && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="attach-receipt-sheet-error"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          <SheetFooter className="mt-4 shrink-0">
            <Button variant="outline" onClick={onClose} data-testid="attach-receipt-sheet-cancel">
              Отмена
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={mutation.isPending}
              data-testid="attach-receipt-sheet-submit"
            >
              {hasExisting ? 'Заменить' : 'Прикрепить'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="attach-receipt-confirm-replace">
          <AlertDialogHeader>
            <AlertDialogTitle>Заменить существующий чек?</AlertDialogTitle>
            <AlertDialogDescription>
              Старый файл/ссылка будут удалены без возможности восстановления.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="attach-receipt-confirm-cancel">
              Отмена
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate()}
              data-testid="attach-receipt-confirm-submit"
            >
              Заменить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
```

The component is **generic**, not tied to a specific transaction type; it works for ANY of the 9+ branches
(including the already existing SENIOR_INCOME/DROP_INCOME rows without a receipt, PAYOUT/PAYOUT_ADMIN — if
it is ever needed, although now they are out of scope A5/out-of-scope).

### 5.4 `financeApi.attachReceipt` — contract

```tsx
attachReceipt: (id: string, data: AttachReceiptDto) =>
  api.patch<TransactionDto>(`/transactions/${id}/receipt`, data).then((r) => r.data),
```

`AttachReceiptDto` — imported from `@crm/shared` after the backend contract (§2.2, §6 of the brief): an XOR body
`{ receiptDocumentId? } | { receiptExternalUrl? }`.

### 5.5 Entry point 2 — a button in `TransactionDetailDialog` (the main entry on mobile)

Place it right under `<ReceiptPanel tx={t} />` in the right column of the split-view (:467-469):

```tsx
<div className="min-w-0 space-y-2">
  <ReceiptPanel tx={t} />
  {canAttachReceipt(t, user?.id, user?.role ?? '') && (
    <Button
      variant="outline"
      size="sm"
      className="w-full sm:w-auto h-11 sm:h-9"
      onClick={() => setAttachOpen(true)}
      data-testid="detail-attach-receipt"
    >
      <Receipt className="h-3.5 w-3.5 mr-1.5" />
      {hasExisting ? 'Заменить чек' : 'Прикрепить чек'}
    </Button>
  )}
</div>
```

`TransactionDetailDialog` gets `const { user } = useAuth()` (a pattern already used in
`CreateTransactionDialog`) + a local `[attachOpen, setAttachOpen]` state, renders
`<AttachReceiptSheet tx={attachOpen ? t : null} onClose={() => setAttachOpen(false)} />` as a sibling of the
`<Dialog>` at the end of the component (Sheet and Dialog are independent Radix portals, no conflicts).

`w-full h-11` on mobile = a 44px full-width button (a hard gate of responsive-design.md); `sm:w-auto
sm:h-9` on tablet+ — a compact secondary button (the row icon is already visible there as a quick path, this
button is an explicit/clear duplicate inside the already opened details, not redundancy but two access levels:
quick vs. contextual).

### 5.6 `showReceiptPanel` — extending the gate + the `DROP_INCOME` fix

```tsx
const RECEIPT_ELIGIBLE_TYPES = new Set<TransactionDto['type']>([
  'ADMIN_INCOME',
  'SENIOR_INCOME',
  'DROP_INCOME', // ФИКС — раньше отсутствовал, хотя DROP_INCOME уже мог иметь чек (SENIOR_INCOME/DROP_INCOME оба обязательны с самого начала)
  'EXPENSE',
  'SALARY', // НОВОЕ
  'ADMIN_TRANSFER', // НОВОЕ
  'DIVIDEND_TO_ADMIN', // НОВОЕ — реальный ledger-тип дивиденда (не синтетический 'DIVIDEND' диалога)
])
const showReceiptPanel = t ? RECEIPT_ELIGIBLE_TYPES.has(t.type) : false
```

`PAYOUT`/`PAYOUT_ADMIN` — deliberately NOT added (A5 of the brief, out of scope, they have their own on-chain
`txHash` mechanism via `payout-requests`).

### 5.7 Delineation from `AdminEditTransactionDialog`

`AdminEditTransactionDialog` (ADMIN-only «edit everything» — amount/currency/category/receipt) —
**remains a separate flow**, NOT replaced/merged with `AttachReceiptSheet`. It already reuses
`ReceiptInput` (without `explorerOnly` today — optionally `explorerOnly={currency
=== 'USDT'}` can be added there at the same time, since the currency there is editable too — low risk, conformance; NOT among the
mandatory ACs of this task, but recommended to the coordinator/coder to do along the way so as not to leave the
only inconsistent spot). `AttachReceiptSheet` is a narrowly specialized «receipt only»
tool, available NOT only to ADMIN (author self-service), which is its difference and reason for existing.
A similar recommendation (not a mandatory AC) — `EditSeniorIncomeDialog` (:40,125-132, currency
freely editable) can also get `explorerOnly={currency === 'USDT'}` for full
conformance.

---

## 6. Section D — the «no receipt on an old transaction» state

### 6.1 `ReceiptPanel` (detail view) — already solved, unchanged

`receipt-panel.tsx:67-76` already renders a calm dashed placeholder: `FileIcon` + «Нет прикреплённого
чека» (`text-sm text-muted-foreground`, NOT `text-destructive` — does not look like an error). The `#356` badge
lifecycle (`documents.service.ts` `deriveStatusBadge`) is not tied to this feature's UI — it reads
`receiptDocumentId`/the transaction status directly from the DB; attach/replace through the new endpoint **must**
keep this derivation correct (a backend task, not UI) — here only a reminder not to break the document↔transaction
link on a 1:1 replace-with-delete.

### 6.2 `TransactionRow` — a muted indicator

Already described in the §5.2 state table — a muted `Receipt` icon ONLY when the viewer has
`canAttachReceipt`. For the other roles the row looks as it does today (without a new visual element) —
a deliberate decision against noise in a dense table.

---

## 7. Responsive (4 device classes)

### 7.1 Dialogs (all 9 create/pay flows, §3)

| Class              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile 320–639** | `CrmDialogContent max-h-[90dvh]`, body scroll — unchanged from existing behavior. The `ReceiptInput` tab-toggle is full-width, each tab ≥ 44px in touch-zone width (height 32px — **below** the 44px recommendation; see §9 — an existing component, not extended by this task, but if desired it can be raised `h-8`→`h-10`, not a mandatory AC). The explorer-only URL input `h-9`, full-width — no overflow. |
| **Tablet 640+**    | Identical to mobile — dialogs do not switch to 2 columns for the receipt block (matches the existing 1-column convention of all the other fields).                                                                                                                                                                                                                                                              |
| **Laptop 1024+**   | A standard `sm:max-w-lg`/`sm:max-w-md` dialog — unchanged.                                                                                                                                                                                                                                                                                                                                                      |
| **Large 1440+**    | The dialog does not stretch beyond `max-w` — unchanged.                                                                                                                                                                                                                                                                                                                                                         |

### 7.2 `AttachReceiptSheet`

| Class              | Behavior                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile 320–639** | `SheetContent side="right" w-full` — a full-screen slide-over (the `InterviewDetailSheet` pattern). Footer buttons are full-width `flex` (the standard `SheetFooter`). Touch targets ≥44px: `SheetFooter` buttons — `Button` default height (`h-9`=36px) — **raise to `h-11` on mobile** via `className="h-11 sm:h-9"` on both footer buttons (Отмена/Прикрепить), see §9. |
| **Tablet 640+**    | `sm:max-w-md` — capped, not full-screen.                                                                                                                                                                                                                                                                                                                                   |
| **Laptop 1024+**   | Unchanged — the same `sm:max-w-md`.                                                                                                                                                                                                                                                                                                                                        |
| **Large 1440+**    | Unchanged.                                                                                                                                                                                                                                                                                                                                                                 |

### 7.3 `TransactionRow` icon button + `TransactionDetailDialog` button

| Class              | Behavior                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile 320–639** | The row icon is **hidden** (`hidden`) — the actions cell does not get yet another sub-44px element in the horizontal scroll. The main entry — the `TransactionDetailDialog` button, `w-full h-11` (44px, full-width of the column).     |
| **Tablet 768+**    | The row icon appears (`md:inline-flex`, `h-7 w-7`=28px — matches the existing neighboring icon buttons `Edit2`/`Trash2` in the same cluster, touch via mouse/stylus on a tablet is acceptable). The detail button — `sm:w-auto sm:h-9`. |
| **Laptop 1024+**   | Unchanged — both entries are available.                                                                                                                                                                                                 |
| **Large 1440+**    | Unchanged.                                                                                                                                                                                                                              |

### 7.4 General verification

Playwright at 320/375/768/1024/1280/1440/1920: no horizontal page overflow
(`document.scrollWidth <= document.documentElement.clientWidth`), `AttachReceiptSheet` opens/
closes without layout shift, the `ReceiptInput` explorer-only URL field does not overflow the dialog at any
width, the tab-toggle (non-explorer mode) stays 2-column without wrapping the «Файл»/«Ссылка» label text.

---

## 8. A11y (WCAG 2.2 AA)

| Requirement                                       | Implementation                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon-only «Чек» button in the row                 | Explicit `aria-label` (not only `title`, as in the neighboring `Edit2`/`Trash2` — we do NOT inherit this gap for the new element, `aria-label` is mandatory)                                                                                                     |
| Non-interactive indicator (replace forbidden)     | `<span>`, not `<button>` — honest semantics, `aria-label` is present for the screen reader, but it is NOT focusable (no `tabIndex`, no false interactive hint)                                                                                                   |
| `Sheet` focus-trap                                | Radix `Sheet` (a Dialog primitive under the hood) — the focus-trap is built in, standard                                                                                                                                                                         |
| `Sheet` Escape-close                              | Radix closes on Escape as standard — `onOpenChange` is already passed through                                                                                                                                                                                    |
| `AlertDialog` confirm — focus on «Отмена»         | Radix `AlertDialog` default focus on the first focusable (Cancel) — a safe default for a destructive action (replacing a receipt)                                                                                                                                |
| Explorer hint — not only color                    | A text hint (not just a color change of the input) — information is not conveyed ONLY through color                                                                                                                                                              |
| Validation error — text + `aria-live`?            | A text `<p>` next to the field (the existing `fieldErrors.receipt` pattern) — sufficient for critical submit errors, an extra `aria-live` is not required (the form does not update asynchronously after the user's focus)                                       |
| Contrast                                          | `text-emerald-400` on `bg-card`/`bg-transparent` — an already vetted token (used in `STATUS_COLORS.VALIDATED`/`PAID`); `text-muted-foreground` — vetted                                                                                                          |
| Target size (the «Чек» icon button, ≥768px)       | `h-7 w-7` = 28px ≥ the 24px WCAG 2.5.8 minimum — conforms (the project's mobile standard ≥44px applies only on mobile, where the element is hidden altogether, see §7.3)                                                                                         |
| Target size (Detail button, mobile)               | `h-11` = 44px — conforms to the project responsive standard                                                                                                                                                                                                      |
| Target size (`AttachReceiptSheet` footer, mobile) | `h-11 sm:h-9` on both buttons — see §7.2                                                                                                                                                                                                                         |
| Russian UI                                        | All new strings are Russian (see §4.4)                                                                                                                                                                                                                           |
| Label of the mandatory field                      | `«Чек / подтверждение *»` — the asterisk is a visual marker (existing convention); `aria-required` is not added explicitly (the error goes via `fieldErrors.receipt` — the project's existing pattern, we do not introduce a new convention just for this field) |

---

## 9. Edge cases

| Case                                                                                                                                           | Behavior                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A USDT transaction, the user pastes a NON-explorer link                                                                                        | Submit is blocked, `errors.receipt` = «Ссылка должна вести на поддерживаемый blockchain-explorer…» (client-side, before the network request)                                                                                                                                                         |
| Switching currency USDT→another AFTER entering an explorer link                                                                                | `explorerOnly` becomes `false` → the tab-toggle returns, the link stays in `state.externalUrl` (valid as a regular http(s) url — not lost)                                                                                                                                                           |
| Switching currency another→USDT when a file is already uploaded                                                                                | `explorerOnly` becomes `true` → auto-reset of `state` to an empty url mode (§4.1 effect) — the file receipt is UNLINKED from the form (not deleted from S3, simply not used in the payload — the already uploaded document stays an orphan until the next upload cleanup, out of scope of this task) |
| Primary attach on a PAID transaction by the author                                                                                             | Allowed (the brief's §6 — status does not restrict the primary attach)                                                                                                                                                                                                                               |
| Replace on a PAID transaction by a NON-privileged author                                                                                       | `canAttachReceipt` = `false` → the row shows a non-interactive `<span>` indicator, the Detail button is not rendered at all                                                                                                                                                                          |
| An old transaction without a receipt, a viewer without rights (e.g. SENIOR looks at someone else's row — rare in practice due to data scoping) | Neither the icon nor the button is rendered — `ReceiptPanel` in the details shows «Нет прикреплённого чека» as a read-only fact                                                                                                                                                                      |
| `AttachReceiptSheet` is open, but the parent transaction was deleted/changed in the background (race)                                          | `mutation.onError` shows `getApiErrorMessage(err)` in the Sheet's error slot — the existing error-handling pattern (`extractErrorMessage`/`getApiErrorMessage` are already applied in neighboring dialogs)                                                                                           |
| A double click on Submit in `AttachReceiptSheet`                                                                                               | `disabled={mutation.isPending}` on the submit button — the existing double-submit protection pattern                                                                                                                                                                                                 |
| Company-deposit / payout-request pay / manual-confirm / confirm-payout CASH                                                                    | OUT of scope (A4/A5/A6 of the brief) — this spec does NOT touch their UI                                                                                                                                                                                                                             |
| `SALARY` reminder creation (`CreateTransactionDialog`, type `SALARY`)                                                                          | OUT of scope (A3 — a neutral reminder without a receipt; a receipt is required only at pay time via `PaySalaryDialog`, §3.2)                                                                                                                                                                         |

---

## 10. Motion

No new motion. `ReceiptInput` already uses a sliding pill (`framer-motion`, spring transition) for the
tab-toggle — with `explorerOnly` this toggle is simply not rendered (no motion at all in explorer mode,
which is logical — there is nothing to switch). `AttachReceiptSheet` — the standard Radix `Sheet` slide-in animation
(the existing `sheet.tsx` variants). The `AlertDialog` confirm — the standard Radix fade+scale. No new
transition/duration/easing values are introduced — everything is inherited from the existing primitives.

---

## 11. data-testid — summary table

| Element                                             | `data-testid`                                 |
| --------------------------------------------------- | --------------------------------------------- |
| Explorer hint under the URL field (`ReceiptInput`)  | `receipt-input-explorer-hint`                 |
| Receipt error — `CreateTransactionDialog`           | `create-transaction-error-receipt` (existing) |
| Receipt error — `PaySalaryDialog`                   | `pay-salary-error-receipt` (new)              |
| Receipt error — `SettleSeniorPayoutDialog`          | `settle-senior-error-receipt` (new)           |
| Row attach/replace icon                             | `tx-row-attach-receipt-${tx.id}`              |
| Row indicator (non-interactive, «receipt attached») | `tx-row-receipt-indicator-${tx.id}`           |
| Detail attach/replace button                        | `detail-attach-receipt`                       |
| `AttachReceiptSheet` container                      | `attach-receipt-sheet`                        |
| `AttachReceiptSheet` — error                        | `attach-receipt-sheet-error`                  |
| `AttachReceiptSheet` — cancel                       | `attach-receipt-sheet-cancel`                 |
| `AttachReceiptSheet` — submit                       | `attach-receipt-sheet-submit`                 |
| Confirm-replace `AlertDialog` container             | `attach-receipt-confirm-replace`              |
| Confirm-replace — cancel                            | `attach-receipt-confirm-cancel`               |
| Confirm-replace — submit                            | `attach-receipt-confirm-submit`               |

---

## 12. Instructions for the coder (CRITICAL)

1. **Build with our components** — `ReceiptInput` (extended, not rewritten), `Sheet`/
   `AlertDialog`/`Button`/`Badge` from shadcn/ui. Do NOT introduce new CSS variables/hardcoded hex/gradients.
2. **`ReceiptInput.explorerOnly`** — the single source of truth for explorer mode; do NOT duplicate the logic
   of hiding the tab-toggle in each of the 9 dialogs separately — the whole effect is encapsulated in the component (§4.1).
3. **`effectiveCurrency`/discriminant** — use EXACTLY the formulas of the §4.3 table; do not invent
   alternative conditions per dialog — they must match 1:1 the backend `refineCompanyAccountUsdt`/
   `z.literal('USDT')` invariants, otherwise the front end and back end will diverge on when an explorer link is required.
4. **`canAttachReceipt()`** — extract into a separate file (§5.1), import it EVERYWHERE (row/detail/sheet) —
   do NOT copy the triple expression into three places (a drift risk the project is already sensitive to —
   see `.claude/agents/memory/*/lessons.md` on RBAC desync between front-end surfaces).
5. **The backend contract has ALREADY landed** (`packages/shared/src/schemas/finance.ts`, the wip commit
   `wip(shared): mandatory receipt refine + explorer allowlist + attach schema`) — import literally
   `attachReceiptSchema`/`AttachReceiptDto`/`isExplorerUrl`/`BLOCKCHAIN_EXPLORER_HOSTS`/
   `receiptMandatoryError` from `@crm/shared`, do NOT redefine locally. The `PATCH /transactions/:id/receipt`
   controller/service belongs to the backend task (opus + security-reviewer), but the shared contract for the front end
   is ready — `AttachReceiptSheet`/`financeApi.attachReceipt` can be implemented right away without waiting for the
   controller (the types already exist; a network call before the endpoint is ready will simply return 404, does not block
   writing the UI/types).
6. **`txHash` consolidation (§2.3)** — remove the «TX Hash» UI input from `PaySalaryDialog`, do NOT touch the
   `PayoutContent`/`PayoutAdminContent` render (out of scope, A5). `SalaryContent` — the legacy-fallback `TxHashLink` row is
   conditional (only if `tx.txHash && !tx.receiptDocumentId && !tx.receiptExternalUrl`).
7. **`showReceiptPanel`/`showReceipt` — extend by the lists of §3.1/§5.6 literally**, not «by eye» — there
   are deliberately excluded types there (`PAYOUT`, `PAYOUT_ADMIN`, `SALARY`-create-reminder) — do NOT add them.
8. **`AttachReceiptSheet` — a single component**, reused from TWO entry points (row +
   detail). Do NOT create two different Sheet/Dialog for each entry.
9. **Responsive** — the row icon `hidden md:inline-flex`; the Detail button `w-full h-11 sm:w-auto sm:h-9`;
   the Sheet footer buttons `h-11 sm:h-9`. Exact classes — §7.
10. **Optional (non-blocking AC) conformance fixes**, if time permits: `explorerOnly` in
    `AdminEditTransactionDialog`/`EditSeniorIncomeDialog` (§5.7) — low risk, raises consistency,
    NOT mandatory for accepting this task.
11. **data-testid strictly per the §11 table** — AutoTest uses them for the 9-flow mandatory checks +
    the RBAC matrix of attach/replace + explorer-domain validation.

---

## 13. Fidelity references (for Mode B after implementation)

`design-gate: degraded` — a headless session without Claude Design/a browser, `design.png` is not created.
The Mode B fidelity audit after implementation is checked against: (a) this spec in full, (b) the existing
reference components without changing their visual language (the `ReceiptInput` tab-toggle, the `ReceiptPanel`
empty-state, the `FundingSourceFields` account/currency picker, the `AlertDialog` confirm pattern from
`ValidateDialog.tsx`, the `Sheet` slide-over pattern from `InterviewDetailSheet.tsx`), (c) the responsive tables
of §7 at all test widths (320/375/768/1024/1280/1440/1920) — special attention: the row icon is hidden <768px,
the Detail button is full-width 44px on mobile.
