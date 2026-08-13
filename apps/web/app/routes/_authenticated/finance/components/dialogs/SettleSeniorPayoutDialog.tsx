import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { receiptMandatoryError } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { api } from '@/lib/axios'
import { financeApi } from '../../api'
import { fmtAmount, fmtDate, convertAmount, type ExchangeRates } from '../../constants'
import { FundingSourceFields, COMPANY_ACCOUNT_VALUE, type Currency } from './FundingSourceFields'
import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

// Local copy of the finance-page error extractor (same shape used in
// finance/index.tsx + PayoutDetailDialog — the repo keeps per-file copies; no
// shared module exists yet). Surfaces the backend's BadRequest message (e.g.
// «Недостаточно средств на счёте компании…») in the toast.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { message?: unknown } } }).response
    const msg = resp?.data?.message
    if (typeof msg === 'string') return msg
    if (Array.isArray(msg)) return msg.join(', ')
  }
  if (err instanceof Error) return err.message
  return 'Неизвестная ошибка'
}

/**
 * task-senior-settle-owner: pay a senior IOU (SENIOR_PENDING_PAYOUT row) using
 * the SAME funding selection as a SALARY. ADMIN/ACCOUNTANT opens this from the
 * row «Выплатить» button and chooses which account funds the payout (the shared
 * company account vs an admin partner's personal account).
 *
 *   - «Счёт компании» (default) → COMPANY_ACCOUNT. The backend debits the
 *     company account (advisory lock + balance gate) and the closing
 *     SENIOR_INCOME carries fundingSource=COMPANY_ACCOUNT.
 *   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner. The
 *     company account is NOT touched.
 *
 * task-remove-settle-currency (2026-07): a SENIOR settle still has no currency
 * choice — every senior obligation is denominated in USDT (see
 * transactions.service.ts createIous) and the label was purely cosmetic
 * (USD/USDT are treated 1:1 downstream). The backend defaults the funding
 * currency to the obligation's own currency when the payload omits one (see
 * pending-settlement.service.ts), so the SENIOR branch of this dialog simply
 * never sends it.
 *
 * task-drop-payout-currency (2026-08): a DROP settle IS different — the owner
 * asked for the payout to be settleable in any of USDT/USD/UAH/EUR. The
 * amount field stays fully DISABLED (it only shows the server-computed
 * conversion — there is nothing to type), but the currency `<Select>` is
 * active for that branch. See the amount-conversion block in
 * `pending-settlement.service.ts`'s `settleByCompany` for how the actual
 * figure is derived — never client-supplied, there is nothing to trust or
 * distrust with the field disabled.
 *
 * Mirrors PaySalaryDialog (shares FundingSourceFields, with `hideCurrency` —
 * both dialogs keep FundingSourceFields' OWN currency Select hidden and use
 * their own `AmountCurrencyInput` block instead, same as PaySalaryDialog).
 * The settle body is just the funding choice (+ currency for a DROP settle)
 * — the obligation/amount live server-side, resolved by the source
 * (SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT) transaction id.
 *
 * settle-drop-btn: this dialog is REUSED as-is for DROP_PENDING_PAYOUT rows —
 * the backend settle-company cascade is generic (ADR D5, branches on the source
 * transaction's type), so only the recipient-facing copy (title / description /
 * success toast) AND the currency picker (drop-only, see above) adapt to
 * «дропу» below. Everything else (funding picker, mutation, invalidations)
 * is identical for both row types.
 *
 * security-review PR #443 (HIGH-1 / MED-B / MED-1 round 4): a
 * DROP_PENDING_PAYOUT row booked by the drop-payout CASCADE
 * (`tx.dropCascadeOrigin !== false` — task-drop-share-pending-parity) never
 * had its share land on the shared company account (the cascade only
 * credits `payable = income*(1-dropShare%)`; the drop keeps their own cut
 * before the on-chain transfer). «Счёт компании» would silently debit money
 * the company never held. The server is the authority (see the HIGH-1/MED-B
 * guard in pending-settlement.service.ts's settleByCompany — it rejects this
 * with a 400 regardless of what the UI does); this dialog mirrors that
 * decision so an ADMIN/ACCOUNTANT never even reaches the rejected request:
 * for such a row the «Счёт компании» option is disabled and the default
 * account is empty (forces an explicit ADMIN-partner pick, not a guessed
 * one). A drop obligation booked by declareUsdtProjectIncome
 * (`dropCascadeOrigin === false`) is unaffected — `false` marks it as
 * non-cascade, not as a guarantee the company account holds the money (a
 * declaration can also route to a specific admin's personal wallet; see the
 * column comment in schema.ts, corrected round 5). Which pot actually pays
 * is the ADMIN/ACCOUNTANT's own funding-source choice below.
 *
 * MED-1 (round 4): reads `tx.dropCascadeOrigin` — the SAME marker
 * `settleByCompany` authoritatively reads — NOT `tx.payoutRequestId`. The two
 * can diverge (a FK-nulled cascade row, or — before the HIGH-1/round-4 data
 * backfill — a pre-existing admin-declared row that had no marker yet), and
 * `payoutRequestId` was only ever an approximation of the server's real
 * signal. `!== false` mirrors the server's exact fail-safe polarity: `null`
 * (unstamped/unknown) is treated the SAME as `true` (block) — only an
 * EXPLICIT `false` is treated as verified-safe.
 */
export function SettleSeniorPayoutDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // account = COMPANY_ACCOUNT_VALUE (Счёт компании, default) OR an ADMIN
  // partner id OR '' (no valid selection — forced for a cascade-originated
  // drop obligation, see the HIGH-1 note above; the accountant must actively
  // pick an admin partner, never guessed).
  const [account, setAccount] = useState<string>(COMPANY_ACCOUNT_VALUE)
  // task-drop-payout-currency: the DROP payout's currency (SENIOR unaffected
  // — its `<AmountCurrencyInput>` block never renders, see below). Defaults
  // to the obligation's own currency (see the reset effect keyed on tx.id).
  // Stryker disable next-line StringLiteral: this literal is unobservable — the reset effect below (keyed on tx?.id) synchronously overwrites it to tx.currency on EVERY mount before any render is visible to a consumer/test (the dialog never renders without a tx); see the identical reasoning at resetState's `setCurrency('USDT')`
  const [currency, setCurrency] = useState<Currency>('USDT')
  // task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
  // this dialog had NO receipt/hash field at all before; explorer-only while
  // the effective currency is USDT (always true for SENIOR — a settle
  // obligation stays USDT there, task-remove-settle-currency — and true for
  // the DROP default before the owner switches currency).
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)

  const isCompany = account === COMPANY_ACCOUNT_VALUE
  // settle-drop-btn: only the copy below depends on this — the mutation body /
  // funding logic is identical for both SENIOR_PENDING_PAYOUT and
  // DROP_PENDING_PAYOUT source rows.
  const isDropPayout = tx?.type === 'DROP_PENDING_PAYOUT'
  // task-drop-payout-currency: «Счёт компании» is a USDT-only account (the
  // backend re-forces this) — mirrors PaySalaryDialog's `effectiveCurrency`.
  // Meaningless for a SENIOR settle (no currency picker renders there), but
  // harmless to compute unconditionally.
  const effectiveCurrency: Currency = isCompany ? 'USDT' : currency
  // HIGH-1 / MED-1 (round 4): cascade-originated (or unknown-origin) drop
  // obligation — `dropCascadeOrigin !== false` is the EXACT discriminator
  // the server reads (resolveSource / settleByCompany), not an
  // approximation. declareUsdtProjectIncome-booked drop IOUs carry
  // dropCascadeOrigin=false (explicit) and are unaffected.
  const isCascadeDropObligation = isDropPayout && tx?.dropCascadeOrigin !== false
  const companyAccountDisabledReason = isCascadeDropObligation
    ? 'Доля дропа из этой выплаты не проходила через счёт компании — выберите личный счёт админа'
    : undefined
  const dialogTitle = isDropPayout ? 'Выплатить дропу' : 'Выплатить синьору'
  const dialogDescription = isDropPayout ? 'Выплата дропу его доли' : 'Выплата синьору его доли'
  const successMessage = isDropPayout ? 'Выплата дропу проведена' : 'Выплата синьору проведена'

  // task-drop-payout-currency: same query key `AmountCurrencyInput` uses
  // internally (calendar-day scoped) — ONE shared cache entry, not a second
  // request, exactly mirroring PaySalaryDialog. Only fetched for a DROP
  // payout (a SENIOR settle never shows the currency-conversion field).
  //
  // LOW (security-review PR #521 round 1, accepted as-is): `todayKey` is
  // captured once per render, not re-derived on a timer — a tab left open
  // across midnight keeps showing yesterday's cached rate until the NEXT
  // re-render happens to recompute it, so the DISPLAYED figure can disagree
  // with what the server will actually compute at submit time. This is a
  // pre-existing pattern shared with `PaySalaryDialog`/`AmountCurrencyInput`
  // (identical `todayKey`/`staleTime` shape, not introduced by this task) and
  // it is NOT a money-integrity gap: unlike the amount, the server NEVER
  // trusts a client-supplied figure here (the field is disabled — there is
  // nothing to trust) and always recomputes from its own fresh
  // `NbuCurrencyService.getRates()` call at settle time. The worst case is a
  // stale on-screen preview corrected the moment the mutation resolves —
  // not a wrong payout. Fixing the display-side day-rollover would mean
  // reworking the shared cache-key convention across all three call sites,
  // out of proportion for a cosmetic staleness window; left as a known,
  // scoped, low-severity gap rather than a silent one.
  const todayKey = new Date().toISOString().slice(0, 10)
  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', todayKey],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    // Stryker disable next-line ArithmeticOperator: cache-freshness WINDOW (24h) — affects only whether a background refetch happens after a long-idle tab, not any single-render output a unit test observes; same untested-by-design shape as the identical literal in PaySalaryDialog.tsx and amount-currency-input.tsx (pre-existing, not part of this diff)
    staleTime: 1000 * 60 * 60 * 24,
    enabled: !!tx && isDropPayout,
  })

  // The obligation, re-expressed in the currency being paid. `null` while the
  // rates are loading (or unusable) — the amount field then stays empty
  // instead of showing a confidently wrong number. Equal to the obligation
  // amount, unconverted, when `effectiveCurrency` is the obligation's own
  // currency (AC2 — no recalculation when the currency is unchanged).
  const expectedAmount = useMemo(() => {
    if (!tx) return null
    return convertAmount(tx.amount, tx.currency, effectiveCurrency, rates)
  }, [tx, effectiveCurrency, rates])

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
    // Stryker disable next-line StringLiteral: unobservable for the SAME reason as the useState default above — resetState only ever runs right before onClose (tx→null, nothing renders) or right before a NEW tx mounts/rerenders in, and in EITHER case the mount-sync effect (keyed on tx?.id) overwrites this value before any consumer can read it
    setCurrency('USDT')
    setReceipt(emptyReceiptState())
    setReceiptError(null)
    setAccountError(null)
  }

  // HIGH-1: when the dialog opens for a NEW cascade-originated drop
  // obligation, force the default OFF «Счёт компании» — an explicit admin
  // pick is required (see the docstring above for why an auto-picked admin
  // partner would be worse than forcing the choice).
  // Deliberately keyed on tx identity only (isCascadeDropObligation is itself
  // derived from tx, so it is intentionally omitted) — re-running per new tx
  // is correct; re-running on every render would fight the user's own pick.
  useEffect(() => {
    if (tx && isCascadeDropObligation) {
      setAccount('')
    }
  }, [tx?.id])

  // task-drop-payout-currency (AC2 default): every time the dialog opens for
  // a NEW tx, the currency picker starts at the OBLIGATION's own currency —
  // «по умолчанию — валюта обязательства», never a stale pick left over from
  // a previously settled row.
  useEffect(() => {
    if (tx) setCurrency(tx.currency as Currency)
  }, [tx?.id])

  // Select the account: when switching to «Счёт компании» the currency is
  // locked to USDT (mirrors PaySalaryDialog's `selectAccount`) — a no-op for
  // a SENIOR settle (no currency picker there).
  function selectAccount(value: string) {
    setAccount(value)
    setAccountError(null)
    if (value === COMPANY_ACCOUNT_VALUE) setCurrency('USDT')
  }

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // The funding source is chosen HERE (mirrors PaySalaryDialog):
      //   - «Счёт компании» → COMPANY_ACCOUNT (the account is USDT-only; the
      //     backend forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner; the
      //     company account is untouched.
      // task-remove-settle-currency: a SENIOR settle sends no `currency` field
      // — the backend defaults it to the obligation's own currency (USDT).
      // task-drop-payout-currency: a DROP settle DOES send one — the amount
      // that lands on the row is computed server-side from it (never trusted
      // from the client; the field above is fully disabled, so there is
      // nothing to trust in the first place).
      return financeApi.settleSeniorPayoutFromTransaction(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
        ...(isDropPayout ? { currency: effectiveCurrency } : {}),
        receiptDocumentId,
        receiptExternalUrl,
      })
    },
    onSuccess: () => {
      toast.success(successMessage)
      // Invalidate everything the settlement touches: the transactions list (the
      // row flips + a new SENIOR_INCOME appears), profile feeds, the
      // company-account balance / summary, and the auto-generated invoice list.
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['profile-transactions'] })
      void qc.invalidateQueries({ queryKey: ['pending-obligations'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // Only a company-funded settlement debits the company account.
      if (isCompany) void qc.invalidateQueries({ queryKey: ['company-account'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      onClose()
      resetState()
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  function handleClose() {
    onClose()
    resetState()
  }

  // task-receipts-frontend: client-side gate (mirrors PaySalaryDialog) —
  // blocks mutation.mutate() when the receipt is missing/invalid, delegating
  // the rule to the SAME shared function the backend refine uses.
  // task-remove-settle-currency / task-drop-payout-currency: `effectiveCurrency`
  // is always USDT for a SENIOR settle (matches the backend default), and
  // whatever the owner picked for a DROP settle.
  // HIGH-1: additionally blocks submit when no valid account is selected yet
  // (empty string — the forced-off default for a cascade-drop obligation) or,
  // defensively, if `isCompany` were somehow still true for one (the button
  // is disabled in the UI, but this is the same belt-and-suspenders pattern
  // as the receipt gate — never trust only the disabled attribute).
  function handleSubmit() {
    if (isCascadeDropObligation && (!account || isCompany)) {
      setAccountError(
        companyAccountDisabledReason ?? 'Выберите личный счёт админа для этой выплаты',
      )
      return
    }
    const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
    const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
    const err = receiptMandatoryError({ receiptDocumentId, receiptExternalUrl }, effectiveCurrency)
    if (err) {
      setReceiptError(err)
      return
    }
    mutation.mutate()
  }

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="settle-senior-dialog">
        <CrmDialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription className="sr-only">{dialogDescription}</DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
            {tx.receiverName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Получатель</span>
                <span className="font-medium">{tx.receiverName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сумма</span>
              <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
            </div>
            {tx.projectName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Проект</span>
                <span className="font-medium">{tx.projectName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Дата</span>
              <span className="font-medium">{fmtDate(tx.createdAt)}</span>
            </div>
          </div>

          {/* Shared funding-source picker — same UI as PaySalaryDialog, with its
              own currency Select hidden: a SENIOR settle has nothing to pick
              (task-remove-settle-currency); a DROP settle's currency picker
              lives in the AmountCurrencyInput block below instead (mirrors
              PaySalaryDialog — amount and currency sit together). */}
          <FundingSourceFields
            account={account}
            onSelectAccount={selectAccount}
            enabled={!!tx}
            testIdPrefix="settle-senior"
            hideCurrency
            disableCompanyAccount={isCascadeDropObligation}
            disableCompanyAccountReason={companyAccountDisabledReason}
          />
          {accountError && (
            <p className="text-xs text-destructive" data-testid="settle-senior-error-account">
              {accountError}
            </p>
          )}

          {/* task-drop-payout-currency (AC1). DROP-only: the currency the payout
              is settled in is a real choice (USDT/USD/UAH/EUR), but the amount
              input is fully DISABLED — it only shows the server-recalculated
              figure for the chosen currency, never accepts typed input (owner
              decision: «задизейбли полностью инпут и оставь только возможность
              переключать валюту»). Recalculates live on every currency change
              (AC2); no client-typed amount is ever sent (see the mutationFn
              above). */}
          {isDropPayout && (
            <div data-testid="settle-senior-amount-field">
              <AmountCurrencyInput
                amount={expectedAmount !== null ? expectedAmount.toFixed(2) : ''}
                currency={effectiveCurrency}
                onAmountChange={() => {}}
                onCurrencyChange={setCurrency}
                label="Сумма выплаты"
                disableAmount
                disableCurrency={isCompany}
                errorTestId="settle-senior-amount-error"
              />
            </div>
          )}

          {/* task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
              this dialog had no receipt/hash field before. Explorer-only while
              the effective currency is USDT — always true for a SENIOR settle
              (task-remove-settle-currency); true for a DROP settle until the
              owner switches away from the obligation's own currency. */}
          <div className="space-y-1.5">
            <ReceiptInput
              state={receipt}
              onChange={(s) => {
                setReceipt(s)
                setReceiptError(null)
              }}
              label="Чек / подтверждение *"
              explorerOnly={effectiveCurrency === 'USDT'}
              error={receiptError ?? undefined}
            />
            {receiptError && (
              <p className="text-[11px] text-destructive" data-testid="settle-senior-error-receipt">
                {receiptError}
              </p>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive" data-testid="settle-senior-error">
              {error}
            </p>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="settle-senior-cancel">
            Отмена
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="settle-senior-submit"
            data-track="settle-senior-payout"
          >
            {mutation.isPending ? 'Оплата...' : 'Отметить как оплачено'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
