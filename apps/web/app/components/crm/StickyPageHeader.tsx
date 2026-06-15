/**
 * StickyPageHeader — reusable sticky header pattern for CRM list pages.
 *
 * Layout contract:
 *   • The parent <main> in route.tsx is `overflow-y-auto p-6 flex flex-col`.
 *   • Inside an overflow-y-auto container, `position: sticky; top: 0` sticks
 *     to the TOP of that scroll container (NOT the viewport). The global CRM
 *     top-bar is OUTSIDE <main> so no viewport offset is needed.
 *   • We use negative margins `-mx-6 -mt-6` to break out of <main>'s p-6,
 *     then add our own `px-6 pt-6` so the inner content stays aligned.
 *   • z-index 20 — above content rows/cards, below modals/dropdowns (z-50).
 *   • bg-background is opaque — content must NOT bleed through on scroll.
 *   • pb-3 + a subtle shadow provide visual separation from scrolling content.
 *
 * Usage:
 *   <StickyPageHeader>
 *     <div className="flex items-center justify-between">
 *       <h1>Title</h1>
 *       <Button>Action</Button>
 *     </div>
 *     <SegmentedToggle ... />
 *     <Card>...toolbar (search / filters / sort)...</Card>
 *   </StickyPageHeader>
 *   <div className="space-y-6">...scrollable content...</div>
 */

import { cn } from '@/lib/utils'

interface StickyPageHeaderProps {
  children: React.ReactNode
  /** Additional className on the outer sticky wrapper (rarely needed) */
  className?: string
}

export function StickyPageHeader({ children, className }: StickyPageHeaderProps) {
  return (
    <div
      className={cn(
        // ── positioning ──────────────────────────────────────────────────────
        'sticky top-0 z-20',
        // ── background (opaque) ───────────────────────────────────────────────
        'bg-background',
        // ── spacing: negative margin breaks out of <main>'s p-6, then we
        //    re-add px-6 + pt-6 so the inner content lines up with the rest
        //    of the page. Bottom pad is kept small; shadow does the work. ────
        '-mx-6 -mt-6 px-6 pt-6 pb-3',
        // ── shadow below header to visually separate sticky from content ──────
        'shadow-[0_4px_8px_-4px_hsl(var(--border))]',
        className,
      )}
    >
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}
