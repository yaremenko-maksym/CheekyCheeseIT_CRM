/**
 * ConfirmPayoutDialog — manual confirmation of an off-platform PAYOUT.
 *
 * Trigger: «Подтвердить оплату» button on a PAYOUT row in PENDING_PAYMENT
 * (see `TransactionRow.tsx`). Amount is read-only — taken from the PAYOUT row.
 *
 * Two confirmation mechanisms live side by side here:
 *   - CRYPTO / CASH → legacy `financeApi.confirmPayout`. Credits one of the
 *     admin partners (recipientAdmin selector is required). Backend atomically
 *     flips PAYOUT → PAID and inserts a PAYOUT_CONFIRMED row crediting the
 *     chosen admin.
 *   - COMPANY_ACCOUNT → `financeApi.manualConfirmPayout`. Credits the shared
 *     company USDT account — NOT an individual admin — so the recipient
 *     selector is hidden. The Statistics company-account balance updates.
 */
import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AxiosError } from 'axios'
import { ExternalLink, Coins } from 'lucide-react'
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
  DialogDescription,
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

// UI method set. CRYPTO/CASH map onto the legacy `confirmPayout` flow
// (PayoutMethod). COMPANY_ACCOUNT is the new branch that routes to
// `manualConfirmPayout` and credits the shared company account instead of an
// admin partner — it is intentionally NOT a member of `PayoutMethod`.
type UiMethod = PayoutMethod | 'COMPANY_ACCOUNT'

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
  // "must fill" field that the backend will ignore. COMPANY_ACCOUNT hides the
  // recipient selector instead (the company account is credited, not an admin).
  const [method, setMethod] = useState<UiMethod>('CRYPTO')
  const [txHash, setTxHash] = useState<string>('')

  const isCompanyAccount = method === 'COMPANY_ACCOUNT'

  // Return type is `void` on purpose — the two branches resolve to different
  // DTOs (`confirmPayout` → {payout, confirmed}; `manualConfirmPayout` →
  // PayoutRequestDto) and `onSuccess` ignores the payload, so we await + drop
  // the result to give `useMutation` a single, unambiguous mutationFn type.
  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const trimmed = txHash.trim()
      // Compare on `method` directly (not the `isCompanyAccount` alias) so TS
      // narrows `method` to `PayoutMethod` in the else branch below.
      if (method === 'COMPANY_ACCOUNT') {
        // New branch — credits the shared company account. Routed off the
        // payout REQUEST id (not the tx id), matching the #252 backend
        // contract. txHash is optional here; only attach it when populated.
        //
        // Explicit guard instead of double-non-null: `canSubmit` already
        // gates submission when `tx.payoutRequestId` is absent, but a
        // defensive check here makes the money-path safe against any future
        // caller that bypasses the form gate (#253 review code MED fix).
        if (!tx || !tx.payoutRequestId) {
          throw new Error('Выплата не привязана к запросу на выплату — невозможно подтвердить')
        }
        await financeApi.manualConfirmPayout(tx.payoutRequestId, {
          method: 'COMPANY_ACCOUNT',
          ...(trimmed.length > 0 ? { txHash: trimmed } : {}),
        })
        return
      }
      // Legacy CRYPTO/CASH branch — credits the chosen admin partner.
      // `tx` is guaranteed non-null here: `if (!tx) return null` above the
      // Dialog renders nothing when tx is null, so mutationFn is never called.
      // The explicit check removes any implicit reliance on `!`-assertion.
      if (!tx) {
        throw new Error('Транзакция не выбрана')
      }
      await financeApi.confirmPayout(tx.id, {
        recipientAdminId,
        method,
        ...(method === 'CRYPTO' ? { txHash: trimmed } : {}),
      })
    },
    onSuccess: () => {
      toast.success(isCompanyAccount ? 'Оплата зачислена на счёт компании' : 'Оплата подтверждена')
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // Company-account balance feeds the Statistics KPI — refresh it so the
      // balance reflects the new credit immediately.
      void qc.invalidateQueries({ queryKey: ['company-account'] })
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
  // Submit gating branches by method:
  //   - COMPANY_ACCOUNT — no recipient, txHash optional → only the in-flight
  //     guard applies (plus a present payoutRequestId, asserted below).
  //   - CRYPTO — recipient required + txHash ≥ 10 chars.
  //   - CASH — recipient required only.
  const canSubmit =
    !mutation.isPending &&
    (isCompanyAccount
      ? !!tx.payoutRequestId
      : !!recipientAdminId && (method === 'CASH' || cryptoTxHashOk))

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
          <DialogDescription className="sr-only">
            Подтверждение ручной выплаты партнёру или зачисление на счёт компании с указанием метода
            и хэша транзакции.
          </DialogDescription>
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

          {/* AC10 — payment method radio. Three options: crypto / cash credit an
              admin partner; «Счёт компании» credits the shared company account. */}
          <div className="space-y-1.5" data-testid="confirm-payout-method-radio">
            <Label className="text-xs">Метод оплаты</Label>
            <div className="grid grid-cols-3 gap-2">
              <MethodOption
                value="CRYPTO"
                active={method === 'CRYPTO'}
                onSelect={() => setMethod('CRYPTO')}
                icon={<span className="text-base">💎</span>}
                label="Крипта"
              />
              <MethodOption
                value="CASH"
                active={method === 'CASH'}
                onSelect={() => setMethod('CASH')}
                icon={<span className="text-base">💵</span>}
                label="Наличка"
              />
              <MethodOption
                value="COMPANY_ACCOUNT"
                active={isCompanyAccount}
                onSelect={() => setMethod('COMPANY_ACCOUNT')}
                icon={<Coins className="h-4 w-4" />}
                label="Счёт компании"
              />
            </div>
            {isCompanyAccount && (
              <p
                className="text-[11px] text-muted-foreground"
                data-testid="confirm-payout-company-account-hint"
              >
                Кредитует баланс счёта компании.
              </p>
            )}
          </div>

          {/* Recipient selector — required for CRYPTO/CASH only. Hidden for
              COMPANY_ACCOUNT (no admin is credited there). Default empty so the
              user must explicitly choose. */}
          {!isCompanyAccount && (
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
          )}

          {/* txHash input — shown for CRYPTO (required ≥ 10) and COMPANY_ACCOUNT
              (optional). CASH skips it entirely. */}
          {method !== 'CASH' && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="confirm-payout-tx-hash">
                txHash
                {isCompanyAccount && <span className="text-muted-foreground"> (опционально)</span>}
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
              {/* The min-10 warning only applies to the CRYPTO branch where the
                  hash is required. For COMPANY_ACCOUNT the hash is optional. */}
              {method === 'CRYPTO' && !cryptoTxHashOk && txHash.length > 0 && (
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
  value: UiMethod
  active: boolean
  onSelect: () => void
  icon: ReactNode
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
        'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
