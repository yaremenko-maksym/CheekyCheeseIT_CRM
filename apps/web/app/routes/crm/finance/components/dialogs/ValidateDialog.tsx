import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Dialog, CrmDialogContent, CrmDialogHeader, CrmDialogBody, CrmDialogFooter, DialogTitle } from '@/components/ui/crm-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { financeApi } from '../../api'
import { fmtAmount, fmtDate, TYPE_LABELS } from '../../constants'

export function ValidateDialog({ tx, onClose }: { tx: TransactionDto | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')

  const mutation = useMutation({
    mutationFn: ({ action }: { action: 'validate' | 'reject' }) =>
      financeApi.validateTransaction(tx!.id, { action, rejectionReason: reason || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      onClose()
      setReason('')
    },
  })

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

  return (
    <Dialog open={!!tx} onOpenChange={(v) => { if (!v) { onClose(); setReason('') } }}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle>Валидация транзакции</DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Тип</span>
              <span className="font-medium">{TYPE_LABELS[tx.type]}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сумма</span>
              <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
            </div>
            {tx.senderName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Отправитель</span>
                <span className="font-medium">{tx.senderName}</span>
              </div>
            )}
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
            {tx.receiptUrl && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Чек</span>
                <a href={tx.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-primary text-xs underline">
                  Открыть
                </a>
              </div>
            )}
            {tx.notes && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Заметки</span>
                <span className="text-right max-w-48">{tx.notes}</span>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Причина отклонения (при отклонении)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Укажите причину при отклонении..."
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setReason('') }}>Отмена</Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate({ action: 'reject' })}
            disabled={mutation.isPending || !reason.trim()}
          >
            Отклонить
          </Button>
          <Button
            onClick={() => mutation.mutate({ action: 'validate' })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Сохранение...' : 'Подтвердить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
