/**
 * InvoiceCard — list-row card used by historic InvoiceListItem grids.
 *
 * Note: the standalone `/finance/invoices` page was removed in batch 2
 * — INVOICE documents are now surfaced in `/documents` as regular
 * `DocumentCard` rows. The card is retained for tests and a potential
 * future re-use (e.g. an Admin audit list of invoices). The visual layout
 * and onOpen contract are unchanged.
 *
 * Visual layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [type badge]   [status badge]                  [arrow]  │
 *   │ AMOUNT CURRENCY (large)                                 │
 *   │ Контрагент: Іван Іванов                                 │
 *   │ Створено: 3 години тому                                 │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Click anywhere on the card → onOpen(transactionId). The detail dialog is
 * a sibling controlled component on the page, so the card only emits the
 * id; opening / closing the dialog stays out of the card.
 */
import { motion } from 'framer-motion'
import { ArrowRight, CheckCircle2, Clock, FileSignature } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { InvoiceListItem } from '@crm/shared'
import { formatRelativeTime } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { formatAmount } from '@/lib/format-amount'
import { useInvoiceTypeLabel } from '@/lib/invoice-labels'

export interface InvoiceCardProps {
  invoice: InvoiceListItem
  onOpen: (transactionId: string) => void
  /**
   * When true, render a subtle "(ви — контрагент, очікується підпис)" hint
   * so users immediately see which rows need their attention. Computed by
   * the page (it has access to the viewer.id and the counterparty id from
   * the parent transaction list).
   */
  awaitingViewerSignature?: boolean
}

// ---------------------------------------------------------------------------
// Status palette (type label lives in shared invoice-labels helper)
// ---------------------------------------------------------------------------

const TYPE_CLASS: Record<InvoiceListItem['type'], string> = {
  // Blue — SENIOR payout (мы платим контракту с проекта)
  SENIOR_INCOME: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  // Green — salary
  SALARY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
} as const

/**
 * task-i18n-stage3d-pr4 (template G-fin, COPY-L-fin-16). «Рахунок» —
 * canon term, not «інвойс» — `satisfies` without `as const` (урок #707).
 */
const STATUS_LABEL_MESSAGES = {
  PENDING: msg`Очікує підпису`, // en: Awaiting signature
  SIGNED: msg`Підписано всіма`, // en: Signed by everyone
} satisfies Record<InvoiceListItem['status'], MessageDescriptor>

const STATUS_CLASS: Record<InvoiceListItem['status'], string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SIGNED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InvoiceCard({
  invoice,
  onOpen,
  awaitingViewerSignature = false,
}: InvoiceCardProps) {
  const { t, i18n } = useLingui()
  const locale = useLocale()
  const isPending = invoice.status === 'PENDING'
  const typeLabel = useInvoiceTypeLabel(invoice.type)
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
        role="button"
        tabIndex={0}
        aria-label={t`Відкрити рахунок ${typeLabel} на ${formatAmount(invoice.amount, invoice.currency)}`}
        onClick={() => onOpen(invoice.transactionId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(invoice.transactionId)
          }
        }}
        className={cn(
          'group cursor-pointer border-border/70 hover:border-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
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
                {typeLabel}
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
                {i18n._(STATUS_LABEL_MESSAGES[invoice.status])}
              </Badge>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </div>

          <div className="mt-3 text-2xl font-bold tracking-tight tabular-nums">
            {formatAmount(invoice.amount, invoice.currency)}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="text-muted-foreground/70">
                <Trans>Контрагент:</Trans>
              </span>{' '}
              <span className="font-medium text-foreground">{invoice.counterpartyName}</span>
            </span>
            <span
              title={new Date(invoice.createdAt).toLocaleString(
                locale === 'uk' ? 'uk-UA' : 'en-GB',
              )}
            >
              {formatRelativeTime(invoice.createdAt, locale)}
            </span>
          </div>

          {awaitingViewerSignature ? (
            <p className="mt-2 text-xs font-medium text-amber-300">
              <Trans>Очікується ваш підпис</Trans>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
