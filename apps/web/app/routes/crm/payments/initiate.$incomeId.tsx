/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md AC6).
 *
 * «Платить компании» — crypto-only settlement channel for a validated
 * DROP_INCOME. The bank UAH on ТОВ card has been removed (bank channel gone)
 * and the Cash card has been removed too — cash flow now lives in
 * /crm/finance where ACCOUNTANT/ADMIN clicks «Cash передан» directly on the
 * income row.
 *
 * RBAC: DROP can only act on their OWN income; ACCOUNTANT/ADMIN can access
 * any. Other roles are redirected to /crm.
 */
import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Coins, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { financeApi } from '../finance/api'
import { PageHeader } from '@/components/crm/StickyPageHeader'

export const Route = createFileRoute('/crm/payments/initiate/$incomeId')({
  component: InitiatePaymentPage,
})

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtUsd(amount: string | number): string {
  const n = typeof amount === 'number' ? amount : parseFloat(amount)
  if (!Number.isFinite(n)) return '$0.00'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { message?: unknown } } }).response
    const msg = resp?.data?.message
    if (typeof msg === 'string') return msg
    if (Array.isArray(msg)) return msg.join(', ')
  }
  if (err instanceof Error) return err.message
  return 'Неизвестная ошибка'
}

function copyToClipboard(text: string, label: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} скопировано`),
    () => toast.error('Не удалось скопировать'),
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

function InitiatePaymentPage() {
  const { incomeId } = Route.useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Pull the income tx so we can render header + access-guard.
  const { data: income, isLoading: incomeLoading } = useQuery({
    queryKey: ['transaction', incomeId],
    queryFn: () => api.get<TransactionDto>(`/transactions/${incomeId}`).then((r) => r.data),
    enabled: !!user,
  })

  // Access guard — DROP must own the income; ACCOUNTANT/ADMIN may access any.
  useEffect(() => {
    if (!user || !income) return
    const isOwner = income.recipientId === user.id || income.receiverId === user.id
    const isPrivileged = user.role === 'ADMIN' || user.role === 'ACCOUNTANT'
    if (!isPrivileged && !(user.role === 'DROP' && isOwner)) {
      void navigate({ to: '/crm' })
    }
  }, [user, income, navigate])

  if (!user) return null

  return (
    <div className="flex flex-col h-full">
      <PageHeader>
        <div className="flex items-center gap-2">
          <Link
            to="/crm/finance"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="back-button"
          >
            <ArrowLeft className="h-3 w-3" /> Назад
          </Link>
        </div>
      </PageHeader>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <div className="space-y-6 max-w-3xl">
          {incomeLoading || !income ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <IncomeSummary income={income} />
              <CryptoChannelCard incomeId={incomeId} queryClient={queryClient} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Income summary header ─────────────────────────────────────────────────

function IncomeSummary({ income }: { income: TransactionDto }) {
  return (
    <Card data-testid="income-summary">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Информация о приходе</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Проект</p>
          <p className="font-medium truncate">{income.projectName ?? '—'}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Сумма</p>
          <p className="font-bold tabular-nums text-lg" data-testid="income-amount">
            {fmtUsd(income.amount)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Валюта</p>
          <p className="font-medium">{income.currency}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Статус</p>
          <p className="font-medium text-emerald-400">{income.status}</p>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Crypto channel (only remaining channel) ───────────────────────────────

type QueryClientType = ReturnType<typeof useQueryClient>

function CryptoChannelCard({
  incomeId,
  queryClient,
}: {
  incomeId: string
  queryClient: QueryClientType
}) {
  const [hashes, setHashes] = useState<string[]>(['', '', ''])
  const [done, setDone] = useState(false)

  const { data: recipientsData, isLoading } = useQuery({
    queryKey: ['payment-channel-crypto', incomeId],
    queryFn: () => financeApi.initiateCryptoPayment(incomeId),
    enabled: !done,
    staleTime: 30_000,
    retry: false,
  })

  const confirm = useMutation({
    mutationFn: (txHashes: string[]) => financeApi.confirmCryptoPayment({ incomeId, txHashes }),
    onSuccess: () => {
      toast.success('Crypto-оплата зафиксирована')
      setDone(true)
      void queryClient.invalidateQueries({ queryKey: ['transaction', incomeId] })
      void queryClient.invalidateQueries({ queryKey: ['profile-transactions'] })
      // Таблица транзакций и сводка финансов должны обновиться после crypto-оплаты
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
      void queryClient.invalidateQueries({ queryKey: ['finance-summary'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  const recipients = recipientsData?.recipients ?? []

  return (
    <Card className="border-violet-500/30" data-testid="channel-crypto">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Coins className="h-5 w-5 text-violet-400" />
          USDT (crypto)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Отправьте USDT на 3 кошелька (синьор + 2 админа) и подтвердите отправку, указав txHash.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <SuccessBlock label="Crypto-оплата зафиксирована" />
        ) : isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <ul className="space-y-3">
              {recipients.map((r, i) => (
                <li
                  key={r.userId}
                  className="rounded-lg border border-border/60 p-3 space-y-2"
                  data-testid={`crypto-recipient-${i}`}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{r.displayName}</span>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {r.role}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input readOnly value={r.address || '—'} className="h-8 text-xs font-mono" />
                    {r.address && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        onClick={() => copyToClipboard(r.address, 'Адрес')}
                        title="Скопировать адрес"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Сумма</span>
                    <span className="font-bold tabular-nums">{fmtUsd(r.amount)} USDT</span>
                  </div>
                  <Input
                    placeholder="txHash после отправки"
                    value={hashes[i] ?? ''}
                    onChange={(e) => {
                      const next = [...hashes]
                      next[i] = e.target.value
                      setHashes(next)
                    }}
                    className="h-8 text-xs"
                    data-testid={`crypto-hash-input-${i}`}
                  />
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              MetaMask интеграция — Phase 5. Сейчас отправляйте вручную и указывайте txHash для
              каждого получателя.
            </p>
            <Button
              className="w-full"
              disabled={confirm.isPending || hashes.every((h) => h.trim() === '')}
              onClick={() => {
                const trimmed = hashes.map((h) => h.trim()).filter((h) => h.length > 0)
                if (trimmed.length === 0) {
                  toast.error('Введите хотя бы один txHash')
                  return
                }
                confirm.mutate(trimmed)
              }}
              data-testid="crypto-confirm-button"
            >
              {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Подтвердить отправку
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Reusable success block ────────────────────────────────────────────────

function SuccessBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-4">
      <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
      <div>
        <p className="text-sm font-medium text-emerald-400">{label}</p>
        <p className="text-[11px] text-muted-foreground">Транзакции добавлены в реестр.</p>
      </div>
    </div>
  )
}
