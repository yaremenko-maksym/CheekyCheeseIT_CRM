import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ProjectApprovalActions } from '@/components/projects/ProjectApprovalActions'
import { CancelPendingShareButton } from '@/components/pending-share/cancel-pending-share'
import { SeniorShareApprovalActions } from '@/components/pending/SeniorShareApprovalActions'
import type { PendingItem } from '@crm/shared'

export type PendingZone = 'mine' | 'proposedByMe'

/** Same relative-time helper as notifications-bell.tsx's `fmtRelative` — not
 * re-exported from there (that file has no other reason to be a shared
 * module) since it's a 4-line pure function, cheaper to repeat once than to
 * add a cross-import for. */
function fmtRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru })
  } catch {
    return iso
  }
}

/** `subjectType` is the server's own answer to "which endpoint family does
 * this row's action belong to" — required and closed (`'USER' | 'PROJECT'`,
 * see its doc in `@crm/shared`'s `pending.ts`), so there is no missing-value
 * case to guess at any more: integration decision 1, 2026-09-11. */
function shareScopeOf(item: PendingItem): 'user' | 'project' {
  return item.subjectType === 'USER' ? 'user' : 'project'
}

function metaFor(item: PendingItem, zone: PendingZone): string {
  const rel = fmtRelative(item.createdAt)
  if (item.kind === 'PROJECT_APPROVAL') {
    if (zone === 'proposedByMe') {
      return item.waitingFor?.length ? `Ждём: ${item.waitingFor.join(', ')} · ${rel}` : rel
    }
    return item.proposedBy ? `Предложил ${item.proposedBy} · ${rel}` : rel
  }
  if (item.kind === 'SHARE_APPROVAL') {
    const pct = item.pendingPercent
    const base =
      item.currentPercent != null
        ? `Сейчас ${item.currentPercent}% → предлагают ${pct}%`
        : `Предлагают ${pct}%`
    if (zone === 'proposedByMe') {
      const who = item.waitingFor?.length ? `ждём: ${item.waitingFor.join(', ')}` : null
      return who ? `${base} · ${who} · ${rel}` : `${base} · ${rel}`
    }
    return `${base} · ${rel}`
  }
  // CONTRACT_TO_SIGN (§6.3) and the AC6 unknown-kind default branch (§6.5)
  // both render давность only — no "от кого" (see use-pending-items.ts's
  // `proposedBy` doc: nobody "proposes" a contract the same way).
  return rel
}

function OpenLink({ item, primary }: { item: PendingItem; primary?: boolean }) {
  const navigate = useNavigate()
  // Same try/catch + hard-navigation fallback as notifications-bell.tsx's
  // `handleItemClick` — `item.link` is server data, not a route literal
  // TanStack Router's typed `Link` can validate at compile time.
  function handleOpen() {
    try {
      void navigate({ to: item.link as never })
    } catch {
      window.location.assign(item.link)
    }
  }
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'ghost'}
      size="sm"
      className="h-11 gap-1 sm:h-7"
      onClick={handleOpen}
      data-testid={`pending-item-open-${item.subjectId}`}
    >
      Открыть
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Button>
  )
}

function renderActions(item: PendingItem, zone: PendingZone, onActed: () => void) {
  const has = (a: PendingItem['actions'][number]) => item.actions.includes(a)

  if (item.kind === 'PROJECT_APPROVAL') {
    if (zone === 'mine' && has('approve') && has('reject')) {
      return (
        <ProjectApprovalActions
          projectId={item.subjectId}
          companyName={item.title}
          onActed={onActed}
        />
      )
    }
    // §6.4: proposedByMe (ADMIN observer) — no revoke endpoint in main for a
    // project draft (task «Допущения») — 'open' only.
    return has('open') ? <OpenLink item={item} /> : null
  }

  if (item.kind === 'SHARE_APPROVAL') {
    if (zone === 'mine' && has('approve') && has('reject')) {
      return (
        <SeniorShareApprovalActions
          scope={shareScopeOf(item)}
          id={item.subjectId}
          onActed={onActed}
        />
      )
    }
    if (zone === 'proposedByMe' && has('cancel')) {
      return (
        <CancelPendingShareButton
          scope={shareScopeOf(item)}
          id={item.subjectId}
          pendingPercent={item.pendingPercent ?? 0}
        />
      )
    }
    return has('open') ? <OpenLink item={item} /> : null
  }

  if (item.kind === 'CONTRACT_TO_SIGN') {
    // §6.3: single primary CTA, no approve/reject on this screen at all —
    // signing stays in ContractTab/ContractActionBar (task «Границы»).
    return has('open') ? <OpenLink item={item} primary /> : null
  }

  // AC6 — unknown kind never crashes the screen: 'open' if offered, else
  // nothing (no guess at what other actions would even mean).
  return has('open') ? <OpenLink item={item} /> : null
}

export interface PendingItemRowProps {
  item: PendingItem
  zone: PendingZone
  onActed: () => void
}

/**
 * task-pending-screen design spec §6. One row shape for every `kind` — the
 * differences are confined to `metaFor`/`renderActions` above, not to the
 * JSX skeleton, matching §9's "один и тот же .item-row на всех классах
 * устройств" decision.
 *
 * Renders a `<div>`, not the `<li>` — `PendingKindSection` supplies the
 * `<motion.li>` wrapper (design spec §11's AnimatePresence/exit animation
 * needs to own the actual list-item node so the whole row — border, padding,
 * everything — collapses together, not just its content).
 */
export function PendingItemRow({ item, zone, onActed }: PendingItemRowProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2.5 rounded-md border px-3 py-2.5',
        zone === 'proposedByMe'
          ? 'border-amber-500/30 bg-amber-500/[0.06]'
          : 'border-border/40 bg-muted/20',
      )}
      data-testid={`pending-item-row-${item.kind}-${item.subjectId}`}
      // Design spec §12: not reachable by Tab (it is a container, not a
      // control — `-1`, never `0`), but focusable programmatically so the
      // page can land focus HERE when the row above it disappears from
      // under the user. Without it `.focus()` is a no-op on a plain div and
      // focus falls back to <body>.
      tabIndex={-1}
    >
      {/* Design spec §9 (mobile): "заголовок+мета на всю ширину, кнопки на
          следующей строке". `flex-wrap` alone does not produce that — a
          `flex-1 min-w-0` text column SHRINKS instead of forcing the actions
          onto the next line, and at 320px that left the meta line wrapping
          inside a ~60px gutter beside the buttons (seen in the AC7
          screenshot, not in any assertion: nothing overflowed, it was just
          unreadable). `w-full` below `sm:` is what actually makes the two
          blocks stack. */}
      <div className="w-full min-w-0 sm:flex-1">
        {item.kind === 'CONTRACT_TO_SIGN' ? (
          // §6.3: title and badge are SEPARATE flex items (each wraps on its
          // own) — the exact defect the design doc's own mock caught on
          // 320px when they shared one `<p>` (see design spec §6.3's own
          // writeup of that fix).
          <div className="item-title-row flex flex-wrap items-center gap-1.5">
            <p className="min-w-10 flex-1 truncate text-sm font-medium">{item.title}</p>
            <Badge variant="default" className="flex-none">
              готов к подписанию
            </Badge>
          </div>
        ) : (
          // §10.4: one line + truncate from 640px up, 2-line wrap-anywhere
          // below it — an 80-char project/share title must not push the
          // action buttons off the row (AC7).
          <p className="line-clamp-2 wrap-anywhere text-sm font-medium sm:line-clamp-none sm:truncate">
            {item.title}
          </p>
        )}
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">{metaFor(item, zone)}</p>
      </div>
      <div className="w-full sm:w-auto sm:flex-none">{renderActions(item, zone, onActed)}</div>
    </div>
  )
}
