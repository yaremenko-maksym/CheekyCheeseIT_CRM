import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import type { TransactionDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { financeApi } from '../../api'
import { fmtAmount, TYPE_LABEL_MESSAGES } from '../../constants'

/**
 * Restore — task-soft-delete-and-money-audit (AC6). ADMIN-only (the caller
 * only ever sets `tx` for ADMIN); reason mandatory for the same audit-trail
 * reason as delete.
 */
export function RestoreTransactionDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const { t, i18n } = useLingui()
  const [reason, setReason] = useState('')
  const qc = useQueryClient()
  const handleClose = () => {
    onClose()
    setReason('')
  }
  const restoreMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      financeApi.restoreTransaction(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      handleClose()
    },
  })

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(o) => {
        if (!o) {
          handleClose()
        }
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle className="text-base">
            <Trans>Відновити транзакцію?</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Підтвердження відновлення раніше видаленої фінансової транзакції.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2 space-y-3">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              <Trans>Транзакція знову з’явиться в загальному списку та в усіх розрахунках.</Trans>
            </p>
            {/* Stryker disable next-line ConditionalExpression: the dialog body only renders while `open={!!tx}`, so `tx` is never null here — forcing the guard on is equivalent (the off-mutant is killed by the summary assertion) */}
            {tx && (
              <p className="font-medium text-foreground">
                {i18n._(TYPE_LABEL_MESSAGES[tx.type])} · {fmtAmount(tx.amount, tx.currency)}
              </p>
            )}
            {tx?.deletionReason && (
              <p className="text-xs">
                <Trans>
                  Причина видалення: <span className="italic">{tx.deletionReason}</span>
                </Trans>
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="restore-tx-reason" className="text-xs font-medium text-foreground">
              {t`Причина відновлення (обов’язково)`}
            </label>
            <Textarea
              id="restore-tx-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t`Наприклад: видалено помилково`}
              className="min-h-16 text-sm"
              data-testid="restore-tx-reason-input"
            />
            {/* FIX-SPEC-M-1 (fix-round, PR #730 / COPY-M-fin-5) — same
                      visible hint as the delete dialog. */}
            {reason.length > 0 && reason.trim().length < 3 && (
              <p className="text-xs text-destructive" data-testid="restore-tx-reason-hint">
                {t`Вкажіть щонайменше 3 символи причини`}
              </p>
            )}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleClose()}>
            {t`Скасувати`}
          </Button>
          <Button
            size="sm"
            onClick={() => tx && restoreMutation.mutate({ id: tx.id, reason: reason.trim() })}
            disabled={restoreMutation.isPending || reason.trim().length < 3}
            data-testid="restore-tx-confirm-button"
          >
            {restoreMutation.isPending ? t`Відновлення…` : t`Відновити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
