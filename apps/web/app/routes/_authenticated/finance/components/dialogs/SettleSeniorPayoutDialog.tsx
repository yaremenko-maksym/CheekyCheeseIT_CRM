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
 * company account vs an admin partner's personal account) + the currency.
 *
 *   - «Счёт компании» (default) → COMPANY_ACCOUNT, currency forced USDT. The
 *     backend debits the company account (advisory lock + balance gate) and the
 *     closing SENIOR_INCOME carries fundingSource=COMPANY_ACCOUNT.
 *   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner; any
 *     currency. The company account is NOT touched.
 *
 * Mirrors PaySalaryDialog (shares FundingSourceFields). The settle body is just
 * the funding choice — the obligation/amount live server-side, resolved by the
 * source (SENIOR_PENDING_PAYOUT) transaction id.
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
  const [currency, setCurrency] = useState<Currency>('USDT')
  // task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
  // this dialog had NO receipt/hash field at all before; explorer-only when
  // the effective currency is USDT (COMPANY_ACCOUNT always forces it).
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
    setCurrency('USDT')
    setReceipt(emptyReceiptState())
    setReceiptError(null)
  }

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // The funding source + currency are chosen HERE (mirrors PaySalaryDialog):
      //   - «Счёт компании» → COMPANY_ACCOUNT, currency forced USDT (the account
      //     is USDT-only; the backend re-forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner, the
      //     chosen currency (any) is used; the company account is untouched.
      return financeApi.settleSeniorPayoutFromTransaction(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
        currency: isCompany ? 'USDT' : currency,
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

  // Select the account: when switching to «Счёт компании» the currency is locked
  // to USDT; switching to a partner restores an editable currency.
  function selectAccount(value: string) {
    setAccount(value)
    if (value === COMPANY_ACCOUNT_VALUE) setCurrency('USDT')
  }

  // task-receipts-frontend: client-side gate (mirrors PaySalaryDialog) —
  // blocks mutation.mutate() when the receipt is missing/invalid, delegating
  // the rule to the SAME shared function the backend refine uses.
  function handleSubmit() {
    const effectiveCurrency = isCompany ? 'USDT' : currency
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

          {/* Shared funding-source picker — same UI as PaySalaryDialog, but the
              currency options are narrowed to USDT/USD: the backend rejects
              closing a USDT obligation in EUR/UAH without conversion (see
              pending-settlement.service.ts). */}
          <FundingSourceFields
            account={account}
            currency={currency}
            onSelectAccount={selectAccount}
            onSelectCurrency={setCurrency}
            enabled={!!tx}
            testIdPrefix="settle-senior"
            allowedCurrencies={['USDT', 'USD']}
          />

          {/* task-receipts-frontend: mandatory proof of payment (design-spec §3.3) —
              this dialog had no receipt/hash field before. Explorer-only when the
              effective currency is USDT (COMPANY_ACCOUNT always forces it). */}
          <div className="space-y-1.5">
            <ReceiptInput
              state={receipt}
              onChange={(s) => {
                setReceipt(s)
                setReceiptError(null)
              }}
              label="Чек / подтверждение *"
              explorerOnly={currency === 'USDT'}
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
