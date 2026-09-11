import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { PendingItemRow, type PendingZone } from '@/components/pending/PendingItemRow'
import type { PendingItem } from '@/hooks/use-pending-items'

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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </div>
      <ul className="space-y-1.5" data-testid={`pending-kind-section-${zone}-${title}`}>
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={`${item.kind}-${item.subjectId}`}
              layout
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
