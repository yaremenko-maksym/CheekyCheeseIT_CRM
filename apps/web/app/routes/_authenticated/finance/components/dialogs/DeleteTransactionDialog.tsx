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
 * Delete confirmation — task-soft-delete-and-money-audit: now a SOFT delete
 * (row is marked, never physically removed) and the reason is MANDATORY (it
 * lands in the audit journal). Reason is kept in local state so the dialog can
 * disable the submit button until it is long enough.
 */
export function DeleteTransactionDialog({
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
  const deleteMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      financeApi.deleteTransaction(id, reason),
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
          <DialogTitle className="text-base text-destructive">
            <Trans>Видалити транзакцію?</Trans>
          </DialogTitle>
          {/* COPY-M-fin-14: this sr-only description used to phrase the
                    same fact differently from the visible paragraph below
                    ("не удалена физически" here, absent there) — one sentence
                    for screen readers and sighted users alike now, not two
                    near-identical ones a translator would have to keep in
                    sync by hand. */}
          <DialogDescription className="sr-only">
            <Trans>
              Транзакцію буде прибрано з загального списку — відновити її може лише адміністратор.
            </Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2 space-y-3">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              <Trans>
                Транзакцію буде прибрано з загального списку — відновити її може лише адміністратор.
              </Trans>
            </p>
            {tx && (
              <p className="font-medium text-foreground">
                {i18n._(TYPE_LABEL_MESSAGES[tx.type])} · {fmtAmount(tx.amount, tx.currency)}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="delete-tx-reason" className="text-xs font-medium text-foreground">
              {t`Причина видалення (обов’язково)`}
            </label>
            <Textarea
              id="delete-tx-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t`Наприклад: помилково створена транзакція`}
              className="min-h-16 text-sm"
              data-testid="delete-tx-reason-input"
            />
            {/* FIX-SPEC-M-1 (fix-round, PR #730 / COPY-M-fin-5): the
                      confirm button below was silently `disabled` below 3
                      characters with no visible reason why — a mandatory
                      field that refuses without saying so. */}
            {reason.length > 0 && reason.trim().length < 3 && (
              <p className="text-xs text-destructive" data-testid="delete-tx-reason-hint">
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
            variant="destructive"
            size="sm"
            onClick={() => tx && deleteMutation.mutate({ id: tx.id, reason: reason.trim() })}
            disabled={deleteMutation.isPending || reason.trim().length < 3}
            data-testid="delete-tx-confirm-button"
          >
            {deleteMutation.isPending ? t`Видалення…` : t`Видалити`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
