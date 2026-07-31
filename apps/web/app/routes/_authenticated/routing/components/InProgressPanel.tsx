import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Wallet } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  STATUS_COLORS,
  STATUS_LABELS,
  fmtAmount,
  fmtDate,
} from '@/routes/_authenticated/finance/constants'
import { CreateTransactionDialog } from '@/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog'
import { PayoutDetailDialog } from '@/routes/_authenticated/finance/components/dialogs/PayoutDetailDialog'

/**
 * InProgressPanel — shared «Транзакции в работе» panel used by both
 * SeniorDashboard and DropDashboard.
 *
 * Renders:
 *   - income rows (PENDING/VALIDATED SENIOR_INCOME or DROP_INCOME) with
 *     «Создать выплату» on eligible VALIDATED rows (status=VALIDATED, no payout)
 *   - PAYOUT rows in PENDING_PAYMENT status with «Оплатить» → PayoutDetailDialog
 *   - toolbar: «Добавить приход» + batch «Создать выплату»
 *
 * Purely presentational — caller supplies data. The caller keeps react-query
 * hooks and passes `onRefresh` to invalidate caches after dialog success.
 */

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

export interface InProgressPanelProps {
  /**
   * Income transactions in the pipeline (PENDING/VALIDATED). Shown as
   * income rows; VALIDATED rows without a payout get «Создать выплату».
   */
  incomeTxs: TransactionDto[]
  /**
   * PAYOUT rows in PENDING_PAYMENT that belong to the current user.
   * These get an «Оплатить» button → PayoutDetailDialog.
   */
  payoutTxs: TransactionDto[]
  /**
   * Subset of incomeTxs: VALIDATED rows without a payoutRequestId —
   * eligible to batch into a new payout request.
   */
  validatedIncomes: TransactionDto[]
  /** Called when react-query caches should be refreshed (e.g. after dialog closes). */
  onRefresh: () => void
  /** data-testid prefix to namespace testids (e.g. "senior" or "drop"). */
  testIdPrefix: string
  /**
   * task-company-share-cta. The toolbar batch button and the per-row
   * «Создать выплату» pill both need to open `CompanySharePayoutModal`, which
   * the dashboard (SeniorDashboard/DropDashboard) now owns — it also drives
   * the modal from `CompanySharePayoutStrip` (SENIOR only). `ids` is the
   * preselected transaction id list: `[]` for the batch button (generic
   * multi-select — the modal defaults that to "select all"), `[txId]` for a
   * single row.
   */
  onOpenPayout: (ids: string[]) => void
}

export function InProgressPanel({
  incomeTxs,
  payoutTxs,
  validatedIncomes,
  onRefresh,
  testIdPrefix,
  onOpenPayout,
}: InProgressPanelProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [payoutDetailOpen, setPayoutDetailOpen] = useState(false)
  const [payoutDetailId, setPayoutDetailId] = useState<string | null>(null)

  function openPayoutForTx(txId: string) {
    onOpenPayout([txId])
  }

  function openPayoutBatch() {
    onOpenPayout([])
  }

  function openPayoutDetail(payoutRequestId: string) {
    setPayoutDetailId(payoutRequestId)
    setPayoutDetailOpen(true)
  }

  const allRows = [...incomeTxs, ...payoutTxs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  const isEmpty = allRows.length === 0

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
                {validatedIncomes.length > 0 && (
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

            {/* Rows */}
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
                  const isEligibleForPayout =
                    !isPayout && t.status === 'VALIDATED' && !t.payoutRequestId
                  const showPayBtn =
                    isPayout && t.status === 'PENDING_PAYMENT' && !!t.payoutRequestId

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

                      {/* VALIDATED income → «Создать выплату» */}
                      {isEligibleForPayout && (
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

                      {/* PAYOUT PENDING_PAYMENT → «Оплатить» */}
                      {showPayBtn && (
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
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Shared finance dialogs */}
      <CreateTransactionDialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false)
          onRefresh()
        }}
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
