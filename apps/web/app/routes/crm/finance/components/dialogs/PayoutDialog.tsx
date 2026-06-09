import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

/**
 * Step 1 of the SENIOR payout flow — selection only. Picks which VALIDATED
 * SENIOR_INCOME transactions go into a Выплата (payout_request). On submit,
 * the backend:
 *   1. Creates a payout_request with a freshly-generated stub contract address
 *   2. Flips the selected transactions to status=PENDING_PAYMENT
 *
 * After creation this dialog closes — the SENIOR pays via PayoutDetailDialog,
 * which is opened from the inline «Оплатить» button on a PENDING_PAYMENT row
 * (where the contract address + tx-hash field live).
 */
export function PayoutDialog({
  open,
  onClose,
  validatedTxs,
  preselectedTxIds,
}: {
  open: boolean
  onClose: () => void
  validatedTxs: TransactionDto[]
  /**
   * Optional transaction IDs to pre-check when the dialog opens. Used by
   * inline row «Выплатить» and detail dialog footer to open with a single
   * tx already selected, while the header button leaves the selection empty
   * so the user can pick multiple rows manually.
   */
  preselectedTxIds?: string[]
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselectedTxIds ?? []))

  // Sync selection when the dialog re-opens with a different preselection.
  // Important: the dialog component is mounted permanently in the parent and
  // toggled via `open`, so without this effect the previously-selected ids
  // would persist across consecutive opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set(preselectedTxIds ?? []))
    }
  }, [open, preselectedTxIds])

  // Per-tx effective share: prefer the snapshot stored on the transaction
  // (immutable since creation). Older rows that pre-date the snapshot fall
  // back to the senior's current default and get an "approx" badge.
  const seniorDefault = user?.seniorSharePercent ?? 26
  const selectedTxs = validatedTxs.filter((t) => selected.has(t.id))

  // Mixed-currency guard: mirror the backend rejection so the SENIOR sees
  // an inline error before even hitting submit.
  const selectedCurrencies = new Set(selectedTxs.map((t) => t.currency))
  const hasMixedCurrencies = selectedCurrencies.size > 1
  // Display currency for totals — only meaningful when all txs share the same
  // currency (hasMixedCurrencies === false). Falls back to 'USDT' for empty
  // selection or pre-guard display.
  const batchCurrency =
    selectedCurrencies.size === 1 ? ([...selectedCurrencies][0]! as string) : 'USDT'
  const totalIncome = selectedTxs.reduce((sum, t) => sum + parseFloat(t.amount), 0)
  const previewRows = selectedTxs.map((tx) => {
    const snapshot = tx.seniorSharePercent
    const share = snapshot ?? seniorDefault
    const amount = parseFloat(tx.amount)
    return {
      tx,
      sharePercent: share,
      isApproximate: snapshot === null || snapshot === undefined,
      senior: amount * (share / 100),
      payable: amount * (1 - share / 100),
    }
  })
  const payable = previewRows.reduce((sum, r) => sum + r.payable, 0)
  const totalSenior = previewRows.reduce((sum, r) => sum + r.senior, 0)

  const createMutation = useMutation({
    mutationFn: () => financeApi.createPayoutRequest({ transactionIds: [...selected] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['payout-requests'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      toast.success('Выплата создана', {
        description: 'Откройте выплату в строке транзакции и подтвердите оплату.',
      })
      handleClose()
    },
  })

  function handleClose() {
    onClose()
    setSelected(new Set())
  }

  function toggleTx(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const createError = createMutation.error instanceof Error ? createMutation.error.message : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-lg">
        <CrmDialogHeader>
          <DialogTitle>Выбрать транзакции для выплаты</DialogTitle>
          <DialogDescription className="sr-only">
            Выбор подтверждённых транзакций для формирования запроса на выплату.
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          <div className="space-y-4">
            {validatedTxs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Нет подтверждённых транзакций
              </p>
            ) : (
              <div className="space-y-2">
                {validatedTxs.map((tx) => (
                  <label
                    key={tx.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(tx.id)}
                      onChange={() => toggleTx(tx.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{tx.projectName ?? '—'}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(tx.createdAt).toLocaleDateString('uk-UA')}
                      </p>
                    </div>
                    <span className="text-sm font-medium tabular-nums shrink-0">
                      {fmtAmount(tx.amount, tx.currency)}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {selected.size > 0 && (
              <div className="space-y-3">
                {/* Per-transaction preview — shows the snapshot share so
                    SENIOR can sanity-check what each row contributes. */}
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2 text-xs">
                  <p className="font-medium text-foreground/80">Превью расчёта</p>
                  {previewRows.map(
                    ({ tx, sharePercent, isApproximate, senior, payable: rowPay }) => (
                      <div
                        key={tx.id}
                        className="space-y-0.5 border-l-2 border-border/60 pl-2"
                        data-testid={`payout-preview-row-${tx.id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-foreground truncate">
                            Транзакция #{tx.id.slice(0, 6)} от{' '}
                            {new Date(tx.txDate ?? tx.createdAt).toLocaleDateString('ru-RU')}
                          </span>
                          <span className="tabular-nums font-medium text-foreground shrink-0">
                            {fmtAmount(tx.amount, tx.currency)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>
                            Ваша доля {sharePercent}%
                            {/* task-team-senior-share-override. Reuse the
                              per-row snapshot source so the SENIOR knows if
                              the share came from a project / team override
                              or their user default. Legacy rows (no source)
                              keep the old «approx» badge. */}
                            {tx.seniorSharePercentSource ? (
                              <span
                                className="ml-1.5 text-[10px] uppercase tracking-wide opacity-75"
                                data-testid={`payout-preview-source-${tx.id}`}
                                data-share-source={tx.seniorSharePercentSource}
                              >
                                ·{' '}
                                {tx.seniorSharePercentSource === 'PROJECT'
                                  ? 'проект'
                                  : tx.seniorSharePercentSource === 'TEAM'
                                    ? 'команда'
                                    : 'по умолчанию'}
                              </span>
                            ) : null}
                            {isApproximate && (
                              <Badge variant="outline" className="ml-1.5 text-[9px] py-0">
                                approx
                              </Badge>
                            )}
                          </span>
                          <span className="tabular-nums">{fmtAmount(senior, tx.currency)}</span>
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>К оплате {100 - sharePercent}%</span>
                          <span className="tabular-nums">{fmtAmount(rowPay, tx.currency)}</span>
                        </div>
                      </div>
                    ),
                  )}
                </div>

                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Всего выбрано</span>
                    <span className="font-medium">{selected.size} транз.</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Общая сумма</span>
                    <span className="font-medium tabular-nums">
                      {fmtAmount(totalIncome, batchCurrency)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Остаётся вам</span>
                    <span className="font-medium tabular-nums">
                      {fmtAmount(totalSenior, batchCurrency)}
                    </span>
                  </div>
                  <div
                    className="flex justify-between text-primary"
                    data-testid="payout-preview-total"
                  >
                    <span>Всего к оплате</span>
                    <span className="font-bold tabular-nums">
                      {fmtAmount(payable, batchCurrency)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {hasMixedCurrencies && (
              <p className="text-xs text-destructive" data-testid="payout-mixed-currency-error">
                Нельзя смешивать валюты в одной выплате. Выберите транзакции только одной валюты.
              </p>
            )}

            {createError && <p className="text-xs text-destructive">{createError}</p>}
          </div>
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Отмена
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={selected.size === 0 || hasMixedCurrencies || createMutation.isPending}
          >
            {createMutation.isPending ? 'Создание...' : 'Создать выплату'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
