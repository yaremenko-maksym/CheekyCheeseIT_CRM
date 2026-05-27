import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, CrmDialogContent, CrmDialogHeader, CrmDialogBody, CrmDialogFooter, DialogTitle } from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

/**
 * Step 2 of the SENIOR payout flow — pays a previously-created Выплата.
 *
 * Opened from the inline «Оплатить» badge on a PENDING_PAYMENT transaction
 * row (the badge passes the tx.payoutRequestId here). Shows the destination
 * contract address the SENIOR must send `payableAmount` USDT to, then takes
 * the on-chain tx_hash and submits it to /payout-requests/:id/pay where the
 * backend verifies via etherscan (stub auto-confirms in dev) and triggers
 * the invoice auto-creation cascade.
 *
 * Read-only when the payout is already PAID — preserves the audit trail
 * (contract address used, the tx hash that closed it).
 */
export function PayoutDetailDialog({
  open,
  onClose,
  payoutId,
}: {
  open: boolean
  onClose: () => void
  payoutId: string | null
}) {
  const qc = useQueryClient()
  const [txHash, setTxHash] = useState('')
  const [copied, setCopied] = useState(false)

  const payoutQuery = useQuery({
    queryKey: ['payout-request', payoutId],
    queryFn: () => financeApi.getPayoutRequest(payoutId!),
    enabled: open && !!payoutId,
  })

  // Reset local state when the dialog flips closed → open with a new id
  useEffect(() => {
    if (open) {
      setTxHash('')
      setCopied(false)
    }
  }, [open, payoutId])

  const payMutation = useMutation({
    mutationFn: () => financeApi.payPayoutRequest(payoutId!, { txHash: txHash.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['payout-requests'] })
      void qc.invalidateQueries({ queryKey: ['payout-request', payoutId] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['notifications'] })
      toast.success('Оплата подтверждена', {
        description: 'Транзакции переведены в статус ОПЛАЧЕНО, инвойсы сгенерированы.',
      })
      handleClose()
    },
  })

  function handleClose() {
    onClose()
    setTxHash('')
    setCopied(false)
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can fail in insecure contexts (http) — show the
      // address so the user can still copy manually.
      toast.error('Не удалось скопировать. Выделите адрес вручную.')
    }
  }

  const payout = payoutQuery.data
  const payError = payMutation.error instanceof Error ? payMutation.error.message : null
  const isPaid = payout?.status === 'PAID'

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <CrmDialogContent maxWidth="sm:max-w-xl">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isPaid ? 'Выплата (оплачена)' : 'Подтвердить выплату'}
            {isPaid && (
              <Badge variant="secondary" className="text-[10px]">PAID</Badge>
            )}
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4 space-y-4">
          {payoutQuery.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {payoutQuery.isError && (
            <p className="text-sm text-destructive">
              Не удалось загрузить данные выплаты. Попробуйте позже.
            </p>
          )}

          {payout && (
            <>
              {/* Payable amount banner — first thing user sees */}
              <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">К оплате</span>
                <span
                  className="text-lg font-bold tabular-nums text-primary"
                  data-testid="payout-detail-payable"
                >
                  ₮{parseFloat(payout.payableAmount).toFixed(2)}
                </span>
              </div>

              {/* Contract address — copy-able */}
              <div className="space-y-1.5">
                <Label className="text-xs">Адрес смарт-контракта (USDT ERC-20)</Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
                  <code
                    className="flex-1 text-xs font-mono break-all"
                    data-testid="payout-detail-contract-address"
                  >
                    {payout.contractAddress}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 shrink-0"
                    onClick={() => copyAddress(payout.contractAddress)}
                    aria-label="Скопировать адрес"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Отправьте сумму к оплате на указанный адрес, затем вставьте хеш транзакции ниже.
                </p>
              </div>

              {/* Transactions in this payout */}
              {payout.transactions && payout.transactions.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Транзакции в выплате ({payout.transactions.length})</Label>
                  <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto">
                    {payout.transactions
                      .filter((t) => t.type === 'SENIOR_INCOME')
                      .map((tx) => (
                        <div
                          key={tx.id}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                          data-testid={`payout-detail-tx-${tx.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{tx.projectName ?? '—'}</p>
                            <p className="text-muted-foreground">
                              #{tx.id.slice(0, 6)} от{' '}
                              {new Date(tx.txDate ?? tx.createdAt).toLocaleDateString('ru-RU')}
                            </p>
                          </div>
                          <span className="tabular-nums font-medium shrink-0">
                            {fmtAmount(tx.amount, tx.currency)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* TX hash — input (PENDING) or read-only display (PAID) */}
              {isPaid ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Хеш транзакции</Label>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
                    <code className="flex-1 text-xs font-mono break-all">
                      {payout.txHash ?? '—'}
                    </code>
                    {payout.txHash && (
                      <a
                        href={`https://etherscan.io/tx/${payout.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        aria-label="Открыть в etherscan"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="payout-tx-hash-input">
                    Хеш транзакции (после оплаты)
                  </Label>
                  <Input
                    id="payout-tx-hash-input"
                    data-testid="payout-detail-tx-hash-input"
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value)}
                    placeholder="0x..."
                    className="h-8 text-sm font-mono"
                    disabled={payMutation.isPending}
                  />
                </div>
              )}

              {payError && <p className="text-xs text-destructive">{payError}</p>}
            </>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {isPaid ? 'Закрыть' : 'Отмена'}
          </Button>
          {!isPaid && payout && (
            <Button
              data-testid="payout-detail-submit"
              onClick={() => payMutation.mutate()}
              disabled={txHash.trim().length < 10 || payMutation.isPending}
            >
              {payMutation.isPending ? 'Проверка...' : 'Подтвердить оплату'}
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
