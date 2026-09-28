import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLingui, Plural } from '@lingui/react/macro'
import type { TransactionDto } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
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
  fmtRate,
  fmtUsd,
  TYPE_LABEL_MESSAGES,
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
  const { t, i18n } = useLingui()
  const locale = useLocale()
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
    // Guard: if tx is not found in queue (desync) or it's the last element → close.
    if (currentIndex === -1 || currentIndex >= queue.length - 1) {
      onClose()
      return
    }
    const nextTx = queue[currentIndex + 1]
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

  // COPY-H-fin-3: never the raw `.message` of an unknown error — status-based
  // resolution through the SAME resolver every other finance screen uses
  // (`getApiErrorMessage`; see `axios-utils.spec.ts` for its contract).
  const error = mutation.error ? getApiErrorMessage(mutation.error) : null

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
            <DialogTitle>{t`Валідація транзакції`}</DialogTitle>
            <DialogDescription className="sr-only">{t`Валідація транзакції`}</DialogDescription>
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
                {/* J-fin (урок #700): ICU `<Plural>`, not a hand-rolled
                    mod-based ternary — uk needs three forms (one/few/many),
                    not the two this used to hardcode. */}
                <Plural
                  value={remainingCount}
                  one="транзакція залишилась в черзі"
                  few="транзакції залишилось в черзі"
                  many="транзакцій залишилось в черзі"
                  other="транзакції залишилось в черзі"
                />
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t`Тип`}</span>
                <span className="font-medium">{i18n._(TYPE_LABEL_MESSAGES[tx.type])}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t`Сума`}</span>
                <span className="font-medium tabular-nums">
                  {fmtAmount(tx.amount, tx.currency)}
                </span>
              </div>
              {needsRate && rates && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t`Курс (USD)`}</span>
                    <span className="text-xs text-muted-foreground">
                      {fmtRate(tx.currency, rates)}
                      <span className="ml-1.5 opacity-50">{t`· НБУ`}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t`В USD`}</span>
                    <span className="font-medium tabular-nums">
                      {fmtUsd(tx.amount, tx.currency, rates)}
                    </span>
                  </div>
                </>
              )}
              {tx.senderName && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t`Відправник`}</span>
                  <span className="font-medium">{tx.senderName}</span>
                </div>
              )}
              {tx.projectName && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t`Проєкт`}</span>
                  <span className="font-medium">{tx.projectName}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t`Дата`}</span>
                <span className="font-medium">{formatDate(tx.createdAt, locale, 'shortYY')}</span>
              </div>
              {tx.notes && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t`Примітки`}</span>
                  <span className="text-right max-w-48">{tx.notes}</span>
                </div>
              )}
            </div>

            {/* AC6: inline receipt preview — shown when a receipt is attached */}
            {(tx.receiptDocumentId || tx.receiptExternalUrl) && <ReceiptPanel tx={tx} compact />}

            <div className="space-y-1">
              <Label className="text-xs">{t`Причина відмови (у разі відмови)`}</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t`Вкажіть причину у разі відмови…`}
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
              {t`Скасувати`}
            </Button>
            <Button
              variant="destructive"
              onClick={() => mutation.mutate({ action: 'reject' })}
              disabled={mutation.isPending || !reason.trim()}
              data-testid="validate-transaction-reject"
            >
              {t`Відхилити`}
            </Button>
            {/* AC2: счётчик на кнопке; при клике — AlertDialog confirm-попап */}
            <Button
              onClick={() => setShowConfirm(true)}
              disabled={mutation.isPending}
              data-testid="validate-transaction-confirm"
            >
              {mutation.isPending
                ? t`Збереження…`
                : remainingCount > 1
                  ? t`Підтвердити (${remainingCount})`
                  : t`Підтвердити`}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* AC2: confirm-попап перед действием валидации */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent data-testid="validate-confirm-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Підтвердити валідацію?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Транзакцію буде підтверджено і переведено у статус «Валідовано».`}
              {remainingCount > 1 && (
                <> {t`Після підтвердження черга перейде до наступної транзакції.`}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="validate-confirm-cancel">
              {t`Скасувати`}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConfirm(false)
                mutation.mutate({ action: 'validate' })
              }}
              data-testid="validate-confirm-ok"
            >
              {t`Підтвердити`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
