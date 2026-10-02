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
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
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
  title: MessageDescriptor
  icon: typeof Briefcase
}> = [
  { kind: 'PROJECT_APPROVAL', title: msg`Проєкти`, icon: Briefcase },
  { kind: 'SHARE_APPROVAL', title: msg`Частки`, icon: DollarSign },
  { kind: 'CONTRACT_TO_SIGN', title: msg`Контракти`, icon: FileSignature },
]

// task-i18n-stage3e-pr4: a `msg` descriptor, not a string. `sectionTitleOf`
// is only ever compared by reference against another call to itself
// (`handleActed`'s grouping) — each descriptor is created once at module
// load, so identity equals «same section» exactly as the equal strings did.
// The VISIBLE «Інше» heading text is resolved from this same descriptor at
// render (`i18n._(OTHER_SECTION_TITLE)`), covered by the AC6 grouping test.
const OTHER_SECTION_TITLE: MessageDescriptor = msg`Інше`

/** Which section a row is rendered in — the same grouping the JSX below
 * applies, extracted so the focus chain asks the question once. */
function sectionTitleOf(item: PendingItemOrUnknown): MessageDescriptor {
  return KIND_SECTIONS.find((s) => s.kind === item.kind)?.title ?? OTHER_SECTION_TITLE
}

/**
 * task-i18n-stage2-task8: the `kind`-based counterpart of `sectionTitleOf`
 * — used ONLY for the testid-selector half of the focus chain (§12), which
 * must stay stable across locales. `sectionTitleOf` keeps doing the
 * grouping (`handleActed`'s `sectionTitleOf(i) === sectionTitleOf(item)`)
 * and the VISIBLE heading text — neither of those is a selector.
 */
function sectionKindOf(item: PendingItemOrUnknown): PendingItemKind | 'OTHER' {
  return KIND_SECTIONS.find((s) => s.kind === item.kind)?.kind ?? 'OTHER'
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
    `[data-testid="pending-kind-heading-${zone}-${sectionKindOf(acted)}"]`,
    zone === 'mine' ? '#pending-mine-heading' : '#pending-others-heading',
    '[data-testid="pending-page"]',
  ]
}

// Exported (not module-private) for __tests__/index.test.tsx — same
// precedent as $projectId.tsx's PendingShareApprovalBanner: the alternative
// is mounting the route through a full TanStack Router tree to read this
// page's own empty/loading/error states.
export function PendingPage() {
  const { t, i18n } = useLingui()
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
          {/* COPY-L-2 (fix-round 3): this screen calls itself «рішення»
              everywhere — nav item, both headings, the empty state — and
              «список» appeared exactly once, at the moment the reader least
              understands what broke. The dashboard widget names the thing
              too («Не вдалося перевірити, чи чекає на вас рішення щодо
              проєкту»). */}
          <p className="text-sm text-destructive">{t`Не вдалося завантажити, що чекає на рішення`}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            aria-label={t`Повторити завантаження`}
          >
            {t`Повторити`}
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
            <p className="mt-1 text-sm font-medium">{t`Нічого не чекає на ваше рішення`}</p>
            {/* COPY-M-6 (fix-round 3): the old subline repeated «вашого
                рішення» one line below the heading, then explained «нічого не
                чекає» through «коли буде чекати» — a ring that says nothing
                when deleted. «документи на підпис» was also a third name for
                the contract on one screen, and /documents is a different
                section entirely; the three nouns now match the three sections
                this screen actually has. */}
            <p className="max-w-xs text-xs text-muted-foreground">
              {t`Нові проєкти, частки та контракти з’являться тут`}
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
                  {t`Очікують вашого рішення`}
                </h2>
                <div className="space-y-4">
                  {KIND_SECTIONS.map(({ kind, title, icon }) => (
                    <PendingKindSection
                      key={kind}
                      kind={kind}
                      title={i18n._(title)}
                      icon={icon}
                      items={visibleMine.filter((i) => i.kind === kind)}
                      zone="mine"
                      onActed={(i) => handleActed(i, 'mine')}
                    />
                  ))}
                  <PendingKindSection
                    kind="OTHER"
                    title={i18n._(OTHER_SECTION_TITLE)}
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
                  {t`Очікують рішення інших`}
                </h2>
                <div className="space-y-4">
                  {/* CONTRACT_TO_SIGN can never appear in proposedByMe (§2
                      task insert — it isn't an `approvals` row at all) —
                      no Contracts sub-section rendered here on purpose. */}
                  {KIND_SECTIONS.filter((s) => s.kind !== 'CONTRACT_TO_SIGN').map(
                    ({ kind, title, icon }) => (
                      <PendingKindSection
                        key={kind}
                        kind={kind}
                        title={i18n._(title)}
                        icon={icon}
                        items={visibleOther.filter((i) => i.kind === kind)}
                        zone="proposedByMe"
                        onActed={(i) => handleActed(i, 'proposedByMe')}
                      />
                    ),
                  )}
                  <PendingKindSection
                    kind="OTHER"
                    title={i18n._(OTHER_SECTION_TITLE)}
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
