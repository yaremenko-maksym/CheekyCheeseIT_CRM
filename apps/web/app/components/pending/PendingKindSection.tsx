import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { PendingItemRow, type PendingZone } from '@/components/pending/PendingItemRow'
import type { PendingItem } from '@crm/shared'

export interface PendingKindSectionProps {
  title: string
  icon: LucideIcon
  items: PendingItem[]
  zone: PendingZone
  onActed: (item: PendingItem) => void
}

/**
 * task-pending-screen design spec §5.2 п.2, §11. Renders nothing when empty
 * (deletion-test / §3 "рендерится только если непуста" — same "nothing, not
 * an empty card" convention `PendingProjectApprovalsPanel` already uses).
 *
 * `AnimatePresence` + `motion.li` here is what makes AC4's "строка исчезла"
 * a visible transition instead of an instant DOM removal — `layout` lets
 * the remaining rows slide up into the gap, `exit` collapses the departing
 * row's own height instead of leaving a blank gap for one frame.
 */
export function PendingKindSection({
  title,
  icon: Icon,
  items,
  zone,
  onActed,
}: PendingKindSectionProps) {
  const shouldReduceMotion = useReducedMotion()
  if (items.length === 0) return null
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-amber-400" aria-hidden />
        {/* `tabIndex={-1}` + a testid for the same reason the row has them
            (design spec §12): when the acted row was the last one in this
            section, focus lands on the section's own heading rather than on
            <body>. Not in the Tab order — headings never are. */}
        <h3
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          tabIndex={-1}
          data-testid={`pending-kind-heading-${zone}-${title}`}
        >
          {title}
        </h3>
      </div>
      <ul className="space-y-1.5" data-testid={`pending-kind-section-${zone}-${title}`}>
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={`${item.kind}-${item.subjectId}`}
              // `layout="position"`, not bare `layout`: the rows only ever
              // need to SLIDE UP into a departing row's gap, and the plain
              // version animates size too — by scaling the element, which
              // visibly distorts the row's text and buttons mid-flight (and
              // was measurable: a 44px touch target reads as 40.4px while
              // the transform is running). Position-only keeps the slide and
              // leaves the contents undeformed.
              layout="position"
              initial={false}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
            >
              <PendingItemRow item={item} zone={zone} onActed={() => onActed(item)} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  )
}
