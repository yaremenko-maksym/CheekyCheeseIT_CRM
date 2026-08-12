import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/axios'
import { cn, normalizeDecimalInput } from '@/lib/utils'

export const CURRENCIES = ['USDT', 'USD', 'EUR', 'UAH'] as const
export type Currency = (typeof CURRENCIES)[number]

type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

function toUsd(amount: number, currency: Currency, rates: ExchangeRates): number {
  if (currency === 'USD' || currency === 'USDT') return amount
  if (currency === 'EUR') return amount * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return amount / parseFloat(rates.usdUah)
  return amount
}

function fmtRateDate(date: string): string {
  // Backend (nbu-currency.service.ts) returns YYYYMMDD compact format
  // (e.g. "20260522") because that's what the NBU API uses. JS Date()
  // constructor doesn't parse this — convert to ISO YYYY-MM-DD first.
  if (!date) return ''
  const iso = /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function AmountCurrencyInput({
  amount,
  currency,
  onAmountChange,
  onCurrencyChange,
  label = 'Сумма',
  currencyLabel = 'Валюта',
  placeholder = '0.00',
  inputClassName,
  disabled,
  disableCurrency,
  disableAmount,
  error,
  errorTestId,
}: {
  amount: string | number
  currency: Currency
  onAmountChange: (v: string) => void
  onCurrencyChange: (v: Currency) => void
  label?: string
  currencyLabel?: string
  placeholder?: string
  inputClassName?: string
  /** Disables BOTH the amount input and the currency selector. */
  disabled?: boolean
  /**
   * Lock the currency selector only while keeping the amount input editable.
   * Used when the funding source mandates a fixed currency (e.g. COMPANY_ACCOUNT → USDT).
   */
  disableCurrency?: boolean
  /**
   * task-drop-payout-currency: lock ONLY the amount input, leaving the
   * currency selector active — the opposite pairing from `disableCurrency`.
   * Used when the shown figure is a server-computed conversion the caller
   * must not hand-edit, but the currency it is expressed in is still a real
   * choice (e.g. «Выплатить дропу» — the payout is recalculated, not typed).
   * Independent of `disabled`/`disableCurrency`: it does NOT touch the
   * currency `<Select>`.
   */
  disableAmount?: boolean
  /** Inline validation message rendered under the amount input. */
  error?: string | undefined
  /** data-testid for the error <p> (caller-supplied for E2E). */
  errorTestId?: string | undefined
}) {
  const needsRate = currency === 'EUR' || currency === 'UAH' || currency === 'USD'

  // ut-20: cache key is the **calendar day** (YYYY-MM-DD) — so when the
  // browser tab survives past midnight, the query auto-invalidates and
  // refetches today's NBU rate instead of showing yesterday's cached value.
  const todayKey = new Date().toISOString().slice(0, 10)

  const { data: rates, isFetching } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', todayKey],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60 * 24,
    enabled: needsRate,
  })

  const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount
  const convertedUsd =
    rates && !isNaN(amountNum) && amountNum > 0
      ? toUsd(amountNum, currency, rates).toFixed(2)
      : null

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_110px] gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <Input
            value={amount}
            onChange={(e) => onAmountChange(normalizeDecimalInput(e.target.value))}
            onKeyDown={(e) => e.key === '-' && e.preventDefault()}
            placeholder={placeholder}
            type="text"
            inputMode="decimal"
            disabled={disabled || disableAmount}
            data-testid="amount-currency-amount-input"
            className={cn('h-9 text-sm', error && 'border-destructive', inputClassName)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{currencyLabel}</Label>
          <Select
            value={currency}
            onValueChange={(v) => onCurrencyChange(v as Currency)}
            disabled={(disabled ?? false) || (disableCurrency ?? false)}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c} className="text-sm">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-destructive" data-testid={errorTestId}>
          {error}
        </p>
      )}

      {/* USDT peg notice */}
      {currency === 'USDT' && (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
          <span className="font-medium">1 USDT = 1 USD</span>
          <span className="text-muted-foreground">· ERC-20, привязан к доллару</span>
        </div>
      )}

      {/* Conversion hint for EUR/UAH/USD */}
      {needsRate && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
            isFetching ? 'border-border/50' : 'border-blue-500/20 bg-blue-500/5 text-blue-400',
          )}
        >
          {isFetching ? (
            <Skeleton className="h-3.5 w-48 rounded" />
          ) : rates ? (
            <>
              {convertedUsd && currency !== 'USD' && (
                <span className="font-medium">≈ ${convertedUsd} USD&nbsp;·&nbsp;</span>
              )}
              <span className={currency !== 'USD' ? 'text-muted-foreground' : 'font-medium'}>
                {currency === 'EUR'
                  ? `1 EUR = ${(parseFloat(rates.eurUah) / parseFloat(rates.usdUah)).toFixed(4)} USD`
                  : currency === 'USD'
                    ? '1 USD = 1 USD'
                    : `1 USD = ${parseFloat(rates.usdUah).toFixed(2)} UAH`}
              </span>
              <span className="ml-auto text-muted-foreground/60">{fmtRateDate(rates.date)}</span>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
