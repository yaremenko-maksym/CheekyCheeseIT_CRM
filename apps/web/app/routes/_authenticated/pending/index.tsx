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
import { usePendingItems, type PendingItem, type PendingItemKind } from '@/hooks/use-pending-items'

export const Route = createFileRoute('/_authenticated/pending/')({
  component: PendingPage,
})

/** Composite key — `subjectId` alone isn't unique across kinds (a project id
 * and a PROJECT_SENIOR_SHARE subjectId are different id spaces, but nothing
 * stops them colliding by chance). */
function itemKey(item: PendingItem): string {
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

function PendingPage() {
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
      return next.size === prev.size ? prev : next
    })
    // Deliberately keyed on `dataUpdatedAt` (an actual refetch), not on
    // `mine`/`proposedByMe` (a brand-new array identity every render) — same
    // precedent as PendingProjectApprovalsPanel.tsx (react-hooks/exhaustive-deps
    // is not configured in this project's eslint).
  }, [dataUpdatedAt])

  const visibleMine = mine.filter((i) => !dismissed.has(itemKey(i)))
  const visibleOther = proposedByMe.filter((i) => !dismissed.has(itemKey(i)))

  function handleActed(item: PendingItem) {
    setDismissed((prev) => new Set(prev).add(itemKey(item)))
  }

  if (isLoading) {
    return (
      <div data-testid="pending-page" className="flex h-full flex-col">
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
      <div data-testid="pending-page" className="flex h-full flex-col">
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-5 text-center"
          data-testid="pending-error"
        >
          <p className="text-sm text-destructive">Не удалось загрузить список.</p>
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
    <div data-testid="pending-page" className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6 lg:max-w-6xl lg:px-8">
        {isEmpty ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-1 text-center"
            data-testid="pending-empty"
          >
            <Inbox className="h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="mt-1 text-sm font-medium">Ничего не ждёт вашего решения</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Новые проекты, доли и документы на подпись появятся здесь, как только кто-то будет
              ждать вашего решения.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {visibleMine.length > 0 && (
              <section className="space-y-3" aria-labelledby="pending-mine-heading">
                <h2 id="pending-mine-heading" className="text-base font-semibold tracking-tight">
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
                      onActed={handleActed}
                    />
                  ))}
                  <PendingKindSection
                    title="Другое"
                    icon={HelpCircle}
                    items={visibleMine.filter((i) => !KIND_SECTIONS.some((s) => s.kind === i.kind))}
                    zone="mine"
                    onActed={handleActed}
                  />
                </div>
              </section>
            )}

            {visibleOther.length > 0 && (
              <section className="space-y-3" aria-labelledby="pending-others-heading">
                <h2 id="pending-others-heading" className="text-base font-semibold tracking-tight">
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
                        onActed={handleActed}
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
                    onActed={handleActed}
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
