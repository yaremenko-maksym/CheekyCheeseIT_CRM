import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

/**
 * Quick single-transaction payout confirmation.
 *
 * Reuses the existing PayoutDialog "create payout request" backend call but
 * skips the multi-select step — used from the Actions column inline button
 * and from TransactionDetailDialog footer for a streamlined "Выплатить"
 * action when only one row is involved.
 *
 * RBAC: caller is responsible for visibility. We accept any VALIDATED
 * SENIOR_INCOME row and submit `[tx.id]` to the API. The backend enforces
 * the actual permission (senior must own the transaction).
 */
export function QuickPayoutConfirmDialog({
  tx,
  onClose,
  onSuccess,
}: {
  tx: TransactionDto | null
  onClose: () => void
  onSuccess?: () => void
}) {
  const qc = useQueryClient()
  const { user } = useAuth()

  const seniorDefault = user?.seniorSharePercent ?? 26
  const sharePercent = tx?.seniorSharePercent ?? seniorDefault
  const amount = tx ? parseFloat(tx.amount) : 0
  const payable = amount * (1 - sharePercent / 100)

  const createMutation = useMutation({
    mutationFn: () => financeApi.createPayoutRequest({ transactionIds: [tx!.id] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['payout-requests'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      toast.success('Транзакция отправлена в выплату')
      onSuccess?.()
      onClose()
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Не удалось создать выплату'
      toast.error(msg)
    },
  })

  return (
    <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle className="text-base">Подтвердить выплату?</DialogTitle>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          {tx && (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Сумма транзакции</span>
                  <span className="font-medium tabular-nums">
                    {fmtAmount(tx.amount, tx.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Ваша доля {sharePercent}%</span>
                  <span className="tabular-nums">{(amount * (sharePercent / 100)).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-primary border-t border-border/60 pt-1.5 mt-1">
                  <span className="font-medium">К оплате</span>
                  <span className="font-bold tabular-nums" data-testid="quick-payout-payable">
                    {fmtAmount(payable.toFixed(2), tx.currency)}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Транзакция перейдёт в статус «Ожидает оплаты». Hash USDT можно будет ввести позже в
                разделе выплат.
              </p>
            </div>
          )}
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={createMutation.isPending}>
            Отмена
          </Button>
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={!tx || createMutation.isPending}
            data-testid="quick-payout-confirm"
          >
            {createMutation.isPending ? 'Отправка…' : 'Выплатить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
