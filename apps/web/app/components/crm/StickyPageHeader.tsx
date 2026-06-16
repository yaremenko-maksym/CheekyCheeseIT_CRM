/**
 * PageHeader — compact fixed header for CRM list/detail pages.
 *
 * Layout contract (new model):
 *   • The parent page root is `flex flex-col h-full` (fills the <main> area).
 *   • PageHeader is `flex-none` — always visible, never scrolls.
 *   • The scrollable content area below is `flex-1 min-h-0 overflow-y-auto`.
 *   • No negative margins: horizontal padding contained within the header.
 *   • The global top-bar and <main> (route.tsx) own the outer p-6 — we
 *     inherit that padding context via `px-6 pt-4 pb-3` here.
 *   • z-index 20 — above content rows/cards, below modals/dropdowns (z-50).
 *   • bg-background is opaque — content does NOT bleed through on scroll.
 *   • Compact vertical padding keeps more space for content.
 *
 * Usage:
 *   <div className="flex flex-col h-full">
 *     <PageHeader>
 *       <div className="flex items-center justify-between">
 *         <h1>Title</h1>
 *         <Button>Action</Button>
 *       </div>
 *       <SegmentedToggle ... />
 *       <Card>...toolbar (search / filters / sort)...</Card>
 *     </PageHeader>
 *     <div className="flex-1 min-h-0 overflow-y-auto pt-4 pb-6">
 *       ...scrollable content...
 *     </div>
 *   </div>
 *
 * StickyPageHeader is kept as an alias for backwards compat.
 */

import { cn } from '@/lib/utils'

interface PageHeaderProps {
  children: React.ReactNode
  /** Additional className on the outer wrapper (rarely needed) */
  className?: string
}

export function PageHeader({ children, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        // ── layout: flex-none so it never scrolls away with content ─────────
        'flex-none',
        // ── stacking context: above cards/rows, below modals ─────────────────
        'relative z-20',
        // ── background (opaque) ──────────────────────────────────────────────
        'bg-background',
        // ── compact spacing — no negative margins needed ──────────────────────
        'px-6 pt-4 pb-3',
        // ── subtle bottom shadow to visually separate header from content ─────
        'shadow-[0_4px_8px_-4px_hsl(var(--border))]',
        className,
      )}
    >
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

/**
 * @deprecated Use PageHeader instead.
 * Alias kept so existing import sites compile without changes during migration.
 */
export const StickyPageHeader = PageHeader
