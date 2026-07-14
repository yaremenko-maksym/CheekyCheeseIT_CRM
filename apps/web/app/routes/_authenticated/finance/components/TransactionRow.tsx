import { forwardRef } from 'react'
import { Edit2, CheckCircle2, ArrowRight, Trash2, Wallet, BadgeCheck } from 'lucide-react'
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
          to="/profile/$userId"
          params={{ userId: id }}
          className="text-primary hover:underline underline-offset-2 font-medium break-words max-w-44 block"
          title={display}
          onClick={(e) => e.stopPropagation()}
        >
          {display}
        </Link>
      )
    }
    return (
      <Link
        to="/projects/$projectId"
        params={{ projectId: id }}
        className="text-primary hover:underline underline-offset-2 font-medium break-words max-w-44 block"
        title={display}
        onClick={(e) => e.stopPropagation()}
      >
        {display}
      </Link>
    )
  }

  // Non-clickable alias (e.g. CheekyCheeseIT, company name)
  return (
    <span className="text-muted-foreground break-words max-w-44 block" title={display}>
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

    // The company owes a senior their drop-project share. The row is booked with
    // senderLabel='COMPANY' (no senderId) and receiverId = the senior, so the
    // sender renders as the non-clickable company alias and the receiver as the
    // clickable senior — instead of the previous «—» default.
    case 'SENIOR_PENDING_PAYOUT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? 'CheekyCheeseIT'} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Manual QA #367 fix: mirror of SENIOR_PENDING_PAYOUT above — the company
    // owes a drop their USDT-project share (booked by bookCompanyObligations,
    // same row shape: senderLabel='COMPANY', receiverId = the drop). Without
    // this case the row fell through to `default` and rendered a bare "—"
    // (no participant at all), unlike the senior row right above it.
    case 'DROP_PENDING_PAYOUT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? 'CheekyCheeseIT'} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Drop registers project income: client company → drop. The row is booked
    // with senderLabel = client company name (no senderId) and receiverId = the
    // drop, so the sender renders as the non-clickable client alias and the
    // receiver as the clickable drop — instead of the previous «—» default.
    case 'DROP_INCOME':
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
   * Full list of transactions currently in view — used to scope sibling rows
   * for display (e.g. payoutRequestId linking). Optional.
   */
  transactions?: TransactionDto[]
  onValidate?: (tx: TransactionDto) => void
  onEdit?: (tx: TransactionDto) => void
  onAdminEdit?: (tx: TransactionDto) => void
  onDelete?: (tx: TransactionDto) => void
  onPaySalary?: (tx: TransactionDto) => void
  /**
   * task-senior-settle-in-tx-row. ADMIN/ACCOUNTANT clicks «Выплатить» on a
   * SENIOR_PENDING_PAYOUT row (PENDING_PAYMENT) to pay the senior their
   * drop-project share from the company account. Mirrors the salary pay flow:
   * an auto-created PENDING row is settled manually from the transactions list.
   *
   * settle-drop-btn: also fired for DROP_PENDING_PAYOUT rows (same shape, same
   * generic settle-company endpoint — see canSettleSeniorPayout above). The
   * name stays as-is to keep the prop threaded through TransactionsTable /
   * ActiveTransactionsTable / finance index.tsx / admin dashboard unchanged.
   */
  onSettleSeniorPayout?: (tx: TransactionDto) => void
  /**
   * feat/finance-payout-flow (#7). SENIOR clicks «Выплатить» on a VALIDATED
   * SENIOR_INCOME row — opens PayoutDialog pre-selecting this tx.
   */
  onInitiatePayout?: (txId: string) => void
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
  onClick?: (tx: TransactionDto) => void
}

// forwardRef is required because the row is rendered inside an
// <AnimatePresence mode="popLayout"> in TransactionsTable. framer-motion needs
// to attach a ref to the underlying <tr> to measure layout for the enter/exit
// animation. Without forwardRef React logs «Function components cannot be given
// refs» once per row (50-60× on /finance) and the row animation breaks.
export const TransactionRow = forwardRef<HTMLTableRowElement, TransactionRowProps>(
  function TransactionRow(
    {
      tx,
      role,
      rates,
      currentUserId,
      transactions: _transactions,
      onValidate,
      onEdit,
      onAdminEdit,
      onDelete,
      onPaySalary,
      onSettleSeniorPayout,
      onInitiatePayout,
      onOpenPayoutDetail,
      onConfirmPayout,
      onClick,
    },
    ref,
  ) {
    const isAdmin = role === 'ADMIN'
    const isAccountant = role === 'ACCOUNTANT'
    const isSenior = role === 'SENIOR'

    const canValidate =
      (isAdmin || isAccountant) && tx.type === 'SENIOR_INCOME' && tx.status === 'PENDING'
    // feat/finance-payout-flow (#7): SENIOR sees «Выплатить» on their own
    // VALIDATED SENIOR_INCOME rows that haven't been included in a payout yet
    // (payoutRequestId is null). Clicking opens PayoutDialog pre-selecting
    // this row; they can then add more VALIDATED rows before submitting.
    const showInitiatePayout =
      isSenior &&
      tx.type === 'SENIOR_INCOME' &&
      tx.status === 'VALIDATED' &&
      !tx.payoutRequestId &&
      tx.receiverId === currentUserId
    const canEdit = isSenior && tx.type === 'SENIOR_INCOME' && tx.status === 'REJECTED'
    const canPaySalary = isAdmin && tx.type === 'SALARY' && tx.status === 'PENDING'
    // task-senior-settle-in-tx-row. ADMIN/ACCOUNTANT see «Выплатить» on a
    // SENIOR_PENDING_PAYOUT row (the company's IOU to a senior from a
    // drop-project) while it is still PENDING_PAYMENT. Clicking settles the IOU
    // from the company account (the senior's auto-created SENIOR_INCOME + invoice
    // cascade). Hidden for SENIOR/DROP/JUNIOR/HR — settlement is a privileged
    // money action, enforced again server-side.
    //
    // Mirror fix (settle-drop-btn): DROP_PENDING_PAYOUT is the SAME company-IOU
    // shape (senderLabel='COMPANY', receiverId=the drop) as SENIOR_PENDING_PAYOUT
    // — the backend already routes both through the SAME generic
    // /pending-settlements/by-source-transaction/:id/settle-company endpoint,
    // branching on the source transaction's type (ADR D5). The RBAC condition
    // below is intentionally IDENTICAL to the senior branch — no additional
    // restriction is introduced for the drop mirror.
    const canSettleSeniorPayout =
      (isAdmin || isAccountant) &&
      (tx.type === 'SENIOR_PENDING_PAYOUT' || tx.type === 'DROP_PENDING_PAYOUT') &&
      tx.status === 'PENDING_PAYMENT'
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

    return (
      <motion.tr
        ref={ref}
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
              to="/projects/$projectId"
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
                    ? `Источник процента доли: ${
                        tx.seniorSharePercentSource === 'PROJECT'
                          ? 'переопределён на уровне проекта'
                          : tx.seniorSharePercentSource === 'TEAM'
                            ? 'переопределён на уровне команды'
                            : 'глобальное значение по умолчанию'
                      }`
                    : 'Процент доли синьора от этой транзакции'
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
                        : 'по умолчанию'}
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
            {showInitiatePayout && onInitiatePayout && (
              <Button
                variant="default"
                size="sm"
                className="h-7 px-2 text-xs bg-primary/90 text-primary-foreground hover:bg-primary"
                onClick={() => onInitiatePayout(tx.id)}
                data-testid={`tx-row-initiate-payout-${tx.id}`}
              >
                <Wallet className="h-3.5 w-3.5 mr-1" />
                Выплатить
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
            {canSettleSeniorPayout && onSettleSeniorPayout && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-green-400 hover:text-green-300 hover:bg-green-500/10"
                onClick={() => onSettleSeniorPayout(tx)}
                data-testid={`tx-row-settle-senior-payout-${tx.id}`}
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
