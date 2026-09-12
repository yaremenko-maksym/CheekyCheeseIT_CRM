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
        {/* task-667-mutation-web: every framer-motion prop below (the
            `AnimatePresence`/`motion.li` `initial`s, `exit`, `transition`,
            and the list `key`) is a genuine mutation-gate equivalent in THIS
            harness — verified empirically, not assumed: a probe test that
            dumped `container.querySelectorAll('li')[n].outerHTML` for a
            mounted, populated section showed a bare `<li>` with NO `style`
            attribute and nothing animation-related at all — happy-dom (this
            project's vitest environment, see apps/web/vitest.config.ts)
            never runs framer-motion's real style-application path, so no
            DOM-based assertion in this suite can distinguish any of these
            values from a mutated one. `key` is included for a second,
            independent reason on top of that: React never renders `key` to
            the DOM, and `PendingItemRow` is a pure function of its own
            props with no internal/DOM state a wrong-instance reuse across a
            re-render could visibly corrupt — the content-only assertions
            this whole test file uses cannot tell a stable key from a
            colliding one either. */}
        {/* Stryker disable next-line BooleanLiteral: see the block comment above — no observable DOM effect in this test harness */}
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              // Stryker disable next-line StringLiteral: see the block comment above — `key` is never rendered to the DOM and this component has no state a collision could visibly corrupt
              key={`${item.kind}-${item.subjectId}`}
              // `layout="position"`, not bare `layout`: the rows only ever
              // need to SLIDE UP into a departing row's gap, and the plain
              // version animates size too — by scaling the element, which
              // visibly distorts the row's text and buttons mid-flight (and
              // was measurable: a 44px touch target reads as 40.4px while
              // the transform is running). Position-only keeps the slide and
              // leaves the contents undeformed.
              layout="position"
              // Stryker disable next-line BooleanLiteral: see the block comment above — no observable DOM effect in this test harness
              initial={false}
              // Stryker disable next-line ObjectLiteral: see the block comment above — no observable DOM effect in this test harness
              exit={{ opacity: 0, height: 0 }}
              // Stryker disable next-line ObjectLiteral: see the block comment above — no observable DOM effect in this test harness
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
