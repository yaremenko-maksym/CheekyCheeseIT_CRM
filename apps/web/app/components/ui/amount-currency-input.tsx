import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'

export const CURRENCIES = ['USDT', 'USD', 'EUR', 'UAH'] as const
export type Currency = typeof CURRENCIES[number]

type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

function toUsd(amount: number, currency: Currency, rates: ExchangeRates): number {
  if (currency === 'USD' || currency === 'USDT') return amount
  if (currency === 'EUR') return amount * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return amount / parseFloat(rates.usdUah)
  return amount
}

function fmtRateDate(date: string) {
  return new Date(date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
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
}: {
  amount: string | number
  currency: Currency
  onAmountChange: (v: string) => void
  onCurrencyChange: (v: Currency) => void
  label?: string
  currencyLabel?: string
  placeholder?: string
  inputClassName?: string
  disabled?: boolean
}) {
  const needsRate = currency === 'EUR' || currency === 'UAH' || currency === 'USD'

  const { data: rates, isFetching } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60 * 24,
    enabled: needsRate,
  })

  const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount
  const convertedUsd = rates && !isNaN(amountNum) && amountNum > 0
    ? toUsd(amountNum, currency, rates).toFixed(2)
    : null

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_110px] gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <Input
            value={amount}
            onChange={(e) => onAmountChange(e.target.value.replace(/[^0-9.]/g, ''))}
            onKeyDown={(e) => e.key === '-' && e.preventDefault()}
            placeholder={placeholder}
            type="number"
            min="0"
            step="0.01"
            disabled={disabled}
            className={cn('h-9 text-sm', inputClassName)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{currencyLabel}</Label>
          <Select value={currency} onValueChange={(v) => onCurrencyChange(v as Currency)} disabled={disabled ?? false}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c} className="text-sm">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* USDT peg notice */}
      {currency === 'USDT' && (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
          <span className="font-medium">1 USDT = 1 USD</span>
          <span className="text-muted-foreground">· ERC-20, привязан к доллару</span>
        </div>
      )}

      {/* Conversion hint for EUR/UAH/USD */}
      {needsRate && (
        <div className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
          isFetching ? 'border-border/50' : 'border-blue-500/20 bg-blue-500/5 text-blue-400',
        )}>
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
