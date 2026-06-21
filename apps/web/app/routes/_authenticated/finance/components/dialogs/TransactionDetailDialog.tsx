import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ExternalLink,
  ArrowRight,
  Hash,
  Calendar,
  User,
  Briefcase,
  Percent,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Lock,
  Wallet,
} from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { api } from '@/lib/axios'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  fmtAmount,
  fmtDate,
  fmtMonth,
  fmtRate,
  fmtUsd,
  TYPE_LABELS,
  TYPE_COLORS,
  STATUS_COLORS,
  STATUS_LABELS,
  type ExchangeRates,
} from '../../constants'
import { financeApi } from '../../api'
import { ReceiptPanel } from './receipt-panel'

// ── Helpers ────────────────────────────────────────────────────────────────────

const ETHERSCAN_BASE = 'https://etherscan.io/tx/'

function StatusIcon({ status }: { status: TransactionDto['status'] }) {
  switch (status) {
    case 'PAID':
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    case 'VALIDATED':
      return <CheckCircle2 className="h-4 w-4 text-blue-400" />
    case 'REJECTED':
      return <XCircle className="h-4 w-4 text-red-400" />
    case 'PENDING':
      return <Clock className="h-4 w-4 text-amber-400" />
    case 'LOCKED':
      return <Lock className="h-4 w-4 text-gray-400" />
    default:
      return <RefreshCw className="h-4 w-4 text-muted-foreground" />
  }
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-0">
      <div className="mt-0.5 text-muted-foreground shrink-0 w-4">{icon}</div>
      <span className="text-xs text-muted-foreground w-28 shrink-0 mt-0.5">{label}</span>
      <div className="flex-1 text-sm font-medium min-w-0">{children}</div>
    </div>
  )
}

function UserLink({
  id,
  name,
}: {
  id: string | null | undefined
  name: string | null | undefined
}) {
  if (!id || !name) return <span className="text-muted-foreground">{name ?? '—'}</span>
  return (
    <Link
      to="/profile/$userId"
      params={{ userId: id }}
      className="text-primary hover:underline underline-offset-2"
    >
      {name}
    </Link>
  )
}

function ProjectLink({
  id,
  name,
}: {
  id: string | null | undefined
  name: string | null | undefined
}) {
  if (!id || !name) return <span className="text-muted-foreground">{name ?? '—'}</span>
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: id }}
      className="text-primary hover:underline underline-offset-2"
    >
      {name}
    </Link>
  )
}

function TxHashLink({ hash }: { hash: string }) {
  return (
    <a
      href={`${ETHERSCAN_BASE}${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-primary hover:underline underline-offset-2 font-mono text-xs break-all"
    >
      {hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  )
}

// ── Type-specific content blocks ───────────────────────────────────────────────

function AdminIncomeContent({ tx }: { tx: TransactionDto }) {
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Получатель">
        {/* seed: senderId = admin, receiverId = null */}
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label="Проект">
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function SeniorIncomeContent({ tx }: { tx: TransactionDto }) {
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Синьор">
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label="Проект">
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {tx.seniorSharePercent != null && (
        <Row icon={<Percent className="h-4 w-4" />} label="Доля синьора">
          <span>{tx.seniorSharePercent}%</span>
          {/* task-team-senior-share-override. Show the snapshot source
              right next to the percent so the SENIOR can see whether the
              split came from a project / team override or the user default.
              Legacy rows (no source) keep the previous rendering. */}
          {tx.seniorSharePercentSource ? (
            <span
              className="text-[11px] text-muted-foreground ml-2 uppercase tracking-wide"
              data-testid={`tx-detail-senior-share-source`}
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
          <span className="text-xs text-muted-foreground ml-2">
            (к выплате:{' '}
            {fmtAmount(
              (parseFloat(tx.amount) * (1 - tx.seniorSharePercent / 100)).toFixed(2),
              tx.currency,
            )}
            )
          </span>
        </Row>
      )}
      {tx.validatedBy && (
        <Row icon={<CheckCircle2 className="h-4 w-4" />} label="Проверил">
          <span className="text-muted-foreground text-xs">
            {tx.validatedAt ? fmtDate(tx.validatedAt) : ''}
          </span>
        </Row>
      )}
      {tx.rejectionReason && (
        <Row icon={<XCircle className="h-4 w-4" />} label="Причина отказа">
          <span className="text-red-400">{tx.rejectionReason}</span>
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function ExpenseContent({ tx }: { tx: TransactionDto }) {
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Кто создал">
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<FileText className="h-4 w-4" />} label="Категория">
        <span>{tx.receiverLabel ?? '—'}</span>
      </Row>
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function SalaryContent({ tx }: { tx: TransactionDto }) {
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Получатель">
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      <Row icon={<Calendar className="h-4 w-4" />} label="Период">
        <span>{fmtMonth(tx.salaryMonth)}</span>
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label="Проект">
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {tx.txHash && (
        <Row icon={<Hash className="h-4 w-4" />} label="TX Hash">
          <TxHashLink hash={tx.txHash} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function AdminTransferContent({ tx }: { tx: TransactionDto }) {
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Отправитель">
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<User className="h-4 w-4" />} label="Получатель">
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function PayoutContent({ tx }: { tx: TransactionDto }) {
  const pr = tx.payoutRequest
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Синьор">
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<Briefcase className="h-4 w-4" />} label="Получатель">
        <span className="text-muted-foreground">{tx.receiverLabel ?? 'CheekyCheeseIT'}</span>
      </Row>
      {pr && (
        <>
          <Row icon={<Percent className="h-4 w-4" />} label="Доход синьора">
            <span>{fmtAmount(pr.incomeAmount, 'USDT')}</span>
          </Row>
          {pr.seniorSharePercent != null && (
            <Row icon={<Percent className="h-4 w-4" />} label="Доля синьора">
              <span>{pr.seniorSharePercent}%</span>
              {/* task-team-senior-share-override. Mirror the source badge
                  on the payout view so SENIORs can see "why this %" without
                  drilling into the originating SENIOR_INCOME row. */}
              {pr.seniorSharePercentSource ? (
                <span
                  className="text-[11px] text-muted-foreground ml-2 uppercase tracking-wide"
                  data-testid="payout-detail-senior-share-source"
                  data-share-source={pr.seniorSharePercentSource}
                >
                  ·{' '}
                  {pr.seniorSharePercentSource === 'PROJECT'
                    ? 'проект'
                    : pr.seniorSharePercentSource === 'TEAM'
                      ? 'команда'
                      : 'по умолчанию'}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground ml-2">
                → выплачено: {fmtAmount(pr.payableAmount, 'USDT')}
              </span>
            </Row>
          )}
        </>
      )}
      {tx.txHash && (
        <Row icon={<Hash className="h-4 w-4" />} label="TX Hash">
          <TxHashLink hash={tx.txHash} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label="Заметки">
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function PayoutAdminContent({ tx }: { tx: TransactionDto }) {
  const pr = tx.payoutRequest
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label="Источник">
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<User className="h-4 w-4" />} label="Получатель">
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {pr && (
        <Row icon={<Percent className="h-4 w-4" />} label="Общий доход">
          <span className="text-muted-foreground">{fmtAmount(pr.payableAmount, 'USDT')} × 50%</span>
        </Row>
      )}
      {tx.txHash && (
        <Row icon={<Hash className="h-4 w-4" />} label="TX Hash">
          <TxHashLink hash={tx.txHash} />
        </Row>
      )}
    </>
  )
}

// ── Loading skeleton ───────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-3 pt-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}

// ── Main dialog ────────────────────────────────────────────────────────────────

export function TransactionDetailDialog({
  tx,
  onClose,
  canQuickPayout = false,
  onQuickPayout,
}: {
  tx: TransactionDto | null
  onClose: () => void
  /**
   * If true and `tx` is a VALIDATED SENIOR_INCOME owned by the viewer, the
   * footer surfaces a primary «Выплатить» button. RBAC is enforced by the
   * caller (only SENIOR receives `true` here).
   */
  canQuickPayout?: boolean
  onQuickPayout?: (tx: TransactionDto) => void
}) {
  // Fetch fresh single transaction (includes payoutRequest details)
  const { data: detail, isLoading } = useQuery({
    queryKey: ['transaction', tx?.id],
    queryFn: () => financeApi.getTransaction(tx!.id),
    enabled: !!tx,
    staleTime: 30_000,
  })

  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    enabled: !!tx,
    staleTime: 1000 * 60 * 60,
  })

  const t = detail ?? tx

  // Transactions that can carry a receipt — split view applies only when a
  // receipt is meaningful (income, expense). For purely on-chain transactions
  // (PAYOUT, SALARY, ADMIN_TRANSFER, PAYOUT_ADMIN) the receipt panel becomes
  // an «Open in Etherscan» surface via TX hash links inline.
  const showReceiptPanel = t
    ? t.type === 'ADMIN_INCOME' || t.type === 'SENIOR_INCOME' || t.type === 'EXPENSE'
    : false

  return (
    <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth={showReceiptPanel ? 'sm:max-w-5xl' : 'sm:max-w-lg'}>
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-base">
            {t && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                  TYPE_COLORS[t.type],
                )}
              >
                {TYPE_LABELS[t.type]}
              </span>
            )}
            Детали транзакции
          </DialogTitle>
          <DialogDescription className="sr-only">
            Полная информация о финансовой транзакции, статус и прикреплённый чек.
          </DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          {!t ? (
            <DetailSkeleton />
          ) : showReceiptPanel ? (
            // Split view: info (≈40%) left, large receipt preview (≈60%) right.
            // On mobile (< md) the grid collapses to a single column with the
            // info section on top — receipt slides below to keep the form-like
            // reading order natural on narrow screens.
            <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-6">
              <div className="space-y-0 min-w-0">
                <TransactionInfoBlock
                  t={t}
                  rates={rates}
                  isLoading={isLoading}
                  detailReady={!!detail}
                />
              </div>
              <div className="min-w-0">
                <ReceiptPanel tx={t} />
              </div>
            </div>
          ) : (
            <div className="space-y-0">
              <TransactionInfoBlock
                t={t}
                rates={rates}
                isLoading={isLoading}
                detailReady={!!detail}
              />
            </div>
          )}
        </CrmDialogBody>

        {/* Footer surfaces the quick payout shortcut alongside the implicit
            close button (Esc / backdrop). Only rendered when the parent
            signals eligibility — RBAC + status checks live there. */}
        {t && canQuickPayout && onQuickPayout && (
          <CrmDialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Закрыть
            </Button>
            <Button size="sm" onClick={() => onQuickPayout(t)} data-testid="detail-quick-payout">
              <Wallet className="h-3.5 w-3.5 mr-1" />
              Выплатить
            </Button>
          </CrmDialogFooter>
        )}
      </CrmDialogContent>
    </Dialog>
  )
}

// ── Info block (left column or full-width depending on layout) ─────────────────

function TransactionInfoBlock({
  t,
  rates,
  isLoading,
  detailReady,
}: {
  t: TransactionDto
  rates: ExchangeRates | undefined
  isLoading: boolean
  detailReady: boolean
}) {
  return (
    <>
      {/* Amount + status header */}
      <div className="flex items-center justify-between pb-4 mb-1 border-b border-border">
        <div>
          {/* Big figure = USD-converted (table-consistent). Subline = the
              original currency + amount so detail view always discloses the
              source value (AC3). USD is the only currency whose source == the
              big figure, so it's the sole exclusion — USDT still shows
              «7 777,00 USDT» to make the currency explicit. */}
          <p className="text-2xl font-bold tabular-nums">{fmtUsd(t.amount, t.currency, rates)}</p>
          {t.currency !== 'USD' && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {fmtAmount(t.amount, t.currency)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusIcon status={t.status} />
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
              STATUS_COLORS[t.status],
            )}
          >
            {STATUS_LABELS[t.status]}
          </span>
        </div>
      </div>

      {/* Date */}
      <Row icon={<Calendar className="h-4 w-4" />} label="Дата">
        <span className="text-muted-foreground">
          {new Date(t.txDate ?? t.createdAt).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </span>
      </Row>

      {/* Conversion rate — only for non-USD/USDT. Uses the shared fmtRate
          helper so the «1 EUR = … USD» copy is identical across detail
          dialogs (AC3 single source of truth). */}
      {(t.currency === 'EUR' || t.currency === 'UAH') && rates && (
        <Row icon={<RefreshCw className="h-4 w-4" />} label="Курс (USD)">
          <span className="text-muted-foreground text-xs">
            {fmtRate(t.currency, rates)}
            <span className="ml-2 opacity-50">· НБУ</span>
          </span>
        </Row>
      )}

      {/* Type-specific rows */}
      {isLoading && !detailReady ? (
        <DetailSkeleton />
      ) : (
        <>
          {t.type === 'ADMIN_INCOME' && <AdminIncomeContent tx={t} />}
          {t.type === 'SENIOR_INCOME' && <SeniorIncomeContent tx={t} />}
          {t.type === 'EXPENSE' && <ExpenseContent tx={t} />}
          {t.type === 'SALARY' && <SalaryContent tx={t} />}
          {t.type === 'ADMIN_TRANSFER' && <AdminTransferContent tx={t} />}
          {t.type === 'PAYOUT' && <PayoutContent tx={t} />}
          {t.type === 'PAYOUT_ADMIN' && <PayoutAdminContent tx={t} />}
        </>
      )}

      {/* Direction summary footer */}
      <div className="pt-3 mt-1 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowRight className="h-3 w-3 shrink-0" />
        <span>
          ID: <span className="font-mono">{t.id.slice(0, 8)}…</span>
        </span>
      </div>
    </>
  )
}
