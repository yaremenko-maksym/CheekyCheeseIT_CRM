import { Edit2, CheckCircle2, ArrowRight, Trash2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import type { TransactionDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TYPE_LABELS, TYPE_COLORS, STATUS_LABELS, STATUS_COLORS, fmtAmount, fmtUsd, fmtDate, type ExchangeRates } from '../constants'

function TypeBadge({ type }: { type: TransactionDto['type'] }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', TYPE_COLORS[type])}>
      {TYPE_LABELS[type]}
    </span>
  )
}

function StatusBadge({ status }: { status: TransactionDto['status'] }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_COLORS[status])}>
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
          className="text-primary hover:underline underline-offset-2 font-medium truncate max-w-28 block"
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
        className="text-primary hover:underline underline-offset-2 font-medium truncate max-w-28 block"
        onClick={(e) => e.stopPropagation()}
      >
        {display}
      </Link>
    )
  }

  // Non-clickable alias (e.g. CheekyCheeseIT, company name)
  return <span className="text-muted-foreground truncate max-w-28 block">{display}</span>
}

function FromTo({ tx }: { tx: TransactionDto }) {
  switch (tx.type) {
    case 'ADMIN_INCOME':
    case 'SENIOR_INCOME':
      // Company (client) → Senior who created the transaction
      // sender_label = client company name, receiver_id = senior user
      return (
        <div className="flex items-center gap-1.5 min-w-0">
          <Party id={null} name={null} label={tx.senderLabel ?? tx.projectName ?? '—'} type="project" />
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
          <Party id={tx.senderId} name={tx.senderName} label={tx.senderLabel ?? 'CheekyCheeseIT'} type="user" />
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

    default:
      return <span className="text-muted-foreground">—</span>
  }
}

export function TransactionRow({
  tx,
  role,
  rates,
  onValidate,
  onEdit,
  onAdminEdit,
  onDelete,
  onPaySalary,
  onClick,
}: {
  tx: TransactionDto
  role: string
  rates: ExchangeRates | undefined
  onValidate?: (tx: TransactionDto) => void
  onEdit?: (tx: TransactionDto) => void
  onAdminEdit?: (tx: TransactionDto) => void
  onDelete?: (tx: TransactionDto) => void
  onPaySalary?: (tx: TransactionDto) => void
  onClick?: (tx: TransactionDto) => void
}) {
  const isAdmin = role === 'ADMIN'
  const isAccountant = role === 'ACCOUNTANT'
  const isSenior = role === 'SENIOR'

  const canValidate = (isAdmin || isAccountant) && tx.type === 'SENIOR_INCOME' && tx.status === 'PENDING'
  const canEdit = isSenior && tx.type === 'SENIOR_INCOME' && tx.status === 'REJECTED'
  const canPaySalary = isAdmin && tx.type === 'SALARY' && tx.status === 'PENDING'
  const canAdminEdit = isAdmin && tx.type !== 'PAYOUT' && tx.type !== 'PAYOUT_ADMIN' && (tx.status === 'PENDING_PAYMENT' || !tx.payoutRequestId)
  const canAdminDelete = canAdminEdit

  return (
    <motion.tr
      layout="position"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.08, ease: 'easeOut' }}
      className={cn(
        'border-b border-border/50 transition-colors text-sm',
        onClick ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/30',
      )}
      onClick={() => onClick?.(tx)}
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
          <p className="text-[11px] text-muted-foreground font-normal">{fmtAmount(tx.amount, tx.currency)}</p>
        )}
      </td>

      <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
        {fmtDate(tx.txDate ?? tx.createdAt)}
      </td>

      <td className="py-3 px-4">
        <StatusBadge status={tx.status} />
        {tx.rejectionReason && (
          <p className="text-xs text-destructive mt-0.5 max-w-40 truncate" title={tx.rejectionReason}>
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
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Проверить
            </Button>
          )}
          {canEdit && onEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
              onClick={() => onEdit(tx)}
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
}
