import { forwardRef } from 'react'
import {
  Edit2,
  CheckCircle2,
  ArrowRight,
  Trash2,
  Wallet,
  BadgeCheck,
  Receipt,
  RotateCcw,
} from 'lucide-react'
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
import { settlementSplit } from '../cascade-preview'
import { canAttachReceipt } from './receipt-permissions'

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

// task-soft-delete-and-money-audit. Only ever rendered for ADMIN/ACCOUNTANT —
// a deleted row can never reach this component for any other viewer (server-
// side `findAll`/`findOne` hide it entirely, AC2). The reason is surfaced via
// title-tooltip rather than a second visible line — keeps the row height
// unchanged for the common (non-deleted) case.
function DeletedBadge({ reason }: { reason: string | null | undefined }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive whitespace-nowrap"
      title={reason ?? undefined}
      data-testid="tx-deleted-badge"
    >
      Удалено
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

// fix/payout-drop-from-to (UX polish): the backend books company-funded
// sender rows with the raw literal senderLabel='COMPANY' (see
// PendingSettlementService.settleByCompany §D5) — an English token that reads
// oddly inside an otherwise-Russian row. Display-only normalization to the
// Russian alias so PAYOUT_DROP / SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT
// read consistently with the rest of the UI. Any other label (e.g. an
// admin's displayName on an ADMIN_PERSONAL-funded row) passes through
// unchanged; a missing label falls back to the existing company alias.
function displaySenderLabel(label: string | null | undefined): string {
  if (label === 'COMPANY') return 'Счёт компании'
  return label ?? 'CheekyCheeseIT'
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
          <Party id={null} name={null} label={displaySenderLabel(tx.senderLabel)} type="user" />
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
          <Party id={null} name={null} label={displaySenderLabel(tx.senderLabel)} type="user" />
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

    // fix/payout-drop-from-to: the auto-created drop share credited after
    // payPayoutRequest on a drop-project settles (see
    // PendingSettlementService.settleByCompany). Sender mirrors the funding
    // source: COMPANY_ACCOUNT/legacy rows carry senderId=null +
    // senderLabel='COMPANY' (non-clickable alias), ADMIN_PERSONAL rows carry
    // a real senderId/senderName (the admin who personally funded it) —
    // Party handles both via the same id-presence check. Receiver is always
    // the drop. Without this case the row fell through to `default` and
    // rendered a bare «—», same class of bug as DROP_PENDING_PAYOUT above.
    case 'PAYOUT_DROP':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party
            id={tx.senderId}
            name={tx.senderName}
            label={displaySenderLabel(tx.senderLabel)}
            type="user"
          />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // fix/payout-drop-from-to (audit pass, AC2): two more LIVE money types
    // that insert real rows into `transactions` (CompanyAccountService) and
    // are visible to ADMIN/ACCOUNTANT in the unfiltered findAll() list, yet
    // had no FromTo case — same bare-«—» bug as PAYOUT_DROP above.
    //
    // COMPANY_DEPOSIT: a SENIOR/DROP submits a verified USDT deposit onto the
    // shared company wallet (submitDeposit). senderId/senderName = the
    // submitter (clickable), receiverId=null + receiverLabel='Счёт компании'.
    case 'COMPANY_DEPOSIT':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={null} name={null} label={tx.receiverLabel ?? 'Счёт компании'} type="user" />
        </div>
      )

    // DIVIDEND_TO_ADMIN: ADMIN withdraws dividends from the company account
    // (createDividend). senderId=null + senderLabel='Счёт компании' (company
    // alias, non-clickable), receiverId = the admin (clickable).
    case 'DIVIDEND_TO_ADMIN':
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? 'Счёт компании'} type="user" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <Party id={tx.receiverId} name={tx.receiverName} label={tx.receiverLabel} type="user" />
        </div>
      )

    // Intentionally «—»: Phase 4-B placeholder types (TOV_INCOME, SENIOR_PAID,
    // ADMIN_INCOME_CASH, ADMIN_INCOME_CRYPTO, SENIOR_INCOME_CRYPTO,
    // DIVIDEND_TAX) exist only to satisfy the exhaustive TYPE_LABELS/
    // TYPE_COLORS Record<> contracts — no current flow ever inserts a row
    // with these types (verified against every `.insert(transactions)` call
    // site), so falling through to the dash here is correct, not a bug.
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
  /**
   * task-receipts-frontend. Opens `AttachReceiptSheet` for this tx (attach
   * when it has no receipt yet, replace otherwise). Rendered as a compact
   * icon button visible from ≥768px — RBAC/status-gated via
   * `canAttachReceipt` (see `receipt-permissions.ts`). On mobile the primary
   * entry point is the button inside `TransactionDetailDialog` instead (the
   * row's actions cell is already a tight horizontal-scroll area).
   */
  onAttachReceipt?: (tx: TransactionDto) => void
  onClick?: (tx: TransactionDto) => void
  /**
   * task-soft-delete-and-money-audit. ADMIN-only restore action on a deleted
   * row (visible only after the ADMIN/ACCOUNTANT «показать удалённые» toggle
   * — see FinancePage). Never rendered for ACCOUNTANT (they can see a
   * deleted row but not restore it — mirrors the server-side RBAC).
   */
  onRestore?: (tx: TransactionDto) => void
}

// forwardRef is required because the row is rendered inside an
// <AnimatePresence mode="sync"> in TransactionsTable (task-finance-sort-date-
// and-jump AC4 — was "popLayout", switched because that mode can't
// meaningfully position a <tr>). framer-motion still needs to attach a ref to
// the underlying <tr> to measure it for the enter/exit animation below.
// Without forwardRef React logs «Function components cannot be given refs»
// once per row (50-60× on /finance) and the row animation breaks.
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
      onAttachReceipt,
      onClick,
      onRestore,
    },
    ref,
  ) {
    const isAdmin = role === 'ADMIN'
    const isAccountant = role === 'ACCOUNTANT'
    const isSenior = role === 'SENIOR'
    // task-soft-delete-and-money-audit. This row can only ever be a deleted
    // one when the viewer is ADMIN/ACCOUNTANT AND explicitly toggled
    // «показать удалённые» — every other viewer never receives it (AC2/AC3).
    // No further mutating action is available on it (must restore first) —
    // every `can*`/`show*` gate below is additionally guarded by `!isDeleted`.
    const isDeleted = !!tx.deletedAt

    // task-cascade-preview-ui (task 5). `null` on every row without a settle
    // accumulator — which is nearly all of them, so the list is unchanged for
    // the ordinary case.
    const settlement = settlementSplit(tx)
    const remainingToPay = settlement?.remaining ?? 0

    const canValidate =
      !isDeleted &&
      (isAdmin || isAccountant) &&
      tx.type === 'SENIOR_INCOME' &&
      tx.status === 'PENDING'
    // feat/finance-payout-flow (#7): SENIOR sees «Выплатить» on their own
    // VALIDATED SENIOR_INCOME rows that haven't been included in a payout yet
    // (payoutRequestId is null). Clicking opens PayoutDialog pre-selecting
    // this row; they can then add more VALIDATED rows before submitting.
    const showInitiatePayout =
      !isDeleted &&
      isSenior &&
      tx.type === 'SENIOR_INCOME' &&
      tx.status === 'VALIDATED' &&
      !tx.payoutRequestId &&
      tx.receiverId === currentUserId
    const canEdit =
      !isDeleted && isSenior && tx.type === 'SENIOR_INCOME' && tx.status === 'REJECTED'
    const canPaySalary = !isDeleted && isAdmin && tx.type === 'SALARY' && tx.status === 'PENDING'
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
      !isDeleted &&
      (isAdmin || isAccountant) &&
      (tx.type === 'SENIOR_PENDING_PAYOUT' || tx.type === 'DROP_PENDING_PAYOUT') &&
      tx.status === 'PENDING_PAYMENT'
    const canAdminEdit =
      !isDeleted &&
      isAdmin &&
      tx.type !== 'PAYOUT' &&
      tx.type !== 'PAYOUT_ADMIN' &&
      (tx.status === 'PENDING_PAYMENT' || !tx.payoutRequestId)
    const canAdminDelete = canAdminEdit
    // task-soft-delete-and-money-audit. ADMIN-only, and only on an already-
    // deleted row (mirrors the server-side `restoreTransaction` guard —
    // ACCOUNTANT can see the row but not restore it).
    const canRestore = isDeleted && isAdmin
    // Inline «Оплатить» for the «Выплата» row (PAYOUT type, PENDING_PAYMENT).
    // New flow (task-payout-auto-on-validate): when ACCOUNTANT clicks
    // «Подтвердить» on a SENIOR_INCOME, the backend atomically creates a
    // PAYOUT row carrying this button. SENIOR_INCOME rows no longer have any
    // inline «Выплатить» pill — they just show «Ожидает выплаты» status.
    // Scoped by senderId so a SENIOR only sees the pill for their own payouts.
    const showPayPayout =
      !isDeleted &&
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
      !isDeleted &&
      (isAdmin || isAccountant) &&
      tx.type === 'PAYOUT' &&
      tx.status === 'PENDING_PAYMENT'
    // task-receipts-frontend. Compact row entry for attach/replace-receipt —
    // visible from ≥768px only (see `onAttachReceipt` doc above). Gated on
    // BOTH the shared RBAC/status rule AND the handler actually being wired
    // (mirrors every other row action in this component) — surfaces omitted
    // read-only consumers (e.g. the dashboard's ActiveTransactionsTable) do
    // not render an inert button.
    const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
    const showAttachReceipt =
      !isDeleted && !!onAttachReceipt && canAttachReceipt(tx, currentUserId, role)

    return (
      <motion.tr
        ref={ref}
        initial={{ opacity: 0, y: -4 }}
        // task-soft-delete-and-money-audit: a deleted row (visible only to
        // ADMIN/ACCOUNTANT via the «показать удалённые» toggle) is dimmed —
        // framer-motion's `animate.opacity` is an inline style, so a Tailwind
        // opacity utility class would be silently overridden by it; the dim
        // has to be expressed here instead.
        animate={{ opacity: isDeleted ? 0.55 : 1, y: 0 }}
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
        data-tx-deleted={isDeleted ? 'true' : undefined}
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
          {/* task-cascade-preview-ui (task 5). A partly-paid obligation is a
              state that did not exist before tasks 3/3b, and the amount column
              alone cannot express it: the row says 8 000 while only 3 000 is
              still owed. Amber rather than the muted grey of «Доля: X%» — this
              is new information worth catching while scanning, but it is not a
              problem, so not destructive. Absent on every row without an
              accumulator, which is nearly all of them. */}
          {settlement && (
            <p
              className="text-[11px] font-normal text-amber-400"
              data-testid={`tx-row-settled-${tx.id}`}
            >
              Выплачено {fmtAmount(settlement.settled, settlement.settledCurrency)}
              {/* COPY-M-2: «к доплате», the same name the detail dialog, the
                  cascade panel and the settle dialog use for the SAME number
                  from the SAME function. It was «осталось» here alone, and the
                  operator crosses all four surfaces in one scenario. Measured
                  by the copy reviewer: two lines in a ~150px cell either way,
                  so the unification costs nothing.
                  UX-3: absent entirely once there is nothing left to pay —
                  «к доплате 0,00» is a line to read and discard. */}
              {/* ONE number, ONE condition. The explicit `remaining !== null`
                  test that stood beside `> 0` was dead at RUNTIME — `null > 0`
                  is already `false`, which the mutation gate proved by deleting
                  it with every test still green. It was NOT dead to the type
                  system, though: dropping it alone made `remaining` a
                  `number | null` inside the branch and `pnpm typecheck` caught
                  it. Collapsing to a single narrowed value satisfies both.
                  Cross-currency (`null`) and fully closed (`0`) mean the same
                  thing here: no actionable remainder. */}
              {remainingToPay > 0 && ` · к доплате ${fmtAmount(remainingToPay, tx.currency)}`}
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
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge status={tx.status} />
            {isDeleted && <DeletedBadge reason={tx.deletionReason} />}
          </div>
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
            {/* task-soft-delete-and-money-audit. A deleted row shows ONLY the
                restore action (ADMIN) — every other action above is gated
                `!isDeleted`, so this is the sole affordance left. */}
            {canRestore && onRestore && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                onClick={() => onRestore(tx)}
                data-testid={`tx-row-restore-${tx.id}`}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Восстановить
              </Button>
            )}
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
            {/* task-receipts-frontend. Attach/replace-receipt affordance —
                hidden below md (768px), the row's actions cell is already a
                tight horizontal-scroll strip on mobile; the primary mobile
                entry is the button inside TransactionDetailDialog instead. */}
            <div className="hidden md:inline-flex">
              {showAttachReceipt ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 w-7 p-0',
                    hasReceipt
                      ? 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                  )}
                  onClick={() => onAttachReceipt?.(tx)}
                  title={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
                  aria-label={hasReceipt ? 'Заменить чек' : 'Прикрепить чек'}
                  data-testid={`tx-row-attach-receipt-${tx.id}`}
                >
                  <Receipt className="h-3.5 w-3.5" />
                </Button>
              ) : hasReceipt ? (
                <span
                  className="inline-flex h-7 w-7 items-center justify-center text-emerald-400/60"
                  title="Чек прикреплён"
                  aria-label="Чек прикреплён"
                  data-testid={`tx-row-receipt-indicator-${tx.id}`}
                >
                  <Receipt className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </div>
          </div>
        </td>
      </motion.tr>
    )
  },
)

TransactionRow.displayName = 'TransactionRow'
