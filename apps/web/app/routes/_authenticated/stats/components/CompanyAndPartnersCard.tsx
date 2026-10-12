import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, Coins, HelpCircle, Info } from 'lucide-react'
import { Trans } from '@lingui/react/macro'

import type { FinanceSummaryDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { companyAccountApi } from '../../finance/api'

// USDT balance formatting + short address — mirrors the (removed) CompanyAccountCard
// so the company-account KPI reads identically on /stats.
export function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}
// ── Partner share computation (audit 2026-06-28 #14) ──────────────────────────
// The share % is computed over Σ|balance| so it can never go negative/garbled. A
// partner with a negative HOLDING balance (or a non-positive total) shows «—» as
// its label and the bar uses the absolute magnitude. Exported pure so the unit
// test pins the contract without rendering the route.
export function partnerShare(balance: number, absTotal: number): { label: string; barPct: number } {
  const hasShare = absTotal > 0 && balance >= 0
  const pct = hasShare ? Math.round((balance / absTotal) * 100) : 0
  const barPct = absTotal > 0 ? Math.round((Math.abs(balance) / absTotal) * 100) : 0
  return { label: hasShare ? `${pct}%` : '—', barPct }
}

// ── Combined Company + Partners balance card ──────────────────────────────────
// Merges CompanyAccountKpi (USDT счёт компании) and PartnerBalancesCard into
// one Card with two sections separated by a divider. Shown for both ADMIN and
// ACCOUNTANT; the partner-balances section renders only for ADMIN.

export function CompanyAndPartnersCard({
  summary,
  isAdmin,
}: {
  summary: FinanceSummaryDto
  isAdmin: boolean
}) {
  const { data: account, isLoading: accountLoading } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
  })

  // Partner balances are ADMIN-only: for any other viewer `sorted` stays empty, which
  // also keeps the partner section below hidden (single gate: `sorted.length > 0`).
  const sorted = isAdmin ? [...summary.adminBalances].sort((a, b) => b.balance - a.balance) : []
  // The richest and poorest partner, when there are two distinct ones to settle between.
  const settlement =
    sorted.length >= 2 && sorted[0]!.userId !== sorted[sorted.length - 1]!.userId
      ? {
          rich: sorted[0]!,
          poor: sorted[sorted.length - 1]!,
          debt: Math.abs(sorted[0]!.balance - sorted[sorted.length - 1]!.balance) / 2,
        }
      : null
  const total = sorted.reduce((s, b) => s + b.balance, 0)
  // Audit 2026-06-28 (#14): the share % must be computed over the sum of ABSOLUTE
  // balances. A partner with a negative HOLDING balance (or a net total ≤ 0) made
  // `balance / total` render a negative / garbled percentage. `absTotal` keeps the
  // denominator positive; a negative balance renders «—» instead of a bogus %.
  const absTotal = sorted.reduce((s, b) => s + Math.abs(b.balance), 0)

  return (
    <Card
      className="overflow-hidden flex flex-col h-full"
      data-testid="stats-company-partners-card"
    >
      {/* ── Секція 1: Рахунок компанії (USDT) ── */}
      <div data-testid="stats-company-account-balance">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Coins className="h-4 w-4 text-yellow-500" aria-hidden="true" />
              <Trans>Рахунок компанії · USDT</Trans>
            </CardTitle>
            <TooltipProvider delayDuration={200}>
              <UITooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-60 text-xs leading-relaxed">
                  <Trans>
                    Накопичений USDT-баланс на рахунку компанії — поповнюється через підтверджені
                    виплати (метод «Рахунок компанії») і зменшується виведенням дивідендів.
                  </Trans>
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {accountLoading ? (
            <div className="space-y-1.5">
              <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
              <div className="h-3.5 w-24 rounded bg-muted animate-pulse" />
            </div>
          ) : (
            <div className="space-y-0.5">
              <p className="text-2xl font-bold tabular-nums text-yellow-500">
                {account ? `${fmtUsdt(account.balance)} USDT` : '—'}
              </p>
              {account?.walletAddress && (
                <p className="text-xs text-muted-foreground font-mono">
                  {shortAddress(account.walletAddress)}
                </p>
              )}
              {!account?.walletAddress && (
                <p className="text-xs text-muted-foreground">
                  <Trans>Гаманець не налаштовано</Trans>
                </p>
              )}
            </div>
          )}
        </CardContent>
      </div>

      {/* ── Секція 2: Баланси партнерів (лише ADMIN) ── */}
      {sorted.length > 0 && (
        <>
          <div className="h-px bg-border/60 mx-4" />
          <CardHeader className="pb-2 pt-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-semibold">
                  <Trans>Баланси партнерів</Trans>
                </CardTitle>
                <TooltipProvider delayDuration={200}>
                  <UITooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-60 text-xs leading-relaxed">
                      <Trans>
                        Накопичений баланс кожного партнера: усі оплачені надходження та дохід
                        адмінів мінус перекази між адмінами.
                      </Trans>
                    </TooltipContent>
                  </UITooltip>
                </TooltipProvider>
              </div>
              <span className="text-xs text-muted-foreground">
                <Trans>Разом</Trans>:{' '}
                <span className="font-semibold text-foreground">
                  $
                  {total.toLocaleString('en-US', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
              </span>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3" data-testid="stats-partner-balances">
            {/* Balance bars */}
            <div className="space-y-2.5">
              {sorted.map((ab, i) => {
                // Audit 2026-06-28 (#14): share over Σ|balance| (see partnerShare)
                // so the % can never go negative/garbled; a negative balance shows
                // «—» (its dollar figure already styles red below). The bar uses a
                // positive magnitude width clamped to ≥2%.
                const { label: shareLabel, barPct } = partnerShare(ab.balance, absTotal)
                const isLeading = i === 0
                return (
                  <div key={ab.userId} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            'h-2.5 w-2.5 rounded-full shrink-0',
                            isLeading ? 'bg-violet-500' : 'bg-sky-500',
                          )}
                        />
                        <span className="font-medium">{ab.displayName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{shareLabel}</span>
                        <span
                          className={cn(
                            'font-bold tabular-nums',
                            ab.balance >= 0 ? 'text-foreground' : 'text-red-400',
                          )}
                        >
                          $
                          {ab.balance.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          isLeading ? 'bg-violet-500' : 'bg-sky-500',
                        )}
                        style={{ width: `${Math.max(2, barPct)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="h-px bg-border/60" />

            {/* Settlement block */}
            {settlement === null || settlement.debt <= 0.01 ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/8 border border-emerald-500/20 px-3 py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 shrink-0">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-xs font-medium text-emerald-400">
                    <Trans>Баланси вирівняно</Trans>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    <Trans>Ніхто нікому не винен</Trans>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-amber-500/10">
                  <Info className="h-3 w-3 text-amber-400/70 shrink-0" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                    <Trans>Для вирівнювання</Trans>
                  </span>
                </div>
                <div className="px-3 py-3 flex items-center gap-3">
                  {/* Sender */}
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                    <div className="h-8 w-8 rounded-full bg-violet-500/15 flex items-center justify-center text-xs font-bold text-violet-400">
                      {settlement.rich.displayName.charAt(0)}
                    </div>
                    <span
                      className="text-[11px] font-medium text-center leading-tight truncate w-full text-center"
                      title={settlement.rich.displayName}
                    >
                      {settlement.rich.displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      <Trans>надсилає</Trans>
                    </span>
                  </div>
                  {/* Arrow + amount */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0">
                    <span className="text-lg font-black tabular-nums text-amber-400">
                      $
                      {settlement.debt.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <div className="flex items-center gap-0.5 text-amber-500/60">
                      <div className="h-px w-6 bg-amber-500/40" />
                      <ArrowRight className="h-3.5 w-3.5" />
                      <div className="h-px w-6 bg-amber-500/40" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">USDT</span>
                  </div>
                  {/* Receiver */}
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                    <div className="h-8 w-8 rounded-full bg-sky-500/15 flex items-center justify-center text-xs font-bold text-sky-400">
                      {settlement.poor.displayName.charAt(0)}
                    </div>
                    <span
                      className="text-[11px] font-medium text-center leading-tight truncate w-full text-center"
                      title={settlement.poor.displayName}
                    >
                      {settlement.poor.displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      <Trans>отримує</Trans>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </>
      )}
    </Card>
  )
}
