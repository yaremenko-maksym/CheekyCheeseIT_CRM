import { forwardRef } from 'react'
import { Edit2, CheckCircle2, ArrowRight, Trash2, Wallet, BadgeCheck, Banknote } from 'lucide-react'
// NOTE: Wallet icon is still used by the «Оплатить» pill on PAYOUT rows.
import { Link } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import type { TransactionDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  TYPE_LABELS,
  TYPE_COLORS,
  STATUS_LABELS,
  STATUS_COLORS,
  fmtAmount,
  fmtUsd,
  fmtDate,
  type ExchangeRates,
} from '../constants'

function TypeBadge({ type }: { type: TransactionDto['type'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TYPE_COLORS[type],
      )}
    >
      {TYPE_LABELS[type]}
    </span>
  )
}

function StatusBadge({ status }: { status: TransactionDto['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_COLORS[status],
      )}
      data-testid={`tx-status-badge-${status.toLowerCase()}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

// A party (sender or receiver) — clickable if it's a known user or project
function Party({
  id,
  name,
  label,
  type,
}: {
  id: string | null | undefined
  name: string | null | undefined
  label: string | null | undefined
  type: 'user' | 'project'
}) {
  const display = name ?? label ?? '—'

  if (id && name) {
    if (type === 'user') {
      return (
        <Link
          to="/crm/profile/$userId"
          params={{ userId: id }}
          className="text-primary hover:underline underline-offset-2 font-medium truncate max-w-44 block"
          title={display}
          onClick={(e) => e.stopPropagation()}
        >
          {display}
        </Link>
      )
    }
    return (
      <Link
        to="/crm/projects/$projectId"
        params={{ projectId: id }}
        className="text-primary hover:underline underline-offset-2 font-medium truncate max-w-44 block"
        title={display}
        onClick={(e) => e.stopPropagation()}
      >
        {display}
      </Link>
    )
  }

  // Non-clickable alias (e.g. CheekyCheeseIT, company name)
  return (
    <span className="text-muted-foreground truncate max-w-44 block" title={display}>
      {display}
    </span>
  )
}

function FromTo({ tx }: { tx: TransactionDto }) {
  switch (tx.type) {
    case 'ADMIN_INCOME':
    case 'SENIOR_INCOME':
      // Company (client) → Senior who created the transaction
      // sender_label = client company name, receiver_id = senior user
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={null}
            name={null}
            label={tx.senderLabel ?? tx.projectName ?? '—'}
            type="project"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'EXPENSE':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? '—'} type="user" />
        </div>
      )

    case 'SALARY':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={tx.senderId}
            name={tx.senderName}
            label={tx.senderLabel ?? 'CheekyCheeseIT'}
            type="user"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'ADMIN_TRANSFER':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    case 'PAYOUT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? 'CheekyCheeseIT'} type="user" />
        </div>
      )

    case 'PAYOUT_ADMIN':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Drop role - phase 3 (spec §8.4). Sender mirrors the original PAYOUT
    // (drop / senior). Receiver is the admin partner chosen during manual
    // confirmation — surfaced through receiverId/receiverName.
    case 'PAYOUT_CONFIRMED':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    default:
      return <span className="text-muted-foreground">—</span>
  }
}

type TransactionRowProps = {
  tx: TransactionDto
  role: string
  rates: ExchangeRates | undefined
  /** Used to scope "Доля: X%" visibility for SENIOR (only own rows). */
  currentUserId?: string | null
  /**
   * Full list of transactions currently in view — needed to decide whether
   * the «Cash передан» action is available on a DROP_INCOME row (we hide it
   * if a payment-channel cascade already exists for that income's
   * payoutRequestId). Optional; when absent the action assumes "no cascade".
   */
  transactions?: TransactionDto[]
  onValidate?: (tx: TransactionDto) => void
  onEdit?: (tx: TransactionDto) => void
  onAdminEdit?: (tx: TransactionDto) => void
  onDelete?: (tx: TransactionDto) => void
  onPaySalary?: (tx: TransactionDto) => void
  /**
   * Opens the PayoutDetailDialog for an already-created payout. Triggered by
   * the inline «Оплатить» pill on PENDING_PAYMENT rows (where the SENIOR has
   * already created the request and now needs to send USDT to the contract
   * address + submit the tx hash). Receives the payout_request id.
   */
  onOpenPayoutDetail?: (payoutRequestId: string) => void
  /**
   * Drop role - phase 3 (manual payout confirmation, spec §8.4). Opens the
   * ConfirmPayoutDialog for an ACCOUNTANT/ADMIN. Shown on PAYOUT rows in
   * PENDING_PAYMENT — the confirmation flips the row to PAID and inserts a
   * new PAYOUT_CONFIRMED credit row for the chosen admin.
   */
  onConfirmPayout?: (tx: TransactionDto) => void
  /**
   * Drop role - phase 4 refactor (AC7). Opens LogCashPaymentDialog for an
   * ADMIN/ACCOUNTANT on VALIDATED DROP_INCOME rows whose payment-channel
   * cascade has not landed yet (no SENIOR_INCOME_CRYPTO / ADMIN_INCOME_*
   * rows linked to the same payoutRequestId).
   */
  onLogCash?: (tx: TransactionDto) => void
  onClick?: (tx: TransactionDto) => void
}

// forwardRef is required because the row is rendered inside an
// <AnimatePresence mode="popLayout"> in TransactionsTable. framer-motion needs
// to attach a ref to the underlying <tr> to measure layout for the enter/exit
// animation. Without forwardRef React logs «Function components cannot be given
// refs» once per row (50-60× on /crm/finance) and the row animation breaks.
export const TransactionRow = forwardRef<HTMLTableRowElement, TransactionRowProps>(
  function TransactionRow(
    {
      tx,
      role,
      rates,
      currentUserId,
      transactions,
      onValidate,
      onEdit,
      onAdminEdit,
      onDelete,
      onPaySalary,
      onOpenPayoutDetail,
      onConfirmPayout,
      onLogCash,
      onClick,
    },
    ref,
  ) {
    const isAdmin = role === 'ADMIN'
    const isAccountant = role === 'ACCOUNTANT'
    const isSenior = role === 'SENIOR'

    const canValidate =
      (isAdmin || isAccountant) && tx.type === 'SENIOR_INCOME' && tx.status === 'PENDING'
    const canEdit = isSenior && tx.type === 'SENIOR_INCOME' && tx.status === 'REJECTED'
    const canPaySalary = isAdmin && tx.type === 'SALARY' && tx.status === 'PENDING'
    const canAdminEdit =
      isAdmin &&
      tx.type !== 'PAYOUT' &&
      tx.type !== 'PAYOUT_ADMIN' &&
      (tx.status === 'PENDING_PAYMENT' || !tx.payoutRequestId)
    const canAdminDelete = canAdminEdit
    // Inline «Оплатить» for the «Выплата» row (PAYOUT type, PENDING_PAYMENT).
    // New flow (task-payout-auto-on-validate): when ACCOUNTANT clicks
    // «Подтвердить» on a SENIOR_INCOME, the backend atomically creates a
    // PAYOUT row carrying this button. SENIOR_INCOME rows no longer have any
    // inline «Выплатить» pill — they just show «Ожидает выплаты» status.
    // Scoped by senderId so a SENIOR only sees the pill for their own payouts.
    const showPayPayout =
      isSenior &&
      tx.type === 'PAYOUT' &&
      tx.status === 'PENDING_PAYMENT' &&
      !!tx.payoutRequestId &&
      tx.senderId === currentUserId
    // Drop role - phase 3 (manual payout confirmation, spec §8.4). ADMIN /
    // ACCOUNTANT see «Подтвердить оплату» on every PAYOUT row in
    // PENDING_PAYMENT. The action records which admin actually received the
    // off-platform money and flips the PAYOUT to PAID (see ConfirmPayoutDialog).
    const showConfirmPayout =
      (isAdmin || isAccountant) && tx.type === 'PAYOUT' && tx.status === 'PENDING_PAYMENT'

    // Drop role - phase 4 refactor (AC7). ADMIN/ACCOUNTANT see «Cash передан»
    // on VALIDATED DROP_INCOME rows whose payment-channel cascade has not
    // landed yet. We sniff the cascade by looking at sibling transactions
    // sharing the same payoutRequestId — if any of the "after-channel" types
    // (SENIOR_INCOME_CRYPTO / ADMIN_INCOME_* / SENIOR_PENDING_PAYOUT / TOV_INCOME)
    // is present, the action is hidden.
    const hasPayoutCascade =
      tx.type === 'DROP_INCOME' && tx.payoutRequestId
        ? (transactions ?? []).some(
            (t) =>
              t.id !== tx.id &&
              t.payoutRequestId === tx.payoutRequestId &&
              (t.type === 'SENIOR_INCOME_CRYPTO' ||
                t.type === 'ADMIN_INCOME_CRYPTO' ||
                t.type === 'ADMIN_INCOME_CASH' ||
                t.type === 'SENIOR_PENDING_PAYOUT' ||
                t.type === 'TOV_INCOME'),
          )
        : false
    const showLogCash =
      (isAdmin || isAccountant) &&
      tx.type === 'DROP_INCOME' &&
      tx.status === 'VALIDATED' &&
      !hasPayoutCascade

    return (
      <motion.tr
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.08, ease: 'easeOut' }}
        className={cn(
          'border-b border-border/50 transition-colors text-sm',
          onClick
            ? 'cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
            : 'hover:bg-muted/30',
        )}
        onClick={() => onClick?.(tx)}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onClick(tx)
                }
              }
            : undefined
        }
        tabIndex={onClick ? 0 : undefined}
        aria-label={onClick ? `Открыть транзакцию ${tx.type}` : undefined}
        data-testid={`tx-row-${tx.id}`}
        data-tx-type={tx.type}
      >
        <td className="py-3 px-4 whitespace-nowrap">
          <TypeBadge type={tx.type} />
        </td>

        {/* From → To */}
        <td className="py-3 px-4 min-w-0 max-w-56">
          <FromTo tx={tx} />
          {/* Show project link below for all relevant types */}
          {tx.projectName && tx.projectId && tx.type !== 'ADMIN_INCOME' && (
            <Link
              to="/crm/projects/$projectId"
              params={{ projectId: tx.projectId }}
              className="text-xs text-muted-foreground hover:text-foreground mt-0.5 truncate max-w-48 block"
              onClick={(e) => e.stopPropagation()}
            >
              {tx.projectName}
            </Link>
          )}
          {tx.salaryMonth && (
            <p className="text-xs text-muted-foreground mt-0.5">{tx.salaryMonth}</p>
          )}
        </td>

        <td className="py-3 px-4 tabular-nums font-medium whitespace-nowrap">
          <span>{fmtUsd(tx.amount, tx.currency, rates)}</span>
          {tx.currency !== 'USD' && tx.currency !== 'USDT' && (
            <p className="text-[11px] text-muted-foreground font-normal">
              {fmtAmount(tx.amount, tx.currency)}
            </p>
          )}
          {/* SENIOR_INCOME — show the snapshot share % so ADMIN/ACCOUNTANT/SENIOR
            can see what split this row will use at payout time. The snapshot
            is immutable (set on creation), so historical rows keep their
            original % even if the project override changes later.
            task-team-senior-share-override: also surface the source if the
            row has one — legacy rows (no source) render as before. */}
          {tx.type === 'SENIOR_INCOME' &&
            tx.seniorSharePercent !== null &&
            (isAdmin || isAccountant || (isSenior && tx.receiverId === currentUserId)) && (
              <p
                className="text-[11px] text-muted-foreground font-normal"
                data-testid={`tx-row-senior-share-${tx.id}`}
                title={
                  tx.seniorSharePercentSource
                    ? `Источник: ${
                        tx.seniorSharePercentSource === 'PROJECT'
                          ? 'проект'
                          : tx.seniorSharePercentSource === 'TEAM'
                            ? 'команда'
                            : 'по умолчанию'
                      }`
                    : undefined
                }
              >
                Доля: {tx.seniorSharePercent}%
                {tx.seniorSharePercentSource ? (
                  <span
                    className="ml-1 text-[10px] uppercase tracking-wide opacity-75"
                    data-testid={`tx-row-senior-share-source-${tx.id}`}
                    data-share-source={tx.seniorSharePercentSource}
                  >
                    ·{' '}
                    {tx.seniorSharePercentSource === 'PROJECT'
                      ? 'проект'
                      : tx.seniorSharePercentSource === 'TEAM'
                        ? 'команда'
                        : 'default'}
                  </span>
                ) : null}
              </p>
            )}
        </td>

        <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
          {fmtDate(tx.txDate ?? tx.createdAt)}
        </td>

        <td className="py-3 px-4">
          <StatusBadge status={tx.status} />
          {tx.rejectionReason && (
            <p
              className="text-xs text-destructive mt-0.5 max-w-40 truncate"
              title={tx.rejectionReason}
            >
              {tx.rejectionReason}
            </p>
          )}
        </td>

        <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            {canValidate && onValidate && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                onClick={() => onValidate(tx)}
                data-testid={`tx-row-validate-${tx.id}`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Проверить
              </Button>
            )}
            {showPayPayout && onOpenPayoutDetail && tx.payoutRequestId && (
              <Button
                variant="default"
                size="sm"
                className="h-7 px-2 text-xs bg-primary/90 text-primary-foreground hover:bg-primary"
                onClick={() => onOpenPayoutDetail(tx.payoutRequestId!)}
                data-testid={`row-pay-payout-${tx.id}`}
              >
                <Wallet className="h-3.5 w-3.5 mr-1" />
                Оплатить
              </Button>
            )}
            {showConfirmPayout && onConfirmPayout && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                onClick={() => onConfirmPayout(tx)}
                data-testid={`confirm-payout-button-${tx.id}`}
              >
                <BadgeCheck className="h-3.5 w-3.5 mr-1" />
                Подтвердить оплату
              </Button>
            )}
            {showLogCash && onLogCash && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                onClick={() => onLogCash(tx)}
                data-testid={`log-cash-button-${tx.id}`}
              >
                <Banknote className="h-3.5 w-3.5 mr-1" />
                Cash передан
              </Button>
            )}
            {canEdit && onEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                onClick={() => onEdit(tx)}
                data-testid={`tx-row-edit-${tx.id}`}
              >
                <Edit2 className="h-3.5 w-3.5 mr-1" />
                Исправить
              </Button>
            )}
            {canPaySalary && onPaySalary && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-green-400 hover:text-green-300 hover:bg-green-500/10"
                onClick={() => onPaySalary(tx)}
                data-testid={`tx-row-pay-salary-${tx.id}`}
              >
                Выплатить
              </Button>
            )}
            {canAdminEdit && onAdminEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                onClick={() => onAdminEdit(tx)}
                title="Редактировать"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {canAdminDelete && onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => onDelete(tx)}
                title="Удалить"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </td>
      </motion.tr>
    )
  },
)

TransactionRow.displayName = 'TransactionRow'
