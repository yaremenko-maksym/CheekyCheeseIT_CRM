import { createFileRoute } from '@tanstack/react-router'
import { StickyPageHeader } from '@/components/crm/StickyPageHeader'
import { useQuery } from '@tanstack/react-query'
import { Plus, Wallet } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { TransactionDto, TransactionStatus } from '@crm/shared'
import { formatMonthLabel } from '@crm/shared'
import { formatTxOrCreated } from './utils/tx-date'
import { useLocale } from '@/lib/i18n'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { api } from '@/lib/axios'
import { financeApi } from './api'
import { fmtAmount, STATUS_COLORS, STATUS_LABEL_MESSAGES, type ExchangeRates } from './constants'
import { TransactionsTable } from './components/TransactionsTable'
import { CreateTransactionDialog } from './components/dialogs/CreateTransactionDialog'
import { resolveSalaryPrefillCurrency } from './components/dialogs/create-transaction/shared'
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
import { DeleteTransactionDialog } from './components/dialogs/DeleteTransactionDialog'
import { RestoreTransactionDialog } from './components/dialogs/RestoreTransactionDialog'
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
  const [salaryPartSource, setSalaryPartSource] = useState<TransactionDto | null>(null)
  const [validateTx, setValidateTx] = useState<TransactionDto | null>(null)
  const [editTx, setEditTx] = useState<TransactionDto | null>(null)
  const [adminEditTx, setAdminEditTx] = useState<TransactionDto | null>(null)
  const [deleteTx, setDeleteTx] = useState<TransactionDto | null>(null)
  // task-soft-delete-and-money-audit (AC3). ADMIN/ACCOUNTANT-only «показать
  // удалённые» toggle — default OFF, matching the server's default-hidden
  // list. Reset is unnecessary: the query itself is gated by role below.
  const [showDeleted, setShowDeleted] = useState(false)
  // task-soft-delete-and-money-audit (AC6). ADMIN-only restore dialog target.
  const [restoreTx, setRestoreTx] = useState<TransactionDto | null>(null)
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

  const openSalaryPart = useCallback((tx: TransactionDto) => {
    setSalaryPartSource(tx)
    setShowCreate(true)
  }, [])

  const closeCreate = useCallback(() => {
    setShowCreate(false)
    setSalaryPartSource(null)
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
                              {formatTxOrCreated(salaryTx.txDate, salaryTx.createdAt, locale)}
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
                                {formatTxOrCreated(salaryTx.txDate, salaryTx.createdAt, locale)}
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
              «Фільтри / тулбари» — mobile toolbar collapses, it does not
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
          SENIOR_PENDING_PAYOUT row in the table via the «Виплатити» button
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
                onAddSalaryPart={openSalaryPart}
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
          <CreateTransactionDialog
            open={showCreate}
            onClose={closeCreate}
            {...(salaryPartSource?.receiverId && salaryPartSource.salaryMonth
              ? {
                  salaryPrefill: {
                    receiverId: salaryPartSource.receiverId,
                    salaryMonth: salaryPartSource.salaryMonth,
                    currency: resolveSalaryPrefillCurrency(salaryPartSource),
                  },
                }
              : {})}
          />
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

          {/* Delete confirmation — soft delete with a mandatory reason. */}
          <DeleteTransactionDialog tx={deleteTx} onClose={() => setDeleteTx(null)} />

          {/* Restore — ADMIN-only; reason mandatory. */}
          <RestoreTransactionDialog tx={restoreTx} onClose={() => setRestoreTx(null)} />
        </div>
      </div>
    </div>
  )
}
