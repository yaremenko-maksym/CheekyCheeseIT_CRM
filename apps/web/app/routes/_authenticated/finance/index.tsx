import { createFileRoute } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, ArrowUpDown, ChevronDown, X, Wallet } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import type { TransactionDto, TransactionStatus } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { trackFeatureClick } from '@/lib/telemetry'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
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
import { compareTxByAmount, compareTxByDate } from './sort'
import { CreateTransactionDialog } from './components/dialogs/CreateTransactionDialog'
import { ValidateDialog } from './components/dialogs/ValidateDialog'
import { EditSeniorIncomeDialog } from './components/dialogs/EditSeniorIncomeDialog'
import { PaySalaryDialog } from './components/dialogs/PaySalaryDialog'
import { SettleSeniorPayoutDialog } from './components/dialogs/SettleSeniorPayoutDialog'
// PayoutDialog (batch payout) — re-activated by feat/finance-payout-flow (#7).
// SENIOR manually creates a payout request by selecting one or more VALIDATED
// SENIOR_INCOME rows. The old auto-create path on ACCOUNTANT validate has been
// removed to eliminate duplicate payouts.
import { PayoutDialog } from './components/dialogs/PayoutDialog'
import { PayoutDetailDialog } from './components/dialogs/PayoutDetailDialog'
import { TransactionDetailDialog } from './components/dialogs/TransactionDetailDialog'
import { AdminEditTransactionDialog } from './components/dialogs/AdminEditTransactionDialog'
import { AttachReceiptSheet } from './components/dialogs/AttachReceiptSheet'
import { DropFinancePage } from './components/DropFinancePage'
import { ConfirmPayoutDialog } from '@/components/finance/ConfirmPayoutDialog'

/**
 * Deep-link search params for /finance.
 *
 * `status` — optional pre-selected transaction-status filter (e.g. the
 * AccountantDashboard CTA navigates with `?status=PENDING`). Validated against
 * the known transaction statuses; anything unexpected is dropped (returns
 * undefined) so a malformed URL never poisons the filter UI.
 */
type FinanceSearch = {
  status?: TransactionStatus
}

const KNOWN_STATUSES: readonly TransactionStatus[] = [
  'PENDING',
  'VALIDATED',
  'PENDING_PAYMENT',
  'REJECTED',
  'PAID',
  'LOCKED',
  'PENDING_CASH_CONFIRM',
]

export const Route = createFileRoute('/_authenticated/finance/')({
  component: FinancePage,
  validateSearch: (search: Record<string, unknown>): FinanceSearch => {
    const raw = search['status']
    if (typeof raw === 'string' && (KNOWN_STATUSES as readonly string[]).includes(raw)) {
      return { status: raw as TransactionStatus }
    }
    return {}
  },
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
  initialStatus,
  onValidate,
  onEdit,
  onAdminEdit,
  onDelete,
  onPaySalary,
  onSettleSeniorPayout,
  onOpenPayoutDetail,
  onInitiatePayout,
  onConfirmPayout,
  onAttachReceipt,
  onDetail,
}: {
  transactions: TransactionDto[]
  loading: boolean
  role: string
  rates: ExchangeRates | undefined
  /**
   * Deep-link initial status filter (e.g. AccountantDashboard CTA →
   * `?status=PENDING`). When omitted, the filter starts at 'all'. The user can
   * still change/clear it freely afterwards — it only seeds the initial value.
   */
  initialStatus?: string
  currentUserId?: string | null
  onValidate: (tx: TransactionDto) => void
  onEdit: (tx: TransactionDto) => void
  onAdminEdit: (tx: TransactionDto) => void
  onDelete: (tx: TransactionDto) => void
  onPaySalary: (tx: TransactionDto) => void
  /**
   * task-senior-settle-in-tx-row. ADMIN/ACCOUNTANT clicks «Выплатить» on a
   * SENIOR_PENDING_PAYOUT row (PENDING_PAYMENT) — settles the senior IOU from
   * the company account. Passed straight to TransactionRow.
   */
  onSettleSeniorPayout: (tx: TransactionDto) => void
  /**
   * Opens PayoutDetailDialog for PENDING_PAYMENT rows. Passed straight to
   * TransactionRow; receives the payout_request id (already resolved by the
   * row from tx.payoutRequestId).
   */
  onOpenPayoutDetail: (payoutRequestId: string) => void
  /**
   * feat/finance-payout-flow (#7). SENIOR clicks «Выплатить» on a VALIDATED
   * SENIOR_INCOME row — opens PayoutDialog pre-selecting that tx.
   */
  onInitiatePayout?: (txId: string) => void
  /**
   * Drop role - phase 3 (spec §8.4). Opens ConfirmPayoutDialog for an
   * ADMIN/ACCOUNTANT on PAYOUT rows in PENDING_PAYMENT.
   */
  onConfirmPayout: (tx: TransactionDto) => void
  /**
   * task-receipts-frontend. Opens `AttachReceiptSheet` for the row's tx
   * (attach/replace). Passed straight to `TransactionRow` — RBAC/status
   * gate is `canAttachReceipt`, applied inside the row.
   */
  onAttachReceipt?: (tx: TransactionDto) => void
  onDetail: (tx: TransactionDto) => void
}) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  // Seed from the deep-link `?status=` param (AccountantDashboard CTA). Falls
  // back to 'all'. Only the initial value — user changes/clears it freely after.
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? 'all')
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
      if (sortKey === 'date') return compareTxByDate(a, b, sortDir)
      return compareTxByAmount(a, b, sortDir)
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

  return (
    <>
      {/* FilterBar always visible — chrome-in-place */}
      <FilterBar
        search={search}
        onSearch={setSearch}
        filterSlot={
          <>
            <FilterSelect
              value={typeFilter}
              onChange={(v) => {
                setTypeFilter(v)
                // task-telemetry-web: Select onValueChange, not a DOM click —
                // the delegated [data-track] listener never sees it.
                trackFeatureClick('finance-filter-change')
              }}
              placeholder="Все типы"
              options={TYPE_OPTIONS}
            />
            <FilterSelect
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v)
                trackFeatureClick('finance-filter-change')
              }}
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
      {loading ? (
        /* Skeleton rows inside table — thead stays, only data rows replaced */
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
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-3 px-4" colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : paged.length === 0 ? (
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
                    transactions={transactions}
                    onValidate={onValidate}
                    onEdit={onEdit}
                    onAdminEdit={onAdminEdit}
                    onDelete={onDelete}
                    onPaySalary={onPaySalary}
                    onSettleSeniorPayout={onSettleSeniorPayout}
                    onOpenPayoutDetail={onOpenPayoutDetail}
                    {...(onInitiatePayout ? { onInitiatePayout } : {})}
                    onConfirmPayout={onConfirmPayout}
                    {...(onAttachReceipt ? { onAttachReceipt } : {})}
                    onClick={onDetail}
                  />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
      {!loading && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPage={setPage}
        />
      )}
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

function FinancePage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'ACCOUNTANT', 'HR', 'DROP', 'JUNIOR'])
  const { user } = useAuth()
  // Deep-link status filter (?status=PENDING) — from the AccountantDashboard CTA.
  // useSearch is hook-order-safe (called before the early returns below).
  const { status: deepLinkStatus } = Route.useSearch()
  if (denied) return null
  const role = user?.role ?? ''
  const userId = user?.id ?? ''

  const isAdmin = role === 'ADMIN'
  const isSenior = role === 'SENIOR'
  const isJunior = role === 'JUNIOR'
  const isHr = role === 'HR'
  // task-accountant-create-transaction. ACCOUNTANT may create transactions with
  // the SAME set as ADMIN (income/expense/salary/transfer) — see business doc
  // finance.md: «ACCOUNTANT — Все транзакции, валидация, расходы, выплаты».
  const isAccountant = role === 'ACCOUNTANT'
  // Drop role - phase 2. DROP user reaches the normal finance table and
  // can register new income via «Новая транзакция» (which renders the
  // DROP_INCOME card from CreateTransactionDialog).
  const isDrop = role === 'DROP'

  const [showCreate, setShowCreate] = useState(false)
  const [validateTx, setValidateTx] = useState<TransactionDto | null>(null)
  const [editTx, setEditTx] = useState<TransactionDto | null>(null)
  const [adminEditTx, setAdminEditTx] = useState<TransactionDto | null>(null)
  const [deleteTx, setDeleteTx] = useState<TransactionDto | null>(null)
  const [paySalaryTx, setPaySalaryTx] = useState<TransactionDto | null>(null)
  // task-senior-settle-owner. SENIOR_PENDING_PAYOUT row whose «Выплатить» funding
  // dialog is open (ADMIN/ACCOUNTANT). null = closed.
  const [settleSeniorTx, setSettleSeniorTx] = useState<TransactionDto | null>(null)
  // PayoutDialog state — feat/finance-payout-flow (#7). SENIOR selects one or
  // more VALIDATED SENIOR_INCOME rows → POST /api/payout-requests creates a
  // single payout_request + PAYOUT row (PENDING_PAYMENT).
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false)
  // preselectedPayoutTxId is set when SENIOR clicks the inline «Выплатить»
  // pill on a single VALIDATED row (quick single-tx path). Cleared on close.
  const [preselectedPayoutTxId, setPreselectedPayoutTxId] = useState<string | undefined>()

  // Payout detail dialog — opened from the inline «Оплатить» pill on the
  // «Выплата» (PAYOUT) row (PENDING_PAYMENT). null = closed.
  const [payoutDetailId, setPayoutDetailId] = useState<string | null>(null)
  // Drop role - phase 3 (spec §8.4). PAYOUT row whose manual confirmation
  // dialog is currently open. Visible only to ADMIN/ACCOUNTANT (the row
  // button itself is hidden for other roles — see TransactionRow).
  const [confirmPayoutTx, setConfirmPayoutTx] = useState<TransactionDto | null>(null)
  const [detailTx, setDetailTx] = useState<TransactionDto | null>(null)
  // task-receipts-frontend. Row-icon entry point — opens AttachReceiptSheet
  // for the clicked tx (attach if it has no receipt yet, replace otherwise).
  const [attachReceiptTx, setAttachReceiptTx] = useState<TransactionDto | null>(null)

  const openPayoutDetail = useCallback((payoutRequestId: string) => {
    setPayoutDetailId(payoutRequestId)
  }, [])

  const closePayoutDetail = useCallback(() => {
    setPayoutDetailId(null)
  }, [])

  // feat/finance-payout-flow (#7): inline row «Выплатить» on a VALIDATED
  // SENIOR_INCOME opens PayoutDialog with that tx pre-selected.
  const openPayoutDialogForTx = useCallback((txId: string) => {
    setPreselectedPayoutTxId(txId)
    setPayoutDialogOpen(true)
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

  // task-senior-settle-owner. Pay the senior their drop-project share directly
  // from the SENIOR_PENDING_PAYOUT row (ADMIN/ACCOUNTANT only). The «Выплатить»
  // button now opens SettleSeniorPayoutDialog — the SAME funding-source picker as
  // the SALARY pay flow (Счёт компании vs an admin partner + currency). The
  // dialog owns the settle mutation + the idempotent backend cascade; here we
  // just track which row's dialog is open.
  const onSettleSeniorPayout = useCallback((tx: TransactionDto) => {
    setSettleSeniorTx(tx)
  }, [])

  const canCreate = isAdmin || isSenior || isDrop || isAccountant

  // DROP has its own self-scoped API endpoints (drop-incomes / drop-payments)
  // rendered via DropFinancePage below. Disabling the privileged /transactions
  // query for DROP avoids an unnecessary request with a different data shape.
  const { data: transactions = [], isLoading: txLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
    enabled: !isDrop,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60,
  })

  // Payout-requests query is not needed here — the SENIOR initiates a payout
  // by clicking «Выплатить» on a VALIDATED row, which opens PayoutDialog.
  // PAYOUT rows (after creation) are surfaced in the main transactions table.

  // AC2 / AC3: validatable pending-транзакции — SENIOR_INCOME и DROP_INCOME со
  // статусом PENDING. Это те же строки, что считает дашборд «ожидают валидации».
  // Используются для очереди в ValidateDialog.
  // useMemo: filters run once when transactions change, not on every render.
  const validateQueue = useMemo(
    () =>
      transactions.filter(
        (t) => (t.type === 'SENIOR_INCOME' || t.type === 'DROP_INCOME') && t.status === 'PENDING',
      ),
    [transactions],
  )

  // VALIDATED SENIOR_INCOME rows available for batching into a new payout.
  // Used by PayoutDialog to populate the multi-select list.
  const validatedSeniorIncomes = useMemo(
    () =>
      transactions.filter(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'VALIDATED' && !t.payoutRequestId,
      ),
    [transactions],
  )

  // Drop role - phase 2. DROP gets their own dedicated finance cabinet that
  // shows only their own incomes/payments via self-scoped API endpoints.
  // Must return BEFORE loading transactions — DROP doesn't use the shared
  // transactions query (different data shape + API path).
  if (isDrop) return <DropFinancePage />

  // HR view
  if (isHr) {
    const mySalaries = transactions.filter((t) => t.type === 'SALARY' && t.receiverId === userId)
    return (
      <div className="flex flex-col h-full" data-testid="finance-page">
        <div
          className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="space-y-6">
            <Card>
              <CardContent className="p-0">
                {txLoading ? (
                  <div className="p-6 space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 rounded-lg" />
                    ))}
                  </div>
                ) : mySalaries.length === 0 ? (
                  <div className="py-16 text-center text-sm text-muted-foreground">
                    Выплат пока нет
                  </div>
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
                            className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            tabIndex={0}
                            aria-label={`Открыть транзакцию за ${t.salaryMonth ?? t.createdAt}`}
                            onClick={() => setDetailTx(t)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setDetailTx(t)
                              }
                            }}
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
        </div>
      </div>
    )
  }

  // Junior view
  if (isJunior) {
    const mySalaries = transactions.filter((t) => t.type === 'SALARY' && t.receiverId === userId)
    return (
      <TooltipProvider>
        <div className="flex flex-col h-full" data-testid="finance-page">
          <div
            className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="space-y-6">
              <Card>
                <CardContent className="p-0">
                  {txLoading ? (
                    <div className="p-6 space-y-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 rounded-lg" />
                      ))}
                    </div>
                  ) : mySalaries.length === 0 ? (
                    <div className="py-16 text-center text-sm text-muted-foreground">
                      Выплат пока нет
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border text-xs text-muted-foreground">
                            <th className="py-3 px-4 text-left font-medium">Сумма</th>
                            <th className="py-3 px-4 text-left font-medium">Проект</th>
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
                              className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              tabIndex={0}
                              aria-label={`Открыть транзакцию за ${t.salaryMonth ?? t.createdAt}`}
                              onClick={() => setDetailTx(t)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setDetailTx(t)
                                }
                              }}
                            >
                              <td className="py-3 px-4 text-sm tabular-nums font-medium text-green-500">
                                {fmtAmount(t.amount, t.currency)}
                              </td>
                              <td className="py-3 px-4 text-sm text-muted-foreground">
                                {t.projectName ?? '—'}
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
                              <td
                                className="py-3 px-4 text-xs font-mono text-muted-foreground"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {t.txHash ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-default underline decoration-dotted underline-offset-2">
                                        {t.txHash.slice(0, 14)}…
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="top"
                                      className="max-w-xs break-all font-mono"
                                    >
                                      {t.txHash}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  '—'
                                )}
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
          </div>
        </div>
      </TooltipProvider>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="finance-page">
      <StickyPageHeader>
        {/* Header */}
        <div className="flex items-start justify-between">
          <div />
          <div className="flex gap-2">
            {/* feat/finance-payout-flow (#7): SENIOR can batch multiple VALIDATED
              incomes into one payout via the header button. Badge shows count. */}
            {isSenior && validatedSeniorIncomes.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setPreselectedPayoutTxId(undefined)
                  setPayoutDialogOpen(true)
                }}
                data-testid="finance-initiate-payout-button"
              >
                <Wallet className="h-4 w-4 mr-1" />
                Выплатить ({validatedSeniorIncomes.length})
              </Button>
            )}
            {canCreate && (
              <Button
                onClick={() => setShowCreate(true)}
                data-testid="finance-create-transaction-button"
              >
                <Plus className="h-4 w-4 mr-1" /> Новая транзакция
              </Button>
            )}
          </div>
        </div>
      </StickyPageHeader>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div className="space-y-6">
          {/* task-senior-settle-in-tx-row. The two senior-settlement cards
          («Ожидают зачисления» + «Долги компании перед синьорами») were
          removed — they carried no info beyond what the transactions table
          already shows. The senior IOU is now paid straight from its
          SENIOR_PENDING_PAYOUT row in the table via the «Выплатить» button
          (ADMIN/ACCOUNTANT only), mirroring the salary pay flow. */}

          {/* Transactions table */}
          <Card>
            <CardContent className="p-0">
              <TransactionsTable
                transactions={transactions}
                loading={txLoading}
                role={role}
                rates={rates}
                currentUserId={userId}
                {...(deepLinkStatus ? { initialStatus: deepLinkStatus } : {})}
                onValidate={setValidateTx}
                onEdit={setEditTx}
                onAdminEdit={setAdminEditTx}
                onDelete={setDeleteTx}
                onPaySalary={setPaySalaryTx}
                onSettleSeniorPayout={onSettleSeniorPayout}
                onOpenPayoutDetail={openPayoutDetail}
                {...(isSenior ? { onInitiatePayout: openPayoutDialogForTx } : {})}
                onConfirmPayout={setConfirmPayoutTx}
                onAttachReceipt={setAttachReceiptTx}
                onDetail={setDetailTx}
              />
            </CardContent>
          </Card>

          {/* Dialogs */}
          <CreateTransactionDialog open={showCreate} onClose={() => setShowCreate(false)} />
          <ValidateDialog
            tx={validateTx}
            queue={validateQueue}
            onClose={() => setValidateTx(null)}
            onAdvance={(nextTx) => setValidateTx(nextTx)}
          />
          <EditSeniorIncomeDialog tx={editTx} onClose={() => setEditTx(null)} />
          <AdminEditTransactionDialog tx={adminEditTx} onClose={() => setAdminEditTx(null)} />
          <PaySalaryDialog tx={paySalaryTx} onClose={() => setPaySalaryTx(null)} />
          {/* task-senior-settle-owner: senior IOU pay dialog (salary-style funding). */}
          <SettleSeniorPayoutDialog tx={settleSeniorTx} onClose={() => setSettleSeniorTx(null)} />
          {/* feat/finance-payout-flow (#7): PayoutDialog re-activated. SENIOR
          selects one or more VALIDATED SENIOR_INCOME rows → single payout. */}
          <PayoutDialog
            open={payoutDialogOpen}
            onClose={() => {
              setPayoutDialogOpen(false)
              setPreselectedPayoutTxId(undefined)
            }}
            validatedTxs={validatedSeniorIncomes}
            {...(preselectedPayoutTxId ? { preselectedTxIds: [preselectedPayoutTxId] } : {})}
          />
          <PayoutDetailDialog
            open={!!payoutDetailId}
            onClose={closePayoutDetail}
            payoutId={payoutDetailId}
          />
          <ConfirmPayoutDialog tx={confirmPayoutTx} onClose={() => setConfirmPayoutTx(null)} />
          <TransactionDetailDialog tx={detailTx} onClose={() => setDetailTx(null)} />
          {/* task-receipts-frontend: row-icon attach/replace entry point. */}
          <AttachReceiptSheet tx={attachReceiptTx} onClose={() => setAttachReceiptTx(null)} />

          {/* Delete confirmation */}
          <Dialog open={!!deleteTx} onOpenChange={(o) => !o && setDeleteTx(null)}>
            <CrmDialogContent maxWidth="sm:max-w-sm">
              <CrmDialogHeader>
                <DialogTitle className="text-base text-destructive">
                  Удалить транзакцию?
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Подтверждение безвозвратного удаления финансовой транзакции.
                </DialogDescription>
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
      </div>
    </div>
  )
}
