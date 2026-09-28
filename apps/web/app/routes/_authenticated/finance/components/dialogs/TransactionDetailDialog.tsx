import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useLingui } from '@lingui/react/macro'
import { formatDate, formatMonthLabel } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
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
  Receipt,
} from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
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
  fmtRate,
  fmtUsd,
  TYPE_LABEL_MESSAGES,
  TYPE_COLORS,
  STATUS_COLORS,
  STATUS_LABEL_MESSAGES,
  type ExchangeRates,
} from '../../constants'
import { financeApi } from '../../api'
import { settlementSplit } from '../../cascade-preview'
import { ReceiptPanel } from './receipt-panel'
import { AttachReceiptSheet } from './AttachReceiptSheet'
import { canAttachReceipt } from '../receipt-permissions'

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

/** Localised share-source tag — «· проєкт»/«· команда»/«· за замовчуванням»,
 * shared by SeniorIncomeContent and PayoutContent (same snapshot-source enum
 * as TransactionRow's own inline copy of this switch). */
function ShareSourceTag({
  source,
  testId,
}: {
  source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT'
  testId: string
}) {
  const { t } = useLingui()
  return (
    <span
      className="text-[11px] text-muted-foreground ml-2 uppercase tracking-wide"
      data-testid={testId}
      data-share-source={source}
    >
      · {source === 'PROJECT' ? t`проєкт` : source === 'TEAM' ? t`команда` : t`за замовчуванням`}
    </span>
  )
}

function AdminIncomeContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Отримувач`}>
        {/* seed: senderId = admin, receiverId = null */}
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label={t`Проєкт`}>
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function SeniorIncomeContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  const locale = useLocale()
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Сеньйор`}>
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label={t`Проєкт`}>
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {tx.seniorSharePercent != null && (
        <Row icon={<Percent className="h-4 w-4" />} label={t`Частка сеньйора`}>
          <span>{tx.seniorSharePercent}%</span>
          {/* task-team-senior-share-override. Show the snapshot source
              right next to the percent so the SENIOR can see whether the
              split came from a project / team override or the user default.
              Legacy rows (no source) keep the previous rendering. */}
          {tx.seniorSharePercentSource ? (
            <ShareSourceTag
              source={tx.seniorSharePercentSource}
              testId="tx-detail-senior-share-source"
            />
          ) : null}
          <span className="text-xs text-muted-foreground ml-2">
            {t`(до отримання: ${fmtAmount(
              (parseFloat(tx.amount) * (1 - tx.seniorSharePercent / 100)).toFixed(2),
              tx.currency,
            )})`}
          </span>
        </Row>
      )}
      {tx.validatedAt && (
        <Row icon={<CheckCircle2 className="h-4 w-4" />} label={t`Хто перевірив`}>
          <span className="text-muted-foreground text-xs">
            {tx.validatedAt ? formatDate(tx.validatedAt, locale) : ''}
          </span>
        </Row>
      )}
      {tx.rejectionReason && (
        <Row icon={<XCircle className="h-4 w-4" />} label={t`Причина відмови`}>
          <span className="text-red-400">{tx.rejectionReason}</span>
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function ExpenseContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Хто створив`}>
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<FileText className="h-4 w-4" />} label={t`Категорія`}>
        <span>{tx.receiverLabel ?? '—'}</span>
      </Row>
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function SalaryContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  const locale = useLocale()
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Отримувач`}>
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      <Row icon={<Calendar className="h-4 w-4" />} label={t`Період`}>
        <span>{formatMonthLabel(tx.salaryMonth, locale)}</span>
      </Row>
      {tx.projectId && (
        <Row icon={<Briefcase className="h-4 w-4" />} label={t`Проєкт`}>
          <ProjectLink id={tx.projectId} name={tx.projectName} />
        </Row>
      )}
      {/* task-receipts-frontend (design-spec §2.3): TxHashLink is a legacy
          fallback now — it only surfaces when there is NO new-style receipt
          (old PAID rows created before this feature). New payments carry a
          mandatory ReceiptInput → ReceiptPanel (rendered by the split-view
          above), so the two never show simultaneously. */}
      {tx.txHash && !tx.receiptDocumentId && !tx.receiptExternalUrl && (
        <Row icon={<Hash className="h-4 w-4" />} label={t`Хеш транзакції`}>
          <TxHashLink hash={tx.txHash} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function AdminTransferContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Відправник`}>
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<User className="h-4 w-4" />} label={t`Отримувач`}>
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function PayoutContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  const pr = tx.payoutRequest
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Сеньйор`}>
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<Briefcase className="h-4 w-4" />} label={t`Отримувач`}>
        <span className="text-muted-foreground">{tx.receiverLabel ?? 'CheekyCheeseIT'}</span>
      </Row>
      {pr && (
        <>
          <Row icon={<Percent className="h-4 w-4" />} label={t`Дохід сеньйора`}>
            <span>{fmtAmount(pr.incomeAmount, 'USDT')}</span>
          </Row>
          {pr.seniorSharePercent != null && (
            <Row icon={<Percent className="h-4 w-4" />} label={t`Частка сеньйора`}>
              <span>{pr.seniorSharePercent}%</span>
              {/* task-team-senior-share-override. Mirror the source badge
                  on the payout view so SENIORs can see "why this %" without
                  drilling into the originating SENIOR_INCOME row. */}
              {pr.seniorSharePercentSource ? (
                <ShareSourceTag
                  source={pr.seniorSharePercentSource}
                  testId="payout-detail-senior-share-source"
                />
              ) : null}
              <span className="text-xs text-muted-foreground ml-2">
                {t`→ виплачено: ${fmtAmount(pr.payableAmount, 'USDT')}`}
              </span>
            </Row>
          )}
        </>
      )}
      {tx.txHash && (
        <Row icon={<Hash className="h-4 w-4" />} label={t`Хеш транзакції`}>
          <TxHashLink hash={tx.txHash} />
        </Row>
      )}
      {tx.notes && (
        <Row icon={<FileText className="h-4 w-4" />} label={t`Примітки`}>
          <span className="text-muted-foreground">{tx.notes}</span>
        </Row>
      )}
    </>
  )
}

function PayoutAdminContent({ tx }: { tx: TransactionDto }) {
  const { t } = useLingui()
  const pr = tx.payoutRequest
  return (
    <>
      <Row icon={<User className="h-4 w-4" />} label={t`Джерело`}>
        <UserLink id={tx.senderId} name={tx.senderName} />
      </Row>
      <Row icon={<User className="h-4 w-4" />} label={t`Отримувач`}>
        <UserLink id={tx.receiverId} name={tx.receiverName} />
      </Row>
      {pr && (
        <Row icon={<Percent className="h-4 w-4" />} label={t`Загальний дохід`}>
          <span className="text-muted-foreground">{fmtAmount(pr.payableAmount, 'USDT')} × 50%</span>
        </Row>
      )}
      {tx.txHash && (
        <Row icon={<Hash className="h-4 w-4" />} label={t`Хеш транзакції`}>
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

// task-receipts-frontend (design-spec §5.6): types eligible for the
// split-view receipt panel. Extends the pre-existing set with SALARY /
// ADMIN_TRANSFER / DIVIDEND_TO_ADMIN (now mandatory-receipt flows) and fixes
// a pre-existing gap — DROP_INCOME could already carry a receipt (mandatory
// since day one, same as SENIOR_INCOME) but never got the split-view
// preview. PAYOUT / PAYOUT_ADMIN are deliberately NOT added — out of scope
// (A5 — they use the on-chain txHash mechanism via payout-requests instead).
const RECEIPT_ELIGIBLE_TYPES = new Set<TransactionDto['type']>([
  'ADMIN_INCOME',
  'SENIOR_INCOME',
  'DROP_INCOME',
  'EXPENSE',
  'SALARY',
  'ADMIN_TRANSFER',
  'DIVIDEND_TO_ADMIN',
])

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
  const { user } = useAuth()
  const { t, i18n } = useLingui()
  // task-receipts-frontend: attach/replace-receipt Sheet, opened from the
  // button below ReceiptPanel (primary entry point on mobile — the row icon
  // in TransactionRow is hidden below md).
  const [attachOpen, setAttachOpen] = useState(false)

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

  // Renamed from bare `t` (pre-existing) — `useLingui()`'s own `t` macro
  // occupies that name in this function's scope now.
  const row = detail ?? tx

  // Transactions that can carry a receipt — split view applies only when a
  // receipt is meaningful. For purely on-chain transactions (PAYOUT,
  // PAYOUT_ADMIN) the receipt panel becomes an «Open in Etherscan» surface
  // via TX hash links inline instead.
  // Stryker disable next-line BooleanLiteral: the `false` alternative only
  // matters when `row` is falsy, and `row` is falsy exactly when `tx` is
  // (`<Dialog open={!!tx}>`) — the dialog is closed and its content
  // unmounted, so `showReceiptPanel` never reaches any JSX a test could
  // observe on that branch.
  const showReceiptPanel = row ? RECEIPT_ELIGIBLE_TYPES.has(row.type) : false
  const hasExistingReceipt = !!(row?.receiptDocumentId || row?.receiptExternalUrl)
  const showAttachButton = row
    ? canAttachReceipt(
        row,
        user?.id,
        // Stryker disable next-line StringLiteral: canAttachReceipt only compares
        // role against the literals 'ADMIN'/'ACCOUNTANT' — any other string
        // (the '' fallback or the mutant's "Stryker was here!") is equally
        // non-matching, so no test can observe a difference between them.
        user?.role ?? '',
      )
    : // Stryker disable next-line BooleanLiteral: same reasoning as
      // `showReceiptPanel` above — reached only when `row` is falsy, i.e. the
      // dialog is closed and unmounted.
      false
  // Same audience the server already uses for the audit fields on this DTO.
  const privileged = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  return (
    <>
      <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
        <CrmDialogContent maxWidth={showReceiptPanel ? 'sm:max-w-5xl' : 'sm:max-w-lg'}>
          <CrmDialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              {row && (
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                    TYPE_COLORS[row.type],
                  )}
                >
                  {i18n._(TYPE_LABEL_MESSAGES[row.type])}
                </span>
              )}
              {t`Деталі транзакції`}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t`Повна інформація про фінансову транзакцію, статус і прикріплений чек.`}
            </DialogDescription>
          </CrmDialogHeader>

          <CrmDialogBody className="pb-4">
            {!row ? (
              <DetailSkeleton />
            ) : showReceiptPanel ? (
              // Split view: info (≈40%) left, large receipt preview (≈60%) right.
              // On mobile (< md) the grid collapses to a single column with the
              // info section on top — receipt slides below to keep the form-like
              // reading order natural on narrow screens.
              <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-6">
                <div className="space-y-0 min-w-0">
                  <TransactionInfoBlock
                    t={row}
                    rates={rates}
                    isLoading={isLoading}
                    detailReady={!!detail}
                    privileged={privileged}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <ReceiptPanel tx={row} />
                  {/* task-receipts-frontend: primary attach/replace entry point —
                    full-width 44px on mobile (hard responsive-design.md gate),
                    compact secondary button from sm+ (row icon already covers
                    the quick path there). */}
                  {showAttachButton && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto h-11 sm:h-9"
                      onClick={() => setAttachOpen(true)}
                      data-testid="detail-attach-receipt"
                    >
                      <Receipt className="h-3.5 w-3.5 mr-1.5" />
                      {hasExistingReceipt ? t`Замінити чек` : t`Прикріпити чек`}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-0">
                <TransactionInfoBlock
                  t={row}
                  rates={rates}
                  isLoading={isLoading}
                  detailReady={!!detail}
                  privileged={privileged}
                />
              </div>
            )}
          </CrmDialogBody>

          {/* Footer surfaces the quick payout shortcut alongside the implicit
            close button (Esc / backdrop). Only rendered when the parent
            signals eligibility — RBAC + status checks live there. */}
          {row && canQuickPayout && onQuickPayout && (
            <CrmDialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                {t`Закрити`}
              </Button>
              <Button
                size="sm"
                onClick={() => onQuickPayout(row)}
                data-testid="detail-quick-payout"
              >
                <Wallet className="h-3.5 w-3.5 mr-1" />
                {t`Виплатити`}
              </Button>
            </CrmDialogFooter>
          )}
        </CrmDialogContent>
      </Dialog>
      {/* task-receipts-frontend: Sheet + Dialog are independent Radix portals
          (Sheet is ALSO a Dialog.Root under the hood — sibling, not nested,
          avoids stacking two Radix dialog roots which can fight over
          Escape/focus-trap). */}
      <AttachReceiptSheet tx={attachOpen ? row : null} onClose={() => setAttachOpen(false)} />
    </>
  )
}

// ── Info block (left column or full-width depending on layout) ─────────────────

function TransactionInfoBlock({
  t: tx,
  rates,
  isLoading,
  detailReady,
  privileged,
}: {
  t: TransactionDto
  rates: ExchangeRates | undefined
  isLoading: boolean
  detailReady: boolean
  /** ADMIN/ACCOUNTANT — the audience for the internal payment-fact triplet. */
  privileged: boolean
}) {
  // Prop kept as `t` at the call sites (unchanged) — renamed to `tx` on
  // destructure so `useLingui()`'s own `t` macro is free to bind below.
  const { t, i18n } = useLingui()
  const locale = useLocale()
  // task-cascade-preview-ui (task 5): null on every row without an accumulator.
  const settlement = settlementSplit(tx)
  // UX-8: ONE narrowed value, the same shape `TransactionRow` settled on for
  // this exact question. A separate `remaining !== null` test would be dead at
  // RUNTIME — `null > 0` is already false in JS, which the mutation gate proved
  // by surviving its removal — but not dead to the type system, since dropping
  // it alone leaves `number | null` inside the branch. Cross-currency (`null`)
  // and fully closed (`0`) mean the same thing here: no actionable remainder.
  const remainingToPay = settlement?.remaining ?? 0

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
          <p className="text-2xl font-bold tabular-nums">{fmtUsd(tx.amount, tx.currency, rates)}</p>
          {tx.currency !== 'USD' && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {fmtAmount(tx.amount, tx.currency)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusIcon status={tx.status} />
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
              STATUS_COLORS[tx.status],
            )}
          >
            {i18n._(STATUS_LABEL_MESSAGES[tx.status])}
          </span>
        </div>
      </div>

      {/* task-cascade-preview-ui (task 5). What has actually been paid against
          this obligation, and what is still owed. Rendered only when there IS
          an accumulator — the split is meaningless on a row that was never
          partly settled, and until tasks 3/3b such a row could not exist. */}
      {settlement && (
        <Row icon={<Wallet className="h-4 w-4" />} label={t`Виплачено`}>
          <span className="tabular-nums" data-testid="tx-detail-settled">
            {fmtAmount(settlement.settled, settlement.settledCurrency)}
          </span>
          {/* UX-8 (design fidelity): `> 0`, not merely «есть остаток». This is
              the THIRD surface of UX-3 — `TransactionRow` and
              `CascadeImpactPanel` stopped printing a remainder of zero two
              rounds ago, and this dialog, reading the very same
              `settlementSplit`, kept printing «К доплате: 0,00» beside an
              obligation whose own badge already says «Оплачено». */}
          {remainingToPay > 0 && (
            <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
              {t`До сплати: ${fmtAmount(remainingToPay, tx.currency)}`}
            </span>
          )}
        </Row>
      )}

      {/* task-cascade-preview-ui (task 5), the payment-fact triplet. Already on
          the wire since task-salary-pay-amount and read by nothing — so an
          operator who hits the `PAYMENT_FACT_RECORDED` refusal («на этой строке
          зафиксирован факт платежа») had no way to see the fact they were being
          refused over. A refusal whose cause is invisible is worse than the
          refusal itself. ADMIN/ACCOUNTANT only: an internal accounting detail,
          the same audience as the other audit fields in this dialog.

          SR-L-2 (security-review): this is a RENDER gate, not RBAC. The triplet
          is on the wire for every role that can see the row — `mapTx` does not
          mask it — so `privileged` hides it from the SCREEN and nothing more.
          Reading it as a server-side restriction would be wrong. Pre-existing
          on the wire; recorded here so the next reader is not misled. */}
      {privileged && tx.originalAmount != null && (
        <Row icon={<Percent className="h-4 w-4" />} label={t`Факт переказу`}>
          {/* COPY-M-6: «Обязательство» is the glossary name of a
              `pending_obligations` row, and a SALARY — one of the two writers
              of this triplet (`paySalary`, drop-settle) — has none. Plain words
              that are true for both writers. */}
          <span className="tabular-nums" data-testid="tx-detail-payment-fact">
            {t`Нараховано: ${fmtAmount(tx.originalAmount, tx.originalCurrency ?? tx.currency)}`}
          </span>
          {/* COPY-M-5: the same shape `fmtRate` prints one row up
              («1 EUR = 1.0800 USD»). «×0.0243» did not say what to multiply by
              what, and a rate reads identically to its reciprocal — unusable on
              the one screen that exists so an accountant can CHECK the figure.
              `exchangeRate` is paid-currency units per 1 unit of what was owed,
              so the owed currency is the left-hand side. */}
          {tx.exchangeRate != null && (
            <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
              {t`Курс: 1 ${tx.originalCurrency ?? tx.currency} = ${Number(tx.exchangeRate).toFixed(4)} ${tx.currency}`}
            </span>
          )}
        </Row>
      )}

      {/* Date */}
      <Row icon={<Calendar className="h-4 w-4" />} label={t`Дата`}>
        <span className="text-muted-foreground">
          {formatDate(tx.txDate ?? tx.createdAt, locale, 'long')}
        </span>
      </Row>

      {/* Conversion rate — only for non-USD/USDT. Uses the shared fmtRate
          helper so the «1 EUR = … USD» copy is identical across detail
          dialogs (AC3 single source of truth). */}
      {(tx.currency === 'EUR' || tx.currency === 'UAH') && rates && (
        <Row icon={<RefreshCw className="h-4 w-4" />} label={t`Курс (USD)`}>
          <span className="text-muted-foreground text-xs">
            {fmtRate(tx.currency, rates)}
            <span className="ml-2 opacity-50">{t`· НБУ`}</span>
          </span>
        </Row>
      )}

      {/* Type-specific rows */}
      {isLoading && !detailReady ? (
        <DetailSkeleton />
      ) : (
        <>
          {tx.type === 'ADMIN_INCOME' && <AdminIncomeContent tx={tx} />}
          {tx.type === 'SENIOR_INCOME' && <SeniorIncomeContent tx={tx} />}
          {tx.type === 'EXPENSE' && <ExpenseContent tx={tx} />}
          {tx.type === 'SALARY' && <SalaryContent tx={tx} />}
          {tx.type === 'ADMIN_TRANSFER' && <AdminTransferContent tx={tx} />}
          {tx.type === 'PAYOUT' && <PayoutContent tx={tx} />}
          {tx.type === 'PAYOUT_ADMIN' && <PayoutAdminContent tx={tx} />}
        </>
      )}

      {/* Direction summary footer */}
      <div className="pt-3 mt-1 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowRight className="h-3 w-3 shrink-0" />
        <span>{t`ID: ${tx.id.slice(0, 8)}…`}</span>
      </div>
    </>
  )
}
