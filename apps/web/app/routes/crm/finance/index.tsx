import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, ArrowUpDown, ChevronDown, X, Wallet } from 'lucide-react'
import { useCallback, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { cn } from '@/lib/utils'
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
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'

import { api } from '@/lib/axios'
import { financeApi } from './api'
import {
  fmtAmount,
  fmtDate,
  fmtMonth,
  STATUS_COLORS,
  STATUS_LABELS,
  TYPE_LABELS,
  type ExchangeRates,
} from './constants'
import { TransactionRow } from './components/TransactionRow'
import { Pagination } from './components/Pagination'
import { usePaginatedFilter } from './hooks/usePaginatedFilter'
import { CreateTransactionDialog } from './components/dialogs/CreateTransactionDialog'
import { ValidateDialog } from './components/dialogs/ValidateDialog'
import { EditSeniorIncomeDialog } from './components/dialogs/EditSeniorIncomeDialog'
import { PaySalaryDialog } from './components/dialogs/PaySalaryDialog'
import { PayoutDialog } from './components/dialogs/PayoutDialog'
import { TransactionDetailDialog } from './components/dialogs/TransactionDetailDialog'
import { AdminEditTransactionDialog } from './components/dialogs/AdminEditTransactionDialog'
import { MyProjectShares } from './components/MyProjectShares'

export const Route = createFileRoute('/crm/finance/')({
  component: FinancePage,
})

// ── Shared UI primitives ───────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'

function FilterBar({
  search,
  onSearch,
  filterSlot,
  sortSlot,
  onClear,
  hasActive,
}: {
  search: string
  onSearch: (v: string) => void
  filterSlot?: React.ReactNode
  sortSlot?: React.ReactNode
  onClear: () => void
  hasActive: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
      <div className="relative flex-1 min-w-40">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-8 h-8 text-sm"
          placeholder="Поиск…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      {filterSlot}
      {sortSlot}
      {hasActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-muted-foreground"
          onClick={onClear}
        >
          <X className="h-3.5 w-3.5" /> Сбросить
        </Button>
      )}
    </div>
  )
}

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors h-8',
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60',
      )}
    >
      <ArrowUpDown className="h-3 w-3" />
      {label}
      {active && (
        <ChevronDown
          className={cn('h-3 w-3 transition-transform', dir === 'asc' && 'rotate-180')}
        />
      )}
    </button>
  )
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs w-auto min-w-32 max-w-44">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="py-14 text-center text-sm text-muted-foreground">
      {filtered ? 'Ничего не найдено' : 'Нет данных'}
    </div>
  )
}

// ── Transactions table ─────────────────────────────────────────────────────────

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))

type TxSort = 'date' | 'amount'

function TransactionsTable({
  transactions,
  loading,
  role,
  rates,
  currentUserId,
  payoutEligibleIds,
  onValidate,
  onEdit,
  onAdminEdit,
  onDelete,
  onPaySalary,
  onQuickPayout,
  onDetail,
}: {
  transactions: TransactionDto[]
  loading: boolean
  role: string
  rates: ExchangeRates | undefined
  currentUserId?: string | null
  /** Set of tx IDs that the current SENIOR can pay out inline (own VALIDATED rows, no pending payout). */
  payoutEligibleIds: Set<string>
  onValidate: (tx: TransactionDto) => void
  onEdit: (tx: TransactionDto) => void
  onAdminEdit: (tx: TransactionDto) => void
  onDelete: (tx: TransactionDto) => void
  onPaySalary: (tx: TransactionDto) => void
  onQuickPayout: (tx: TransactionDto) => void
  onDetail: (tx: TransactionDto) => void
}) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortKey, setSortKey] = useState<TxSort>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const toggleSort = (key: TxSort) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const filter = useCallback(
    (tx: TransactionDto) => {
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
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    },
    [search, typeFilter, statusFilter],
  )

  const sort = useCallback(
    (a: TransactionDto, b: TransactionDto) => {
      const mul = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'date')
        return (
          mul *
          (new Date(a.txDate ?? a.createdAt).getTime() -
            new Date(b.txDate ?? b.createdAt).getTime())
        )
      return mul * (parseFloat(a.amount) - parseFloat(b.amount))
    },
    [sortKey, sortDir],
  )

  const { paged, page, setPage, totalPages, totalItems, pageSize } = usePaginatedFilter<
    TransactionDto,
    TxSort
  >(transactions, filter, sort)

  const hasActive = search !== '' || typeFilter !== 'all' || statusFilter !== 'all'
  const onClear = () => {
    setSearch('')
    setTypeFilter('all')
    setStatusFilter('all')
  }

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <>
      <FilterBar
        search={search}
        onSearch={setSearch}
        filterSlot={
          <>
            <FilterSelect
              value={typeFilter}
              onChange={setTypeFilter}
              placeholder="Все типы"
              options={TYPE_OPTIONS}
            />
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              placeholder="Все статусы"
              options={STATUS_OPTIONS}
            />
          </>
        }
        sortSlot={
          <div className="flex gap-1.5">
            <SortButton
              label="Дата"
              active={sortKey === 'date'}
              dir={sortDir}
              onClick={() => toggleSort('date')}
            />
            <SortButton
              label="Сумма"
              active={sortKey === 'amount'}
              dir={sortDir}
              onClick={() => toggleSort('amount')}
            />
          </div>
        }
        onClear={onClear}
        hasActive={hasActive}
      />
      {paged.length === 0 ? (
        <EmptyState filtered={hasActive} />
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
              <AnimatePresence mode="popLayout" initial={false}>
                {paged.map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    role={role}
                    rates={rates}
                    currentUserId={currentUserId ?? null}
                    canQuickPayout={payoutEligibleIds.has(tx.id)}
                    onValidate={onValidate}
                    onEdit={onEdit}
                    onAdminEdit={onAdminEdit}
                    onDelete={onDelete}
                    onPaySalary={onPaySalary}
                    onQuickPayout={onQuickPayout}
                    onClick={onDetail}
                  />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        totalItems={totalItems}
        pageSize={pageSize}
        onPage={setPage}
      />
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

function FinancePage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'ACCOUNTANT', 'HR'])
  const { user } = useAuth()
  if (denied) return null
  const role = user?.role ?? ''
  const userId = user?.id ?? ''

  const isAdmin = role === 'ADMIN'
  const isSenior = role === 'SENIOR'
  const isAccountant = role === 'ACCOUNTANT'
  const isJunior = role === 'JUNIOR'
  const isHr = role === 'HR'

  const [showCreate, setShowCreate] = useState(false)
  const [validateTx, setValidateTx] = useState<TransactionDto | null>(null)
  const [editTx, setEditTx] = useState<TransactionDto | null>(null)
  const [adminEditTx, setAdminEditTx] = useState<TransactionDto | null>(null)
  const [deleteTx, setDeleteTx] = useState<TransactionDto | null>(null)
  const [paySalaryTx, setPaySalaryTx] = useState<TransactionDto | null>(null)
  const [showPayout, setShowPayout] = useState(false)
  // Optional preselected tx IDs for PayoutDialog. When set, the dialog opens
  // with these rows already checked (used by inline row button and detail
  // dialog footer). When the header «Выплатить (N)» triggers the dialog it
  // stays undefined so the SENIOR can pick rows manually from the full list.
  const [payoutPreselected, setPayoutPreselected] = useState<string[] | undefined>(undefined)
  const [detailTx, setDetailTx] = useState<TransactionDto | null>(null)

  const openPayoutForTx = useCallback((tx: TransactionDto) => {
    setPayoutPreselected([tx.id])
    setShowPayout(true)
  }, [])

  const closePayoutDialog = useCallback(() => {
    setShowPayout(false)
    setPayoutPreselected(undefined)
  }, [])

  const qc = useQueryClient()
  const deleteMutation = useMutation({
    mutationFn: (id: string) => financeApi.deleteTransaction(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      setDeleteTx(null)
    },
  })

  const canCreate = isAdmin || isSenior
  const showPayoutsTab = isAdmin || isSenior || isAccountant

  const { data: transactions = [], isLoading: txLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  const { data: payouts = [] } = useQuery({
    queryKey: ['payout-requests'],
    queryFn: financeApi.getPayoutRequests,
    enabled: showPayoutsTab,
  })

  const pendingPayoutTxIds = new Set(
    payouts
      .filter((p) => p.status === 'PENDING')
      .flatMap((p) => (p.transactions ?? []).map((t) => t.id)),
  )
  // SENIOR_INCOME flow: sender = client company (label only, senderId=NULL),
  // receiverId = the senior who created the income. Filter must scope by
  // receiverId — using senderId here matched ZERO rows in production because
  // the backend never populates senderId for SENIOR_INCOME (see
  // transactions.service.ts createSeniorIncome). This regression hid the
  // «Оплатить (N)» button for SENIOR even with VALIDATED transactions ready
  // to be paid. E2E coverage in finance-senior-payment-flow.spec.ts asserts
  // the button is visible with realistic mocks (senderId=null).
  const validatedForPayout = transactions.filter(
    (t) =>
      t.type === 'SENIOR_INCOME' &&
      t.status === 'VALIDATED' &&
      !pendingPayoutTxIds.has(t.id) &&
      t.receiverId === userId,
  )
  // Same rules drive the inline «Выплатить» button in each row and the
  // dialog footer. Wrap in Set for O(1) row lookup. Empty for non-SENIOR
  // users so RBAC is enforced at the data layer in addition to the role
  // check inside TransactionRow.
  const payoutEligibleIds = new Set(isSenior ? validatedForPayout.map((t) => t.id) : [])

  // HR view
  if (isHr) {
    const mySalaries = transactions.filter((t) => t.type === 'SALARY' && t.receiverId === userId)
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Финансы</h1>
          <p className="text-sm text-muted-foreground">История ваших выплат</p>
        </div>
        <Card>
          <CardContent className="p-0">
            {txLoading ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : mySalaries.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Выплат пока нет</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="py-3 px-4 text-left font-medium">Сумма</th>
                      <th className="py-3 px-4 text-left font-medium">Месяц</th>
                      <th className="py-3 px-4 text-left font-medium">Дата</th>
                      <th className="py-3 px-4 text-left font-medium">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mySalaries.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => setDetailTx(t)}
                      >
                        <td className="py-3 px-4 text-sm tabular-nums font-medium text-green-500">
                          {fmtAmount(t.amount, t.currency)}
                        </td>
                        <td className="py-3 px-4 text-sm text-muted-foreground">
                          {fmtMonth(t.salaryMonth)}
                        </td>
                        <td className="py-3 px-4 text-xs text-muted-foreground">
                          {fmtDate(t.txDate ?? t.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                              STATUS_COLORS[t.status],
                            )}
                          >
                            {STATUS_LABELS[t.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <TransactionDetailDialog tx={detailTx} onClose={() => setDetailTx(null)} />
      </div>
    )
  }

  // Junior view
  if (isJunior) {
    const mySalaries = transactions.filter((t) => t.type === 'SALARY' && t.receiverId === userId)
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Финансы</h1>
          <p className="text-sm text-muted-foreground">Ваши выплаты</p>
        </div>
        <Card>
          <CardContent className="p-0">
            {txLoading ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : mySalaries.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Выплат пока нет</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="py-3 px-4 text-left font-medium">Сумма</th>
                      <th className="py-3 px-4 text-left font-medium">Месяц</th>
                      <th className="py-3 px-4 text-left font-medium">Дата</th>
                      <th className="py-3 px-4 text-left font-medium">Статус</th>
                      <th className="py-3 px-4 text-left font-medium">TX Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mySalaries.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                      >
                        <td className="py-3 px-4 text-sm tabular-nums font-medium text-green-500">
                          {fmtAmount(t.amount, t.currency)}
                        </td>
                        <td className="py-3 px-4 text-sm text-muted-foreground">
                          {fmtMonth(t.salaryMonth)}
                        </td>
                        <td className="py-3 px-4 text-xs text-muted-foreground">
                          {fmtDate(t.txDate ?? t.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                              STATUS_COLORS[t.status],
                            )}
                          >
                            {STATUS_LABELS[t.status]}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs font-mono text-muted-foreground">
                          {t.txHash ? <span title={t.txHash}>{t.txHash.slice(0, 14)}…</span> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Финансы</h1>
          <p className="text-sm text-muted-foreground">Все транзакции</p>
        </div>
        <div className="flex gap-2">
          {isSenior && validatedForPayout.length > 0 && (
            <Button
              variant="default"
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm shadow-primary/30 ring-1 ring-primary/40"
              onClick={() => {
                setPayoutPreselected(undefined)
                setShowPayout(true)
              }}
              data-testid="header-payout-button"
            >
              <Wallet className="h-4 w-4 mr-1" /> Выплатить ({validatedForPayout.length})
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> Новая транзакция
            </Button>
          )}
        </div>
      </div>

      {/* SENIOR — own projects + effective share % (no impact for other roles). */}
      {isSenior && <MyProjectShares />}

      {/* Transactions table */}
      <Card>
        <CardContent className="p-0">
          <TransactionsTable
            transactions={transactions}
            loading={txLoading}
            role={role}
            rates={rates}
            currentUserId={userId}
            payoutEligibleIds={payoutEligibleIds}
            onValidate={setValidateTx}
            onEdit={setEditTx}
            onAdminEdit={setAdminEditTx}
            onDelete={setDeleteTx}
            onPaySalary={setPaySalaryTx}
            onQuickPayout={openPayoutForTx}
            onDetail={setDetailTx}
          />
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateTransactionDialog open={showCreate} onClose={() => setShowCreate(false)} />
      <ValidateDialog tx={validateTx} onClose={() => setValidateTx(null)} />
      <EditSeniorIncomeDialog tx={editTx} onClose={() => setEditTx(null)} />
      <AdminEditTransactionDialog tx={adminEditTx} onClose={() => setAdminEditTx(null)} />
      <PaySalaryDialog tx={paySalaryTx} onClose={() => setPaySalaryTx(null)} />
      <PayoutDialog
        open={showPayout}
        onClose={closePayoutDialog}
        validatedTxs={validatedForPayout}
        {...(payoutPreselected ? { preselectedTxIds: payoutPreselected } : {})}
      />
      <TransactionDetailDialog
        tx={detailTx}
        onClose={() => setDetailTx(null)}
        canQuickPayout={!!detailTx && payoutEligibleIds.has(detailTx.id)}
        onQuickPayout={(t) => {
          setDetailTx(null)
          openPayoutForTx(t)
        }}
      />

      {/* Delete confirmation */}
      <Dialog open={!!deleteTx} onOpenChange={(o) => !o && setDeleteTx(null)}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle className="text-base text-destructive">Удалить транзакцию?</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <div className="text-sm text-muted-foreground space-y-1">
              <p>Это действие необратимо.</p>
              {deleteTx && (
                <p className="font-medium text-foreground">
                  {TYPE_LABELS[deleteTx.type]} · {fmtAmount(deleteTx.amount, deleteTx.currency)}
                </p>
              )}
            </div>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTx(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteTx && deleteMutation.mutate(deleteTx.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Удаление...' : 'Удалить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}
