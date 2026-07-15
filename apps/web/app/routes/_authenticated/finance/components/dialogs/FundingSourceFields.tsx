import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { companyAccountApi } from '../../api'

export type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'
type UserOption = { id: string; displayName: string; role: string }

// UI-level account selection. 'COMPANY' = pay from the shared company USDT
// account (COMPANY_ACCOUNT). Any other value is an ADMIN partner's id → the
// payment is ADMIN_PERSONAL funded by that partner's personal account.
export const COMPANY_ACCOUNT_VALUE = 'COMPANY' as const

export const CURRENCIES: Currency[] = ['USDT', 'USD', 'EUR', 'UAH']

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Shared funding-source picker for pay-time money dialogs (PaySalaryDialog,
 * SettleSeniorPayoutDialog). Mirrors the SALARY pay flow exactly — DRY single
 * source for "С какого счёта оплачено" (Счёт компании vs admin partner) + the
 * company-account balance hint + the currency selector (locked to USDT for the
 * company account). The parent owns the `account` / `currency` state and the
 * funding semantics; this component is purely presentational + the read-only
 * admin-partners / company-balance queries.
 *
 * `testIdPrefix` keeps each consumer's testids distinct (e.g. `pay-salary-*`
 * vs `settle-senior-*`).
 */
export function FundingSourceFields({
  account,
  currency,
  onSelectAccount,
  onSelectCurrency,
  enabled = true,
  testIdPrefix,
  allowedCurrencies = CURRENCIES,
  hideCurrency = false,
}: {
  /** COMPANY_ACCOUNT_VALUE (Счёт компании) OR an ADMIN partner id. */
  account: string
  /** Omit entirely when `hideCurrency` is true. */
  currency?: Currency
  /** Called with the new account value. Parent locks currency → USDT for company. */
  onSelectAccount: (value: string) => void
  onSelectCurrency?: (value: Currency) => void
  /** Gate the read-only queries (only fetch while the dialog is open). */
  enabled?: boolean
  testIdPrefix: string
  /**
   * Restricts the currency options shown for the ADMIN_PERSONAL branch (the
   * COMPANY_ACCOUNT branch is always forced/locked to USDT regardless of this
   * prop). Defaults to all four currencies (PaySalaryDialog — any currency is a
   * legitimate salary payout). Irrelevant when `hideCurrency` is set.
   */
  allowedCurrencies?: Currency[]
  /**
   * task-remove-settle-currency: hides the currency Select entirely.
   * SettleSeniorPayoutDialog sets this — a settle obligation is always
   * denominated in USDT (the picker was purely cosmetic; see
   * pending-settlement.service.ts), so there is nothing to pick. PaySalaryDialog
   * leaves this false — salary IS legitimately paid in different currencies.
   */
  hideCurrency?: boolean
}) {
  const isCompany = account === COMPANY_ACCOUNT_VALUE

  // Admin partners (Maksym / Kostya) for the ADMIN_PERSONAL options. Same source
  // as CreateTransactionDialog / PaySalaryDialog — /users filtered by role === ADMIN.
  const { data: allUsers = [] } = useQuery<UserOption[]>({
    queryKey: ['users-all'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled,
  })
  const adminUsers = useMemo(() => allUsers.filter((u) => u.role === 'ADMIN'), [allUsers])

  // Company account balance — shown as a hint when «Счёт компании» is selected.
  const { data: companyAccount } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
    enabled,
  })
  const companyBalance = companyAccount?.balance ?? 0

  return (
    <>
      {/* Account selector — С какого счёта оплачено */}
      <div className="space-y-2" data-testid={`${testIdPrefix}-account-section`}>
        <Label className="text-xs text-muted-foreground">С какого счёта оплачено</Label>
        <div className="grid grid-cols-1 gap-1.5">
          {/* Company account — default */}
          <button
            type="button"
            onClick={() => onSelectAccount(COMPANY_ACCOUNT_VALUE)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
              isCompany
                ? 'border-primary bg-primary/8 text-foreground'
                : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
            )}
            data-testid={`${testIdPrefix}-account-company`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">Счёт компании</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                Спишется со счёта компании (USDT)
              </div>
            </div>
            {isCompany && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
          </button>

          {/* Admin partners — personal accounts */}
          {adminUsers.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => onSelectAccount(u.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                account === u.id
                  ? 'border-primary bg-primary/8 text-foreground'
                  : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
              )}
              data-testid={`${testIdPrefix}-account-admin-${u.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium leading-tight">{u.displayName}</div>
                <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                  Из личного счёта партнёра
                </div>
              </div>
              {account === u.id && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
            </button>
          ))}
        </div>

        {/* Company balance hint */}
        {isCompany && (
          <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
            <span>Баланс счёта компании</span>
            <span
              className="font-bold tabular-nums"
              data-testid={`${testIdPrefix}-company-balance-hint`}
            >
              {fmtUsdt(companyBalance)} USDT
            </span>
          </div>
        )}
      </div>

      {/* Currency selector — locked to USDT for the company account. Hidden
          entirely for settle dialogs (task-remove-settle-currency): the
          obligation currency is always USDT, so there is nothing to pick. */}
      {!hideCurrency && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Валюта</Label>
          <Select
            value={currency ?? 'USDT'}
            onValueChange={(v) => onSelectCurrency?.(v as Currency)}
            disabled={isCompany}
          >
            <SelectTrigger className="h-9 text-sm" data-testid={`${testIdPrefix}-currency-trigger`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedCurrencies.map((c) => (
                <SelectItem
                  key={c}
                  value={c}
                  className="text-sm"
                  data-testid={`${testIdPrefix}-currency-${c}`}
                >
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isCompany && (
            <p className="text-[11px] text-muted-foreground">Спишется со счёта компании в USDT</p>
          )}
        </div>
      )}
    </>
  )
}
