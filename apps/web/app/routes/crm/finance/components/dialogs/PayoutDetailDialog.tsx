import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { toast } from 'sonner'
import type { ManualPayoutMethod } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { cn } from '@/lib/utils'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { financeApi } from '../../api'
import { fmtAmount } from '../../constants'

// Dev-only escape hatch: shown in dev builds so the SENIOR can rehearse the
// success and error paths of the payout submit without sending a real
// on-chain transaction. Tree-shaken out of `pnpm build` (import.meta.env.DEV
// becomes the literal `false` in production output → dead-code elimination
// drops the whole branch).
const SHOW_DEV_SIMULATE = import.meta.env.DEV

type SimulateMode = 'success' | 'error' | 'real'

// On-chain submit state machine (Phase 8 v2 design spec §3.5). Drives the
// inline status block + footer CTA so the SENIOR sees Etherscan validation
// progress INSIDE the dialog (previously the result surfaced only via toast).
type OnChainStatus = 'idle' | 'validating' | 'confirmed' | 'rejected'

// Auto-close delay after a confirmed on-chain payout (design spec §3.5).
const CONFIRMED_AUTOCLOSE_MS = 1500

const MANUAL_METHODS: { value: ManualPayoutMethod; label: string; icon: React.ReactNode }[] = [
  { value: 'CASH', label: 'Наличные', icon: <Banknote className="h-3.5 w-3.5" /> },
  { value: 'ADMIN_USDT', label: 'USDT партнёра', icon: <Wallet className="h-3.5 w-3.5" /> },
  { value: 'COMPANY_ACCOUNT', label: 'Счёт компании', icon: <Coins className="h-3.5 w-3.5" /> },
]

/**
 * Pull a user-facing message out of either an axios error (where NestJS puts
 * the Russian text in `response.data.message`) or a plain Error. Axios's own
 * `error.message` is the generic "Request failed with status code 400" — we
 * want the backend's actual reason ("Получатель транзакции не совпадает с
 * кошельком компании") surfaced in the toast and inline diagnostic.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { message?: unknown } } }).response
    const msg = resp?.data?.message
    if (typeof msg === 'string' && msg.length > 0) return msg
    if (Array.isArray(msg) && msg.length > 0 && typeof msg[0] === 'string') return msg[0]
  }
  if (err instanceof Error) return err.message
  return 'Неизвестная ошибка'
}

/**
 * Step 2 of the SENIOR/DROP payout flow — settles a previously-created Выплата
 * by transferring `payableAmount` USDT to the COMPANY wallet and submitting the
 * on-chain tx hash for Etherscan verification (Phase 8 v2).
 *
 * Opened from the inline «Оплатить» badge on a PENDING_PAYMENT transaction row.
 * The destination wallet is `payout.contractAddress` (the company USDT wallet);
 * the SENIOR copies it, sends the USDT, then pastes the hash. The submit hits
 * /payout-requests/:id/pay where the backend verifies on-chain (stub
 * auto-confirms in dev) and flips the payout to PAID.
 *
 * ADMIN/ACCOUNTANT additionally get a secondary «Ручное подтверждение» section
 * (escape hatch) that calls the NEW /payout-requests/:id/manual-confirm
 * endpoint — for payouts settled off the on-chain happy path.
 *
 * Read-only when the payout is already PAID — preserves the audit trail.
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
  const { user } = useAuth()
  const canManualConfirm = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  const [txHash, setTxHash] = useState('')
  const [copied, setCopied] = useState(false)
  const [onChainStatus, setOnChainStatus] = useState<OnChainStatus>('idle')
  // Default to «real» — the SENIOR has to explicitly opt into one of the
  // simulate paths to unlock submit. Real verification is intentionally
  // disabled in dev (no on-chain ledger transactions to validate against),
  // so it acts as a hard gate that forces a conscious dev-mode choice
  // instead of accidentally submitting an unsigned stub.
  const [simulateMode, setSimulateMode] = useState<SimulateMode>('real')

  // Manual-override (ADMIN/ACCOUNTANT) local state.
  const [manualMethod, setManualMethod] = useState<ManualPayoutMethod>('COMPANY_ACCOUNT')
  const [manualNote, setManualNote] = useState('')
  const [manualTxHash, setManualTxHash] = useState('')

  // Auto-close timer ref so we can clear it on unmount / manual close and never
  // fire a stale onClose after the dialog already went away (design spec §13.4).
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      setOnChainStatus('idle')
      setSimulateMode('real')
      setManualMethod('COMPANY_ACCOUNT')
      setManualNote('')
      setManualTxHash('')
    }
  }, [open, payoutId])

  // Clean up any pending auto-close timer on unmount.
  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
    }
  }, [])

  function invalidatePayoutQueries() {
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: ['payout-request', payoutId] })
    void qc.invalidateQueries({ queryKey: ['finance-summary'] })
    void qc.invalidateQueries({ queryKey: ['company-account'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  const payMutation = useMutation({
    mutationFn: () => {
      // Only attach simulateResult when the dev toggle is mounted AND the
      // user picked one of the simulate options. In prod the field is never
      // sent — backend behaviour matches what it always did.
      const simulateResult = SHOW_DEV_SIMULATE && simulateMode !== 'real' ? simulateMode : undefined
      const trimmedHash = txHash.trim()
      // In simulate mode the hash is optional — only attach it when non-empty so
      // backend's superRefine doesn't see a stray empty string. In real mode
      // (prod) we always submit the trimmed hash (gate ensures min 10 chars).
      const hashField =
        simulateResult !== undefined
          ? trimmedHash.length > 0
            ? { txHash: trimmedHash }
            : {}
          : { txHash: trimmedHash }
      return financeApi.payPayoutRequest(payoutId!, {
        ...hashField,
        ...(simulateResult !== undefined && { simulateResult }),
      })
    },
    onMutate: () => {
      setOnChainStatus('validating')
    },
    onSuccess: () => {
      setOnChainStatus('confirmed')
      invalidatePayoutQueries()
      toast.success('Оплата подтверждена', {
        description: 'Транзакции переведены в статус ОПЛАЧЕНО, инвойсы сгенерированы.',
      })
      // Auto-close after a short success beat so the user sees the confirmed
      // status block before the dialog dismisses.
      autoCloseRef.current = setTimeout(() => {
        handleClose()
      }, CONFIRMED_AUTOCLOSE_MS)
    },
    onError: (err) => {
      // Surface the concrete backend reason both inline (status block) and via
      // toast. Dialog stays open with the input re-enabled so the user can fix
      // the hash and retry, or fall back to manual confirmation.
      setOnChainStatus('rejected')
      toast.error('Не удалось подтвердить оплату', {
        description: extractErrorMessage(err),
      })
    },
  })

  const manualMutation = useMutation({
    mutationFn: () => {
      const trimmedNote = manualNote.trim()
      const trimmedHash = manualTxHash.trim()
      return financeApi.manualConfirmPayout(payoutId!, {
        method: manualMethod,
        // Only attach optional fields when populated (CASH never carries a hash;
        // the field is hidden for it anyway).
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
        ...(manualMethod !== 'CASH' && trimmedHash.length > 0 ? { txHash: trimmedHash } : {}),
      })
    },
    onSuccess: () => {
      invalidatePayoutQueries()
      toast.success('Выплата подтверждена вручную', {
        description:
          manualMethod === 'COMPANY_ACCOUNT'
            ? 'Баланс счёта компании пополнен.'
            : 'Выплата переведена в статус ОПЛАЧЕНО.',
      })
      handleClose()
    },
    onError: (err) => {
      toast.error('Не удалось подтвердить вручную', {
        description: extractErrorMessage(err),
      })
    },
  })

  function handleClose() {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current)
      autoCloseRef.current = null
    }
    onClose()
    setTxHash('')
    setCopied(false)
    setOnChainStatus('idle')
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
  const payError = payMutation.error ? extractErrorMessage(payMutation.error) : null
  const isPaid = payout?.status === 'PAID'

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-xl" data-testid="payout-detail-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="payout-detail-title">
            {isPaid ? 'Выплата (оплачена)' : 'Подтвердить выплату'}
            {isPaid && (
              <Badge variant="secondary" className="text-[10px]">
                PAID
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">Детали выплаты</DialogDescription>
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
                      <p className="text-[11px] text-muted-foreground">
                        Обратитесь к администратору.
                      </p>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Переведите {fmtAmount(payout.payableAmount, 'USDT')} на адрес кошелька компании
                    (ERC-20), затем вставьте хеш транзакции.
                  </p>
                </div>
              </div>

              {/* Transactions in this payout (SENIOR_INCOME-only — see PR #56). */}
              {(() => {
                const seniorIncomeTxs =
                  payout.transactions?.filter((t) => t.type === 'SENIOR_INCOME') ?? []
                if (seniorIncomeTxs.length === 0) return null
                return (
                  <div className="space-y-1.5">
                    <Label className="text-xs" data-testid="payout-detail-transactions-count">
                      Транзакции в выплате ({seniorIncomeTxs.length})
                    </Label>
                    <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto">
                      {seniorIncomeTxs.map((tx) => (
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
                    Хеш транзакции
                    {SHOW_DEV_SIMULATE &&
                    (simulateMode === 'success' || simulateMode === 'error') ? (
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
                        {
                          value: 'real',
                          label: '🔗 Реальная проверка (недоступно в dev)',
                        },
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
                    Доступно только в dev-сборке. Выберите «успех» или «ошибку», чтобы
                    разблокировать «Подтвердить оплату».
                  </p>
                </div>
              )}

              {/* On-chain validation status block (design spec §3.5) — appears
                  after the first submit. Inline, role="status"/"alert" for SR. */}
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
                        <p className="text-xs font-medium text-emerald-400">
                          Транзакция подтверждена
                        </p>
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
                        <p className="text-xs font-medium text-destructive">
                          Транзакция не принята
                        </p>
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
                  payout is PAID. Visually secondary, divided off from the
                  on-chain flow (design spec §3.7). Uses the NEW manual-confirm
                  endpoint. */}
              {canManualConfirm && !isPaid && (
                <div className="space-y-3" data-testid="payout-detail-manual-section">
                  {/* Divider with label */}
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

                  {/* Method radiogroup */}
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

                  {/* Note (optional) */}
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

                  {/* Manual TX hash — hidden for CASH (no on-chain hash) */}
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
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {isPaid || onChainStatus === 'confirmed' ? 'Закрыть' : 'Отмена'}
          </Button>
          {!isPaid &&
            payout &&
            onChainStatus !== 'confirmed' &&
            (() => {
              // Submit gate (PR #56 logic preserved):
              //   1. payMutation.isPending — always blocks (request in flight).
              //   2. DEV simulate mode (success/error) — hash is optional.
              //   3. Real mode — requires hash ≥ 10 chars; in DEV the «🔗
              //      Реальная проверка» radio is itself a hard gate.
              const isSimulate =
                SHOW_DEV_SIMULATE && (simulateMode === 'success' || simulateMode === 'error')
              const realModeBlocked = SHOW_DEV_SIMULATE && simulateMode === 'real'
              const hashTooShort = txHash.trim().length < 10
              const submitDisabled =
                payMutation.isPending || realModeBlocked || (!isSimulate && hashTooShort)
              return (
                <Button
                  data-testid="payout-detail-submit"
                  onClick={() => payMutation.mutate()}
                  disabled={submitDisabled}
                  className={submitDisabled ? 'opacity-50 cursor-not-allowed' : undefined}
                >
                  {payMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Проверка…
                    </>
                  ) : (
                    'Подтвердить оплату'
                  )}
                </Button>
              )
            })()}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
