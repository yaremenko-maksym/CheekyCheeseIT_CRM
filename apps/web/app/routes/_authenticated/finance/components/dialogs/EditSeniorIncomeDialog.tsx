import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { parseStrictAmount } from '@/lib/utils'
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
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { financeApi } from '../../api'
import {
  ReceiptInput,
  receiptStateFromDocument,
  receiptStateFromExternalUrl,
  type ReceiptState,
} from '../ReceiptInput'

type ProjectOption = { id: string; name: string; seniorId: string }

// task-i18n-stage3d-pr2 (COPY-H-fin-3). Thrown from `mutationFn` — a plain
// event-handler callback, not a component render — so `i18n._()` (the
// runtime function) is used here, not the `t` macro (component-scope only).
const INVALID_AMOUNT_MESSAGE = msg`Некоректна сума`

export function EditSeniorIncomeDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const { t } = useLingui()
  const { user } = useAuth()
  const qc = useQueryClient()

  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [receipt, setReceipt] = useState<ReceiptState>(receiptStateFromExternalUrl(null))
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (tx) {
      setAmount(tx.amount)
      setCurrency((tx.currency as Currency) || 'USDT')
      // Prefer documentId over externalUrl when both somehow exist
      // (DB enforces XOR so at most one is non-null here).
      if (tx.receiptDocumentId) {
        setReceipt(receiptStateFromDocument(tx.receiptDocumentId))
      } else {
        setReceipt(receiptStateFromExternalUrl(tx.receiptExternalUrl))
      }
      setNotes(tx.notes ?? '')
    }
  }, [tx])

  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectOption[]>('/projects').then((r) => r.data),
    enabled: !!tx,
  })

  const _myProjects = projects.filter((p) => p.seniorId === user?.id)

  const mutation = useMutation({
    mutationFn: () => {
      const amt = parseStrictAmount(amount)
      if (isNaN(amt) || amt <= 0) throw new Error(i18n._(INVALID_AMOUNT_MESSAGE))
      const nextReceiptDocId = receipt.mode === 'file' ? receipt.documentId : null
      const nextReceiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // fix/external-receipt-rendering round 2 (security-review PR #470 MED-2):
      // same reasoning as AdminEditTransactionDialog — the form pre-fills the
      // tx's existing receipt even when only amount is being resubmitted.
      // Omit the receipt fields when unchanged so an untouched legacy
      // `http://` receipt never trips the now-https-only write schema on a
      // field the user didn't edit; `undefined` = "leave unchanged" server-side.
      const receiptUnchanged =
        nextReceiptDocId === (tx?.receiptDocumentId ?? null) &&
        nextReceiptExternalUrl === (tx?.receiptExternalUrl ?? null)
      return financeApi.updateSeniorIncome(tx!.id, {
        amount: amt,
        currency,
        ...(!receiptUnchanged && {
          receiptDocumentId: nextReceiptDocId,
          receiptExternalUrl: nextReceiptExternalUrl,
        }),
        notes: notes || null,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      onClose()
    },
  })

  // COPY-H-fin-3: `getApiErrorMessage` handles BOTH the local `Error` thrown
  // above (falls through to its own `.message`, already localised via
  // `i18n._`) and a real axios failure (status-based resolution) — no raw
  // `.message` of an UNKNOWN shape ever reaches the screen.
  const error = mutation.error ? getApiErrorMessage(mutation.error) : null

  if (!tx) return null

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle>{t`Виправити транзакцію`}</DialogTitle>
          <DialogDescription className="sr-only">{t`Виправлення транзакції`}</DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {tx.rejectionReason && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
              data-testid="edit-senior-income-rejection-panel"
            >
              <p className="text-xs font-medium text-destructive mb-1">{t`Причина відмови:`}</p>
              <p className="text-sm" data-testid="edit-senior-income-rejection-reason">
                {tx.rejectionReason}
              </p>
            </div>
          )}

          {tx.projectName && (
            <div className="space-y-1">
              <Label className="text-xs">{t`Проєкт`}</Label>
              <p className="text-sm font-medium px-1">{tx.projectName}</p>
            </div>
          )}

          <AmountCurrencyInput
            amount={amount}
            currency={currency}
            onAmountChange={setAmount}
            onCurrencyChange={setCurrency}
          />

          <ReceiptInput state={receipt} onChange={setReceipt} />

          <div className="space-y-1">
            <Label className="text-xs">{t`Примітки`}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t`Додаткова інформація...`}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="edit-senior-income-cancel">
            {t`Скасувати`}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            data-testid="edit-senior-income-resubmit"
          >
            {mutation.isPending ? t`Збереження...` : t`Надіслати повторно`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
