/**
 * task-drop-company-debt-and-invoices.
 *
 * ADMIN / ACCOUNTANT view of pending COMPANY debts to seniors. Shown on
 * /crm/finance only — DROP no longer holds (or closes) senior debts after
 * the refactor.
 *
 * Each item exposes a «Выплатить синьору» button that calls
 * POST /api/pending-settlements/:id/settle-company. The backend:
 *   - inserts a SENIOR_INCOME (status=PAID) crediting the senior balance,
 *   - patches the obligation → status=PAID,
 *   - auto-generates a signable invoice for the senior (same trigger as
 *     payPayoutRequest).
 *
 * Hidden when there are no open COMPANY debts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, Loader2 } from 'lucide-react'
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

export function PendingSettlementCompanyCard() {
  const qc = useQueryClient()
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['pending-settlements-company'],
    queryFn: () => financeApi.listCompanyPendingSettlements(),
    staleTime: 15_000,
  })

  const settle = useMutation({
    mutationFn: (obligationId: string) => financeApi.settleObligationByCompany(obligationId),
    onSuccess: () => {
      toast.success('Выплата проведена')
      void qc.invalidateQueries({ queryKey: ['pending-settlements-company'] })
      void qc.invalidateQueries({ queryKey: ['pending-settlements-senior'] })
      void qc.invalidateQueries({ queryKey: ['pending-obligations'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['profile-transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  if (!isLoading && items.length === 0) return null

  return (
    <Card className="border-amber-500/40" data-testid="pending-settlement-company-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-amber-400" />
          Долги компании перед синьорами
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Senior-доля от дроп-проекта. Закройте оплатив синьору кнопкой «Выплатить синьору» — инвойс
          сгенерируется автоматически.
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
                data-testid={`pending-settlement-company-item-${it.obligationId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {it.projectName ?? '— без проекта —'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Синьор:{' '}
                    <span
                      className="font-medium"
                      data-testid="pending-settlement-company-senior-name"
                    >
                      {it.seniorName}
                    </span>{' '}
                    · {fmtDate(it.createdAt)}
                  </p>
                </div>
                <div
                  className="text-sm font-bold tabular-nums"
                  data-testid="pending-settlement-company-amount"
                >
                  {formatAmountUsd(it.amount, it.currency)}
                </div>
                <Button
                  size="sm"
                  variant="default"
                  disabled={settle.isPending}
                  onClick={() => settle.mutate(it.obligationId)}
                  data-testid={`pending-settlement-company-settle-button-${it.obligationId}`}
                >
                  {settle.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  )}
                  Выплатить синьору
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
