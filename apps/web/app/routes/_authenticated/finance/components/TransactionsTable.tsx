import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Search, ArrowUpDown, ChevronDown, X, Trash2 } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { TransactionDto } from '@crm/shared'
import { trackFeatureClick } from '@/lib/telemetry'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { STATUS_LABEL_MESSAGES, TYPE_LABEL_MESSAGES, type ExchangeRates } from '../constants'
import { compareTxByAmount, compareTxByDate } from '../sort'
import { usePaginatedFilter } from '../hooks/usePaginatedFilter'
import { TransactionRow } from './TransactionRow'
import { Pagination } from './Pagination'

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

export function TransactionsTable({
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
  onAddSalaryPart,
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
  onAddSalaryPart: (tx: TransactionDto) => void
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
    // Stryker disable next-line ArrayDeclaration: `i18n` from useLingui() keeps the same object identity across a locale switch, so `[i18n]` and `[]` memoise identically — the mutant is behaviourally equivalent and cannot be observed
    [i18n],
  )
  const STATUS_OPTIONS = useMemo(
    () =>
      Object.keys(STATUS_LABEL_MESSAGES).map((value) => ({
        value,
        label: i18n._(STATUS_LABEL_MESSAGES[value as keyof typeof STATUS_LABEL_MESSAGES]),
      })),
    // Stryker disable next-line ArrayDeclaration: same as TYPE_OPTIONS above — `i18n` identity is stable, `[]` is behaviourally equivalent
    [i18n],
  )
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  // Seed from the deep-link `?status=` param (AccountantDashboard CTA). Falls
  // back to 'all'. Only the initial value — user changes/clears it freely after.
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? 'all')
  const [sortKey, setSortKey] = useState<TxSort>('date')
  // Stryker disable next-line StringLiteral: compareTxByDate/compareTxByAmount and SortButton only test `dir === 'asc'`, so an empty-string direction behaves exactly like 'desc'
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const toggleSort = (key: TxSort) => {
    // Stryker disable next-line StringLiteral: the 'desc' result is only ever compared against 'asc', so '' is equivalent to 'desc' (the 'asc' branch is covered by the direction-flip test)
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      // Stryker disable next-line StringLiteral: '' behaves exactly like 'desc' — direction is only compared against 'asc'
      setSortDir('desc')
    }
  }

  const filter = useCallback(
    (tx: TransactionDto) => {
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false
      if (statusFilter !== 'all' && tx.status !== statusFilter) return false
      // Stryker disable next-line ConditionalExpression: with an empty search `haystack.includes('')` is true for every row, so forcing the branch on is behaviourally equivalent (the off-mutant is killed by the search tests)
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
              <AnimatePresence
                mode="sync"
                // Stryker disable next-line BooleanLiteral: `initial` only suppresses the first-mount enter animation of motion children; jsdom runs no animation and the row is not a motion element under test
                initial={false}
              >
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
                    onAddSalaryPart={onAddSalaryPart}
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
