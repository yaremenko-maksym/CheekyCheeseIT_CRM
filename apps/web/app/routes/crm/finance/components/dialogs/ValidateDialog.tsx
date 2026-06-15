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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { financeApi } from '../../api'
import { ReceiptPanel } from './receipt-panel'
import {
  fmtAmount,
  fmtDate,
  fmtRate,
  fmtUsd,
  TYPE_LABELS,
  type ExchangeRates,
} from '../../constants'

/**
 * ValidateDialog — модалка-очередь валидации (AC2, AC3, AC4).
 *
 * Принимает текущую транзакцию (`tx`) и весь список pending-транзакций
 * очереди (`queue`). После подтверждения или отклонения одной tx — модалка
 * НЕ закрывается: родитель переключает `tx` на следующую (advanceQueue).
 * При пустой очереди родитель вызывает onClose.
 *
 * - Кнопка «Подтвердить» показывает счётчик оставшихся: «Подтвердить (N)».
 * - При клике «Подтвердить» → AlertDialog-попап для подтверждения.
 * - «Отклонить» (с причиной) двигает очередь без попапа.
 * - Инвалидирует ['transactions'], ['finance-summary'], ['accountant','summary'].
 */
export function ValidateDialog({
  tx,
  queue,
  onClose,
  onAdvance,
}: {
  /** Текущая транзакция для отображения. null = модалка закрыта. */
  tx: TransactionDto | null
  /** Все validatable pending-транзакции (SENIOR_INCOME/DROP_INCOME PENDING). */
  queue: TransactionDto[]
  /** Закрыть модалку (очередь исчерпана или пользователь нажал «Отмена»). */
  onClose: () => void
  /**
   * Перейти к следующей транзакции в очереди.
   * Вызывается после успешной валидации/отклонения, если есть следующая.
   */
  onAdvance: (nextTx: TransactionDto) => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

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

  /** Индекс текущей tx в очереди (или -1 если нет). */
  const currentIndex = tx ? queue.findIndex((q) => q.id === tx.id) : -1
  /** Сколько ещё осталось подтвердить (включая текущую). */
  const remainingCount = currentIndex >= 0 ? queue.length - currentIndex : queue.length

  /** После успешного действия — перейти к следующей или закрыть. */
  const handleActionSuccess = () => {
    setReason('')
    setShowConfirm(false)
    const nextTx = currentIndex >= 0 ? queue[currentIndex + 1] : undefined
    if (nextTx) {
      onAdvance(nextTx)
    } else {
      onClose()
    }
  }

  const mutation = useMutation({
    mutationFn: ({ action }: { action: 'validate' | 'reject' }) =>
      financeApi.validateTransaction(tx!.id, { action, rejectionReason: reason || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['accountant', 'summary'] })
      handleActionSuccess()
    },
  })

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

  const handleDialogClose = () => {
    onClose()
    setReason('')
    setShowConfirm(false)
  }

  return (
    <>
      <Dialog
        open={!!tx}
        onOpenChange={(v) => {
          if (!v) handleDialogClose()
        }}
      >
        <CrmDialogContent maxWidth="sm:max-w-xl" data-testid="validate-transaction-dialog">
          <CrmDialogHeader>
            <DialogTitle>Валидация транзакции</DialogTitle>
            <DialogDescription className="sr-only">Валидация транзакции</DialogDescription>
          </CrmDialogHeader>

          <CrmDialogBody className="space-y-4 pb-4">
            {/* Queue progress indicator — shown when more than 1 tx in queue */}
            {queue.length > 1 && (
              <div
                className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                data-testid="validate-queue-indicator"
              >
                <span
                  className="font-medium text-foreground"
                  data-testid="validate-queue-remaining"
                >
                  {remainingCount}
                </span>
                <span>
                  {remainingCount === 1
                    ? 'транзакция'
                    : remainingCount >= 2 && remainingCount <= 4
                      ? 'транзакции'
                      : 'транзакций'}{' '}
                  осталось в очереди
                </span>
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Тип</span>
                <span className="font-medium">{TYPE_LABELS[tx.type]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Сумма</span>
                <span className="font-medium tabular-nums">
                  {fmtAmount(tx.amount, tx.currency)}
                </span>
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
              {tx.notes && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Заметки</span>
                  <span className="text-right max-w-48">{tx.notes}</span>
                </div>
              )}
            </div>

            {/* AC6: inline receipt preview — shown when a receipt is attached */}
            {(tx.receiptDocumentId || tx.receiptExternalUrl) && <ReceiptPanel tx={tx} compact />}

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
              onClick={handleDialogClose}
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
            {/* AC2: счётчик на кнопке; при клике — AlertDialog confirm-попап */}
            <Button
              onClick={() => setShowConfirm(true)}
              disabled={mutation.isPending}
              data-testid="validate-transaction-confirm"
            >
              {mutation.isPending
                ? 'Сохранение...'
                : remainingCount > 1
                  ? `Подтвердить (${remainingCount})`
                  : 'Подтвердить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* AC2: confirm-попап перед действием валидации */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent data-testid="validate-confirm-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Подтвердить валидацию?</AlertDialogTitle>
            <AlertDialogDescription>
              Транзакция будет подтверждена и переведена в статус «Валидирована».
              {remainingCount > 1 && (
                <> После подтверждения очередь перейдёт к следующей транзакции.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="validate-confirm-cancel">Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConfirm(false)
                mutation.mutate({ action: 'validate' })
              }}
              data-testid="validate-confirm-ok"
            >
              Подтвердить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
