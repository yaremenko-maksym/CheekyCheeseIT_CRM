import {
  Banknote,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  ExternalLink,
  Loader2,
  Wallet,
  XCircle,
} from 'lucide-react'
import type { ManualPayoutMethod } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { fmtAmount } from '../../constants'
import { SHOW_DEV_SIMULATE, type PayoutPaymentFormState } from '../../hooks/usePayoutPaymentForm'

const MANUAL_METHODS: { value: ManualPayoutMethod; label: string; icon: React.ReactNode }[] = [
  { value: 'CASH', label: 'Наличные', icon: <Banknote className="h-3.5 w-3.5" /> },
  { value: 'ADMIN_USDT', label: 'USDT партнёра', icon: <Wallet className="h-3.5 w-3.5" /> },
  { value: 'COMPANY_ACCOUNT', label: 'Счёт компании', icon: <Coins className="h-3.5 w-3.5" /> },
]

/**
 * PayoutPaymentForm — the BODY of "step 2" of the payout flow, extracted
 * unchanged from `PayoutDetailDialog.tsx` (task-company-share-cta §7.3 of the
 * design spec). Instruction card / transactions-in-payout list / tx-hash
 * input / dev-simulate radiogroup / on-chain status block / manual-confirm
 * section (ADMIN/ACCOUNTANT) — same JSX, same logic, now reading from the
 * shared `usePayoutPaymentForm` hook state instead of local closures.
 *
 * Purely presentational — does NOT own a `<Dialog>`/`<CrmDialogContent>` or a
 * footer. Callers:
 *   - `PayoutDetailDialog` wraps this in its own `<Dialog>` + header + footer
 *     (existing behaviour, unchanged).
 *   - `CompanySharePayoutModal` step 2 renders this directly inside its
 *     already-open dialog shell, with its own header/footer.
 */
export function PayoutPaymentForm({
  state,
  canManualConfirm,
}: {
  state: PayoutPaymentFormState
  canManualConfirm: boolean
}) {
  const {
    payoutQuery,
    payout,
    txHash,
    setTxHash,
    copied,
    copyAddress,
    onChainStatus,
    simulateMode,
    setSimulateMode,
    manualMethod,
    setManualMethod,
    manualNote,
    setManualNote,
    manualTxHash,
    setManualTxHash,
    payMutation,
    payError,
    manualMutation,
    isPaid,
  } = state

  return (
    <div className="space-y-4">
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
          {/* Instruction card — PRIMARY. Combines «сколько» (amount) and
              «куда» (company wallet address) so the SENIOR reads it top-down
              as a single transfer instruction (design spec §3.2). */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
            {/* Amount row */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground shrink-0">К оплате</span>
              <span
                className="text-xl font-bold tabular-nums text-primary"
                data-testid="payout-detail-payable"
              >
                {fmtAmount(payout.payableAmount, 'USDT')}
              </span>
            </div>

            {/* Divider */}
            <div className="border-t border-border/40" />

            {/* Address row */}
            <div className="space-y-1">
              <p
                className="text-xs text-muted-foreground"
                data-testid="payout-detail-contract-address-label"
              >
                Адрес кошелька компании (USDT ERC-20):
              </p>
              {payout.contractAddress ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <code
                    className="flex-1 text-xs font-mono break-all min-w-0 text-foreground/90"
                    data-testid="payout-detail-contract-address"
                  >
                    {payout.contractAddress}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0 shrink-0"
                    onClick={() => copyAddress(payout.contractAddress)}
                    aria-label="Скопировать адрес"
                    data-testid="payout-detail-copy-address"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <p className="text-xs text-destructive/80">Адрес не настроен</p>
                  <p className="text-[11px] text-muted-foreground">Обратитесь к администратору.</p>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Переведите {fmtAmount(payout.payableAmount, 'USDT')} на адрес кошелька компании
                (ERC-20), затем вставьте хеш транзакции.
              </p>
            </div>
          </div>

          {/* Transactions in this payout (SENIOR_INCOME-only — see PR #56).
              Preserved exactly as in the original PayoutDetailDialog — this
              extraction changes NO logic (design spec §7.3). */}
          {(() => {
            const incomeTxs = payout.transactions?.filter((t) => t.type === 'SENIOR_INCOME') ?? []
            if (incomeTxs.length === 0) return null
            return (
              <div className="space-y-1.5">
                <Label className="text-xs" data-testid="payout-detail-transactions-count">
                  Транзакции в выплате ({incomeTxs.length})
                </Label>
                <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto">
                  {incomeTxs.map((tx) => (
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
            )
          })()}

          {/* TX hash — input (PENDING) or read-only display (PAID) */}
          {isPaid ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Хеш транзакции</Label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
                <code className="flex-1 text-xs font-mono break-all">{payout.txHash ?? '—'}</code>
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
                Хеш транзакции
                {SHOW_DEV_SIMULATE && (simulateMode === 'success' || simulateMode === 'error') ? (
                  <span className="text-muted-foreground"> (опционально в dev режиме)</span>
                ) : (
                  <span className="text-muted-foreground"> (после оплаты)</span>
                )}
              </Label>
              <Input
                id="payout-tx-hash-input"
                data-testid="payout-detail-tx-hash-input"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
                className="h-9 text-sm font-mono"
                disabled={payMutation.isPending || onChainStatus === 'confirmed'}
              />
              {txHash.trim().length >= 10 && (
                <a
                  href={`https://etherscan.io/tx/${txHash.trim()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  Проверить в Etherscan <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {SHOW_DEV_SIMULATE && !isPaid && (
            <div
              className="space-y-1.5 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-2.5"
              data-testid="payout-detail-dev-simulate"
              role="radiogroup"
              aria-label="Dev режим: результат валидации"
            >
              <Label className="text-xs flex items-center gap-1.5">
                <span>🔧 Dev режим: результат валидации</span>
              </Label>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    { value: 'success', label: '✅ Симулировать успех' },
                    { value: 'error', label: '❌ Симулировать ошибку' },
                    { value: 'real', label: '🔗 Реальная проверка (недоступно в dev)' },
                  ] as const
                ).map((opt) => {
                  const selected = simulateMode === opt.value
                  return (
                    <label
                      key={opt.value}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs cursor-pointer transition-colors',
                        selected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-background hover:bg-muted/40 text-muted-foreground',
                      )}
                      data-testid={`payout-detail-dev-simulate-${opt.value}`}
                    >
                      <input
                        type="radio"
                        name="payout-simulate-mode"
                        value={opt.value}
                        checked={selected}
                        onChange={() => setSimulateMode(opt.value)}
                        disabled={payMutation.isPending}
                        className="h-3 w-3 accent-primary shrink-0"
                      />
                      <span>{opt.label}</span>
                    </label>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Доступно только в dev-сборке. Выберите «успех» или «ошибку», чтобы разблокировать
                «Подтвердить оплату».
              </p>
            </div>
          )}

          {/* On-chain validation status block (design spec §3.5). */}
          {!isPaid && onChainStatus !== 'idle' && (
            <div
              data-testid="payout-detail-on-chain-status"
              data-status={onChainStatus}
              className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
            >
              {onChainStatus === 'validating' && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs font-medium">Проверка on-chain…</p>
                    <p className="text-[11px] text-muted-foreground">
                      Запрос к Etherscan, займёт несколько секунд
                    </p>
                  </div>
                </div>
              )}
              {onChainStatus === 'confirmed' && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
                >
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-emerald-400">Транзакция подтверждена</p>
                    <p className="text-[11px] text-muted-foreground">
                      Выплата переведена в статус ОПЛАЧЕНО
                    </p>
                  </div>
                </div>
              )}
              {onChainStatus === 'rejected' && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    <p className="text-xs font-medium text-destructive">Транзакция не принята</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground pl-6">
                    {payError ?? 'Не удалось подтвердить оплату.'}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 pl-6">
                    Проверьте хеш и попробуйте снова, или используйте ручное подтверждение.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Manual override section — ADMIN/ACCOUNTANT only, hidden once the
              payout is PAID (design spec §3.7). */}
          {canManualConfirm && !isPaid && (
            <div className="space-y-3" data-testid="payout-detail-manual-section">
              <div className="relative my-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border/50" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-[10px] text-muted-foreground uppercase tracking-wider">
                    Ручное подтверждение
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Метод оплаты</Label>
                <div
                  role="radiogroup"
                  aria-label="Метод ручного подтверждения"
                  className="grid grid-cols-3 gap-2 max-sm:grid-cols-1"
                >
                  {MANUAL_METHODS.map((m) => {
                    const active = manualMethod === m.value
                    return (
                      <button
                        key={m.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setManualMethod(m.value)}
                        data-testid={`payout-detail-manual-method-${m.value.toLowerCase()}`}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors cursor-pointer',
                          active
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40',
                        )}
                      >
                        {m.icon}
                        <span>{m.label}</span>
                      </button>
                    )
                  })}
                </div>
                {manualMethod === 'COMPANY_ACCOUNT' && (
                  <p className="text-[11px] text-primary/80 flex items-center gap-1">
                    <Coins className="h-3 w-3 shrink-0" />
                    Этот метод кредитует баланс счёта компании
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label className="text-xs" htmlFor="payout-manual-note">
                  Примечание <span className="text-muted-foreground">(опционально)</span>
                </Label>
                <Textarea
                  id="payout-manual-note"
                  data-testid="payout-detail-manual-note"
                  rows={2}
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder="Укажите детали ручного подтверждения"
                  className="text-xs resize-none"
                />
              </div>

              {manualMethod !== 'CASH' && (
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="payout-manual-tx-hash">
                    Хеш транзакции <span className="text-muted-foreground">(опционально)</span>
                  </Label>
                  <Input
                    id="payout-manual-tx-hash"
                    data-testid="payout-detail-manual-tx-hash"
                    value={manualTxHash}
                    onChange={(e) => setManualTxHash(e.target.value)}
                    placeholder="0x..."
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => manualMutation.mutate()}
                disabled={manualMutation.isPending}
                className="w-full mt-1"
                data-testid="payout-detail-manual-submit"
              >
                {manualMutation.isPending ? 'Сохранение…' : 'Подтвердить вручную'}
              </Button>
            </div>
          )}

          {payError && onChainStatus !== 'rejected' && (
            <p className="text-xs text-destructive">{payError}</p>
          )}
        </>
      )}
    </div>
  )
}
