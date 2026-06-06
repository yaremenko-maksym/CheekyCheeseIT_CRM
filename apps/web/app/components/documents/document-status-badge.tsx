/**
 * DocumentStatusBadge — renders the semantic status badge for a document entry.
 *
 * Backend sends {kind, state} (see packages/shared/src/schemas/documents.ts:
 * statusBadgeSchema). This component owns ALL Russian label copy and badge
 * color tone — the backend stays semantic-only.
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
import type { StatusBadge } from '@crm/shared'
import { Badge } from '@/components/ui/badge'

interface DocumentStatusBadgeProps {
  badge: StatusBadge
  className?: string | undefined
}

// ---------------------------------------------------------------------------
// Label + tone mapping
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'amber' | 'green'

interface BadgeMeta {
  label: string
  tone: BadgeTone
}

function resolveMeta(badge: StatusBadge): BadgeMeta {
  if (badge.kind === 'contract') {
    if (badge.state === 'draft') return { label: 'Драфт', tone: 'neutral' }
    if (badge.state === 'ready') return { label: 'Готово к подписи', tone: 'amber' }
    return { label: 'Подписано', tone: 'green' }
  }
  if (badge.kind === 'invoice') {
    if (badge.state === 'ready') return { label: 'Ожидает подписи', tone: 'amber' }
    return { label: 'Подписано', tone: 'green' }
  }
  // receipt
  if (badge.state === 'pending') return { label: 'Требует подтверждения', tone: 'amber' }
  return { label: 'Подтверждено', tone: 'green' }
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
  const { label, tone } = resolveMeta(badge)

  return (
    <Badge
      className={`${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
      data-testid="document-status-badge"
      data-badge-kind={badge.kind}
      data-badge-state={badge.state}
    >
      {label}
    </Badge>
  )
}
