/**
 * Drop role - phase 4-C. SENIOR view of pending senior IOUs.
 *
 * Passive list — the SENIOR sees what's owed to them (debtor=DROP or
 * debtor=TOV) and waits for the DROP or ACCOUNTANT to close it. There is
 * no action button on this card — the closure is triggered by the debtor
 * side. Hidden when the list is empty.
 *
 * Also doubles as the «общий список ожидающих» for ADMIN/ACCOUNTANT who
 * may want to see every open senior debt across the system; the same
 * /pending-settlements/senior endpoint returns the role-appropriate slice.
 */
import { useQuery } from '@tanstack/react-query'
import { HandCoins } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAmountUsd } from '@/lib/format-amount'
import { financeApi } from '../api'

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

export function PendingSettlementSeniorCard() {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['pending-settlements-senior'],
    queryFn: () => financeApi.listSeniorPendingSettlements(),
    staleTime: 15_000,
  })

  if (!isLoading && items.length === 0) return null

  return (
    <Card className="border-sky-500/40" data-testid="pending-settlement-senior-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <HandCoins className="h-4 w-4 text-sky-400" />
          Ожидают зачисления
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Senior-доля от дропа или ТОВ. Закроется автоматически, когда дроп заплатит или бухгалтер
          обработает выплату.
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
                data-testid={`pending-settlement-senior-item-${it.obligationId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {it.projectName ?? '— без проекта —'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Должник:{' '}
                    <span className="font-medium" data-testid="pending-settlement-senior-debtor">
                      {it.debtorType === 'TOV' ? 'ТОВ' : `Дроп · ${it.debtorName ?? '—'}`}
                    </span>{' '}
                    · {fmtDate(it.createdAt)}
                  </p>
                </div>
                <div
                  className="text-sm font-bold tabular-nums"
                  data-testid="pending-settlement-senior-amount"
                >
                  {formatAmountUsd(it.amount, it.currency)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
