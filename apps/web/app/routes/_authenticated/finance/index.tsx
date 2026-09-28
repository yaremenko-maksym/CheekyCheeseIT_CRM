import { createFileRoute } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, ArrowUpDown, ChevronDown, X, Wallet, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import type { TransactionDto, TransactionStatus } from '@crm/shared'
import { formatDate, formatMonthLabel } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { trackFeatureClick } from '@/lib/telemetry'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  STATUS_COLORS,
  STATUS_LABEL_MESSAGES,
  TYPE_LABEL_MESSAGES,
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
// CompanySharePayoutModal (batch payout) — re-activated by
// feat/finance-payout-flow (#7), replaced task-company-share-cta. SENIOR
// manually creates a payout request by selecting one or more VALIDATED
// SENIOR_INCOME rows. The old auto-create path on ACCOUNTANT validate has been
// removed to eliminate duplicate payouts.
import { CompanySharePayoutModal } from './components/dialogs/CompanySharePayoutModal'
import { PayoutDetailDialog } from './components/dialogs/PayoutDetailDialog'
import { TransactionDetailDialog } from './components/dialogs/TransactionDetailDialog'
import { AdminEditTransactionDialog } from './components/dialogs/AdminEditTransactionDialog'
import { AttachReceiptSheet } from './components/dialogs/AttachReceiptSheet'
import { DropFinancePage } from './components/DropFinancePage'
import { ConfirmPayoutDialog } from '@/components/finance/ConfirmPayoutDialog'
import { CompanySharePayoutStrip } from './components/CompanySharePayoutStrip'

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
  const { t } = useLingui()
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
      <div className="relative flex-1 min-w-40">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          enterKeyHint="search"
          className="pl-8 h-8 text-sm"
          placeholder={t`Пошук…`}
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
          <X className="h-3.5 w-3.5" /> {t`Скинути`}
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
      {filtered ? (
        // task-i18n-stage3d-pr1 (Task 1, Step 4). Same key wave (b) already
        // established for the filtered-empty state — one situation, one text,
        // not a second phrasing of "nothing here".
        <Trans>Нічого не знайдено — скиньте фільтри</Trans>
      ) : (
        // COPY-M-fin-6: names the reason (nothing recorded yet) AND the next
        // step (the button that fixes it), quoting the SAME label the
        // toolbar's own «Нова транзакція» button carries below.
        <Trans>Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»</Trans>
      )}
    </div>
  )
}

// ── Transactions table ─────────────────────────────────────────────────────────

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
  onRestore,
  showDeleted,
  onToggleShowDeleted,
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
  /**
   * task-soft-delete-and-money-audit. ADMIN-only restore action, passed
   * straight through to TransactionRow (which additionally gates it to
   * ADMIN + an already-deleted row).
   */
  onRestore?: (tx: TransactionDto) => void
  /**
   * task-soft-delete-and-money-audit (AC3). «Показать удалённые» toggle —
   * only rendered when the caller passes `onToggleShowDeleted` (i.e. the
   * viewer is ADMIN/ACCOUNTANT; see FinancePage). Default OFF, matching the
   * server's default-hidden list.
   */
  showDeleted?: boolean
  onToggleShowDeleted?: () => void
}) {
  const { t, i18n } = useLingui()
  // task-i18n-stage3d-pr1 (Task 1, Step 4, template G-fin). Moved off the
  // module level — a module-level `i18n._()` call would freeze every label at
  // whatever locale was active on first import (`constants.ts`'s own
  // `activeLocale()` doc explains the mechanism this avoids). `i18n` in the
  // deps array so a live locale switch recomputes the option list.
  const TYPE_OPTIONS = useMemo(
    () =>
      Object.keys(TYPE_LABEL_MESSAGES).map((value) => ({
        value,
        label: i18n._(TYPE_LABEL_MESSAGES[value as keyof typeof TYPE_LABEL_MESSAGES]),
      })),
    [i18n],
  )
  const STATUS_OPTIONS = useMemo(
    () =>
      Object.keys(STATUS_LABEL_MESSAGES).map((value) => ({
        value,
        label: i18n._(STATUS_LABEL_MESSAGES[value as keyof typeof STATUS_LABEL_MESSAGES]),
      })),
    [i18n],
  )
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
              placeholder={t`Усі типи`}
              options={TYPE_OPTIONS}
            />
            <FilterSelect
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v)
                trackFeatureClick('finance-filter-change')
              }}
              placeholder={t`Усі статуси`}
              options={STATUS_OPTIONS}
            />
            {/* task-soft-delete-and-money-audit (AC3). Only rendered for
                ADMIN/ACCOUNTANT (FinancePage passes the handler only for
                those roles). Default OFF — matches the server's
                default-hidden list; explicit toggle widens it. */}
            {onToggleShowDeleted && (
              <button
                type="button"
                onClick={() => {
                  onToggleShowDeleted()
                  trackFeatureClick('finance-filter-change')
                }}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors h-8',
                  showDeleted
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60',
                )}
                data-testid="finance-toggle-show-deleted"
                aria-pressed={!!showDeleted}
              >
                <Trash2 className="h-3 w-3" />
                {t`Показати видалені`}
              </button>
            )}
          </>
        }
        sortSlot={
          <div className="flex gap-1.5">
            <SortButton
              label={t`Дата`}
              active={sortKey === 'date'}
              dir={sortDir}
              onClick={() => toggleSort('date')}
            />
            <SortButton
              label={t`Сума`}
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
                <th className="py-3 px-4 text-left font-medium">{t`Тип`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Учасник / Проєкт`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Сума`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Дата`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Статус`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Дії`}</th>
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
                <th className="py-3 px-4 text-left font-medium">{t`Тип`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Учасник / Проєкт`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Сума`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Дата`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Статус`}</th>
                <th className="py-3 px-4 text-left font-medium">{t`Дії`}</th>
              </tr>
            </thead>
            <tbody>
              {/* task-finance-sort-date-and-jump (AC4). `mode="popLayout"`
                  removes exiting elements from flow via `position: absolute`
                  so siblings can reflow immediately — but a `<tr>` cannot be
                  meaningfully absolutely positioned: it falls out of the
                  table's layout context and jumps to the top-left of the
                  nearest positioned ancestor. Re-sorting keeps every row's
                  key but changes their order, which popLayout treats as a
                  reflow for the WHOLE list — hence the entire table visibly
                  jumping on every sort toggle. `mode="sync"` (the default —
                  named explicitly so it isn't mistaken for an oversight)
                  keeps the enter/exit animations below and drops only the
                  absolute-positioning reflow trick, which tables can't use
                  anyway. */}
              <AnimatePresence mode="sync" initial={false}>
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
                    {...(onRestore ? { onRestore } : {})}
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
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'ACCOUNTANT', 'HR', 'DROP', 'JUNIOR'])
  const { user } = useAuth()
  // Deep-link status filter (?status=PENDING) — from the AccountantDashboard CTA.
  // useSearch is hook-order-safe (called before the early returns below).
  const { status: deepLinkStatus } = Route.useSearch()
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
  // task-soft-delete-and-money-audit. Reason is mandatory (server enforces
  // `min(3)`) — kept in local state so the dialog can disable the submit
  // button until it is long enough, mirroring ReleaseOnChainHash's UX.
  const [deleteReason, setDeleteReason] = useState('')
  // task-soft-delete-and-money-audit (AC3). ADMIN/ACCOUNTANT-only «показать
  // удалённые» toggle — default OFF, matching the server's default-hidden
  // list. Reset is unnecessary: the query itself is gated by role below.
  const [showDeleted, setShowDeleted] = useState(false)
  // task-soft-delete-and-money-audit (AC6). ADMIN-only restore dialog target.
  const [restoreTx, setRestoreTx] = useState<TransactionDto | null>(null)
  const [restoreReason, setRestoreReason] = useState('')
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
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      financeApi.deleteTransaction(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      setDeleteTx(null)
      setDeleteReason('')
    },
  })

  // task-soft-delete-and-money-audit (AC6). ADMIN-only — reverses a soft
  // delete. Reason is mandatory for the same audit-trail reason as delete.
  const restoreMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      financeApi.restoreTransaction(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      setRestoreTx(null)
      setRestoreReason('')
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
  // task-soft-delete-and-money-audit (AC2/AC3). Only ADMIN/ACCOUNTANT may
  // ever request `includeDeleted` — the server ignores it for every other
  // role regardless, but gating the toggle's very existence here means a
  // SENIOR/JUNIOR/HR/DROP never even sees the affordance.
  const canSeeDeleted = isAdmin || isAccountant
  const effectiveShowDeleted = canSeeDeleted && showDeleted

  // DROP has its own self-scoped API endpoints (drop-incomes / drop-payments)
  // rendered via DropFinancePage below. Disabling the privileged /transactions
  // query for DROP avoids an unnecessary request with a different data shape.
  const { data: transactions = [], isLoading: txLoading } = useQuery({
    queryKey: ['transactions', effectiveShowDeleted ? 'with-deleted' : 'active'],
    queryFn: () =>
      financeApi.getTransactions(effectiveShowDeleted ? { includeDeleted: 'true' } : undefined),
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

  // Rules of Hooks: every hook above must run on every render regardless of
  // `denied`, so the guard-return moved here — after the last hook call —
  // instead of sitting between `useAuth`/`useSearch` and the ~24 hooks below
  // it (useState/useQuery/useMemo/useMutation). `denied` flips false→true
  // mid-mount once `useAuth`'s `isLoading` resolves to a disallowed role; a
  // guard sitting in the middle of the hook list made that transition change
  // the hook count between renders — "Rendered fewer hooks than expected."
  // useRoleGuard's own effect below still redirects; this route is also
  // gated at the layout level (see use-role-guard.ts), so this is
  // defense-in-depth, not the only line standing between a denied viewer and
  // this page.
  if (denied) return null

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
                    <Trans>Виплат ще немає</Trans>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground">
                          <th className="py-3 px-4 text-left font-medium">{t`Сума`}</th>
                          <th className="py-3 px-4 text-left font-medium">{t`Місяць`}</th>
                          <th className="py-3 px-4 text-left font-medium">{t`Дата`}</th>
                          <th className="py-3 px-4 text-left font-medium">{t`Статус`}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mySalaries.map((salaryTx) => (
                          <tr
                            key={salaryTx.id}
                            className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            tabIndex={0}
                            aria-label={t`Відкрити транзакцію за ${salaryTx.salaryMonth ?? salaryTx.createdAt}`}
                            onClick={() => setDetailTx(salaryTx)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setDetailTx(salaryTx)
                              }
                            }}
                          >
                            <td className="py-3 px-4 text-sm tabular-nums font-medium text-green-500">
                              {fmtAmount(salaryTx.amount, salaryTx.currency)}
                            </td>
                            <td className="py-3 px-4 text-sm text-muted-foreground">
                              {formatMonthLabel(salaryTx.salaryMonth, locale)}
                            </td>
                            <td className="py-3 px-4 text-xs text-muted-foreground">
                              {formatDate(salaryTx.txDate ?? salaryTx.createdAt, locale, 'shortYY')}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                                  STATUS_COLORS[salaryTx.status],
                                )}
                              >
                                {i18n._(STATUS_LABEL_MESSAGES[salaryTx.status])}
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
                      <Trans>Виплат ще немає</Trans>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border text-xs text-muted-foreground">
                            <th className="py-3 px-4 text-left font-medium">{t`Сума`}</th>
                            <th className="py-3 px-4 text-left font-medium">{t`Проєкт`}</th>
                            <th className="py-3 px-4 text-left font-medium">{t`Місяць`}</th>
                            <th className="py-3 px-4 text-left font-medium">{t`Дата`}</th>
                            <th className="py-3 px-4 text-left font-medium">{t`Статус`}</th>
                            <th className="py-3 px-4 text-left font-medium">{t`Хеш транзакції`}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mySalaries.map((salaryTx) => (
                            <tr
                              key={salaryTx.id}
                              className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              tabIndex={0}
                              aria-label={t`Відкрити транзакцію за ${salaryTx.salaryMonth ?? salaryTx.createdAt}`}
                              onClick={() => setDetailTx(salaryTx)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setDetailTx(salaryTx)
                                }
                              }}
                            >
                              <td className="py-3 px-4 text-sm tabular-nums font-medium text-green-500">
                                {fmtAmount(salaryTx.amount, salaryTx.currency)}
                              </td>
                              <td className="py-3 px-4 text-sm text-muted-foreground">
                                {salaryTx.projectName ?? '—'}
                              </td>
                              <td className="py-3 px-4 text-sm text-muted-foreground">
                                {formatMonthLabel(salaryTx.salaryMonth, locale)}
                              </td>
                              <td className="py-3 px-4 text-xs text-muted-foreground">
                                {formatDate(
                                  salaryTx.txDate ?? salaryTx.createdAt,
                                  locale,
                                  'shortYY',
                                )}
                              </td>
                              <td className="py-3 px-4">
                                <span
                                  className={cn(
                                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                                    STATUS_COLORS[salaryTx.status],
                                  )}
                                >
                                  {i18n._(STATUS_LABEL_MESSAGES[salaryTx.status])}
                                </span>
                              </td>
                              <td
                                className="py-3 px-4 text-xs font-mono text-muted-foreground"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {salaryTx.txHash ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-default underline decoration-dotted underline-offset-2">
                                        {salaryTx.txHash.slice(0, 14)}…
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="top"
                                      className="max-w-xs break-all font-mono"
                                    >
                                      {salaryTx.txHash}
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
          {/* FIX-UX-M-1 (fix-round, PR #730): with the payout badge active
              («Виплатити (N)»), two full-width buttons overflow the right
              edge at ≤363px — reachable but past the viewport, no scroll
              indicator. `flex-wrap` is the safety net; the primary fix is
              icon-only «Нова транзакція» below `sm` (foundation.md §10
              «Фильтры / тулбары» — mobile toolbar collapses, it does not
              scroll). The `Wallet` payout button keeps its digit-count label
              at every width — it is the rarer, count-bearing action, and
              icon-only there would hide the number the badge exists for. */}
          <div className="flex flex-wrap justify-end gap-2">
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
                {t`Виплатити (${validatedSeniorIncomes.length})`}
              </Button>
            )}
            {canCreate && (
              <Button
                onClick={() => setShowCreate(true)}
                data-testid="finance-create-transaction-button"
                aria-label={t`Нова транзакція`}
              >
                <Plus className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">{t`Нова транзакція`}</span>
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

          {/* task-company-share-cta. First element, right above the
              transactions table (design spec §4.2 — «буквально вверху
              списка»). SENIOR only — task boundary excludes ADMIN/ACCOUNTANT
              here since /finance's `transactions` query is UNSCOPED for them
              (would otherwise show every senior's outstanding share). */}
          {isSenior && (
            <CompanySharePayoutStrip
              transactions={transactions}
              isLoading={txLoading}
              currentUserId={userId}
              userSeniorSharePercent={user?.seniorSharePercent}
              onOpen={() => {
                setPreselectedPayoutTxId(undefined)
                setPayoutDialogOpen(true)
              }}
            />
          )}

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
                {...(isAdmin ? { onRestore: setRestoreTx } : {})}
                {...(canSeeDeleted
                  ? {
                      showDeleted,
                      onToggleShowDeleted: () => setShowDeleted((v) => !v),
                    }
                  : {})}
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
          {/* feat/finance-payout-flow (#7): batch-payout re-activated, now
          via CompanySharePayoutModal (task-company-share-cta). SENIOR
          selects one or more VALIDATED SENIOR_INCOME rows → single payout. */}
          <CompanySharePayoutModal
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

          {/* Delete confirmation — task-soft-delete-and-money-audit: now a
              SOFT delete (row is marked, never physically removed) and the
              reason is MANDATORY (it lands in the audit journal). */}
          <Dialog
            open={!!deleteTx}
            onOpenChange={(o) => {
              if (!o) {
                setDeleteTx(null)
                setDeleteReason('')
              }
            }}
          >
            <CrmDialogContent maxWidth="sm:max-w-sm">
              <CrmDialogHeader>
                <DialogTitle className="text-base text-destructive">
                  <Trans>Видалити транзакцію?</Trans>
                </DialogTitle>
                {/* COPY-M-fin-14: this sr-only description used to phrase the
                    same fact differently from the visible paragraph below
                    ("не удалена физически" here, absent there) — one sentence
                    for screen readers and sighted users alike now, not two
                    near-identical ones a translator would have to keep in
                    sync by hand. */}
                <DialogDescription className="sr-only">
                  <Trans>
                    Транзакцію буде прибрано з загального списку — відновити її може лише
                    адміністратор.
                  </Trans>
                </DialogDescription>
              </CrmDialogHeader>
              <CrmDialogBody className="pb-2 space-y-3">
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>
                    <Trans>
                      Транзакцію буде прибрано з загального списку — відновити її може лише
                      адміністратор.
                    </Trans>
                  </p>
                  {deleteTx && (
                    <p className="font-medium text-foreground">
                      {i18n._(TYPE_LABEL_MESSAGES[deleteTx.type])} ·{' '}
                      {fmtAmount(deleteTx.amount, deleteTx.currency)}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label htmlFor="delete-tx-reason" className="text-xs font-medium text-foreground">
                    {t`Причина видалення (обов’язково)`}
                  </label>
                  <Textarea
                    id="delete-tx-reason"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    placeholder={t`Наприклад: помилково створена транзакція`}
                    className="min-h-16 text-sm"
                    data-testid="delete-tx-reason-input"
                  />
                  {/* FIX-SPEC-M-1 (fix-round, PR #730 / COPY-M-fin-5): the
                      confirm button below was silently `disabled` below 3
                      characters with no visible reason why — a mandatory
                      field that refuses without saying so. */}
                  {deleteReason.length > 0 && deleteReason.trim().length < 3 && (
                    <p className="text-xs text-destructive" data-testid="delete-tx-reason-hint">
                      {t`Вкажіть щонайменше 3 символи причини`}
                    </p>
                  )}
                </div>
              </CrmDialogBody>
              <CrmDialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDeleteTx(null)
                    setDeleteReason('')
                  }}
                >
                  {t`Скасувати`}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    deleteTx &&
                    deleteMutation.mutate({ id: deleteTx.id, reason: deleteReason.trim() })
                  }
                  disabled={deleteMutation.isPending || deleteReason.trim().length < 3}
                  data-testid="delete-tx-confirm-button"
                >
                  {deleteMutation.isPending ? t`Видалення…` : t`Видалити`}
                </Button>
              </CrmDialogFooter>
            </CrmDialogContent>
          </Dialog>

          {/* Restore — task-soft-delete-and-money-audit (AC6). ADMIN-only;
              reason mandatory for the same audit-trail reason as delete. */}
          <Dialog
            open={!!restoreTx}
            onOpenChange={(o) => {
              if (!o) {
                setRestoreTx(null)
                setRestoreReason('')
              }
            }}
          >
            <CrmDialogContent maxWidth="sm:max-w-sm">
              <CrmDialogHeader>
                <DialogTitle className="text-base">
                  <Trans>Відновити транзакцію?</Trans>
                </DialogTitle>
                <DialogDescription className="sr-only">
                  <Trans>Підтвердження відновлення раніше видаленої фінансової транзакції.</Trans>
                </DialogDescription>
              </CrmDialogHeader>
              <CrmDialogBody className="pb-2 space-y-3">
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>
                    <Trans>
                      Транзакція знову з’явиться в загальному списку та в усіх розрахунках.
                    </Trans>
                  </p>
                  {restoreTx && (
                    <p className="font-medium text-foreground">
                      {i18n._(TYPE_LABEL_MESSAGES[restoreTx.type])} ·{' '}
                      {fmtAmount(restoreTx.amount, restoreTx.currency)}
                    </p>
                  )}
                  {restoreTx?.deletionReason && (
                    <p className="text-xs">
                      <Trans>
                        Причина видалення:{' '}
                        <span className="italic">{restoreTx.deletionReason}</span>
                      </Trans>
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="restore-tx-reason"
                    className="text-xs font-medium text-foreground"
                  >
                    {t`Причина відновлення (обов’язково)`}
                  </label>
                  <Textarea
                    id="restore-tx-reason"
                    value={restoreReason}
                    onChange={(e) => setRestoreReason(e.target.value)}
                    placeholder={t`Наприклад: видалено помилково`}
                    className="min-h-16 text-sm"
                    data-testid="restore-tx-reason-input"
                  />
                  {/* FIX-SPEC-M-1 (fix-round, PR #730 / COPY-M-fin-5) — same
                      visible hint as the delete dialog above. */}
                  {restoreReason.length > 0 && restoreReason.trim().length < 3 && (
                    <p className="text-xs text-destructive" data-testid="restore-tx-reason-hint">
                      {t`Вкажіть щонайменше 3 символи причини`}
                    </p>
                  )}
                </div>
              </CrmDialogBody>
              <CrmDialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRestoreTx(null)
                    setRestoreReason('')
                  }}
                >
                  {t`Скасувати`}
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    restoreTx &&
                    restoreMutation.mutate({ id: restoreTx.id, reason: restoreReason.trim() })
                  }
                  disabled={restoreMutation.isPending || restoreReason.trim().length < 3}
                  data-testid="restore-tx-confirm-button"
                >
                  {restoreMutation.isPending ? t`Відновлення…` : t`Відновити`}
                </Button>
              </CrmDialogFooter>
            </CrmDialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
