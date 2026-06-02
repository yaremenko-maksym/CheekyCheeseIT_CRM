/**
 * LogCashPaymentDialog — Drop role - phase 4 (refactor — task-drop-phase4-
 * refactor-remove-tov.md AC7).
 *
 * ADMIN/ACCOUNTANT-only admin-initiated cash flow. The trigger is the «Cash
 * передан» button on a VALIDATED DROP_INCOME row in /crm/finance that does
 * not yet have a payment-channel cascade. The accountant picks which admin
 * (Maksym/Kostya) actually received the cash; backend creates the cascade
 * (ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT) and flips the placeholder
 * PAYOUT to PAID.
 *
 * Replaces the prior round-2 «PendingCashCard» list flow — see AC2/AC7/AC8.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AxiosError } from 'axios'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

// Hard-coded admin partner list. Backend re-validates the recipient is an
// active ADMIN, so we keep the list local rather than going to /users.
const ADMIN_OPTIONS = [
  { id: MAKSYM_ID, name: 'Maksym Yaremenko' },
  { id: KOSTYA_ID, name: 'Kostya' },
]

type LogCashPaymentDialogProps = {
  /** VALIDATED DROP_INCOME being settled. `null` = dialog closed. */
  tx: TransactionDto | null
  onClose: () => void
}

export function LogCashPaymentDialog({ tx, onClose }: LogCashPaymentDialogProps) {
  const qc = useQueryClient()
  const [recipientAdminId, setRecipientAdminId] = useState<string>('')

  const mutation = useMutation({
    mutationFn: () =>
      financeApi.confirmCashPayment({
        incomeId: tx!.id,
        recipientAdminId,
      }),
    onSuccess: () => {
      toast.success('Cash зафиксирован')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['pending-settlements-senior'] })
      void qc.invalidateQueries({ queryKey: ['pending-settlements-drop'] })
      handleClose()
    },
    onError: (err: unknown) => {
      let message = 'Не удалось зафиксировать cash'
      if (err instanceof AxiosError) {
        const data = err.response?.data as { message?: string | string[] } | undefined
        const backendMessage = data?.message
        if (typeof backendMessage === 'string' && backendMessage.length > 0) {
          message = backendMessage
        } else if (Array.isArray(backendMessage) && backendMessage.length > 0) {
          message = backendMessage[0] ?? message
        }
      }
      toast.error(message)
    },
  })

  function handleClose() {
    setRecipientAdminId('')
    onClose()
  }

  if (!tx) return null

  const amountLabel = fmtAmount(tx.amount, tx.currency)
  const projectDisplay = tx.projectName ?? '—'

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="log-cash-payment-dialog">
        <CrmDialogHeader>
          <DialogTitle>Cash передан</DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {/* Read-only summary: who paid, which project, amount. */}
          <div
            className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm"
            data-testid="log-cash-info"
          >
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Приход дропа</span>
              <span className="font-medium tabular-nums" data-testid="log-cash-amount">
                {amountLabel}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Проект</span>
              <span className="font-medium text-right truncate max-w-44" title={projectDisplay}>
                {projectDisplay}
              </span>
            </div>
            <p className="text-xs text-muted-foreground pt-1">
              Senior-доля останется долгом дропа синьору и закроется позже через «Закрыть долг».
            </p>
          </div>

          {/* Recipient admin — required. */}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="log-cash-admin-select">
              Кому из админов пришёл нал
            </Label>
            <Select value={recipientAdminId} onValueChange={(v) => setRecipientAdminId(v)}>
              <SelectTrigger
                id="log-cash-admin-select"
                data-testid="log-cash-admin-select"
                className="h-9 text-sm"
              >
                <SelectValue placeholder="— выберите админа —" />
              </SelectTrigger>
              <SelectContent>
                {ADMIN_OPTIONS.map((admin) => (
                  <SelectItem
                    key={admin.id}
                    value={admin.id}
                    data-testid={`log-cash-admin-option-${admin.id}`}
                    className="text-sm"
                  >
                    {admin.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="log-cash-cancel">
            Отмена
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !recipientAdminId}
            data-testid="log-cash-submit"
          >
            {mutation.isPending ? 'Сохранение...' : 'Подтвердить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
