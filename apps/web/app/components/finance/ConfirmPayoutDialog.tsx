/**
 * ConfirmPayoutDialog — Drop role - phase 3 (spec §8.4),
 * extended in Phase 4 refactor (task-drop-phase4-refactor-remove-tov.md AC10).
 *
 * ADMIN/ACCOUNTANT-only manual confirmation of an off-platform PAYOUT. The
 * accountant picks which admin partner actually received the money AND which
 * payment method was used (crypto vs cash). Backend atomically flips
 * PAYOUT → PAID and inserts a PAYOUT_CONFIRMED row crediting the chosen
 * admin.
 *
 * - Crypto method (default): txHash input shown, etherscan link if entered.
 * - Cash method: txHash hidden, only confirmation needed.
 *
 * Trigger: «Подтвердить оплату» button on a PAYOUT row in PENDING_PAYMENT
 * (see `TransactionRow.tsx`). Amount is read-only — taken from the PAYOUT row.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AxiosError } from 'axios'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { PayoutMethod, TransactionDto } from '@crm/shared'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
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
  // AC10 — Phase 4 refactor. Default = crypto (legacy contract); switching
  // to cash hides the txHash row entirely so the form doesn't surface a
  // "must fill" field that the backend will ignore.
  const [method, setMethod] = useState<PayoutMethod>('CRYPTO')
  const [txHash, setTxHash] = useState<string>('')

  const mutation = useMutation({
    mutationFn: () =>
      financeApi.confirmPayout(tx!.id, {
        recipientAdminId,
        method,
        ...(method === 'CRYPTO' ? { txHash: txHash.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('Оплата подтверждена')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      handleClose()
    },
    onError: (err: unknown) => {
      // Surface backend message when available — covers 400 (wrong type /
      // already confirmed / unknown recipient / missing txHash for crypto),
      // 403 (RBAC). Falls back to the generic copy when the error has no
      // useful body.
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
    setMethod('CRYPTO')
    setTxHash('')
    onClose()
  }

  if (!tx) return null

  const senderDisplay = tx.senderName ?? tx.senderLabel ?? '—'
  const amountLabel = fmtAmount(tx.amount, tx.currency)
  const trimmedHash = txHash.trim()
  const cryptoTxHashOk = trimmedHash.length >= 10
  const canSubmit =
    !!recipientAdminId && (method === 'CASH' || cryptoTxHashOk) && !mutation.isPending

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

          {/* AC10 — payment method radio. */}
          <div className="space-y-1.5" data-testid="confirm-payout-method-radio">
            <Label className="text-xs">Метод оплаты</Label>
            <div className="grid grid-cols-2 gap-2">
              <MethodOption
                value="CRYPTO"
                active={method === 'CRYPTO'}
                onSelect={() => setMethod('CRYPTO')}
                icon="💎"
                label="Крипта"
              />
              <MethodOption
                value="CASH"
                active={method === 'CASH'}
                onSelect={() => setMethod('CASH')}
                icon="💵"
                label="Наличка"
              />
            </div>
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

          {/* CRYPTO-only: txHash input + etherscan link. Cash skips this entirely. */}
          {method === 'CRYPTO' && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="confirm-payout-tx-hash">
                txHash
              </Label>
              <Input
                id="confirm-payout-tx-hash"
                data-testid="confirm-payout-tx-hash"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
                className="h-9 text-xs font-mono"
              />
              {cryptoTxHashOk && (
                <a
                  href={`https://etherscan.io/tx/${trimmedHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  Открыть в Etherscan <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {!cryptoTxHashOk && txHash.length > 0 && (
                <p className="text-[11px] text-amber-500">
                  txHash должен содержать минимум 10 символов
                </p>
              )}
            </div>
          )}

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
            disabled={!canSubmit}
            data-testid="confirm-payout-submit"
          >
            {mutation.isPending ? 'Сохранение...' : 'Подтвердить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

// Small visual radio button — keyboard-friendly via the underlying <button>
// element, no third-party radio component needed.
function MethodOption({
  value,
  active,
  onSelect,
  icon,
  label,
}: {
  value: PayoutMethod
  active: boolean
  onSelect: () => void
  icon: string
  label: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      data-testid={`confirm-payout-method-${value.toLowerCase()}`}
      className={cn(
        'flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60',
      )}
    >
      <span className="text-base">{icon}</span>
      <span>{label}</span>
    </button>
  )
}
