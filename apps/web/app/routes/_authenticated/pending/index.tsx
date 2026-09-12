/**
 * /pending — «Ждут решения» (task-pending-screen, позиция 7c). Design spec:
 * docs/design/pending-screen.md (Tier 1, `design-gate: degraded` — static
 * mock, Claude Design unavailable this session).
 *
 * Aggregates three kinds of unresolved decisions the viewer either owns
 * (`mine`) or, for ADMIN, is waiting on someone else for (`proposedByMe`) —
 * see `use-pending-items.ts` for the `GET /pending` contract. No `<h1>`
 * (design spec §0.4/§3 — no CRM page has one since PR #243/#244); the E2E
 * anchor is `data-testid="pending-page"` on the root, not a heading role.
 */
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Briefcase, DollarSign, FileSignature, HelpCircle, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PendingKindSection } from '@/components/pending/PendingKindSection'
import type { PendingZone } from '@/components/pending/PendingItemRow'
import type { PendingItemKind, PendingItemOrUnknown } from '@crm/shared'
import { usePendingItems } from '@/hooks/use-pending-items'

export const Route = createFileRoute('/_authenticated/pending/')({
  component: PendingPage,
})

/** Composite key — `subjectId` alone isn't unique across kinds (a project id
 * and a PROJECT_SENIOR_SHARE subjectId are different id spaces, but nothing
 * stops them colliding by chance). */
function itemKey(item: PendingItemOrUnknown): string {
  return `${item.kind}:${item.subjectId}`
}

const KIND_SECTIONS: ReadonlyArray<{
  kind: PendingItemKind
  title: string
  icon: typeof Briefcase
}> = [
  { kind: 'PROJECT_APPROVAL', title: 'Проекты', icon: Briefcase },
  { kind: 'SHARE_APPROVAL', title: 'Доли', icon: DollarSign },
  { kind: 'CONTRACT_TO_SIGN', title: 'Контракты', icon: FileSignature },
]

// Stryker disable next-line StringLiteral: sectionTitleOf's fallback is only ever compared against ANOTHER call to sectionTitleOf (handleActed's `sectionTitleOf(i) === sectionTitleOf(item)`, for grouping) — any fallback value groups unknown-kind items identically, so no behavioral assertion can distinguish this specific string from another one. The VISIBLE "«Другое»" heading text is a separate hardcoded JSX literal (below), already covered by the AC6 grouping test.
const OTHER_SECTION_TITLE = 'Другое'

/** Which section a row is rendered in — the same grouping the JSX below
 * applies, extracted so the focus chain asks the question once. */
function sectionTitleOf(item: PendingItemOrUnknown): string {
  return KIND_SECTIONS.find((s) => s.kind === item.kind)?.title ?? OTHER_SECTION_TITLE
}

/**
 * Design spec §12 / integration decision 3: where focus goes once the acted
 * row leaves the DOM. An ORDERED list of candidates rather than a single
 * computed target — the caller takes the first one that actually exists
 * after the re-render, which is also the answer to "what if the whole
 * section, or the whole zone, went away with that row": the question never
 * has to be predicted, only asked in the right order.
 *
 * Order: the next row of the SAME section → that section's heading → the
 * zone's own heading → the page root. (No "previous row" step: the spec
 * says next-or-heading, and a user who just acted on the last row of a
 * section is looking at that section's remaining rows ABOVE the heading —
 * jumping backwards into them reads as a lost place, the heading as a
 * deliberate one.)
 */
export function focusSelectorsAfterActing(
  section: PendingItemOrUnknown[],
  acted: PendingItemOrUnknown,
  zone: PendingZone,
): string[] {
  const index = section.findIndex((i) => itemKey(i) === itemKey(acted))
  const next = index === -1 ? undefined : section[index + 1]
  return [
    ...(next ? [`[data-testid="pending-item-row-${next.kind}-${next.subjectId}"]`] : []),
    `[data-testid="pending-kind-heading-${zone}-${sectionTitleOf(acted)}"]`,
    zone === 'mine' ? '#pending-mine-heading' : '#pending-others-heading',
    '[data-testid="pending-page"]',
  ]
}

// Exported (not module-private) for __tests__/index.test.tsx — same
// precedent as $projectId.tsx's PendingShareApprovalBanner: the alternative
// is mounting the route through a full TanStack Router tree to read this
// page's own empty/loading/error states.
export function PendingPage() {
  const { mine, proposedByMe, isLoading, isError, dataUpdatedAt, refetch } = usePendingItems()

  // Local-dismiss on `onActed`, pruned on every fresh fetch — same pattern
  // (and same reasoning) as PendingProjectApprovalsPanel's `dismissedIds`:
  // makes AC4's "строка исчезла" instant instead of waiting on the
  // invalidated query's round trip, without permanently hiding an item a
  // later re-proposal legitimately brings back.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    setDismissed((prev) => {
      const live = new Set([...mine, ...proposedByMe].map(itemKey))
      const next = new Set([...prev].filter((k) => live.has(k)))
      // Stryker disable next-line ConditionalExpression: same identical pattern and reasoning as PendingProjectApprovalsPanel.tsx's own directive on this exact ternary — the `false?` branch (always return `next`) is a true equivalent mutant here too (`next`'s CONTENT already equals `prev`'s whenever nothing was pruned; the only effect is an extra React re-render via a new Set reference, which no test in this file asserts on). The `true?` branch (pruning never happens) is NOT equivalent and is independently killed by "does NOT prune a dismissal for an item that is STILL pending" below.
      return next.size === prev.size ? prev : next
    })
    // Deliberately keyed on `dataUpdatedAt` (an actual refetch), not on
    // `mine`/`proposedByMe` (a brand-new array identity every render) — same
    // precedent as PendingProjectApprovalsPanel.tsx (react-hooks/exhaustive-deps
    // is not configured in this project's eslint).
  }, [dataUpdatedAt])

  const visibleMine = mine.filter((i) => !dismissed.has(itemKey(i)))
  const visibleOther = proposedByMe.filter((i) => !dismissed.has(itemKey(i)))

  function handleActed(item: PendingItemOrUnknown, zone: PendingZone) {
    const list = zone === 'mine' ? visibleMine : visibleOther
    const section = list.filter((i) => sectionTitleOf(i) === sectionTitleOf(item))
    setFocusSelectors(focusSelectorsAfterActing(section, item, zone))
    setDismissed((prev) => new Set(prev).add(itemKey(item)))
  }

  // Runs after the re-render that removed the row, so the DOM it queries is
  // the post-removal one — hence "first candidate that exists" rather than a
  // pre-computed element reference (which could point at a node that has
  // just been unmounted).
  const [focusSelectors, setFocusSelectors] = useState<string[] | null>(null)
  useEffect(() => {
    if (!focusSelectors) return
    for (const selector of focusSelectors) {
      const el = document.querySelector<HTMLElement>(selector)
      if (el) {
        el.focus()
        break
      }
    }
    setFocusSelectors(null)
  }, [focusSelectors])

  if (isLoading) {
    return (
      <div data-testid="pending-page" tabIndex={-1} className="flex h-full flex-col">
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-5 md:px-6 md:py-6 lg:max-w-6xl lg:px-8">
          <Skeleton className="h-16 rounded-md" data-testid="pending-loading" />
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div data-testid="pending-page" tabIndex={-1} className="flex h-full flex-col">
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-5 text-center"
          data-testid="pending-error"
        >
          {/* COPY-L-2 (fix-round 3): this screen calls itself «решение»
              everywhere — nav item, both headings, the empty state — and
              «список» appeared exactly once, at the moment the reader least
              understands what broke. The dashboard widget names the thing
              too («Не удалось проверить, ждёт ли вас решение по проекту»). */}
          <p className="text-sm text-destructive">Не удалось загрузить, что ждёт решения.</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            aria-label="Повторить загрузку"
          >
            Повторить
          </Button>
        </div>
      </div>
    )
  }

  const isEmpty = visibleMine.length === 0 && visibleOther.length === 0

  return (
    <div data-testid="pending-page" tabIndex={-1} className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6 lg:max-w-6xl lg:px-8">
        {isEmpty ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-1 text-center"
            data-testid="pending-empty"
          >
            <Inbox className="h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="mt-1 text-sm font-medium">Ничего не ждёт вашего решения</p>
            {/* COPY-M-6 (fix-round 3): the old subline repeated «вашего
                решения» one line below the heading, then explained «ничего не
                ждёт» through «когда будет ждать» — a ring that says nothing
                when deleted. «документы на подпись» was also a third name for
                the contract on one screen, and /documents is a different
                section entirely; the three nouns now match the three sections
                this screen actually has. */}
            <p className="max-w-xs text-xs text-muted-foreground">
              Новые проекты, доли и контракты появятся здесь.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {visibleMine.length > 0 && (
              <section className="space-y-3" aria-labelledby="pending-mine-heading">
                <h2
                  id="pending-mine-heading"
                  tabIndex={-1}
                  className="text-base font-semibold tracking-tight"
                >
                  Ждут вашего решения
                </h2>
                <div className="space-y-4">
                  {KIND_SECTIONS.map(({ kind, title, icon }) => (
                    <PendingKindSection
                      key={kind}
                      title={title}
                      icon={icon}
                      items={visibleMine.filter((i) => i.kind === kind)}
                      zone="mine"
                      onActed={(i) => handleActed(i, 'mine')}
                    />
                  ))}
                  <PendingKindSection
                    title="Другое"
                    icon={HelpCircle}
                    items={visibleMine.filter((i) => !KIND_SECTIONS.some((s) => s.kind === i.kind))}
                    zone="mine"
                    // Stryker disable next-line ArrowFunction: dead by design, not merely untested — AC6 ("не гадает" at unrecognized kinds) means `PendingItemRow.renderActions`'s fallback for an unrecognized kind renders ONLY `OpenLink` (never approve/reject/cancel), and `OpenLink` never calls `onActed`. This wiring exists for structural parity with the other `PendingKindSection` call sites, but nothing in this bucket can ever invoke it.
                    onActed={(i) => handleActed(i, 'mine')}
                  />
                </div>
              </section>
            )}

            {visibleOther.length > 0 && (
              <section className="space-y-3" aria-labelledby="pending-others-heading">
                <h2
                  id="pending-others-heading"
                  tabIndex={-1}
                  className="text-base font-semibold tracking-tight"
                >
                  Ждут решения других
                </h2>
                <div className="space-y-4">
                  {/* CONTRACT_TO_SIGN can never appear in proposedByMe (§2
                      врезка задания — it isn't an `approvals` row at all) —
                      no Контракты sub-section rendered here on purpose. */}
                  {KIND_SECTIONS.filter((s) => s.kind !== 'CONTRACT_TO_SIGN').map(
                    ({ kind, title, icon }) => (
                      <PendingKindSection
                        key={kind}
                        title={title}
                        icon={icon}
                        items={visibleOther.filter((i) => i.kind === kind)}
                        zone="proposedByMe"
                        onActed={(i) => handleActed(i, 'proposedByMe')}
                      />
                    ),
                  )}
                  <PendingKindSection
                    title="Другое"
                    icon={HelpCircle}
                    items={visibleOther.filter(
                      (i) => !KIND_SECTIONS.some((s) => s.kind === i.kind),
                    )}
                    zone="proposedByMe"
                    // Stryker disable next-line ArrowFunction: same as the mine-zone «Другое» block above — dead by design, not merely untested. See that directive's comment for the full reasoning.
                    onActed={(i) => handleActed(i, 'proposedByMe')}
                  />
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
