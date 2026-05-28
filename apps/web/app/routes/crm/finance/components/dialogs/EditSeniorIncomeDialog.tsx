import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Dialog, CrmDialogContent, CrmDialogHeader, CrmDialogBody, CrmDialogFooter, DialogTitle } from '@/components/ui/crm-dialog'
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

export function EditSeniorIncomeDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
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
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) throw new Error('Некорректная сумма')
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? (receipt.externalUrl || null) : null
      return financeApi.updateSeniorIncome(tx!.id, {
        amount: amt,
        currency,
        receiptDocumentId,
        receiptExternalUrl,
        notes: notes || null,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      onClose()
    },
  })

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

  return (
    <Dialog open={!!tx} onOpenChange={(v) => { if (!v) onClose() }}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle>Исправить транзакцию</DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {tx.rejectionReason && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs font-medium text-destructive mb-1">Причина отклонения:</p>
              <p className="text-sm">{tx.rejectionReason}</p>
            </div>
          )}

          {tx.projectName && (
            <div className="space-y-1">
              <Label className="text-xs">Проект</Label>
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
            <Label className="text-xs">Заметки</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Дополнительная информация..."
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="edit-senior-income-cancel"
          >
            Отмена
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            data-testid="edit-senior-income-resubmit"
          >
            {mutation.isPending ? 'Сохранение...' : 'Переотправить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
