/**
 * DocumentStatusBadge — renders the semantic status badge for a document entry.
 *
 * Backend sends {kind, state} (see packages/shared/src/schemas/documents.ts:
 * statusBadgeSchema). This component owns the label copy (uk/en via Lingui;
 * the shared statuses come from the `document-labels.ts` hub, so
 * `READY_TO_SIGN` reads the same here and on /pending) and the badge color
 * tone — the backend stays semantic-only.
 *
 * Badge tones:
 *   contract/draft    — secondary (neutral, grey)
 *   contract/ready    — amber (waiting for action)
 *   contract/signed   — green (success)
 *   invoice/ready     — amber (missing counterparty signature)
 *   invoice/signed    — green (both signatures present)
 *   receipt/pending   — amber (awaiting confirmation)
 *   receipt/validated — green (confirmed)
 */
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { StatusBadge } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { DOCUMENT_STATUS_MESSAGES } from './document-labels'

interface DocumentStatusBadgeProps {
  badge: StatusBadge
  className?: string | undefined
}

// ---------------------------------------------------------------------------
// Label + tone mapping
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'amber' | 'green'

interface BadgeMeta {
  label: MessageDescriptor
  tone: BadgeTone
}

// Receipt-only statuses: no other screen renders them, so they live here
// rather than in the shared hub.
const RECEIPT_STATUS_MESSAGES = {
  pending: msg`Очікує підтвердження`,
  validated: msg`Підтверджено`,
} satisfies Record<'pending' | 'validated', MessageDescriptor>

function resolveMeta(badge: StatusBadge): BadgeMeta {
  if (badge.kind === 'contract') {
    if (badge.state === 'draft') return { label: DOCUMENT_STATUS_MESSAGES.DRAFT, tone: 'neutral' }
    if (badge.state === 'ready')
      return { label: DOCUMENT_STATUS_MESSAGES.READY_TO_SIGN, tone: 'amber' }
    return { label: DOCUMENT_STATUS_MESSAGES.SIGNED, tone: 'green' }
  }
  if (badge.kind === 'invoice') {
    if (badge.state === 'ready')
      return { label: DOCUMENT_STATUS_MESSAGES.AWAITING_SIGNATURE, tone: 'amber' }
    return { label: DOCUMENT_STATUS_MESSAGES.SIGNED, tone: 'green' }
  }
  // receipt
  if (badge.state === 'pending') return { label: RECEIPT_STATUS_MESSAGES.pending, tone: 'amber' }
  return { label: RECEIPT_STATUS_MESSAGES.validated, tone: 'green' }
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted-foreground/15 text-foreground border-muted-foreground/20',
  amber: 'border-amber-500/30 bg-amber-500/20 text-amber-300',
  green: 'border-emerald-500/30 bg-emerald-500/20 text-emerald-300',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentStatusBadge({ badge, className }: DocumentStatusBadgeProps) {
  const { i18n } = useLingui()
  const { label, tone } = resolveMeta(badge)

  return (
    <Badge
      className={`${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
      data-testid="document-status-badge"
      data-badge-kind={badge.kind}
      data-badge-state={badge.state}
    >
      {i18n._(label)}
    </Badge>
  )
}
