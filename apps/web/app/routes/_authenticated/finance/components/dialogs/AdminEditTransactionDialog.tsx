import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { cn, parseStrictAmount } from '@/lib/utils'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { financeApi } from '../../api'
import { EXPENSE_CATEGORIES, TYPE_LABELS, fmtAmount } from '../../constants'
import {
  ReceiptInput,
  receiptStateFromDocument,
  receiptStateFromExternalUrl,
  type ReceiptState,
} from '../ReceiptInput'

type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'

const EDITABLE_TYPES = ['ADMIN_INCOME', 'SENIOR_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']

export function AdminEditTransactionDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()

  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [notes, setNotes] = useState('')
  const [receipt, setReceipt] = useState<ReceiptState>(receiptStateFromExternalUrl(null))
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]!)
  const [salaryMonth, setSalaryMonth] = useState('')

  useEffect(() => {
    if (!tx) return
    setAmount(parseFloat(tx.amount).toString())
    setCurrency(tx.currency as Currency)
    setNotes(tx.notes ?? '')
    if (tx.receiptDocumentId) {
      setReceipt(receiptStateFromDocument(tx.receiptDocumentId))
    } else {
      setReceipt(receiptStateFromExternalUrl(tx.receiptExternalUrl))
    }
    setCategory(tx.receiverLabel ?? EXPENSE_CATEGORIES[0]!)
    setSalaryMonth(tx.salaryMonth ?? '')
  }, [tx])

  const mutation = useMutation({
    mutationFn: () => {
      const amt = parseStrictAmount(amount)
      if (isNaN(amt) || amt <= 0) throw new Error('Некорректная сумма')
      const nextReceiptDocId = receipt.mode === 'file' ? receipt.documentId : null
      const nextReceiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // fix/external-receipt-rendering round 2 (security-review PR #470 MED-2):
      // the form pre-fills the tx's EXISTING receipt (see the effect above)
      // even when the user is only editing amount/notes. Resending an
      // untouched value unconditionally used to be harmless, but the write
      // schema is now https-only — an untouched legacy `http://` receipt
      // would 400 on a save the user never asked to change. Omit the receipt
      // fields entirely when nothing changed; the API treats an absent field
      // as "leave unchanged" (see `adminUpdateTransaction`'s
      // `receiptDocChanged`/`receiptUrlChanged` gates), so this never touches
      // validation for a field the user didn't look at.
      const receiptUnchanged =
        nextReceiptDocId === (tx?.receiptDocumentId ?? null) &&
        nextReceiptExternalUrl === (tx?.receiptExternalUrl ?? null)
      return financeApi.adminUpdateTransaction(tx!.id, {
        amount: amt,
        currency,
        notes: notes || null,
        ...(!receiptUnchanged && {
          receiptDocumentId: nextReceiptDocId,
          receiptExternalUrl: nextReceiptExternalUrl,
        }),
        ...(tx?.type === 'EXPENSE' && { category }),
        ...(tx?.type === 'SALARY' && salaryMonth && { salaryMonth }),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      onClose()
    },
  })

  const error = mutation.error instanceof Error ? mutation.error.message : null
  const isEditable = tx && EDITABLE_TYPES.includes(tx.type) && !tx.payoutRequestId

  return (
    <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogDescription className="sr-only">Редактирование транзакции</DialogDescription>
          <DialogTitle className="text-base">
            Редактировать транзакцию
            {tx && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {TYPE_LABELS[tx.type]} · {fmtAmount(tx.amount, tx.currency)}
              </span>
            )}
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          {!isEditable && tx ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Транзакцию нельзя редактировать (PAYOUT или привязана к запросу выплаты)
            </div>
          ) : (
            <div className="space-y-4">
              {/* Amount + Currency */}
              <AmountCurrencyInput
                amount={amount}
                currency={currency}
                onAmountChange={setAmount}
                onCurrencyChange={setCurrency}
              />

              {/* Expense category */}
              {tx?.type === 'EXPENSE' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Категория</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {EXPENSE_CATEGORIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(c)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-all',
                          category === c
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-border/80 hover:bg-muted/50',
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Salary month */}
              {tx?.type === 'SALARY' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Месяц</Label>
                  <Input
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    placeholder="2025-03"
                    className="h-9 text-sm"
                  />
                </div>
              )}

              {/* Receipt */}
              {(tx?.type === 'ADMIN_INCOME' ||
                tx?.type === 'SENIOR_INCOME' ||
                tx?.type === 'EXPENSE') && <ReceiptInput state={receipt} onChange={setReceipt} />}

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Заметки</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Дополнительная информация..."
                  rows={2}
                  className="text-sm resize-none"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              )}
            </div>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Отмена
          </Button>
          {isEditable && (
            <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? 'Сохранение...' : 'Сохранить'}
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
