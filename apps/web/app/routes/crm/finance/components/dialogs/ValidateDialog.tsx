import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { api } from '@/lib/axios'
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
import { useDocumentDownloadUrl } from '@/hooks/use-documents'
import { financeApi } from '../../api'
import {
  fmtAmount,
  fmtDate,
  fmtRate,
  fmtUsd,
  TYPE_LABELS,
  type ExchangeRates,
} from '../../constants'

export function ValidateDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')

  // AC3 (finance money strategy): for a non-USD/USDT income the accountant
  // needs to see the conversion they're validating — original amount, the NBU
  // rate, and the resulting USD figure. USD/USDT transactions skip the query
  // entirely (no conversion to show).
  const needsRate = tx?.currency === 'EUR' || tx?.currency === 'UAH'
  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    enabled: !!tx && needsRate,
    staleTime: 1000 * 60 * 60,
  })

  // Fetch presigned URL for uploaded receipts (only when documentId set).
  // External URL receipts skip this query and use tx.receiptExternalUrl directly.
  const receiptDocQuery = useDocumentDownloadUrl(tx?.receiptDocumentId ?? undefined, {
    enabled: !!tx?.receiptDocumentId,
  })
  const receiptUrl = tx?.receiptDocumentId
    ? (receiptDocQuery.data?.url ?? null)
    : (tx?.receiptExternalUrl ?? null)

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
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) {
          onClose()
          setReason('')
        }
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="validate-transaction-dialog">
        <CrmDialogHeader>
          <DialogTitle>Валидация транзакции</DialogTitle>
          <DialogDescription className="sr-only">
            Проверка и подтверждение или отклонение транзакции бухгалтером.
          </DialogDescription>
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
            {needsRate && rates && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Курс (USD)</span>
                  <span className="text-xs text-muted-foreground">
                    {fmtRate(tx.currency, rates)}
                    <span className="ml-1.5 opacity-50">· НБУ</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">В USD</span>
                  <span className="font-medium tabular-nums">
                    {fmtUsd(tx.amount, tx.currency, rates)}
                  </span>
                </div>
              </>
            )}
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
            {receiptUrl && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Чек</span>
                <a
                  href={receiptUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary text-xs underline"
                >
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
          <Button
            variant="outline"
            onClick={() => {
              onClose()
              setReason('')
            }}
            data-testid="validate-transaction-cancel"
          >
            Отмена
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate({ action: 'reject' })}
            disabled={mutation.isPending || !reason.trim()}
            data-testid="validate-transaction-reject"
          >
            Отклонить
          </Button>
          <Button
            onClick={() => mutation.mutate({ action: 'validate' })}
            disabled={mutation.isPending}
            data-testid="validate-transaction-confirm"
          >
            {mutation.isPending ? 'Сохранение...' : 'Подтвердить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
