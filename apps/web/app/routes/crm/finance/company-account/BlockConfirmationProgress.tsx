import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertCircle, CheckCircle2, Coins, Copy, Loader2 } from 'lucide-react'
import type { CompanyDepositDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { companyAccountApi } from '../api'

type Phase = 'idle' | 'checking' | 'confirming' | 'confirmed' | 'error'

interface DepositConfirmCardProps {
  /** Called when a deposit reaches PAID, so the parent can refresh the balance. */
  onCredited?: () => void
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

/** Rough estimate: ~13.5s per Ethereum block. */
function estimateRemaining(confirmations: number, threshold: number): string {
  const blocksLeft = Math.max(0, threshold - confirmations)
  const sec = Math.ceil(blocksLeft * 13.5)
  if (sec <= 0) return 'почти готово'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `~${m} мин ${s} сек осталось` : `~${s} сек осталось`
}

/**
 * task-company-account-frontend — the deposit confirmation flow + the live
 * block-resolution progress bar (12 segments). Owner requirement: "дизайн на
 * высоте", progress feels like a real on-chain process, not a spinner.
 *
 * Flow: submit txHash/link → backend inserts a COMPANY_DEPOSIT. If it already
 * confirmed → PAID. Else PENDING; we poll status every 1.5s and animate
 * confirmations toward the threshold. A recipient mismatch (`toMatches=false`)
 * never credits → shown as an error.
 */
export function DepositConfirmCard({ onCredited }: DepositConfirmCardProps) {
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [deposit, setDeposit] = useState<CompanyDepositDto | null>(null)
  const [errorText, setErrorText] = useState('')
  // Live confirmations (seeded from submit, refreshed by polling).
  const [confirmations, setConfirmations] = useState(0)

  const threshold = deposit?.threshold ?? 12

  const submit = useMutation({
    mutationFn: () => companyAccountApi.submitDeposit({ txHashOrLink: input.trim() }),
    onMutate: () => setPhase('checking'),
    onSuccess: (dep) => {
      setDeposit(dep)
      setConfirmations(dep.confirmations)
      if (dep.status === 'PAID') {
        setPhase('confirmed')
        onCredited?.()
        void qc.invalidateQueries({ queryKey: ['company-account'] })
      } else if (!dep.toMatches) {
        setPhase('error')
        setErrorText(
          'Транзакция не подтверждена: не найдена в блокчейне или отправлена не на адрес компании. Проверьте ссылку.',
        )
      } else {
        setPhase('confirming')
      }
    },
    onError: (err: unknown) => {
      setPhase('error')
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Не удалось проверить транзакцию. Попробуйте ещё раз.'
      setErrorText(typeof msg === 'string' ? msg : 'Ошибка проверки транзакции.')
    },
  })

  // Poll status while confirming; drive UI from the data in an effect (side
  // effects must NOT live in `select`).
  const statusQuery = useQuery({
    queryKey: ['deposit-status', deposit?.id],
    queryFn: () => companyAccountApi.getDepositStatus(deposit!.id),
    enabled: phase === 'confirming' && !!deposit?.id,
    refetchInterval: phase === 'confirming' ? 1500 : false,
  })

  useEffect(() => {
    const s = statusQuery.data
    if (!s || phase !== 'confirming') return
    setConfirmations(s.confirmations)
    if (s.status === 'PAID') {
      setPhase('confirmed')
      onCredited?.()
      void qc.invalidateQueries({ queryKey: ['company-account'] })
    }
  }, [statusQuery.data, phase, onCredited, qc])

  const reset = () => {
    setPhase('idle')
    setDeposit(null)
    setErrorText('')
    setConfirmations(0)
    setInput('')
  }

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    toast.success(`${label} скопирован`)
  }

  return (
    <Card className="border-border bg-muted/20" data-testid="block-confirmation-progress">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Coins className="h-4 w-4 text-primary" /> Подтвердить депозит USDT
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Отправьте USDT на счёт компании и вставьте ссылку на транзакцию Etherscan
        </p>
      </CardHeader>
      <CardContent>
        <AnimatePresence mode="wait">
          {/* ── idle ── */}
          {phase === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="https://etherscan.io/tx/0x… или 0x…"
                className="h-9 font-mono text-sm"
                aria-label="Ссылка на транзакцию Etherscan или txHash"
                data-testid="etherscan-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && input.trim()) submit.mutate()
                }}
              />
              <Button
                className="mt-3 w-full"
                disabled={!input.trim() || submit.isPending}
                onClick={() => submit.mutate()}
                data-testid="submit-deposit-tx"
              >
                Проверить транзакцию
              </Button>
            </motion.div>
          )}

          {/* ── checking ── */}
          {phase === 'checking' && (
            <motion.div
              key="checking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center justify-center gap-3 py-6"
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Проверяем транзакцию…</p>
            </motion.div>
          )}

          {/* ── confirming: 12-segment progress ── */}
          {phase === 'confirming' && (
            <motion.div
              key="confirming"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    Подтверждения блоков
                  </p>
                  <p
                    className="text-3xl font-bold tabular-nums text-foreground"
                    data-testid="confirmation-counter"
                  >
                    {Math.min(confirmations, threshold)} / {threshold}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {estimateRemaining(confirmations, threshold)}
                  </p>
                </div>
                {deposit?.txHash && (
                  <div className="text-right">
                    <p className="text-[10px] text-muted-foreground">TX Hash</p>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-mono text-xs text-foreground/70 hover:text-foreground"
                      onClick={() => copy(deposit.txHash, 'TX Hash')}
                      aria-label="Скопировать TX Hash"
                    >
                      {shortHash(deposit.txHash)} <Copy className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              <BlockSegments confirmations={confirmations} threshold={threshold} />

              <p className="mt-3 text-[11px] text-muted-foreground">
                Ethereum ERC-20 · обычно ~2–3 мин · обновляется автоматически
              </p>
            </motion.div>
          )}

          {/* ── confirmed ── */}
          {phase === 'confirmed' && (
            <motion.div
              key="confirmed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-5"
              role="status"
              aria-live="assertive"
              data-testid="deposit-confirmed-state"
            >
              <motion.div
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 20 }}
              >
                <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-400" />
              </motion.div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-emerald-400">Депозит зачтён</p>
                <p className="text-xs text-muted-foreground">
                  {deposit?.amountUsdt != null
                    ? `+${deposit.amountUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT · `
                    : ''}
                  {threshold}/{threshold} блоков
                </p>
              </div>
              <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={reset}>
                Ещё депозит
              </Button>
            </motion.div>
          )}

          {/* ── error ── */}
          {phase === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-4"
              role="alert"
              data-testid="deposit-error-state"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium text-destructive">Ошибка проверки</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{errorText}</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-7 pl-0 text-xs" onClick={reset}>
                Попробовать другую ссылку
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  )
}

/** The 12 (threshold) segment cells — blockchain "block by block" language. */
function BlockSegments({ confirmations, threshold }: { confirmations: number; threshold: number }) {
  const segments = useMemo(() => Array.from({ length: threshold }, (_, i) => i), [threshold])
  const done = Math.min(confirmations, threshold)
  return (
    <div
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={threshold}
      aria-label="Подтверждения блоков транзакции"
      aria-live="polite"
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${threshold}, minmax(0, 1fr))` }}
    >
      {segments.map((i) => {
        const isDone = i < done
        const isCurrent = i === done
        return (
          <motion.div
            key={i}
            data-testid={`block-segment-${i}`}
            className={cn(
              'h-2.5 rounded-[3px]',
              isDone ? 'bg-primary' : isCurrent ? 'animate-pulse bg-primary/30' : 'bg-muted',
            )}
            initial={isDone ? { scaleY: 0.5, opacity: 0.3 } : false}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1], delay: isDone ? i * 0.04 : 0 }}
            style={{ transformOrigin: 'bottom' }}
          />
        )
      })}
    </div>
  )
}
