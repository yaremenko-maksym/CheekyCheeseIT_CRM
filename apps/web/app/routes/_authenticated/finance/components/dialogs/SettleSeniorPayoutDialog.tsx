import { useState } from 'react'
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
 */
export function SettleSeniorPayoutDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // account = COMPANY_ACCOUNT_VALUE (Счёт компании, default) OR an ADMIN partner id.
  const [account, setAccount] = useState<string>(COMPANY_ACCOUNT_VALUE)
  // task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
  // this dialog had NO receipt/hash field at all before; explorer-only since
  // a settle obligation is always denominated in USDT (task-remove-settle-currency).
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [receiptError, setReceiptError] = useState<string | null>(null)

  const isCompany = account === COMPANY_ACCOUNT_VALUE
  // settle-drop-btn: only the copy below depends on this — the mutation body /
  // funding logic is identical for both SENIOR_PENDING_PAYOUT and
  // DROP_PENDING_PAYOUT source rows.
  const isDropPayout = tx?.type === 'DROP_PENDING_PAYOUT'
  const dialogTitle = isDropPayout ? 'Выплатить дропу' : 'Выплатить синьору'
  const dialogDescription = isDropPayout ? 'Выплата дропу его доли' : 'Выплата синьору его доли'
  const successMessage = isDropPayout ? 'Выплата дропу проведена' : 'Выплата синьору проведена'

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
    setReceipt(emptyReceiptState())
    setReceiptError(null)
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
  function handleSubmit() {
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
            onSelectAccount={setAccount}
            enabled={!!tx}
            testIdPrefix="settle-senior"
            hideCurrency
          />

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
          >
            {mutation.isPending ? 'Оплата...' : 'Отметить как оплачено'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
