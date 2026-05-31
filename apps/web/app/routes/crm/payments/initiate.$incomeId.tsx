/**
 * Drop role - phase 4-B. «Платить компании» — alternative settlement channels
 * for a validated DROP_INCOME. Three cards (crypto / bank / cash) sit on the
 * page; clicking through each runs the matching backend cascade.
 *
 * RBAC: DROP can only act on their OWN income; ACCOUNTANT/ADMIN can access
 * any. Other roles are redirected to /crm/dashboard.
 */
import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Banknote, CheckCircle2, Coins, Copy, Loader2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { financeApi } from '../finance/api'

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
      void navigate({ to: '/crm/dashboard' })
    }
  }, [user, income, navigate])

  if (!user) return null

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="space-y-2">
        <Link
          to="/crm/profile/$userId"
          params={{ userId: user.id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="back-button"
        >
          <ArrowLeft className="h-3 w-3" /> Назад
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Платить компании</h1>
        <p className="text-sm text-muted-foreground">
          Выберите канал оплаты для зачисленного прихода drop-проекта
        </p>
      </header>

      {incomeLoading || !income ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          <IncomeSummary income={income} />

          <div className="grid gap-4 lg:grid-cols-3">
            <CryptoChannelCard incomeId={incomeId} queryClient={queryClient} />
            <BankChannelCard incomeId={incomeId} queryClient={queryClient} />
            <CashChannelCard incomeId={incomeId} queryClient={queryClient} />
          </div>
        </>
      )}
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

// ── Crypto channel ────────────────────────────────────────────────────────

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
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  const recipients = recipientsData?.recipients ?? []

  return (
    <Card className="border-violet-500/30" data-testid="channel-crypto">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Coins className="h-4 w-4 text-violet-400" />
          USDT (crypto)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Отправьте USDT на 3 кошелька (синьор + 2 админа)
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {done ? (
          <SuccessBlock label="Crypto-оплата зафиксирована" />
        ) : isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <ul className="space-y-2">
              {recipients.map((r, i) => (
                <li
                  key={r.userId}
                  className="rounded-lg border border-border/60 p-3 space-y-1"
                  data-testid={`crypto-recipient-${i}`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{r.displayName}</span>
                    <span className="text-muted-foreground uppercase tracking-wide">{r.role}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input
                      readOnly
                      value={r.address || '—'}
                      className="h-7 text-[11px] font-mono"
                    />
                    {r.address && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => copyToClipboard(r.address, 'Адрес')}
                        title="Скопировать адрес"
                      >
                        <Copy className="h-3 w-3" />
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
                    className="h-7 text-[11px]"
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

// ── Bank channel ──────────────────────────────────────────────────────────

function BankChannelCard({
  incomeId,
  queryClient,
}: {
  incomeId: string
  queryClient: QueryClientType
}) {
  const { user } = useAuth()
  const [acknowledged, setAcknowledged] = useState(false)
  const [done, setDone] = useState(false)

  const { data: bankData, isLoading } = useQuery({
    queryKey: ['payment-channel-bank', incomeId],
    queryFn: () => financeApi.initiateBankPayment(incomeId),
    enabled: !done,
    staleTime: 30_000,
    retry: false,
  })

  const confirm = useMutation({
    mutationFn: () => financeApi.confirmBankPayment(incomeId),
    onSuccess: () => {
      toast.success('Зачисление на ТОВ подтверждено')
      setDone(true)
      void queryClient.invalidateQueries({ queryKey: ['transaction', incomeId] })
      void queryClient.invalidateQueries({ queryKey: ['profile-transactions'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  const canConfirm = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  return (
    <Card className="border-sky-500/30" data-testid="channel-bank">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Banknote className="h-4 w-4 text-sky-400" />
          Банк UAH на ТОВ
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Перевод на корпоративный счёт. Бухгалтер подтвердит зачисление.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {done ? (
          <SuccessBlock label="Зачисление подтверждено" />
        ) : isLoading || !bankData ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <BankDetailsRow label="Получатель" value={bankData.tovBankDetails.recipient} />
            <BankDetailsRow label="IBAN" value={bankData.tovBankDetails.iban} mono />
            <BankDetailsRow label="ЕДРПОУ / РНОКПП" value={bankData.tovBankDetails.rnokpp} />
            <BankDetailsRow label="Банк" value={bankData.tovBankDetails.bankName} />
            <BankDetailsRow
              label="Назначение платежа"
              value={bankData.tovBankDetails.reference}
              mono
              testid="bank-reference"
            />
            <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">Сумма</span>
              <span className="font-bold tabular-nums">{fmtUsd(bankData.amount)}</span>
            </div>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                copyToClipboard(
                  `${bankData.tovBankDetails.recipient}\n${bankData.tovBankDetails.iban}\n${bankData.tovBankDetails.rnokpp}\n${bankData.tovBankDetails.reference}`,
                  'Реквизиты',
                )
              }}
              data-testid="bank-copy-button"
            >
              <Copy className="h-3 w-3 mr-1" /> Скопировать реквизиты
            </Button>
            {!acknowledged ? (
              <Button
                className="w-full"
                onClick={() => {
                  setAcknowledged(true)
                  toast.info('Спасибо. Бухгалтер подтвердит зачисление.')
                }}
                data-testid="bank-acknowledge-button"
              >
                Я перевёл
              </Button>
            ) : (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs">
                Ожидаем подтверждения от бухгалтера.
              </div>
            )}
            {canConfirm && acknowledged && (
              <Button
                variant="default"
                className="w-full"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
                data-testid="bank-confirm-button"
              >
                {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Подтвердить зачисление (бухгалтер)
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function BankDetailsRow({
  label,
  value,
  mono,
  testid,
}: {
  label: string
  value: string
  mono?: boolean
  testid?: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1">
        <Input
          readOnly
          value={value}
          className={cn('h-7 text-[11px]', mono ? 'font-mono' : '')}
          {...(testid !== undefined ? { 'data-testid': testid } : {})}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => copyToClipboard(value, label)}
          title="Скопировать"
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

// ── Cash channel ──────────────────────────────────────────────────────────

interface AdminLite {
  id: string
  displayName: string
}

function CashChannelCard({
  incomeId,
  queryClient,
}: {
  incomeId: string
  queryClient: QueryClientType
}) {
  const [adminId, setAdminId] = useState<string>('')
  const [done, setDone] = useState(false)

  const { data: users, isLoading } = useQuery({
    queryKey: ['admins-cash-recipients'],
    queryFn: () => api.get<AdminLite[]>('/users?role=ADMIN').then((r) => r.data),
    staleTime: 5 * 60_000,
  })

  const admins = useMemo(() => users ?? [], [users])

  const confirm = useMutation({
    mutationFn: (recipientAdminId: string) =>
      financeApi.initiateCashPayment(incomeId, recipientAdminId),
    onSuccess: () => {
      toast.success('Оплата налом зафиксирована')
      setDone(true)
      void queryClient.invalidateQueries({ queryKey: ['transaction', incomeId] })
      void queryClient.invalidateQueries({ queryKey: ['profile-transactions'] })
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  })

  return (
    <Card className="border-amber-500/30" data-testid="channel-cash">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-amber-400" />
          Наличные админу
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Передать нал одному из админов. Транзакции создаются сразу.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {done ? (
          <SuccessBlock label="Cash-оплата зафиксирована" />
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Получатель</Label>
              {isLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={adminId} onValueChange={setAdminId}>
                  <SelectTrigger className="h-9" data-testid="cash-admin-select">
                    <SelectValue placeholder="Выберите админа" />
                  </SelectTrigger>
                  <SelectContent>
                    {admins.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Партнёрская доля целиком уходит выбранному админу. Senior-доля записывается как долг
              дропа синьору (закроется позже).
            </p>
            <Button
              className="w-full"
              disabled={!adminId || confirm.isPending}
              onClick={() => confirm.mutate(adminId)}
              data-testid="cash-confirm-button"
            >
              {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Передал нал, подтвердить
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
