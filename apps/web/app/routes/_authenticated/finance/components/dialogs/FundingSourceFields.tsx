import { useMemo } from 'react'
import { AlertCircle } from 'lucide-react'
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
  disableCompanyAccount = false,
  disableCompanyAccountReason,
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
  /**
   * security-review PR #443 (HIGH-1): disables the «Счёт компании» option and
   * shows `disableCompanyAccountReason` as an inline warning. SettleSeniorPayoutDialog
   * sets this for a cascade-originated drop obligation — that money never
   * touched the company pool (see pending-settlement.service.ts's
   * server-side HIGH-1 guard, the real authority; this is the UI mirror so a
   * user never even reaches the 400). Always false for PaySalaryDialog.
   */
  disableCompanyAccount?: boolean
  disableCompanyAccountReason?: string | undefined
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
          {/* Company account — default, UNLESS disableCompanyAccount (HIGH-1:
              a cascade-originated drop obligation's money never touched the
              company pool — the server rejects this funding choice too). */}
          <button
            type="button"
            disabled={disableCompanyAccount}
            aria-disabled={disableCompanyAccount}
            onClick={() => {
              if (!disableCompanyAccount) onSelectAccount(COMPANY_ACCOUNT_VALUE)
            }}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
              disableCompanyAccount
                ? 'cursor-not-allowed border-border bg-muted/10 text-muted-foreground/60 opacity-60'
                : isCompany
                  ? 'border-primary bg-primary/8 text-foreground'
                  : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
            )}
            data-testid={`${testIdPrefix}-account-company`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">Счёт компании</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {disableCompanyAccount
                  ? (disableCompanyAccountReason ?? 'Недоступно для этой выплаты')
                  : 'Спишется со счёта компании (USDT)'}
              </div>
            </div>
            {isCompany && !disableCompanyAccount && (
              <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
            )}
          </button>

          {disableCompanyAccount && disableCompanyAccountReason && (
            <div
              className="flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400"
              data-testid={`${testIdPrefix}-company-disabled-reason`}
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{disableCompanyAccountReason}</span>
            </div>
          )}

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
