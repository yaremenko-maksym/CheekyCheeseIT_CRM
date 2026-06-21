import { useMemo, useState } from 'react'
import { Search, Wallet, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Role, TransactionDto, TotalEarnedDto } from '@crm/shared'
import { totalEarnedSchema } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { formatAmount } from '@/lib/format-amount'
import { financeApi } from '@/routes/crm/finance/api'
import { STATUS_LABELS, TYPE_LABELS, type ExchangeRates } from '@/routes/crm/finance/constants'
import { TransactionRow } from '@/routes/crm/finance/components/TransactionRow'
import { TransactionDetailDialog } from '@/routes/crm/finance/components/dialogs/TransactionDetailDialog'

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))

/**
 * Finance tab inside the user profile.
 *
 * Reuses the /crm/finance TransactionRow + TransactionDetailDialog so the
 * list / row layout / detail dialog match the dedicated finance page. We
 * filter the transactions client-side by sender/receiver matching the
 * profile owner so the same component works for any viewer (ADMIN sees
 * the full unfiltered list when looking at any senior; SENIOR self-view
 * sees only their own).
 */
// Roles for which «всего заработано с нами» is a meaningful figure (people the
// company actually pays: senior payouts / drop shares / junior+HR salary).
// ADMIN targets are intentionally excluded — admins are partners, not payees.
const EARNED_TARGET_ROLES: ReadonlyArray<Role> = ['SENIOR', 'DROP', 'JUNIOR', 'HR']

export function FinanceTab({ userId, targetRole }: { userId: string; targetRole?: Role }) {
  const { user: viewer } = useAuth()
  const role = viewer?.role ?? ''
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  // «Всего заработано» is a privileged financial metric: only ADMIN / ACCOUNTANT
  // viewers see it, and only on SENIOR / DROP / JUNIOR / HR profiles. Other
  // viewers (incl. the target self-viewing) never get the figure — the backend
  // also enforces this (assertCanReadTotalEarned → 403), so the query is the
  // belt-and-suspenders second layer to the server guard.
  const showTotalEarned = isPrivileged && !!targetRole && EARNED_TARGET_ROLES.includes(targetRole)

  const { data: totalEarned } = useQuery<TotalEarnedDto>({
    queryKey: ['profile-total-earned', userId],
    queryFn: () =>
      api.get(`/balances/total-earned/${userId}`).then((r) => totalEarnedSchema.parse(r.data)),
    enabled: showTotalEarned,
    staleTime: 60_000,
  })

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['profile-transactions', userId, role],
    // ADMIN / ACCOUNTANT: use the privileged /users/:id/transactions endpoint
    // which returns every tx the target was part of. For SENIOR self-view
    // (and other roles looking at their own finances) we fall back to the
    // public /transactions endpoint and client-filter by sender/receiver.
    queryFn: () =>
      isPrivileged
        ? api
            .get<TransactionDto[]>(`/users/${userId}/transactions`)
            .then((r) => r.data)
            .catch(() => [])
        : financeApi
            .getTransactions()
            .then((list) => list.filter((t) => t.senderId === userId || t.receiverId === userId)),
    staleTime: 30_000,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [detailTx, setDetailTx] = useState<TransactionDto | null>(null)

  const filtered = useMemo(() => {
    return transactions
      .filter((tx) => {
        if (typeFilter !== 'all' && tx.type !== typeFilter) return false
        if (statusFilter !== 'all' && tx.status !== statusFilter) return false
        if (search) {
          const q = search.toLowerCase()
          const haystack = [
            tx.senderName,
            tx.receiverName,
            tx.senderLabel,
            tx.receiverLabel,
            tx.projectName,
            tx.notes,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(q)) return false
        }
        return true
      })
      .sort(
        (a, b) =>
          new Date(b.txDate ?? b.createdAt).getTime() - new Date(a.txDate ?? a.createdAt).getTime(),
      )
  }, [transactions, search, typeFilter, statusFilter])

  const hasActive = search !== '' || typeFilter !== 'all' || statusFilter !== 'all'

  // «Всего заработано с нами» card — lifetime money the company paid this user.
  // Rendered above the transactions list, visible to ADMIN / ACCOUNTANT only on
  // SENIOR / DROP / JUNIOR / HR profiles (see showTotalEarned). Shown in both the
  // empty-state and the populated branch so the figure is consistent regardless
  // of whether the row list is non-empty.
  const earnedCard =
    showTotalEarned && totalEarned ? (
      <Card className="mb-3 border-primary/30 bg-primary/5" data-testid="total-earned-card">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Всего заработано с нами
              </p>
              <p className="text-xs text-muted-foreground/70">
                Накопленные выплаты компании за всё время
              </p>
            </div>
          </div>
          <span
            className="text-2xl font-bold tabular-nums whitespace-nowrap"
            data-testid="total-earned-amount"
          >
            {formatAmount(totalEarned.totalEarned, totalEarned.currency)}
          </span>
        </CardContent>
      </Card>
    ) : null

  if (isLoading) return <Skeleton className="h-64 w-full" />

  if (transactions.length === 0) {
    return (
      <>
        {earnedCard}
        {/* task-drop-company-debt-and-invoices: DROP no longer holds
            debts to seniors — section removed. The company settles via
            /crm/finance (PendingSettlementCompanyCard). */}
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Транзакций пока нет
          </CardContent>
        </Card>
      </>
    )
  }

  return (
    <>
      {earnedCard}
      <Card>
        <CardContent className="p-0">
          {/* Filter bar — same look as /finance */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
            <div className="relative flex-1 min-w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-sm"
                placeholder="Поиск…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 text-xs w-auto min-w-32 max-w-44">
                <SelectValue placeholder="Все типы" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все типы</SelectItem>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 text-xs w-auto min-w-32 max-w-44">
                <SelectValue placeholder="Все статусы" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все статусы</SelectItem>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActive && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-muted-foreground"
                onClick={() => {
                  setSearch('')
                  setTypeFilter('all')
                  setStatusFilter('all')
                }}
              >
                <X className="h-3.5 w-3.5" /> Сбросить
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              {hasActive ? 'Ничего не найдено' : 'Нет данных'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="py-3 px-4 text-left font-medium">Тип</th>
                    <th className="py-3 px-4 text-left font-medium">Участник / Проект</th>
                    <th className="py-3 px-4 text-left font-medium">Сумма</th>
                    <th className="py-3 px-4 text-left font-medium">Дата</th>
                    <th className="py-3 px-4 text-left font-medium">Статус</th>
                    <th className="py-3 px-4 text-left font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      role={role}
                      rates={rates}
                      currentUserId={viewer?.id ?? null}
                      onClick={setDetailTx}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <TransactionDetailDialog tx={detailTx} onClose={() => setDetailTx(null)} />
    </>
  )
}
