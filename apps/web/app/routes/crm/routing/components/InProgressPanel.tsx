import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Wallet } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import type { TransactionDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { STATUS_COLORS, STATUS_LABELS, fmtAmount, fmtDate } from '@/routes/crm/finance/constants'
import { CreateTransactionDialog } from '@/routes/crm/finance/components/dialogs/CreateTransactionDialog'
import { PayoutDialog } from '@/routes/crm/finance/components/dialogs/PayoutDialog'
import { PayoutDetailDialog } from '@/routes/crm/finance/components/dialogs/PayoutDetailDialog'

/**
 * InProgressPanel — shared «Транзакции в работе» panel used by both
 * SeniorDashboard and DropDashboard.
 *
 * mode='senior':
 *   - Income rows (SENIOR_INCOME PENDING/VALIDATED): «Создать выплату» on eligible VALIDATED
 *   - PAYOUT rows (PENDING_PAYMENT): «Оплатить» → PayoutDetailDialog
 *   - Toolbar: «Добавить приход» + batch «Создать выплату»
 *
 * mode='drop':
 *   - Income rows (DROP_INCOME PENDING/VALIDATED): «Платить» → /crm/payments/initiate/$incomeId
 *     on VALIDATED rows. createPayoutRequest is SENIOR-only (403 for DROP) — not shown.
 *   - PAYOUT rows (PENDING_PAYMENT): NOT rendered (drop settles via initiate, not PayoutDetailDialog)
 *   - Toolbar: «Добавить приход» only; NO batch «Создать выплату» (403 for DROP)
 *
 * Purely presentational — caller supplies data via props. Caller keeps react-query
 * hooks and passes `onRefresh` to invalidate caches after dialog success.
 */

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

export interface InProgressPanelProps {
  /**
   * 'senior' — SENIOR_INCOME rows + «Создать выплату» + PayoutDetailDialog for PAYOUT rows.
   * 'drop'   — DROP_INCOME rows + «Платить»→initiate; PAYOUT rows and createPayout hidden.
   */
  mode: 'senior' | 'drop'
  /**
   * Income transactions in the pipeline (PENDING/VALIDATED).
   * For senior: SENIOR_INCOME rows. For drop: DROP_INCOME rows.
   */
  incomeTxs: TransactionDto[]
  /**
   * PAYOUT rows in PENDING_PAYMENT that belong to the current user.
   * Shown ONLY for mode='senior' with «Оплатить» → PayoutDetailDialog.
   * Ignored for mode='drop' (drop settles via payment-channel initiate route).
   */
  payoutTxs: TransactionDto[]
  /**
   * Subset of incomeTxs: VALIDATED rows without payoutRequestId — eligible
   * to batch into a new payout request. Used ONLY for mode='senior' toolbar.
   * Ignored for mode='drop' (createPayoutRequest is SENIOR-only → 403).
   */
  validatedIncomes: TransactionDto[]
  /** Called when react-query caches should be refreshed after dialog closes. */
  onRefresh: () => void
  /** data-testid prefix to namespace testids (e.g. 'senior' or 'drop'). */
  testIdPrefix: string
}

export function InProgressPanel({
  mode,
  incomeTxs,
  payoutTxs,
  validatedIncomes,
  onRefresh,
  testIdPrefix,
}: InProgressPanelProps) {
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [payoutPreselect, setPayoutPreselect] = useState<string[]>([])
  const [payoutDetailOpen, setPayoutDetailOpen] = useState(false)
  const [payoutDetailId, setPayoutDetailId] = useState<string | null>(null)

  function openPayoutForTx(txId: string) {
    setPayoutPreselect([txId])
    setPayoutOpen(true)
  }

  function openPayoutBatch() {
    setPayoutPreselect([])
    setPayoutOpen(true)
  }

  function openPayoutDetail(payoutRequestId: string) {
    setPayoutDetailId(payoutRequestId)
    setPayoutDetailOpen(true)
  }

  // For senior: merge income + payout rows, newest first.
  // For drop: only income rows (payout rows settled via initiate route, not shown here).
  const visiblePayoutTxs = mode === 'senior' ? payoutTxs : []
  const allRows = [...incomeTxs, ...visiblePayoutTxs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  const isEmpty = allRows.length === 0

  // Batch «Создать выплату» button: SENIOR-only, shown when eligible incomes exist.
  const showBatchPayout = mode === 'senior' && validatedIncomes.length > 0

  return (
    <>
      <motion.div variants={card} initial="hidden" animate="show">
        <Card data-testid={`${testIdPrefix}-in-progress-panel`}>
          <CardContent className="pt-5 space-y-4">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">Транзакции в работе</p>
                <p className="text-xs text-muted-foreground">
                  Приходы на валидации и ожидающие выплаты
                </p>
              </div>
              <div className="flex items-center gap-2">
                {showBatchPayout && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={openPayoutBatch}
                    data-testid={`${testIdPrefix}-create-payout-batch`}
                  >
                    <Wallet className="h-4 w-4" aria-hidden="true" />
                    Создать выплату
                  </Button>
                )}
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setShowCreate(true)}
                  data-testid={`${testIdPrefix}-add-income`}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Добавить приход
                </Button>
              </div>
            </div>

            {/* Transaction rows */}
            {isEmpty ? (
              <p
                className="text-xs text-muted-foreground py-2"
                data-testid={`${testIdPrefix}-in-progress-empty`}
              >
                Нет транзакций в работе. Добавьте приход, чтобы начать.
              </p>
            ) : (
              <ul className="space-y-2" data-testid={`${testIdPrefix}-in-progress-list`}>
                {allRows.map((t) => {
                  const isPayout = t.type === 'PAYOUT'

                  // SENIOR: «Создать выплату» on eligible VALIDATED income rows
                  const showCreatePayoutBtn =
                    mode === 'senior' && !isPayout && t.status === 'VALIDATED' && !t.payoutRequestId

                  // SENIOR: «Оплатить» on PAYOUT PENDING_PAYMENT rows → PayoutDetailDialog
                  const showPayPayoutBtn =
                    mode === 'senior' &&
                    isPayout &&
                    t.status === 'PENDING_PAYMENT' &&
                    !!t.payoutRequestId

                  // DROP: «Платить» on VALIDATED DROP_INCOME rows → /crm/payments/initiate
                  const showDropPayBtn = mode === 'drop' && !isPayout && t.status === 'VALIDATED'

                  return (
                    <li
                      key={t.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                      data-testid={`${testIdPrefix}-in-progress-row-${t.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight truncate">
                          {isPayout ? 'Выплата (USDT)' : (t.projectName ?? '—')}
                        </p>
                        <p className="text-xs text-muted-foreground leading-tight">
                          {fmtDate(t.createdAt)}
                        </p>
                      </div>
                      <span className="text-sm font-medium tabular-nums shrink-0">
                        {fmtAmount(t.amount, t.currency)}
                      </span>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[11px] ${STATUS_COLORS[t.status]}`}
                        data-testid={`${testIdPrefix}-in-progress-status-${t.id}`}
                      >
                        {STATUS_LABELS[t.status]}
                      </Badge>

                      {/* SENIOR: VALIDATED income → «Создать выплату» */}
                      {showCreatePayoutBtn && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          onClick={() => openPayoutForTx(t.id)}
                          data-testid={`${testIdPrefix}-in-progress-payout-${t.id}`}
                        >
                          <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                          Создать выплату
                        </Button>
                      )}

                      {/* SENIOR: PAYOUT PENDING_PAYMENT → «Оплатить» → PayoutDetailDialog */}
                      {showPayPayoutBtn && (
                        <Button
                          variant="default"
                          size="sm"
                          className="shrink-0 gap-1.5 bg-primary/90 text-primary-foreground hover:bg-primary"
                          onClick={() => openPayoutDetail(t.payoutRequestId!)}
                          data-testid={`${testIdPrefix}-pay-payout-${t.id}`}
                        >
                          <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                          Оплатить
                        </Button>
                      )}

                      {/* DROP: VALIDATED DROP_INCOME → «Платить» → /crm/payments/initiate */}
                      {showDropPayBtn && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          aria-label={`Оплатить приход от ${t.projectName ?? 'проекта'}`}
                          data-testid={`${testIdPrefix}-in-progress-pay-${t.id}`}
                          onClick={() =>
                            void navigate({
                              to: '/crm/payments/initiate/$incomeId',
                              params: { incomeId: t.id },
                            })
                          }
                        >
                          Платить
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Finance dialogs */}
      <CreateTransactionDialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false)
          onRefresh()
        }}
      />
      <PayoutDialog
        open={payoutOpen}
        onClose={() => {
          setPayoutOpen(false)
          onRefresh()
        }}
        validatedTxs={validatedIncomes}
        preselectedTxIds={payoutPreselect}
      />
      <PayoutDetailDialog
        open={payoutDetailOpen}
        onClose={() => {
          setPayoutDetailOpen(false)
          onRefresh()
        }}
        payoutId={payoutDetailId}
      />
    </>
  )
}
