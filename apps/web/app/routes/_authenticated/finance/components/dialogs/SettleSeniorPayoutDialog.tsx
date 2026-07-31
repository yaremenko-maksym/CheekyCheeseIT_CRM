import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { financeApi } from '../../api'
import { fmtAmount, fmtDate } from '../../constants'
import { FundingSourceFields, COMPANY_ACCOUNT_VALUE } from './FundingSourceFields'
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
 * task-remove-settle-currency (2026-07): there is no currency choice — every
 * senior/drop obligation is denominated in USDT (see transactions.service.ts
 * createIous) and the label was purely cosmetic (USD/USDT are treated 1:1
 * downstream). The backend now defaults the funding currency to the
 * obligation's own currency when the payload omits one (see
 * pending-settlement.service.ts), so this dialog simply never sends it.
 *
 * Mirrors PaySalaryDialog (shares FundingSourceFields, with `hideCurrency` —
 * PaySalaryDialog still lets the caller pick a currency, that IS legitimate
 * for a salary payout). The settle body is just the funding choice — the
 * obligation/amount live server-side, resolved by the source
 * (SENIOR_PENDING_PAYOUT) transaction id.
 *
 * settle-drop-btn: this dialog is REUSED as-is for DROP_PENDING_PAYOUT rows —
 * the backend settle-company cascade is generic (ADR D5, branches on the source
 * transaction's type), so only the recipient-facing copy (title / description /
 * success toast) adapts to «дропу» below. Everything else (funding picker,
 * mutation, invalidations) is identical for both row types.
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
  // task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
  // this dialog had NO receipt/hash field at all before; explorer-only since
  // a settle obligation is always denominated in USDT (task-remove-settle-currency).
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)

  const isCompany = account === COMPANY_ACCOUNT_VALUE
  // settle-drop-btn: only the copy below depends on this — the mutation body /
  // funding logic is identical for both SENIOR_PENDING_PAYOUT and
  // DROP_PENDING_PAYOUT source rows.
  const isDropPayout = tx?.type === 'DROP_PENDING_PAYOUT'
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

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
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

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // The funding source is chosen HERE (mirrors PaySalaryDialog):
      //   - «Счёт компании» → COMPANY_ACCOUNT (the account is USDT-only; the
      //     backend forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner; the
      //     company account is untouched.
      // task-remove-settle-currency: no `currency` field — the backend
      // defaults it to the obligation's own currency (always USDT).
      return financeApi.settleSeniorPayoutFromTransaction(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
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
  // task-remove-settle-currency: the effective currency is always USDT — a
  // settle obligation is never denominated in anything else (matches the
  // backend default in pending-settlement.service.ts).
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
    const err = receiptMandatoryError({ receiptDocumentId, receiptExternalUrl }, 'USDT')
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

          {/* Shared funding-source picker — same UI as PaySalaryDialog, minus the
              currency Select (task-remove-settle-currency: a settle obligation
              is always USDT — see pending-settlement.service.ts). */}
          <FundingSourceFields
            account={account}
            onSelectAccount={(v) => {
              setAccount(v)
              setAccountError(null)
            }}
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

          {/* task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
              this dialog had no receipt/hash field before. Always explorer-only —
              a settle obligation is always denominated in USDT
              (task-remove-settle-currency). */}
          <div className="space-y-1.5">
            <ReceiptInput
              state={receipt}
              onChange={(s) => {
                setReceipt(s)
                setReceiptError(null)
              }}
              label="Чек / подтверждение *"
              explorerOnly
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
