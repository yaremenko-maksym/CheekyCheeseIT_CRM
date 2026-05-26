/**
 * InvoiceCard — list-row card for `/crm/finance/invoices`.
 *
 * Visual layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [type badge]   [status badge]                  [arrow]  │
 *   │ AMOUNT CURRENCY (large)                                 │
 *   │ Counterparty: Иван Иванов                               │
 *   │ Создан: 3 часа назад                                    │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Click anywhere on the card → onOpen(transactionId). The detail dialog is
 * a sibling controlled component on the page, so the card only emits the
 * id; opening / closing the dialog stays out of the card.
 */
import { motion } from 'framer-motion'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ArrowRight, CheckCircle2, Clock, FileSignature } from 'lucide-react'
import type { InvoiceListItem } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface InvoiceCardProps {
  invoice: InvoiceListItem
  onOpen: (transactionId: string) => void
  /**
   * When true, render a subtle "(вы — контрагент, ожидается подпись)" hint
   * so users immediately see which rows need their attention. Computed by
   * the page (it has access to the viewer.id and the counterparty id from
   * the parent transaction list).
   */
  awaitingViewerSignature?: boolean
}

// ---------------------------------------------------------------------------
// Type / status palettes
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<InvoiceListItem['type'], string> = {
  SENIOR_INCOME: 'Выплата сеньору',
  SALARY: 'Зарплата',
}

const TYPE_CLASS: Record<InvoiceListItem['type'], string> = {
  // Blue — SENIOR payout (мы платим контракту с проекта)
  SENIOR_INCOME: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  // Green — salary
  SALARY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

const STATUS_LABEL: Record<InvoiceListItem['status'], string> = {
  PENDING: 'Ожидает подписи',
  SIGNED: 'Подписано всеми',
}

const STATUS_CLASS: Record<InvoiceListItem['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAmount(amount: string, currency: string): string {
  const num = Number(amount)
  if (!Number.isFinite(num)) return `${amount} ${currency}`
  return `${num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`
}

function fmtRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InvoiceCard({
  invoice,
  onOpen,
  awaitingViewerSignature = false,
}: InvoiceCardProps) {
  const isPending = invoice.status === 'PENDING'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
    >
      <Card
        data-testid={`invoice-card-${invoice.transactionId}`}
        onClick={() => onOpen(invoice.transactionId)}
        className={cn(
          'group cursor-pointer border-border/70 hover:border-primary/40 transition-colors',
          awaitingViewerSignature && 'border-amber-500/50 ring-1 ring-amber-500/20',
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn('border', TYPE_CLASS[invoice.type])}
                data-testid={`invoice-card-type-${invoice.transactionId}`}
              >
                <FileSignature className="mr-1 h-3 w-3" />
                {TYPE_LABEL[invoice.type]}
              </Badge>
              <Badge
                variant="outline"
                className={cn('border', STATUS_CLASS[invoice.status])}
                data-testid={`invoice-card-status-${invoice.transactionId}`}
              >
                {isPending ? (
                  <Clock className="mr-1 h-3 w-3" />
                ) : (
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                )}
                {STATUS_LABEL[invoice.status]}
              </Badge>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </div>

          <div className="mt-3 text-2xl font-bold tracking-tight tabular-nums">
            {fmtAmount(invoice.amount, invoice.currency)}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="text-muted-foreground/70">Контрагент:</span>{' '}
              <span className="font-medium text-foreground">{invoice.counterpartyName}</span>
            </span>
            <span title={new Date(invoice.createdAt).toLocaleString('ru-RU')}>
              {fmtRelative(invoice.createdAt)}
            </span>
          </div>

          {awaitingViewerSignature ? (
            <p className="mt-2 text-xs font-medium text-amber-300">
              Ожидается ваша подпись
            </p>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
