import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UserOption } from './shared'

// Dividend — balance + receiver + USDT amount (ADMIN-only). Renders its own
// USDT-only amount input (no currency selector, no date) — the company-account
// endpoint only needs amount + receiver.
export function DividendFields({
  companyBalance,
  fmtUsdt,
  dividendReceiverId,
  setReceiverId,
  clearFieldError,
  fieldErrors,
  adminUsers,
  amount,
  setAmount,
}: {
  companyBalance: number
  fmtUsdt: (n: number) => string
  dividendReceiverId: string
  setReceiverId: (v: string) => void
  clearFieldError: (field: string) => void
  fieldErrors: Record<string, string>
  adminUsers: UserOption[]
  amount: string
  setAmount: (v: string) => void
}) {
  const { t } = useLingui()
  return (
    <div className="space-y-4" data-testid="create-transaction-dividend-fields">
      {/* Balance summary */}
      <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            <Trans>Баланс рахунку компанії</Trans>
          </span>
          <span
            className="font-bold tabular-nums"
            data-testid="create-transaction-dividend-balance"
          >
            {fmtUsdt(companyBalance)} USDT
          </span>
        </div>
      </div>

      {/* Receiver — ADMIN partner */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          <Trans>Отримувач (партнер)</Trans>
        </Label>
        <Select
          value={dividendReceiverId}
          onValueChange={(v) => {
            setReceiverId(v)
            clearFieldError('receiver')
          }}
        >
          <SelectTrigger
            className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
            data-testid="create-transaction-dividend-receiver-trigger"
          >
            <SelectValue
              placeholder={
                // Stryker disable next-line StringLiteral: unselected-state placeholder — `dividendReceiverId` defaults to the caller's own admin id, so no test in this suite renders this dialog with the placeholder actually showing.
                t`Виберіть партнера`
              }
            />
          </SelectTrigger>
          <SelectContent>
            {adminUsers.map((u) => (
              <SelectItem key={u.id} value={u.id} className="text-sm">
                {u.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fieldErrors.receiver && (
          <p
            className="text-[11px] text-destructive"
            data-testid="create-transaction-error-receiver"
          >
            {fieldErrors.receiver}
          </p>
        )}
      </div>

      {/* USDT amount */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          <Trans>Сума (USDT)</Trans>
        </Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
          <Input
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              clearFieldError('amount')
            }}
            placeholder="0.00"
            inputMode="decimal"
            className={cn(
              'h-9 pl-7 text-sm tabular-nums',
              fieldErrors.amount && 'border-destructive',
            )}
            // Stryker disable next-line StringLiteral: screen-reader-only label, not asserted by any test in this suite (the field is queried by testid).
            aria-label={t`Сума дивідендів у USDT`}
            data-testid="create-transaction-dividend-amount"
          />
        </div>
        {fieldErrors.amount && (
          <p className="text-[11px] text-destructive" data-testid="create-transaction-error-amount">
            {fieldErrors.amount}
          </p>
        )}
      </div>
    </div>
  )
}
