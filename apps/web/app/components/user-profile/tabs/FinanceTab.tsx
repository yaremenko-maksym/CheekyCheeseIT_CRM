import { useMemo, useState } from 'react'
import { Plus, Search, Send, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { TransactionDto } from '@crm/shared'
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
import { financeApi } from '@/routes/crm/finance/api'
import { STATUS_LABELS, TYPE_LABELS, type ExchangeRates } from '@/routes/crm/finance/constants'
import { TransactionRow } from '@/routes/crm/finance/components/TransactionRow'
import { TransactionDetailDialog } from '@/routes/crm/finance/components/dialogs/TransactionDetailDialog'
import { CreateTransactionDialog } from '@/routes/crm/finance/components/dialogs/CreateTransactionDialog'

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
export function FinanceTab({ userId }: { userId: string }) {
  const { user: viewer } = useAuth()
  const navigate = useNavigate()
  const role = viewer?.role ?? ''
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  // Drop role - phase 2. When the DROP user is viewing their own profile,
  // expose «Добавить приход» CTA that reuses CreateTransactionDialog
  // (it auto-selects DROP_INCOME for the role). Other roles never see
  // the button on this tab.
  const isOwnDropProfile = role === 'DROP' && viewer?.id === userId
  // Drop role - phase 4-B. «Платить компании» appears on every VALIDATED
  // DROP_INCOME row of the profile owner — but only the owner-DROP themselves
  // and privileged ADMIN/ACCOUNTANT see the action.
  const showInitiatePaymentForDrop =
    (isOwnDropProfile || isPrivileged) && (role === 'DROP' || isPrivileged)
  const [createOpen, setCreateOpen] = useState(false)

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

  // Drop role - phase 4-B. Surface DROP_INCOME rows awaiting settlement so the
  // drop / accountant can launch the «Платить компании» flow per row without
  // hunting through filters first. Only VALIDATED rows (no payment cascade
  // yet) are actionable.
  const actionableDropIncomes = useMemo(() => {
    if (!showInitiatePaymentForDrop) return []
    return transactions.filter(
      (tx) =>
        tx.type === 'DROP_INCOME' &&
        tx.status === 'VALIDATED' &&
        (tx.recipientId === userId || tx.receiverId === userId),
    )
  }, [transactions, showInitiatePaymentForDrop, userId])

  if (isLoading) return <Skeleton className="h-64 w-full" />

  if (transactions.length === 0) {
    return (
      <>
        {isOwnDropProfile && (
          <div className="mb-3 flex justify-end">
            <Button
              size="sm"
              onClick={() => setCreateOpen(true)}
              data-testid="profile-drop-income-button"
            >
              <Plus className="h-4 w-4 mr-1" /> Добавить приход
            </Button>
          </div>
        )}
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Транзакций пока нет
          </CardContent>
        </Card>
        <CreateTransactionDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      </>
    )
  }

  return (
    <>
      {isOwnDropProfile && (
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            data-testid="profile-drop-income-button"
          >
            <Plus className="h-4 w-4 mr-1" /> Добавить приход
          </Button>
        </div>
      )}
      {actionableDropIncomes.length > 0 && (
        <Card className="mb-3 border-emerald-500/40" data-testid="actionable-drop-incomes-card">
          <CardContent className="py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Приходы, ожидающие оплаты компании
            </p>
            <ul className="space-y-1.5">
              {actionableDropIncomes.map((tx) => (
                <li
                  key={tx.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2"
                  data-testid={`actionable-drop-income-${tx.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {tx.projectName ?? tx.senderLabel ?? 'Drop income'}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {tx.amount} {tx.currency}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() =>
                      void navigate({
                        to: '/crm/payments/initiate/$incomeId',
                        params: { incomeId: tx.id },
                      })
                    }
                    data-testid={`pay-company-button-${tx.id}`}
                  >
                    <Send className="h-3.5 w-3.5 mr-1" /> Платить компании
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
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
      <CreateTransactionDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  )
}
