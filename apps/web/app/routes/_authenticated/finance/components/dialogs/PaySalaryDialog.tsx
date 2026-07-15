import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { financeApi } from '../../api'
import { fmtAmount, fmtDate } from '../../constants'
import { FundingSourceFields, COMPANY_ACCOUNT_VALUE, type Currency } from './FundingSourceFields'
import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

export function PaySalaryDialog({
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
  // task-receipts-frontend: replaces the old optional "TX Hash" text input
  // (design-spec §2.3) — proof of payment is now the mandatory ReceiptInput,
  // explorer-only when the effective currency is USDT.
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const isCompany = account === COMPANY_ACCOUNT_VALUE

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
    setCurrency('USDT')
    setReceipt(emptyReceiptState())
    setReceiptError(null)
    setNotes('')
  }

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // task-salary-pay-flow: the funding source + currency are chosen HERE.
      //   - «Счёт компании» → COMPANY_ACCOUNT, currency forced USDT (the account
      //     is USDT-only; the backend re-forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner, the
      //     chosen currency (any) is used.
      return financeApi.paySalary(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
        currency: isCompany ? 'USDT' : currency,
        receiptDocumentId,
        receiptExternalUrl,
        notes: notes || null,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // A company-funded payout debits the company account → refresh its balance.
      if (isCompany) void qc.invalidateQueries({ queryKey: ['company-account'] })
      onClose()
      resetState()
    },
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

  // task-receipts-frontend: client-side gate (mirrors CreateTransactionDialog) —
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
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="pay-salary-dialog">
        <CrmDialogHeader>
          <DialogTitle>Выплатить зарплату</DialogTitle>
          <DialogDescription className="sr-only">Выплата зарплаты</DialogDescription>
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
            {tx.salaryMonth && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Месяц</span>
                <span className="font-medium">{tx.salaryMonth}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Дата</span>
              <span className="font-medium">{fmtDate(tx.createdAt)}</span>
            </div>
          </div>

          {/* task-senior-settle-owner: account + currency selection is the shared
          FundingSourceFields (same UI as SettleSeniorPayoutDialog). The parent
          owns the funding semantics (COMPANY_ACCOUNT → USDT forced; ADMIN_PERSONAL
          → payerAdminId = the selected partner). */}
          <FundingSourceFields
            account={account}
            currency={currency}
            onSelectAccount={selectAccount}
            onSelectCurrency={setCurrency}
            enabled={!!tx}
            testIdPrefix="pay-salary"
          />

          {/* task-receipts-frontend: mandatory proof of payment (design-spec §3.2),
              replaces the old optional TX Hash text field. Explorer-only when
              the effective currency is USDT (COMPANY_ACCOUNT always forces it;
              ADMIN_PERSONAL defaults to USDT until the currency is switched). */}
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
              <p className="text-[11px] text-destructive" data-testid="pay-salary-error-receipt">
                {receiptError}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Заметки</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Дополнительная информация..."
              rows={2}
              className="text-sm resize-none"
              data-testid="pay-salary-notes"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive" data-testid="pay-salary-error">
              {error}
            </p>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="pay-salary-cancel">
            Отмена
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="pay-salary-submit"
          >
            {mutation.isPending ? 'Оплата...' : 'Отметить как оплачено'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
