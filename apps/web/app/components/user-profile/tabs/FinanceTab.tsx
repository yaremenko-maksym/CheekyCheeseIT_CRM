import { useQuery } from '@tanstack/react-query'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/axios'

export function FinanceTab({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user-finance', userId],
    queryFn: () =>
      api
        .get(`/finance/transactions?userId=${userId}`)
        .then((r) => r.data)
        .catch(() => ({ transactions: [] })),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  const txs = (data as { transactions?: unknown[] })?.transactions ?? []
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
      <CardContent className="pt-6">
        <pre className="overflow-auto text-xs">{JSON.stringify(txs, null, 2)}</pre>
      </CardContent>
    </Card>
  )
}
