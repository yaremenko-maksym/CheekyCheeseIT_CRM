import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, CrmDialogContent, CrmDialogHeader, CrmDialogBody, CrmDialogFooter, DialogTitle } from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

type Step = 'select' | 'pay'

export function PayoutDialog({
  open,
  onClose,
  validatedTxs,
}: {
  open: boolean
  onClose: () => void
  validatedTxs: TransactionDto[]
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [step, setStep] = useState<Step>('select')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [payoutId, setPayoutId] = useState<string | null>(null)
  const [txHash, setTxHash] = useState('')

  // Per-tx effective share: prefer the snapshot stored on the transaction
  // (immutable since creation). Older rows that pre-date the snapshot fall
  // back to the senior's current default and get an "approx" badge.
  const seniorDefault = user?.seniorSharePercent ?? 26
  const selectedTxs = validatedTxs.filter((t) => selected.has(t.id))
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
    onSuccess: (data) => {
      setPayoutId(data.id)
      setStep('pay')
    },
  })

  const payMutation = useMutation({
    mutationFn: () => financeApi.payPayoutRequest(payoutId!, { txHash }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['payout-requests'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      handleClose()
    },
  })

  function handleClose() {
    onClose()
    setStep('select')
    setSelected(new Set())
    setPayoutId(null)
    setTxHash('')
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
  const payError = payMutation.error instanceof Error ? payMutation.error.message : null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <CrmDialogContent maxWidth="sm:max-w-lg">
        <CrmDialogHeader>
          <DialogTitle>{step === 'select' ? 'Выбрать транзакции для выплаты' : 'Подтвердить выплату'}</DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          {step === 'select' && (
            <div className="space-y-4">
              {validatedTxs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">Нет подтверждённых транзакций</p>
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
                    {previewRows.map(({ tx, sharePercent, isApproximate, senior, payable: rowPay }) => (
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
                            {isApproximate && (
                              <Badge variant="outline" className="ml-1.5 text-[9px] py-0">approx</Badge>
                            )}
                          </span>
                          <span className="tabular-nums">{senior.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>К оплате {100 - sharePercent}%</span>
                          <span className="tabular-nums">{rowPay.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Всего выбрано</span>
                      <span className="font-medium">{selected.size} транз.</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Общая сумма</span>
                      <span className="font-medium tabular-nums">₮{totalIncome.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Остаётся вам</span>
                      <span className="font-medium tabular-nums">₮{totalSenior.toFixed(2)}</span>
                    </div>
                    <div
                      className="flex justify-between text-primary"
                      data-testid="payout-preview-total"
                    >
                      <span>Всего к оплате</span>
                      <span className="font-bold tabular-nums">₮{payable.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}

              {createError && <p className="text-xs text-destructive">{createError}</p>}
            </div>
          )}

          {step === 'pay' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
                <div className="flex justify-between text-primary">
                  <span>К оплате</span>
                  <span className="font-bold tabular-nums">₮{payable.toFixed(2)}</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">TX Hash (USDT транзакция)</Label>
                <Input
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="0x..."
                  className="h-8 text-sm font-mono"
                />
              </div>

              {payError && <p className="text-xs text-destructive">{payError}</p>}
            </div>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>Отмена</Button>
          {step === 'select' && (
            <Button
              onClick={() => createMutation.mutate()}
              disabled={selected.size === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? 'Создание...' : 'Далее'}
            </Button>
          )}
          {step === 'pay' && (
            <Button
              onClick={() => payMutation.mutate()}
              disabled={!txHash.trim() || payMutation.isPending}
            >
              {payMutation.isPending ? 'Отправка...' : 'Оплатить'}
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
