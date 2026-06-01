/**
 * Drop role - phase 4-C. ACCOUNTANT / ADMIN view of TOV-owed senior IOUs.
 *
 * Each item exposes a «Выплатить из ТОВ» button calling
 * /api/pending-settlements/:id/settle-tov which inserts EXPENSE (FIAT_TOV) +
 * SENIOR_PAID and patches the obligation to PAID. The button is disabled
 * with a tooltip when the running TOV balance is insufficient.
 *
 * Hidden when there are no open TOV debts.
 */
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatAmountUsd } from '@/lib/format-amount'
import { financeApi } from '../api'

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { message?: unknown } } }).response
    const msg = resp?.data?.message
    if (typeof msg === 'string') return msg
    if (Array.isArray(msg)) return msg.join(', ')
  }
  if (err instanceof Error) return err.message
  return 'Неизвестная ошибка'
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function PendingSettlementTovCard() {
  const qc = useQueryClient()
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['pending-settlements-tov'],
    queryFn: () => financeApi.listTovPendingSettlements(),
    staleTime: 15_000,
  })

  // TOV balance — we use it to disable the «Выплатить» button when the
  // corporate account is short. Fetched once, refreshed when any settle
  // mutation runs (cache invalidation hits ['tov-balance']).
  const { data: tov } = useQuery({
    queryKey: ['tov-balance', 'usd'],
    queryFn: () => financeApi.getTOVBalance('USD'),
    staleTime: 30_000,
  })

  // Per-row "is the balance enough" — items are USDT-denominated in spec, so
  // we compare nominal amounts. Soft cushion of 1e-6 avoids FP false-blocks.
  const insufficient = useMemo(() => {
    const tovBal = tov?.balance ?? Infinity
    const map = new Map<string, boolean>()
    for (const it of items) {
      const owed = parseFloat(it.amount)
      map.set(it.obligationId, Number.isFinite(owed) && tovBal + 1e-6 < owed)
    }
    return map
  }, [tov, items])

  const settle = useMutation({
    mutationFn: (obligationId: string) => financeApi.settleObligationByTov(obligationId),
    onSuccess: () => {
      toast.success('Выплата проведена')
      void qc.invalidateQueries({ queryKey: ['pending-settlements-tov'] })
      void qc.invalidateQueries({ queryKey: ['pending-settlements-senior'] })
      void qc.invalidateQueries({ queryKey: ['pending-obligations'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['tov-balance', 'usd'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  if (!isLoading && items.length === 0) return null

  return (
    <Card className="border-emerald-500/40" data-testid="pending-settlement-tov-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-emerald-400" />
          Долги ТОВ перед синьорами
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Senior-доля от bank-канала. Выплатите из ТОВ-баланса, чтобы закрыть IOU и зачислить
          средства синьору.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Загрузка…</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const disabled = settle.isPending || insufficient.get(it.obligationId) === true
              const tooltipText =
                insufficient.get(it.obligationId) === true
                  ? 'Недостаточно средств на ТОВ'
                  : 'Списать сумму с ТОВ и закрыть IOU'
              return (
                <li
                  key={it.obligationId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  data-testid={`pending-settlement-tov-item-${it.obligationId}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {it.projectName ?? '— без проекта —'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Синьор:{' '}
                      <span
                        className="font-medium"
                        data-testid="pending-settlement-tov-senior-name"
                      >
                        {it.seniorName}
                      </span>{' '}
                      · {fmtDate(it.createdAt)}
                    </p>
                  </div>
                  <div
                    className="text-sm font-bold tabular-nums"
                    data-testid="pending-settlement-tov-amount"
                  >
                    {formatAmountUsd(it.amount, it.currency)}
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            size="sm"
                            variant="default"
                            disabled={disabled}
                            onClick={() => settle.mutate(it.obligationId)}
                            data-testid={`pending-settlement-tov-settle-button-${it.obligationId}`}
                          >
                            {settle.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5 mr-1" />
                            )}
                            Выплатить из ТОВ
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{tooltipText}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
