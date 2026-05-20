import { useQuery } from '@tanstack/react-query'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/axios'

interface Tx {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  createdAt: string
  notes: string | null
  projectName: string | null
  senderName: string | null
  receiverName: string | null
}

const TYPE_LABELS: Record<string, string> = {
  SALARY: 'Зарплата',
  SENIOR_INCOME: 'Доход с проекта',
  ADMIN_INCOME: 'Доход админа',
  ADMIN_TRANSFER: 'Перевод',
  EXPENSE: 'Расход',
  PAYOUT: 'Выплата',
  PAYOUT_ADMIN: 'Выплата партнёру',
}

const STATUS_VARIANT: Record<string, 'default' | 'outline' | 'secondary'> = {
  PAID: 'default',
  VALIDATED: 'secondary',
  PENDING: 'outline',
  PENDING_PAYMENT: 'outline',
  REJECTED: 'outline',
}

export function FinanceTab({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user-transactions', userId],
    queryFn: () =>
      api
        .get<Tx[]>(`/users/${userId}/transactions`)
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  const txs = data ?? []

  if (txs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Транзакций пока нет
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {txs.map((tx) => (
          <div key={tx.id} className="flex items-start justify-between gap-3 rounded border p-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-medium">{TYPE_LABELS[tx.type] ?? tx.type}</p>
              <p className="truncate text-xs text-muted-foreground">
                {new Date(tx.createdAt).toLocaleDateString('ru-RU')}
                {tx.projectName ? ` · ${tx.projectName}` : ''}
                {tx.notes ? ` · ${tx.notes}` : ''}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono font-semibold">
                {tx.amount} {tx.currency}
              </p>
              <Badge variant={STATUS_VARIANT[tx.status] ?? 'outline'} className="mt-1 text-xs">
                {tx.status}
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
