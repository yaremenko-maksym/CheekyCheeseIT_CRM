# Design Spec — Cascade preview when editing a paid transaction (task 5/6)

> **Design tier:** 1 (a new surface — a preview of the monetary consequences of an edit) with elements
> of Tier 2 (an edit of 4 existing financial surfaces that this new surface must
> extend consistently: `AdminEditTransactionDialog`, `TransactionRow`, `TransactionDetailDialog`,
> `SettleSeniorPayoutDialog`).
> **design-gate:** degraded (Claude Design not used — a headless session without the owner in
> the loop, a text spec, Mode E). The fidelity audit after implementation (Mode B) is checked against THIS
> spec + the existing reference components (the `SettleSeniorPayoutDialog` summary-card,
> the `CreateTransactionDialog` obligation-preview banner, the `AmountCurrencyInput` conversion-hint), not
> against `design.png`.
> **Status:** coder-ready
> **Feature branch:** the next one after `feat(finance): drop top-up` (task 3b, PR #608) in the decomposition
> `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md`
> **Sources (architecture, read before implementing):**
>
> - `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` — AC3/AC4/AC6 (what a
>   cascade is, how the version is computed, the risk list)
> - `docs/architecture/2026-08-23-cascade-apply-ledger-term.md` — §1.2/§1.7/§1.12/§1.14 (when
>   applying will actually refuse — this spec derives the Save-gating rule below from them)
> - `docs/architecture/2026-08-23-drop-topup-triplet.md` — §Answer 1/5 (the drop top-up, the triplet)
> - `packages/shared/src/schemas/edit-cascade.ts` — the contract from which the spec is derived
>   literally (symbols `resolveEditCascade`, `resolveDerivative`, `cascadeWarningCodeSchema`,
>   `cascadeEditPreviewResponseSchema`, `classifyEditedRowLedgerFact`, `CASCADE_LEDGER_FACT_MESSAGES`,
>   `floorAmountAtAccumulator`, `isCascadeAmountEdit`)
> - `apps/api/src/finance/transactions.service.ts` — symbols `getEditCascadePreview`,
>   `applyEditCascade` (Phase 1 = the exact condition when Save must be unavailable — see §4.4)

---

## Summary of UX decisions (executive summary)

1. **Not a new dialog — an extension of the existing `AdminEditTransactionDialog`.** A cascade is a
   consequence of editing the amount of an already paid row, not a separate action. The new component
   `CascadeImpactPanel` is embedded UNDER the amount field in the already existing dialog and appears
   exactly when the admin has actually typed a different number on a `status === 'PAID'` row.
   No separate «preview step» with its own «Next» button — the preview is live,
   like the backend's cascade-preview and the obligation-preview in `CreateTransactionDialog`
   (`admin-income-obligation-preview` — a direct visual reference).
2. **A preview is not the same as «the row is editable».** The contract (`isCascadeAmountEdit`)
   answers the question «does something block THIS edit» only when the amount actually differs from
   the saved one. So the amount field is never blocked preventively (that would require
   a probing request, which the contract does not provide) — the refusal is discovered by the same
   movement as the cascade itself: a different number is typed in the field → after the 400 ms debounce
   `GET .../edit-preview` goes out → `blockedReason` arrives.
3. **Save-gating is not «editable/no», but an exact mirror of `applyEditCascade`'s Phase 1.**
   The preview can honestly show a plan that the server will reject anyway (two cases:
   `NO_SHARE_SNAPSHOT`, `OBLIGATION_CURRENCY_MISMATCH` — always block; `NON_USDT_CURRENCY` —
   blocks only when `needsReconfirm === true`). The «Сохранить» button is disabled by EXACTLY this
   predicate (§4.4), not by the heuristic «are there warnings» — otherwise we either let a guaranteed
   400 through, or block what the server will actually accept (an overpayment, for instance, does not block).
4. **«Will return to payout pending» is the main visual signal, not a small badge.** `needsReconfirm`
   is the core of the owner's whole task («after saving, the derivatives, if they were paid,
   return to PENDING»). Such a row in the plan has an accent border (`border-amber-500/30`), not a
   neutral one.
5. **The mobile derivatives table is cards, not horizontal scroll.** The existing pattern
   of `TransactionRow`/`ActiveTransactionsTable` on mobile is `overflow-x-auto` for the whole table; this is
   an existing, separately living compromise of the main list, NOT a precedent for a new surface.
   The assignment explicitly requires something else for this table — below is a card stack modeled on the
   `SettleSeniorPayoutDialog` summary-card (`rounded-lg border border-border bg-muted/30 p-3
space-y-1`).
6. **«Already paid / to be topped up» — three surfaces with one data source, not one.** The list
   (`TransactionRow`), the details (`TransactionDetailDialog`), and — importantly — **the summary in
   `SettleSeniorPayoutDialog`**, which TODAY shows `tx.amount` (the full obligation) as
   «Сумма» and after this task this will become a misleading figure on a row with a partial
   accumulator: the operator will see 130, but 30 will be charged. All three require the same field
   on the wire (`settledAmount`/`settledCurrency`), which TODAY is NOT on `TransactionDto` — see §14, item 1.
7. **The payment fact triplet (originalAmount/exchangeRate) — yes, in task 5, minimally.**
   The data is already on the wire (`TransactionDto.originalAmount/originalCurrency/exchangeRate`, exported
   by `mapTx` today), only the display is missing. It is added in ONE block in
   `TransactionDetailDialog` modeled on the existing `Row` (icon+label+value), because it
   directly explains TWO new refusals of this same task (`PAYMENT_FACT_RECORDED`,
   `SOURCE_ORIGINAL_AMOUNT_SET`) — without it the refusal names a carrier that the operator cannot
   see anywhere in the interface. The full rationale — §7.
8. **409 (a stale preview) — an honest dead end with one button, not a silent recalculation.** The same
   principle as the whole ADR: the server directly says «the world has changed», the UI shows this verbatim and gives
   ONE action — «Обновить предпросмотр» (re-requests the `GET`), Save stays unavailable until the
   plan is refreshed.

---

## 1. Component inventory

### 1.1 Existing (reused as is or extended)

| Component                                    | File                                                            | Role in this feature                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminEditTransactionDialog`                 | `.../finance/components/dialogs/AdminEditTransactionDialog.tsx` | **Extended** — a debounce+preview request, embeds `CascadeImpactPanel`, Save-gating (§4)                                                                                                                                                                |
| `AmountCurrencyInput`                        | `apps/web/app/components/ui/amount-currency-input.tsx`          | Unchanged — the existing amount field, where the typed value comes from                                                                                                                                                                                 |
| `TransactionRow`                             | `.../finance/components/TransactionRow.tsx`                     | **Extended** — an extra «Выплачено / Осталось» line in the amount cell for `*_PENDING_PAYMENT` (§5.1)                                                                                                                                                   |
| `TransactionDetailDialog`, `Row`             | `.../finance/components/dialogs/TransactionDetailDialog.tsx`    | **Extended** — the «Уже выплачено» block (§5.2) + the «Факт платежа» block for the triplet (§7)                                                                                                                                                         |
| `SettleSeniorPayoutDialog`                   | `.../finance/components/dialogs/SettleSeniorPayoutDialog.tsx`   | **Extended** — the summary-card replaces «Сумма» with «К доплате» when there is an accumulator (§5.3) — a **corrective fix**, not cosmetics                                                                                                             |
| `financeApi.adminUpdateTransaction`          | `.../finance/api.ts`                                            | The payload is extended with `cascadeVersion` on a cascade edit (already in `AdminUpdateTransactionDto`, the field is in the contract)                                                                                                                  |
| `Badge`                                      | `apps/web/app/components/ui/badge.tsx`                          | Ready status variants + arbitrary `className` for new warnings (there is no «warning» variant — we use tailwind classes by the `TYPE_COLORS`/`STATUS_COLORS` convention, see §8)                                                                        |
| `Skeleton`                                   | `apps/web/app/components/ui/skeleton.tsx`                       | The panel's loading state (the same pattern as the `AmountCurrencyInput` conversion-hint skeleton)                                                                                                                                                      |
| `Button`, `Label`                            | `apps/web/app/components/ui/*`                                  | Standard primitives                                                                                                                                                                                                                                     |
| `fmtAmount`, `TYPE_LABELS`, `STATUS_LABELS`  | `.../finance/constants.ts`                                      | Formatting of amounts/labels — reused unchanged                                                                                                                                                                                                         |
| `parseStrictAmount`, `normalizeDecimalInput` | `apps/web/app/lib/utils.ts`                                     | Unchanged — already used in `AdminEditTransactionDialog`                                                                                                                                                                                                |
| `getApiErrorMessage`                         | `apps/web/app/lib/axios-utils.ts`                               | **Replaces** the local `mutation.error instanceof Error ? ...` in `AdminEditTransactionDialog` — today's check does not extract the text from the backend's axios response, and the backend text here is the only explanation of the refusal (see §4.5) |

### 1.2 New

| Component                          | Type              | Purpose                                                                                                                                                   | File (proposed)                                                                         |
| ---------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `CascadeImpactPanel`               | New component     | The core of the task — renders all the preview states (§4.2): loading / blocked / empty / plan / stale / network                                          | `.../finance/components/dialogs/CascadeImpactPanel.tsx`                                 |
| `CascadeDerivativeRow`             | New sub-component | One derivative row — desktop `<tr>` + mobile card, a shared data source (§4.3)                                                                            | Inside `CascadeImpactPanel.tsx` (do not extract into a separate file — used only there) |
| `financeApi.getEditCascadePreview` | New API method    | `api.get<CascadeEditPreviewResponse>(\`/transactions/\${id}/edit-preview\`, { params: { amount } }).then(r => r.data)`                                    | `.../finance/api.ts`                                                                    |
| `CASCADE_BLOCKED_REASON_MESSAGES`  | New constant      | Russian text for ALL 6 `blockedReason` values — 4 are already ready in `@crm/shared` (`CASCADE_LEDGER_FACT_MESSAGES`), 2 new ones are written here (§4.6) | `.../finance/constants.ts` (next to `STATUS_LABELS`)                                    |

**Coordination with the already merged contract.** `packages/shared/src/schemas/edit-cascade.ts` is already
in `main` (tasks 2/3/3b, PR #603/#607/#608) — import literally: `cascadeEditPreviewQuerySchema`,
`cascadeEditPreviewResponseSchema`, `CascadeEditPreviewResponse`, `CascadePlan`, `CascadeDerivativePlan`,
`CascadeWarning`, `CASCADE_LEDGER_FACT_MESSAGES`, `amountsDiffer`. The backend endpoints (`GET
:id/edit-preview`, `PATCH :id/admin-edit` with `cascadeVersion`) are also already in `main`. This task is
**purely front end**.

---

## 2. Direction (5 questions — inherits `foundation.md`, introduces nothing new)

| Question         | Answer as applied to this screen                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | ADMIN corrects a mistake in an already posted amount and BEFORE saving sees the monetary consequences — what will roll back, how much can no longer be returned, what is blocked and why. |
| Audience         | ADMIN, rarely (editing a PAID row is not a routine operation), a high cost of error — the screen must be excessively clear, not compact at any price.                                     |
| Tone             | dense · quiet · scannable, like the whole finance module. No dramatization («Осторожно!!!») — facts and numbers speak for themselves.                                                     |
| Memorable detail | The only accent signal on the whole screen — a warm amber border on the row that «will return to payout pending». Everything else is a neutral `border-border`.                           |
| Constraints      | Inherits `AdminEditTransactionDialog`: `sm:max-w-md`→dynamically wider when there is a plan; Tailwind v4 tokens; WCAG 2.2 AA; 320–1440; dark theme; Russian UI.                           |

---

## 3. Token-map

Only existing semantic tokens (`apps/web/app/styles/globals.css`) + the extended tailwind palette
already accepted in the project for status accents (the same class used by
`STATUS_COLORS`/`TYPE_COLORS` in `constants.ts` — not a new practice, a continuation of the existing one).

| Purpose                                                                                              | Token / class                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel surface / summary-card                                                                         | `bg-muted/30` + `border-border` (the same pattern as the `SettleSeniorPayoutDialog` summary-card)                                                              |
| «Will return to payout pending» row (needsReconfirm)                                                 | `border-amber-500/30 bg-amber-500/5` (the same hue as `STATUS_COLORS.PENDING_PAYMENT`)                                                                         |
| Blocking warning (`NO_SHARE_SNAPSHOT`, `OBLIGATION_CURRENCY_MISMATCH`, blocking `NON_USDT_CURRENCY`) | `border-destructive/30 bg-destructive/5 text-destructive`                                                                                                      |
| Non-blocking warning (`OVERPAYMENT`, `SIGNED_INVOICE`, non-blocking `NON_USDT_CURRENCY`)             | `border-amber-500/30 bg-amber-500/5 text-amber-400` (the same class as `STATUS_COLORS.PENDING`)                                                                |
| Refusal (`editable: false`, the whole block)                                                         | `border-destructive/30 bg-destructive/5 text-destructive` (the same pattern as «Транзакцию нельзя редактировать» in the existing `AdminEditTransactionDialog`) |
| Informational plate (a regular plan without warnings)                                                | `border-primary/20 bg-primary/5` (literally the same class as `admin-income-obligation-preview` in `CreateTransactionDialog`)                                  |
| Numbers                                                                                              | `tabular-nums font-medium`                                                                                                                                     |
| Radius                                                                                               | `rounded-lg` (panel) / `rounded-md` (inner row cards) — concentricity per `foundation.md` §3                                                                   |

No raw hex/oklch, no purple gradients, no new `Badge` variant — all
accents via existing Tailwind classes already used in this same module (`STATUS_COLORS`).

---

## 4. Screen A (core) — Preview before saving

### 4.1 Trigger and data

`AdminEditTransactionDialog` already holds the `amount: string` state. Added:

```
debouncedAmount (400ms setTimeout, the same pattern as use-contract-tokens.ts)
  → parsedAmount = parseStrictAmount(debouncedAmount)
  → shouldPreview =
        tx?.status === 'PAID' &&
        Number.isFinite(parsedAmount) && parsedAmount > 0 &&
        amountsDiffer(parsedAmount, Number(tx.amount))   // amountsDiffer from @crm/shared — THE SAME function as on the server
```

```
useQuery({
  queryKey: ['cascade-preview', tx?.id, parsedAmount],
  queryFn: () => financeApi.getEditCascadePreview(tx!.id, parsedAmount),
  enabled: shouldPreview,
  retry: false,   // 400/403/404 are not transient — no point retrying 3× and holding the user in the loading state
})
```

**Why `retry: false` is not a trifle but part of the UX contract.** React Query by default makes up to 3
retries on an error; a refusal (`editable: false`) is a 200 RESPONSE with `blockedReason`, not an HTTP error
(see §4.6), so retry is not about the blocking scenario at all. It matters
for real network failures — without `retry: false` a dropped connection would hold the panel in `isLoading` for
seconds, masking a network error as «calculating».

`status !== 'PAID'` — this entire section is not rendered at all, the dialog's behavior is identical to today's
(a regular amount edit without a cascade, as for `VALIDATED`/`PENDING` rows).

### 4.2 `CascadeImpactPanel` states

The panel is rendered ONLY when `tx.status === 'PAID'` AND the `amount` state differs from the original
(`amountsDiffer(parseStrictAmount(amount), Number(tx.amount))`) — until then the amount field
looks like a regular field, no panel under it.

| #   | State                                                                                  | What it shows                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Loading** (`isFetching`, the debounce has not fired yet OR the request is in flight) | A `Skeleton` row `h-4 w-40` + the text «Пересчитываем связанные выплаты…» (`text-xs text-muted-foreground`) — the same visual weight as the `AmountCurrencyInput` `isFetching` skeleton |
| 2   | **Network error** (query `isError`, NOT a 4xx with a body — `!err.response`)           | A `border-destructive/30` row: «Не удалось загрузить предпросмотр — проверьте соединение» + a «Повторить» button (`refetch()`)                                                          |
| 3   | **Blocked** (`editable: false`)                                                        | §4.6 — a separate block, REPLACES the panel entirely (no point in showing a plan that does not exist)                                                                                   |
| 4   | **Empty** (`editable: true`, `plan.derivatives.length === 0`)                          | §4.7 — a compact confirmation row                                                                                                                                                       |
| 5   | **Plan with derivatives** (`plan.derivatives.length > 0`)                              | §4.3 — the core, table/cards                                                                                                                                                            |
| 6   | **Stale** (409 from `PATCH` on save)                                                   | §4.8 — a separate block, shown ON TOP of the last successful plan (the plan stays visible but outdated — marked)                                                                        |

Between states 1↔5 there must be no layout shift stronger than necessary: the panel always occupies
the position right under `AmountCurrencyInput`, the minimum height is not artificially fixed (the content
dictates), but the loading skeleton takes about the same height as a typical one-line «empty» response
— so that the dialog does not «jump» on every keystroke during the debounce.

### 4.3 Core — a plan with derivatives

**Panel heading:** «Что изменится при сохранении» (`text-xs font-medium text-muted-foreground`,
not the dialog heading — a section subheading, on the `foundation.md` §4 «Card / KPI label» scale).

**Source amount row** (always, when the plan is non-empty) — compact, one line:

```
Сумма источника: {fmtAmount(oldSourceAmount, sourceCurrency)} → {fmtAmount(newSourceAmount, sourceCurrency)}
```

`tabular-nums`, the arrow `ArrowRight` (lucide-react, already used in `TransactionRow`/`FromTo`
for the same «was → became» semantics).

**Source warnings** (`plan.sourceWarnings`, if non-empty) — rendered as rows BEFORE the derivatives
table, each a `border-amber-500/30 bg-amber-500/5` row with the text FROM THE SERVER RESPONSE
(`warning.message`), verbatim, never rewritten on the front end (see §4.5 «one text, not two
descriptions»).

**The derivatives table/cards** — one per `plan.derivatives[i]`. Desktop (`sm:` and wider) —
a table; mobile (`<640px`) — a card stack. See §4.3.1/§4.3.2 for anatomy, §9 for the full responsive
breakdown.

#### 4.3.1 What a single derivative shows (a common field set, both layouts)

| Field                         | Source                                                                                        | Format                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recipient / type              | `TYPE_LABELS[derivative.type]` + the recipient (see below — partially incomplete, §14 item 2) | A `TYPE_COLORS[type]` Badge + a caption under it, if the recipient is known                                                                      |
| Was → Became                  | `derivative.oldAmount` → `derivative.newAmount`, `derivative.currency`                        | `tabular-nums`; if `newAmount === null` — «Стало: —» with destructive highlighting (this is `NO_SHARE_SNAPSHOT`, see below)                      |
| Already paid                  | `derivative.settledAmount`, `derivative.settledCurrency`                                      | Rendered ONLY if `settledAmount > 0`. `fmtAmount(settledAmount, settledCurrency ?? currency)`                                                    |
| To be topped up               | `derivative.remainingToPay`                                                                   | `fmtAmount(remainingToPay, currency)`, or «—» with `title` = the text of the `NON_USDT_CURRENCY` warning, if `remainingToPay === null`           |
| Will return to payout pending | `derivative.needsReconfirm`                                                                   | An amber Badge «⟲ Вернётся в ожидание выплаты» (icon `RotateCcw`, already used in the project for «Восстановить» — the same «rollback» metaphor) |
| Warnings                      | `derivative.warnings[]`                                                                       | A list of chips/rows, text **verbatim from the response**, see §4.5. Icon by severity: `AlertCircle` (destructive) / `AlertTriangle` (amber)     |

**The recipient — what can be shown today without a new API field (important, read before implementing).**
`CascadeDerivativePlan` does NOT contain `receiverId`/`receiverName` — only `id`/`type`/amounts (see §14
item 2 for the full analysis and the proposed fix). Without a new field:

- for the **senior family** — `SENIOR_PENDING_PAYOUT` AND `SENIOR_INCOME` — reuse the **already
  passed** `tx.receiverName` (the source — `ADMIN_INCOME`/`SENIOR_INCOME`, whose recipient IS
  the senior) — the caption «Синьору {tx.receiverName}»;
- for the **drop family** — `DROP_PENDING_PAYOUT` AND `PAYOUT_DROP` — the name is unreachable from the already
  loaded data, the caption is limited to «Доля дропа» (without a name) — honestly, do not invent.

> **Correction, 2026-08-24 (UX-1, fidelity audit).** Previously only the «pending» types stood here —
> `SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT`. This is a **spec** error, not only an implementation one:
> `settleByCompany` flips the IOU **in place** (`SENIOR_PENDING_PAYOUT` → `SENIOR_INCOME`,
> `DROP_PENDING_PAYOUT` → `PAYOUT_DROP`), and `loadCascadeSnapshot` puts `type: d.type` into the plan,
> i.e. the **current** type. Matching only the pending type missed exactly the
> population for which the screen is made: an already paid share that is about to return to
> payout pending was shown without a recipient. Found by a live run of the cascade, not by reading.

### 4.3.2 Desktop table (`sm:` 640px and wider)

A regular HTML table, the style — 1:1 with the existing `<table>` from `TransactionRow.tsx`/
`ActiveTransactionsTable.tsx` (do not wrap in the shadcn `Table` primitive — the finance module already
consistently uses raw `<table>` elements, introducing a second way to build a table in the same
module is not consistency):

```
<table className="w-full text-sm">
  <thead>
    <tr className="border-b border-border/50 text-xs text-muted-foreground">
      <th className="text-left py-2 px-3 font-medium">Получатель</th>
      <th className="text-right py-2 px-3 font-medium">Было → Стало</th>
      <th className="text-right py-2 px-3 font-medium">Выплачено</th>
      <th className="text-right py-2 px-3 font-medium">К доплате</th>
      <th className="text-left py-2 px-3 font-medium">Статус</th>
    </tr>
  </thead>
  <tbody>{/* CascadeDerivativeRow × N, border-b border-border/50 last:border-0, needsReconfirm → border-l-2 border-l-amber-500 */}</tbody>
</table>
```

A row with `needsReconfirm === true` gets `border-l-2 border-l-amber-500` (a left accent
border) — the only «spotlight» row on the whole screen, per the `foundation.md` memorable-detail
principle («yellow = action/attention here»).

### 4.3.3 Mobile card (`<640px`)

A card stack, `space-y-2`, each card — `rounded-lg border border-border bg-muted/30 p-3 space-y-1.5
text-sm` (literally the `SettleSeniorPayoutDialog` summary-card pattern), the needsReconfirm card —
`border-amber-500/30 bg-amber-500/5` instead of neutral:

```
┌─────────────────────────────────────┐
│ [Badge: Ожидаемая выплата синьору]   │
│ Синьору Иван Петров                  │
│ ─────────────────────────────────    │
│ Было → Стало      8 000 → 10 000 USDT│
│ Выплачено                 5 000 USDT │
│ К доплате                  5 000 USDT│
│ ⟲ Вернётся в ожидание выплаты        │
└─────────────────────────────────────┘
```

Each row inside the card — `flex justify-between` (the label on the left muted, the value on the right
`tabular-nums font-medium`) — the same pattern that `SettleSeniorPayoutDialog` already uses 1:1.
Each field fits on one line at 320px (the longest value — an amount with a currency,
≤ ~14 characters, the labels are short — «Было → Стало», «Выплачено», «К доплате» — they do not wrap).

### 4.4 Save-gating — the exact formula

```
canSave =
  editable !== false &&
  (plan === null || plan.derivatives.every(d =>
    d.newAmount !== null &&
    !d.warnings.some(w => w.code === 'OBLIGATION_CURRENCY_MISMATCH') &&
    !(d.needsReconfirm && d.warnings.some(w => w.code === 'NON_USDT_CURRENCY'))
  ))
```

This is the EXACT mirror of the three refusals of `applyEditCascade`'s Phase 1 that are visible from the plan:
`derivativePlan.newAmount === null` (no share snapshot), `OBLIGATION_CURRENCY_MISMATCH` (an
unconditional refusal), `needsReconfirm && NON_USDT_CURRENCY` (a refusal ONLY on a real rollback). **Deliberately NOT
included in the formula** are two more internal refusals of `applyEditCascade` (a mismatch
of `amount`↔`settled_amount` on a company-funded row, a missing `settled_amount` on a legacy
row before #599) — they are **not expressed by a warning code in `CascadeDerivativePlan`** (these are internal
invariant checks, not part of the public plan), so the front end cannot predict them. This is a
deliberate, rare (per the architectural analysis — «empty today by theorem») edge: Save can
theoretically still return 400 on a legacy row. It is handled not by a preventive UI ban
(which cannot be built), but by honestly displaying the server's error text on submit (§4.5) —
no existing class of cases is left without an explanation, it is just discovered at different steps.

`OVERPAYMENT` is **deliberately not part of** the predicate — an overpayment blocks neither `resolveEditCascade`
nor `applyEditCascade` (the row stays `PAID`, nothing is written to it, see AC7 of task 3) —
this is a warning for a human, not a system refusal.

The Save button at `canSave === false` is `disabled`, next to it (not inside title/tooltip — the warning
must be visible without hovering, WCAG 2.2 SC 1.4.13) a `text-xs text-destructive` line:
«Сохранить нельзя, пока не устранены проблемы в предпросмотре ниже» (general, does not duplicate
the specific warning texts — they are already shown row by row).

### 4.5 One text, not two descriptions (critical for the coder)

All texts of warnings/refusals that revolve AROUND money come from the server
(`warning.message`, `CASCADE_LEDGER_FACT_MESSAGES[reason]`, the `PATCH` error) and are rendered
**verbatim**. The front end does NOT rewrite or shorten them in its own words. This is a direct continuation
of the principle recorded in `edit-cascade.ts` itself: «task 5's UI can show the same sentence
without restating it». The only texts that THIS spec writes are the labels of fields/sections
(«Уже выплачено», «Что изменится при сохранении», etc.), NOT monetary explanations.

**The save error (`PATCH` 400/409/500)** — rendered via `getApiErrorMessage(err)`
(`apps/web/app/lib/axios-utils.ts`), NOT via today's check `mutation.error instanceof Error
? mutation.error.message : null` in `AdminEditTransactionDialog` — that check does not extract the body
of the axios response (`error.response.data.message`), and that is where the only text explaining
why the server refused lies. This is a fix of an existing bug in an adjacent movement (the same file, the same
diff), not a separate task.

### 4.6 Blocked (`editable: false`)

Replaces the WHOLE panel (the plan is not shown — there is no plan, `plan: null`). A single block, the style —
an extension of the already existing «Транзакцию нельзя редактировать» in `AdminEditTransactionDialog`
(`flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3
text-sm text-destructive`), with the `Ban` icon (lucide-react — «tool not available», distinct from
the `AlertCircle` already taken in this same dialog, which is used for form errors):

```tsx
<div
  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
  data-testid="cascade-blocked-banner"
>
  <Ban className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
  <span>{CASCADE_BLOCKED_REASON_MESSAGES[blockedReason]}</span>
</div>
```

The Save button is `disabled`.

**`CASCADE_BLOCKED_REASON_MESSAGES` — 6 values, 4 ready, 2 new:**

```ts
import { CASCADE_LEDGER_FACT_MESSAGES, type CascadeEditPreviewBlockedReason } from '@crm/shared'

export const CASCADE_BLOCKED_REASON_MESSAGES: Record<CascadeEditPreviewBlockedReason, string> = {
  ...CASCADE_LEDGER_FACT_MESSAGES, // PAYMENT_FACT_RECORDED / SETTLED_AMOUNT_RECORDED / CLOSES_OBLIGATION / ONCHAIN_DEPOSIT
  PAYOUT_FAMILY:
    'Это строка выплаты — сумма подтверждена исполненным переводом, она не редактируется, правьте сторнирующей транзакцией',
  LINKED_TO_PAYOUT_REQUEST:
    'Строка включена в оформленную заявку на выплату — сумма уже вошла в расчёт перевода, правьте сторнирующей транзакцией',
}
```

> **Correction, 2026-08-25 (QA-H-1, manual QA).** The derivative contract carries **two** monetary
> quantities, not one, and the table above described the former model:
>
> | Field             | What it is                                                                                                                     | Who reads it                                                                         |
> | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
> | `newAmount`       | what the row **will hold** after saving — the share, clamped by the floor to what is already paid (`floorAmountAtAccumulator`) | the «Стало» column, «К доплате»                                                      |
> | `recomputedShare` | what the **share recomputed to** before the floor                                                                              | the `OVERPAYMENT` text, the overpayment predicate, the `CASCADE_OVERPAYMENT` journal |
>
> The split is forced, not cosmetic: the floor **destroys** the raw share, and three
> places consume it. While the quantity was single, «Стало» showed a number the system had already decided not to
> write — manual QA measured via a DB dump: `100 → 50` on screen, `100` in the row.

> **Correction, 2026-08-24 (UX-7, fidelity audit round 4).** The whole block «what can be shown today
> **without a new API field**» — including «for `DROP_PENDING_PAYOUT` … is limited to «Доля дропа» (without a
> name) — honestly, do not invent» — is **outdated**. The field is added: `CascadeDerivativePlan.receiverName`
> is resolved by the server for **each** derivative (§14.2 proposed exactly this, the proposal
> is implemented). The current rule: the caption is taken from `derivative.receiverName` — «Синьору {name}»
> for the senior family, «Дропу {name}» for the drop family; the nameless fallback «Доля дропа»
> remains only when there is no recipient in the data (inventing is still forbidden).
>
> **How this came to light and why it is worth remembering.** The field was added in round 3, but only the
> senior branch was carried through to the screen — i.e. the asymmetry that §14.2 itself calls undesirable we
> described and then reproduced. A contract change is not considered delivered until it has been read by
> **all** the branches it touches.

> **Example correction, 2026-08-24 (SPEC-M-1 / COPY-L-1).** Previously there were two sentences with a period here
> («…она не редактируется. Ошибку исправляйте сторнирующей транзакцией.»), and right there — the instruction
> «the same register as the four accepted». This contradicted itself: all four messages in
> `CASCADE_LEDGER_FACT_MESSAGES` are **one sentence, the remedy after a comma, no period at the end**.
> The implementation followed the form, the spec — its own example; the implementation turned out right, and the example
> is brought in line with it. The arguments (copy-review): the strings are rendered in two different wrappers (the
> panel banner and the narrow error strip of the dialog), and a string without a terminal period fits both equally; a period on
> two of the six messages, shown one at a time in the same banner, reads as «two
> different systems are speaking». The form «the remedy as a separate sentence» is not worse in itself, but is acceptable
> only for all six at once, and four of them live in `@crm/shared` and are shared with the API response —
> that is a separate task.

The wording of the two new strings is written on the model of the four already accepted (they name the carrier +
give the remedy), checked with `Skill('copywriting')` in this same session — the same register, the same length,
no new tone.

### 4.7 Empty — the edit does not produce a cascade

`editable: true`, `plan.derivatives.length === 0` (`ADMIN_INCOME` without booking, `EXPENSE`,
`DIVIDEND_TO_ADMIN`, etc. — rows that simply have no derivatives):

```
border-primary/20 bg-primary/5 (the same class as admin-income-obligation-preview)
«Эта сумма не связана с выплатами — пересчитывать нечего»
```

One line, without an icon — deliberately the quietest of all the panel's statuses (this is NOT a warning,
it is a confirmation that the edit is simple).

### 4.8 Stale — 409 on save

Save pressed → the server returned a `ConflictException` (409, exact text: «Данные изменились с момента
предпросмотра — обновите предпросмотр правки и повторите сохранение», rendered verbatim, §4.5).

Visually — REPLACES the last plan on top (the plan stays visible under it, slightly muted
`opacity-60 pointer-events-none`, so that the operator sees WHAT exactly became stale, rather than losing context):

```tsx
<div
  className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-400"
  data-testid="cascade-stale-banner"
>
  <span>{conflictMessage /* verbatim from the server */}</span>
  <Button
    size="sm"
    variant="outline"
    onClick={() => refetchPreview()}
    data-testid="cascade-refresh-preview"
  >
    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
    Обновить предпросмотр
  </Button>
</div>
```

`RefreshCw` — the same icon already used in the project as the default «recompute» indicator
(`TransactionDetailDialog`'s `StatusIcon` default case). After the click — `refetch()` of the same
react-query request from §4.1 (not a new request, the same one), the plan below updates, the muting is removed,
Save is available again (at `canSave`).

---

## 5. Screen B — «Already paid / to be topped up»

Three surfaces, one source of truth (`tx.settledAmount`/`tx.settledCurrency`, §14 item 1). Rendered
ONLY when `settledAmount != null && settledAmount > 0` — on the overwhelming majority of rows (no
accumulator at all) NOTHING changes.

### 5.1 `TransactionRow` — the transaction list

In the amount cell (where the «Доля: X%» line for `SENIOR_INCOME` is already rendered — the same slot,
the same `text-[11px] text-muted-foreground font-normal` style, a compact caption under the main
amount), for `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}` with `settledAmount > 0`:

```tsx
{
  ;(tx.type === 'SENIOR_PENDING_PAYOUT' || tx.type === 'DROP_PENDING_PAYOUT') &&
    tx.settledAmount != null &&
    tx.settledAmount > 0 && (
      <p className="text-[11px] text-amber-400 font-normal" data-testid={`tx-row-settled-${tx.id}`}>
        Выплачено {fmtAmount(tx.settledAmount, tx.settledCurrency ?? tx.currency)}
        {tx.settledCurrency == null || tx.settledCurrency === tx.currency
          ? ` · осталось ${fmtAmount(Number(tx.amount) - tx.settledAmount, tx.currency)}`
          : ''}
      </p>
    )
}
```

The `amber` color (not the neutral `text-muted-foreground`, like «Доля: X%») — this is a state that
did not exist in the system before and is worth drawing the attention of an operator scanning the list to, but not
alarming enough to be `destructive`.

> **Correction, 2026-08-24 (UX-3 fidelity + COPY-M-2 copy-review).** Two clarifications to the formula above.
> (1) The second half of the caption is called **«к доплате»**, not «осталось»: it is the same number from the
> same function that the details, the cascade panel and the settle dialog show, and the operator goes through all
> four surfaces in one scenario (measured: 2 lines in a ~150px cell in both variants,
> unification is free). (2) The second half is **not rendered at all** when there is nothing to top up
> (`remaining === 0`): «к доплате 0,00» on every fully closed row is a line
> that has to be read and discarded. The original §5.1 formula printed it always.

### 5.2 `TransactionDetailDialog` — details

A new `Row` right after the existing `Row` with the amount, by the same pattern (`icon+label+value`):

```tsx
{
  ;(t.type === 'SENIOR_PENDING_PAYOUT' || t.type === 'DROP_PENDING_PAYOUT') &&
    t.settledAmount != null &&
    t.settledAmount > 0 && (
      <Row icon={<Wallet className="h-4 w-4" />} label="Выплачено">
        <span className="tabular-nums">
          {fmtAmount(t.settledAmount, t.settledCurrency ?? t.currency)}
        </span>
        {(t.settledCurrency == null || t.settledCurrency === t.currency) && (
          <span className="block text-xs text-muted-foreground mt-0.5">
            К доплате: {fmtAmount(Number(t.amount) - t.settledAmount, t.currency)}
          </span>
        )}
      </Row>
    )
}
```

`Wallet` — already imported in the module (`TransactionRow.tsx`), carries a stable «money/account» metaphor.

### 5.3 `SettleSeniorPayoutDialog` — the summary before payment (a corrective fix, not cosmetics)

Today's block:

```tsx
<div className="flex justify-between">
  <span className="text-muted-foreground">Сумма</span>
  <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
</div>
```

Shows `tx.amount` — the FULL obligation. After tasks 3/3b it may differ from what
will actually be charged on pressing «Отметить как оплачено» (the server pays the remainder, `remainingOwed`).
Changes to:

```tsx
{
  tx.settledAmount != null && tx.settledAmount > 0 ? (
    <>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Обязательство</span>
        <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Уже выплачено</span>
        <span className="font-medium tabular-nums text-amber-400">
          {fmtAmount(tx.settledAmount, tx.settledCurrency ?? tx.currency)}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">К доплате сейчас</span>
        <span className="font-semibold tabular-nums">
          {fmtAmount(Number(tx.amount) - tx.settledAmount, tx.currency)}
        </span>
      </div>
    </>
  ) : (
    <div className="flex justify-between">
      <span className="text-muted-foreground">Сумма</span>
      <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
    </div>
  )
}
```

The ordinary case (no accumulator — the overwhelming majority of settles) does not change visually at all —
it is the `else` branch, byte-for-byte today's JSX.

**The drama condition: a DROP with an accumulator > 0 is today unavailable for a top-up altogether** (see
`docs/architecture/2026-08-23-drop-topup-triplet.md` — task 3b removes the AC15(a) refusal for the drop,
but per the decomposition it FOLLOWS, not precedes this one; if task 3b is not yet merged at the time of
implementing task 5 — `SettleSeniorPayoutDialog` for `DROP_PENDING_PAYOUT` with `settledAmount > 0`
will not open at all (the server will reject the attempt to cascade-edit the income earlier — the row will not be able to
reach the state «PENDING with an accumulator» for a drop). Check the actual state of `main` before
implementing — if 3b is already merged (PR #608, per the task file that is already the case), this paragraph is lifted,
the drop top-up works identically to the senior's.

---

## 6. Screen C — The overpayment marker

Not a separate screen — part of §4.3.1 (the «Warnings» field of the derivative row) + §5 (list/details).
The `OVERPAYMENT` warning is rendered as an amber row INSIDE the derivative card/row, text verbatim
from the server.

> **Correction, 2026-08-25 (QA-H-1, manual QA).** The text is **branched by the row's state** — the former
> single wording («…the row stays paid») described two different outcomes and for
> one of them was incorrect:
>
> | Obligation state    | What will happen                        | Message tail                                                        |
> | ------------------- | --------------------------------------- | ------------------------------------------------------------------- |
> | `PAID` (stays PAID) | nothing is written                      | `…строка остаётся оплаченной, разница сама не вернётся`             |
> | open (`PENDING`)    | the amount is raised to the accumulator | `…сумма останется на уровне выплаченного, разница сама не вернётся` |
>
> The second state is reachable: close the obligation fully → raise the source amount (the row
> rolls back to `PENDING_PAYMENT`, keeping the accumulator) → lower it back below what was paid.
> The row is `PENDING_PAYMENT` both before and after saving — calling it «paid» is incorrect. Additionally: a derivative row with this warning **does not get** the `needsReconfirm`
> accent (an overpayment logically excludes a rollback — the server guarantees this anyway via
> `resolveDerivative`, the UI simply does not draw two contradictory marks on one row).

**Outside the preview scope, but a related surface:** if a row ALREADY has an overpayment
(`overpaid`, not just computed, but saved in a past operator decision «leave as is») — the list/details
display from §5 does not highlight it separately (`OVERPAYMENT` is a preview plan code, not a permanent
property of the row; the row simply stays `PAID` with an amount less than
`settledAmount`, which is already visible from «Выплачено N / осталось —» — with
`newAmount < settledAmount` the «remaining» computation in §5.1/5.2 would give a negative number). **Fix: `Math.max(0, ...)` in
the formulas of §5.1/5.2** — «remaining» never shows a negative, on an overpayment
«осталось 0» is rendered (not «-100» — a negative debt is unreadable and contradicts the wording «к доплате»).

---

## 7. The payment fact triplet — `TransactionDetailDialog` «Факт платежа»

### 7.1 Finding and decision

An architectural finding (`2026-08-23-drop-topup-triplet.md`, «Found along the way»): `originalAmount`/
`originalCurrency`/`exchangeRate` are already in `TransactionDto` (exported by `mapTx`), but `apps/web`
does not read them anywhere except two comments in `PaySalaryDialog.tsx`. The operator does not see «how much was
owed and at what rate it was closed» at all, including regular salaries — not only cascade scenarios.

**Decision: yes, it is part of task 5.** Rationale:

1. **Zero API cost** — the data is already on the wire, this is purely front-end work (unlike §14, where
   a new backend endpoint/field is needed).
2. **A direct link with the new refusals of this same task.** `PAYMENT_FACT_RECORDED` (the blocking refusal
   of §4.6) names a carrier («a payment fact is recorded on this row») — but the operator, upon seeing the refusal,
   today CANNOT verify this claim anywhere in the UI. A refusal without the ability to verify its
   cause is worse than a refusal with it. This is the same argument that already drove the design-gate: «a refusal
   names the remedy, rather than merely forbidding» — but the remedy is useless if the fact because of which
   it was refused is invisible.
3. **Does not expand the DOM for free.** Rendered as ONE `Row` block, ONLY when `originalAmount !==
null` (the condition already exists as a predicate in `classifyEditedRowLedgerFact`) — on the overwhelming
   majority of rows nothing changes.

### 7.2 Anatomy

A new `Row` in `TransactionDetailDialog`, right after the existing amount block, visible to
ADMIN/ACCOUNTANT (the same privileged check already used in the file for the other audit
fields — `originalAmount` is not third-party personal data, but it is an internal accounting
detail, not for SENIOR/DROP/JUNIOR/HR):

```tsx
{
  privileged && t.originalAmount !== null && (
    <Row icon={<Percent className="h-4 w-4" />} label="Факт платежа">
      <span className="tabular-nums">
        Обязательство: {fmtAmount(t.originalAmount, t.originalCurrency ?? t.currency)}
      </span>
      {t.exchangeRate !== null && (
        <span className="block text-xs text-muted-foreground mt-0.5 tabular-nums">
          Применённый курс: ×{Number(t.exchangeRate).toFixed(4)}
        </span>
      )}
    </Row>
  )
}
```

`Percent` — already imported in `TransactionDetailDialog.tsx` (used for the senior's/drop's share),
reused — the same «coefficient/conversion» metaphor.

---

## 8. A11y (WCAG 2.2 AA)

| Requirement                                                       | Implementation                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A refusal/warning — not only color                                | An icon (`Ban`/`AlertCircle`/`AlertTriangle`/`RotateCcw`) + text ALWAYS next to the colored accent — never color as the sole carrier of meaning                                                                                                                                                                                                                                      |
| Save disabled — the reason is visible without hovering            | A text line next to the button (§4.4), NOT only the `title`/`disabled` attribute (SC 1.4.13, SC 4.1.2)                                                                                                                                                                                                                                                                               |
| The loading state is announced to a screen reader                 | `aria-live="polite"` — NOT on the whole `CascadeImpactPanel` container (this would re-announce the WHOLE derivatives table on each change of one row — worse than no live region), but on a narrow status element inside (a single «Пересчитываем…»/«Готово» line with `aria-atomic="true"`), which changes its text, rather than on a wide container whose children change entirely |
| Focus is not lost when the panel appears/disappears               | The panel mounts/unmounts below the amount field, NOT between the field and the buttons — focus left in `AmountCurrencyInput` does not jump                                                                                                                                                                                                                                          |
| Target-size (the «Обновить предпросмотр» button)                  | A `size="sm"` Button — standard height ≥24px (the WCAG minimum); on mobile the whole dialog footer already follows the 44px convention of `CrmDialogFooter`                                                                                                                                                                                                                          |
| Contrast                                                          | `text-amber-400`/`text-destructive` on `bg-card`/`bg-muted` — already vetted tokens (used in `STATUS_COLORS`), not new values                                                                                                                                                                                                                                                        |
| The derivatives table — headers readable by a screen reader       | `<th scope="col">` on all 5 headers of the desktop table (there was no explicit `scope` in the existing finance tables — a new, non-inherited edit, added explicitly as an improvement, not a regression)                                                                                                                                                                            |
| The mobile card — semantics instead of `<table>`                  | `<dl>`/`<div>` with a label→value link via visible typography (do not rely on the visual `flex justify-between` as the sole carrier of the link — use `<dt>`/`<dd>` pairs or an `aria-label` on the card that phrases the whole recipient)                                                                                                                                           |
| Decorative icons in the new plates                                | `Ban`/`AlertCircle`/`AlertTriangle`/`RotateCcw`/`RefreshCw` — `aria-hidden` (see the code example in §4.6); the adjacent text carries the whole meaning, the icon is not duplicated in `aria-label`                                                                                                                                                                                  |
| The «Обновить предпросмотр» / «Повторить» buttons — not icon-only | An icon + a visible text label in one button — a separate `aria-label` is not required (unlike icon-only buttons such as `Edit2`/`Trash2` in `TransactionRow`, for which `aria-label` is mandatory)                                                                                                                                                                                  |
| Russian UI                                                        | All new strings are Russian (see §4.6, §4.7, §5, §7)                                                                                                                                                                                                                                                                                                                                 |

---

## 9. Responsive (4 device classes)

### 9.1 `AdminEditTransactionDialog` + `CascadeImpactPanel`

| Class      | Width     | Behavior                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobile** | 320 / 375 | `CrmDialogContent` `w-full` without a `maxWidth` constraint below (existing behavior). `CascadeImpactPanel` — a card stack (§4.3.3), `space-y-2`, each card full-width. The Save button inside `CrmDialogFooter` — full-width `flex-col-reverse` (the dialog's already existing pattern), ≥44px                                                                                                |
| **Tablet** | 768       | `sm:max-w-md` (without a plan) / `sm:max-w-2xl` (with derivatives) — a small width jump when the plan appears is acceptable (the content really is different), NOT considered layout jank. The cards stay a card stack (the table turns on only from 640px — a 768px tablet IS already ≥640px, which means at 768px it is already a desktop table, not cards — see the exact breakpoint below) |
| **Laptop** | 1024/1280 | `sm:max-w-2xl`, the desktop table (§4.3.2), 5 columns fit without wrapping                                                                                                                                                                                                                                                                                                                     |
| **Large**  | 1440/1920 | The dialog does NOT stretch beyond `max-w-2xl` — centered, like all the other dialogs of the module                                                                                                                                                                                                                                                                                            |

**The exact card↔table breakpoint:** `sm:` (640px) is the only threshold in the whole file; 768px (tablet)
already gets the desktop table. This is a DELIBERATE decision: 5 columns with short values (amounts,
statuses) fit at 640px without compression worse than a card stack reads at that width — a table is
denser, and density is a CRM priority (`foundation.md` Tone). The only class with a card stack is
purely mobile (320–639).

### 9.2 `TransactionRow` (list)

The new caption «Выплачено X · осталось Y» — rendered on ALL device classes (this is not a layout
element, but an additional line of text inside the already existing amount cell, which on mobile
already participates in the horizontal scroll of the whole table — an existing, separately living compromise,
this task neither widens nor narrows it).

### 9.3 `TransactionDetailDialog` / `SettleSeniorPayoutDialog`

Both already go through the full responsive cycle (`CrmDialogContent` `max-h-[90dvh]`, scroll body). The new
`Row`/summary rows are ordinary block elements inside the already adaptive container, do not require
their own breakpoints.

### 9.4 Verification

Playwright at 320/375/768/1024/1280/1440/1920: no horizontal page overflow
(`document.scrollWidth <= document.documentElement.clientWidth`); at 320px the derivative cards do not
clip the amount text (check the longest realistic value — a 6-digit amount + 4 characters of
currency); switching card↔table at the 640px boundary produces no «hole» (the two layouts are mutually exclusively
`hidden`/visible, not both in the DOM with visual overlap).

---

## 10. Motion

Inherits `foundation.md` §7 — compositor-friendly properties only. The appearance/disappearance of
`CascadeImpactPanel` is NOT animated by layout height (explicitly forbidden by `foundation.md` §7); an
`opacity` fade (150ms ease-out) is allowed on a change of states INSIDE the panel (loading→plan, plan→blocked),
but not mandatory — the cheapest option (no animation, an instant replacement of content) is also acceptable
and requires no new code. The `RotateCcw`/`RefreshCw` icons are static, without a spin animation (spin
is appropriate only for an active in-flight indicator, and the `isFetching` state is already covered by a separate
Skeleton block in §4.2).

---

## 11. Edge-cases

| Case                                                                                                                                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The operator typed a new amount, then erased it back to the original                                                                                     | `shouldPreview` becomes `false` (`amountsDiffer` returns `false`) — the panel unmounts, Save behaves like a regular (non-cascade) edit                                                                                                                                                                                                                                                                              |
| The operator types fast (several digits in a row)                                                                                                        | Debounce 400ms — the request goes out once after a pause in typing, not on every keystroke                                                                                                                                                                                                                                                                                                                          |
| `newAmount === null` (`NO_SHARE_SNAPSHOT`) on the only derivative                                                                                        | The row/card shows «Стало: —» with destructive highlighting, the warning text verbatim, Save is blocked by the §4.4 formula                                                                                                                                                                                                                                                                                         |
| A direct edit of an already rolled-back `PENDING_PAYMENT` derivative (not via a cascade — the status is not `PAID`) with an amount below `settledAmount` | The cascade panel is NOT rendered (`status !== 'PAID'`), but the server will silently apply `floorAmountAtAccumulator`. A minimal edge-fix: if `tx.settledAmount != null && parsedAmount < tx.settledAmount`, show a NON-cascade, simple hint under the amount field (`text-xs text-muted-foreground`): «Сумма не может быть ниже уже выплаченного ({fmtAmount(tx.settledAmount, ...)}) — будет сохранено как есть» |
| The dialog is open, `tx` changes externally (a react-query invalidation after someone else's action)                                                     | Out of scope of this task — the existing `AdminEditTransactionDialog` behavior (the `useEffect` on `tx` refills the form) does not change; a rare case, not solved separately                                                                                                                                                                                                                                       |
| A very long amount (close to `MAX_TRANSACTION_AMOUNT`)                                                                                                   | `tabular-nums`, no `whitespace-nowrap` in card mode (may wrap to a second line — acceptable, `flex justify-between` does not break), `whitespace-nowrap` in table mode (the column is wide enough)                                                                                                                                                                                                                  |
| An empty network response / timeout                                                                                                                      | §4.2 state 2 — «Не удалось загрузить предпросмотр» + «Повторить»                                                                                                                                                                                                                                                                                                                                                    |
| `blockedReason` suddenly arrives `null`, but `editable: false` (should not happen per the contract, but a safeguard)                                     | The fallback text «Правка суммы для этой строки недоступна» — do not crash the render on an unknown `Record` key                                                                                                                                                                                                                                                                                                    |

---

## 12. data-testid — summary table

| Element                                           | `data-testid`                                         |
| ------------------------------------------------- | ----------------------------------------------------- |
| Preview panel (container, all states)             | `cascade-impact-panel`                                |
| Loading state                                     | `cascade-preview-loading`                             |
| Blocked                                           | `cascade-blocked-banner`                              |
| Empty (no cascade)                                | `cascade-preview-empty`                               |
| Plan — the source amount row                      | `cascade-source-amount`                               |
| Derivative (desktop row / mobile card)            | `cascade-derivative-${derivative.id}`                 |
| The «will return to payout pending» badge         | `cascade-derivative-reconfirm-${derivative.id}`       |
| Derivative warning row                            | `cascade-derivative-warning-${derivative.id}-${code}` |
| Stale preview (409)                               | `cascade-stale-banner`                                |
| The «Обновить предпросмотр» button                | `cascade-refresh-preview`                             |
| The «Повторить» button (network error)            | `cascade-preview-retry`                               |
| `TransactionRow` caption «Выплачено/осталось»     | `tx-row-settled-${tx.id}`                             |
| `TransactionDetailDialog` Row «Выплачено»         | `tx-detail-settled`                                   |
| `TransactionDetailDialog` Row «Факт платежа»      | `tx-detail-payment-fact`                              |
| `SettleSeniorPayoutDialog` row «К доплате сейчас» | `settle-senior-remaining`                             |

---

## 13. Instructions for the coder (CRITICAL)

1. **The backend is already in `main`.** `GET /transactions/:id/edit-preview`, `PATCH
:id/admin-edit` with `cascadeVersion`, the whole contract of `packages/shared/src/schemas/edit-cascade.ts` —
   are not written anew, they are imported literally. This task is front-end only.
2. **`amountsDiffer` — import from `@crm/shared`, do not reinvent.** It is THE SAME function by which the
   server decides whether the amount changed (a `toFixed(6)` comparison) — a second copy will immediately diverge
   from the server at the rounding boundary.
3. **Save-gating — strictly the §4.4 formula.** Not «are there warnings» (an overpayment does not block), not
   «`editable === true`» by itself (a plan can be editable, but a specific derivative inside
   will still block apply).
4. **All monetary texts — verbatim from the server** (§4.5). Do not shorten, do not rewrite «for
   brevity» — the messages have already passed `Skill('copywriting')`/security-review on the backend.
5. **`getApiErrorMessage`, not a local check** — replace the existing
   `mutation.error instanceof Error ? ... : null` in `AdminEditTransactionDialog` (see §4.5).
6. **`CascadeImpactPanel` — a new file, do not embed inline in `AdminEditTransactionDialog`.**
   The state logic (§4.2) is voluminous enough that the dialog would otherwise grow to an unreadable size —
   the same principle by which `ReceiptInput`/`FundingSourceFields` are extracted separately.
7. **Derivative row — ONE component with two renders (`hidden sm:table-row` / `sm:hidden`),
   not two separate files.** The data source is shared, the divergence is only in markup — a pattern already
   used in the module (`hidden md:inline-flex` in `TransactionRow.tsx`).
8. **The `SettleSeniorPayoutDialog` fix (§5.3) — not optional cosmetics, a mandatory AC.** Without
   it the summary-card shows a wrong figure before an irreversible monetary action.
9. **`retry: false` on the preview request** (§4.1) — do not remove «for uniformity» with the other
   `useQuery`s in the module; here it has a different role.
10. **The responsive card↔table breakpoint — `sm:` (640px), not `md:` (768px)** (§9.1) — a deliberate
    divergence from the module's general pattern («tablet = card stack» from `foundation.md`), the rationale
    is there too.
11. **`settledAmount`/`settledCurrency` on `TransactionDto` — needed BEFORE this task starts** (§14
    item 1). If the field has not yet been added on the backend, this is a blocker, not «we'll do it later»: without it §5 and
    §4.3.1 («Выплачено») cannot be implemented honestly.

---

## 14. What is missing in the API for a coherent screen

Three findings, each an input for a separate mini-task (backend + `packages/shared`), not solved
by a silent contract change within task 5 (the Coder-frontend cannot implement it themselves —
the `packages/shared`/`apps/api` zone is not theirs).

### 14.1 `TransactionDto` does not carry `settledAmount`/`settledCurrency` (blocks §5 entirely)

**A fact verified in the code.** `transactionSchema`
(`packages/shared/src/schemas/finance.ts`) lists `originalAmount`/`originalCurrency`/
`exchangeRate`, but NOT `settledAmount`/`settledCurrency`/`settledSharePercent` — these three columns
exist in the `transactions` table (added by task 1, PR #599) and are used INSIDE
`loadCascadeSnapshot`/`applyEditCascade`, but `mapTx` (a symbol in `transactions.service.ts`) does not
pass them outward. Since any API response goes through `transactionSchema.parse()`, the field is physically
stripped even if someone accidentally tried to return it.

**Why this blocks specifically task 5, and not just «would be nice».** Requirement #2 of the brief
(«a PENDING row with already paid/to be topped up in the finance list») and the corrective fix §5.3
(`SettleSeniorPayoutDialog`) physically do not read these numbers from anywhere without this field — they cannot be computed
on the front end, they are not derivable from the already exposed fields.

**A proposal (minimal, without discussion — just specifics for the coordinator):**

```ts
// packages/shared/src/schemas/finance.ts, transactionSchema
settledAmount: z.string().nullable().optional(),
settledCurrency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).nullable().optional(),
```

```ts
// apps/api/src/finance/transactions.service.ts, mapTx — next to originalAmount/originalCurrency
settledAmount: tx.settledAmount,
settledCurrency: tx.settledCurrency,
```

**Visibility (RBAC) — a question for the coordinator/security-reviewer, I do not decide myself.** `amount`/`currency`
are already visible to the row's recipient + ADMIN/ACCOUNTANT (the ordinary counterparty masking of `mapTx` does not
touch them — they are not third-party personal data). `settledAmount` is a quantity of the same nature
(«how much of the already visible amount has already been paid»), the same visibility without extra
masking suggests itself, but this is a decision about the RBAC surface, not a designer's — I record it as an open question,
not as a decided fact.

### 14.2 `CascadeDerivativePlan` does not carry a recipient (narrows §4.3.1)

**A fact.** `cascadeDerivativePlanSchema` (`packages/shared/src/schemas/edit-cascade.ts`) contains
`id`/`type`/amounts/warnings — NOT `receiverId`/`receiverName`. The resolver (`resolveDerivative`) is
a pure function without DB access, and `loadCascadeSnapshot` (a symbol, `transactions.service.ts`) loads
only the fields needed for the cascade arithmetic; the recipient is not among them.

**The practical consequence, already reflected in the spec (§4.3.1):** for `SENIOR_PENDING_PAYOUT` the screen
can honestly show the name (reusing the source's `tx.receiverName` — the same person), but for
`DROP_PENDING_PAYOUT` — no, the recipient is shown nameless («Доля дропа»). On a project with BOTH
derivatives at once (senior + drop) this creates a visible asymmetry in the same table — one
row with a name, the other without.

> **STATUS: implemented, 2026-08-24 (UX-1 + UX-7).** `receiverName` (nullable) is added to
> `cascadeDerivativePlanSchema`, filled in `loadCascadeSnapshot` from `receiver.displayName`
> by an explicit allow-list `columns` (not `receiver: true` — otherwise the e-mail and legal name would leave in the response
> body). Both branches — the senior's and the drop's — read it on the screen; the asymmetry described below
> is eliminated. The «Fact» paragraph above describes the state BEFORE this fix and is kept as history.

**Proposal (done):** add `receiverId`/`receiverName` (nullable) to `cascadeDerivativePlanSchema`,
fill them in `getEditCascadePreview` in the same way `mapTx` already resolves `receiver.displayName`
for regular transactions (the join already exists in other service queries — not a new pattern, it is simply that
`loadCascadeSnapshot`'s query does not select it for derivatives today).

### 14.3 Some refusals of `applyEditCascade` are not visible in `GET /edit-preview` (partially lowers §4.4)

**A fact.** Two internal invariants — a mismatch of `transactions.amount` ↔ `settled_amount` on a
company-funded row (addendum §1.2) and a missing `settled_amount` on a legacy row before #599
(addendum §1.14) — are checked ONLY inside `applyEditCascade`, reading `snap.amount`/
`snap.settledAmount` directly, and are NOT expressed by a `CascadeWarning` code in `resolveDerivative`. The pure
resolver (`resolveEditCascade`) that both `GET` and `PATCH` use does not compute these two conditions at all —
so the preview cannot predict them by construction, not only through an oversight.

**Why this is NOT the same class of problem as 14.1/14.2 (I do not require a fix).** Both cases, per
the addendum's architectural analysis, are **empty in production today** («by theorem», not «for lack of
data to check»): the first requires a row edited BEFORE task 0 (#598), the second — a
settle BEFORE task 1 (#599). Adding a warning code for a population that is empty by construction is
exactly the anti-pattern that the task's own architecture explicitly forbids («do not make the cascade recursive just in case», AC5 item 8 of the main ADR — the same argument, a different place). The spec handles
this rare case honestly (§4.4 — «handled not by a preventive UI ban, but by displaying
the server's error text on submit»), rather than by silence — Save in this extreme case may return
400 even AFTER passing the client-side check, and this is **correct, expected** behavior of the system,
not a gap in this spec.

---

## 15. Fidelity references (for Mode B after implementation)

`design-gate: degraded` — a headless session without Claude Design/a browser, `design.png` is not created.
The Mode B fidelity audit after implementation is checked against:

1. **This spec in full** — the §4.2 states, the §4.4 Save-gating formula, the three surfaces of §5.
2. **Existing reference components without changing their visual language:**
   the `admin-income-obligation-preview` banner (`CreateTransactionDialog.tsx`) — the visual standard for
   §4.7 «empty»; the summary-card (`SettleSeniorPayoutDialog.tsx`) — the standard for §4.3.3/§5.3;
   the conversion-hint skeleton (`AmountCurrencyInput.tsx`) — the standard for §4.2 loading; the «Транзакцию
   нельзя редактировать» banner (`AdminEditTransactionDialog.tsx`, current) — the standard for §4.6.
3. **The §9 responsive table at all test widths** (320/375/768/1024/1280/1440/1920) — special
   attention: the card↔table breakpoint at 640px (NOT 768px — a deliberate divergence from
   `foundation.md`'s general pattern, see §9.1), no horizontal overflow at 320px.
4. **Save-gating live:** on a fixture with `NO_SHARE_SNAPSHOT`/`OBLIGATION_CURRENCY_MISMATCH`/
   a blocking `NON_USDT_CURRENCY`+`needsReconfirm` — the «Сохранить» button is really `disabled`, not
   merely visually muted by a CSS oversight.

---

## 15. Assumptions — rounds 6-7 (decisions made on the record)

All four were caused by findings of manual QA and security-review on live data; none was in
the original assignment.

- **The derivative contract is extended with the `recomputedShare` field** (QA-H-1). The alternative — «just
  clamp `newAmount` by the floor» — was not considered sufficient: the floor **destroys** the raw share,
  and three places consume it (the `OVERPAYMENT` text, the overpayment predicate, the `newShare`/`overpaidBy`
  fields in the `CASCADE_OVERPAYMENT` journal). The form is forced by the nature of the information.
  _Incidentally, for the record:_ the original rationale for this decision in a comment claimed that
  the single-quantity variant would break the journal **silently**. This is incorrect and was refuted
  by an **experiment** (security-review): simulating the single-quantity fix breaks **four**
  pre-existing tests — one in `@crm/shared` (the overpayment warning stops
  firing: `expected [] to deeply equal [{ code: 'OVERPAYMENT' }]`) and three in `@crm/api`
  (the `CASCADE_OVERPAYMENT` journal assertions). It fails loudly, not silently. The handle is given
  deliberately: without it the claim about four tests cannot be re-verified without repeating the
  whole experiment — which, for a record that lives for months, amounts to a conclusion without a verification condition.
  Three independent traces of the
  code (the coder, code-review, spec-review) gave the same wrong answer, because all three
  checked the comparison logic, not the system's behavior. The comment was rewritten to the real reason.

- **The `OVERPAYMENT` text is branched by the obligation state** (QA-H-1, the second layer) — see §6.

- **The floor on write and the floor in the resolver are reduced to ONE predicate** (SR-M-3). The write floored
  unconditionally, while the resolver skips the floor when the accumulator is incomparable with the share being written
  (`max()` over 260 USD and a share of 26 USDT is not a larger number, but a meaningless one). Two similar predicates
  diverged on exactly one population — an open obligation with an accumulator in another currency:
  the plan showed 26, the row would have accepted 260. Now both sides call `settledCurrencyMismatch`,
  the same exported function on the same values: there is nothing to diverge.

  **What was deliberately NOT done here:** this population deliberately passes Phase 1. AC15 refuses
  a **rollback** that could not later be closed; on an open obligation no rollback happens,
  and an ordinary **increase** of such a row's amount is written and must continue to be written.
  The first version of the fix widened the Phase 1 refusal — and was caught by an existing test that
  formulates this carve-out in words. The fix went where the divergence lives, not where
  it was easiest to forbid it.

- **The settlement button at a zero remainder — «Закрыть без доплаты»** instead of «Отметить как оплачено».
  Attribution: **owner decision via the orchestrator**, after QA reached the state live
  (the button works, the obligation closes, the balance does not move) and both axes — design and QA —
  independently noted that the caption promises a money transfer that will not happen.
