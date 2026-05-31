/**
 * ConfirmPayoutDialog — Drop role - phase 3 (spec §8.4).
 *
 * ADMIN/ACCOUNTANT-only manual confirmation of an off-platform PAYOUT.
 * The accountant picks which admin partner actually received the money;
 * backend atomically flips PAYOUT → PAID and inserts a PAYOUT_CONFIRMED row
 * crediting the chosen admin.
 *
 * Trigger: «Подтвердить оплату» button on a PAYOUT row in PENDING_PAYMENT
 * (see `TransactionRow.tsx`). Amount is read-only — taken from the PAYOUT row.
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
import { financeApi } from '@/routes/crm/finance/api'
import { fmtAmount } from '@/routes/crm/finance/constants'

// Hard-coded list of admin partners. Backend re-validates the recipient is an
// active ADMIN, so we don't need a /users fetch here (DROP/SENIOR can't reach
// /users at all, and this dialog is ADMIN/ACCOUNTANT-only anyway). IDs come
// from `@crm/shared` to keep them in sync with seed + backend constants.
const ADMIN_OPTIONS = [
  { id: MAKSYM_ID, name: 'Maksym Yaremenko' },
  { id: KOSTYA_ID, name: 'Kostya' },
]

type ConfirmPayoutDialogProps = {
  /** PAYOUT transaction being confirmed. `null` = dialog closed. */
  tx: TransactionDto | null
  onClose: () => void
}

export function ConfirmPayoutDialog({ tx, onClose }: ConfirmPayoutDialogProps) {
  const qc = useQueryClient()
  const [recipientAdminId, setRecipientAdminId] = useState<string>('')

  const mutation = useMutation({
    mutationFn: () => financeApi.confirmPayout(tx!.id, { recipientAdminId }),
    onSuccess: () => {
      toast.success('Оплата подтверждена')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      handleClose()
    },
    onError: (err: unknown) => {
      // Surface backend message when available — covers 400 (wrong type /
      // already confirmed / unknown recipient), 403 (RBAC). Falls back to the
      // generic copy when the error has no useful body.
      let message = 'Не удалось подтвердить оплату'
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

  const senderDisplay = tx.senderName ?? tx.senderLabel ?? '—'
  const amountLabel = fmtAmount(tx.amount, tx.currency)

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="confirm-payout-dialog">
        <CrmDialogHeader>
          <DialogTitle>Подтвердить оплату</DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          {/* Read-only info block — payer + amount that's being confirmed. */}
          <div
            className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm"
            data-testid="confirm-payout-info"
          >
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Транзакция выплаты</span>
              <span className="font-medium tabular-nums" data-testid="confirm-payout-amount">
                {amountLabel}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">От</span>
              <span className="font-medium text-right truncate max-w-44" title={senderDisplay}>
                {senderDisplay}
              </span>
            </div>
            {tx.projectName && (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Проект</span>
                <span className="font-medium text-right truncate max-w-44" title={tx.projectName}>
                  {tx.projectName}
                </span>
              </div>
            )}
          </div>

          {/* Recipient selector — required field. Default empty so the user
              must explicitly choose. */}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="confirm-payout-admin-select">
              Кому пришла оплата
            </Label>
            <Select value={recipientAdminId} onValueChange={(v) => setRecipientAdminId(v)}>
              <SelectTrigger
                id="confirm-payout-admin-select"
                data-testid="confirm-payout-admin-select"
                className="h-9 text-sm"
              >
                <SelectValue placeholder="— выберите админа —" />
              </SelectTrigger>
              <SelectContent>
                {ADMIN_OPTIONS.map((admin) => (
                  <SelectItem
                    key={admin.id}
                    value={admin.id}
                    data-testid={`confirm-payout-admin-option-${admin.id}`}
                    className="text-sm"
                  >
                    {admin.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Amount — explicit read-only badge so the user sees what amount
              they're confirming. Mirrors the info block; spec requires both. */}
          <div className="space-y-1.5">
            <Label className="text-xs">Сумма</Label>
            <div
              className="inline-flex items-center rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium tabular-nums"
              data-testid="confirm-payout-amount-readonly"
            >
              {amountLabel}
            </div>
          </div>
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="confirm-payout-cancel">
            Отмена
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !recipientAdminId}
            data-testid="confirm-payout-submit"
          >
            {mutation.isPending ? 'Сохранение...' : 'Подтвердить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
