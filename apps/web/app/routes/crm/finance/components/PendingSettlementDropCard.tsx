/**
 * Drop role - phase 4-C. DROP view of own debts to seniors (cash-channel
 * leftovers — senior share retained when the drop handed cash to admin).
 *
 * Each item exposes a «Я заплатил синьору» button that calls
 * /api/pending-settlements/:id/settle-drop. Closure happens optimistically
 * via TanStack Query invalidation — the row disappears once the obligation
 * is patched to PAID.
 *
 * Hidden when there are no open DROP debts.
 *
 * Reused on /crm/profile?tab=finance (mounted inside FinanceTab when the
 * profile owner is the DROP themselves OR when an ADMIN/ACCOUNTANT views a
 * DROP profile).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Handshake } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

export function PendingSettlementDropCard() {
  const qc = useQueryClient()
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['pending-settlements-drop'],
    queryFn: () => financeApi.listDropPendingSettlements(),
    staleTime: 15_000,
  })

  const settle = useMutation({
    mutationFn: (obligationId: string) => financeApi.settleObligationByDrop(obligationId),
    onSuccess: () => {
      toast.success('Долг закрыт')
      void qc.invalidateQueries({ queryKey: ['pending-settlements-drop'] })
      void qc.invalidateQueries({ queryKey: ['pending-settlements-senior'] })
      void qc.invalidateQueries({ queryKey: ['pending-obligations'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['profile-transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  if (!isLoading && items.length === 0) return null

  return (
    <Card className="border-rose-500/40" data-testid="pending-settlement-drop-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Handshake className="h-4 w-4 text-rose-400" />
          Долги перед синьорами
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Вы оставили себе senior-долю при передаче нала админу. Закройте долг кнопкой «Я заплатил
          синьору» после оплаты вне платформы.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Загрузка…</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li
                key={it.obligationId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                data-testid={`pending-settlement-drop-item-${it.obligationId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {it.projectName ?? '— без проекта —'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Синьор:{' '}
                    <span className="font-medium" data-testid="pending-settlement-drop-senior-name">
                      {it.seniorName}
                    </span>{' '}
                    · {fmtDate(it.createdAt)}
                  </p>
                </div>
                <div
                  className="text-sm font-bold tabular-nums"
                  data-testid="pending-settlement-drop-amount"
                >
                  {formatAmountUsd(it.amount, it.currency)}
                </div>
                <Button
                  size="sm"
                  variant="default"
                  disabled={settle.isPending}
                  onClick={() => settle.mutate(it.obligationId)}
                  data-testid={`pending-settlement-drop-settle-button-${it.obligationId}`}
                >
                  {settle.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  )}
                  Я заплатил синьору
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
