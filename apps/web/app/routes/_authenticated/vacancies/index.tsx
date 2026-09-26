/**
 * /vacancies — task-crm-vacancies-ui §4.1. List of vacancies (ADMIN | HR):
 * status-filter SegmentedToggle, grid of VacancyCard, «Create vacancy» →
 * VacancySheet (also reused for per-card «Edit»).
 *
 * No page-level h1/h2 title — matches the established convention across the
 * redesigned CRM pages (project_page_titles_removed: the sidebar nav item
 * already says «Vacancies»; see /projects, /team for the same header shape).
 */
import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import { Briefcase, Plus } from 'lucide-react'
import type { Vacancy, VacancyStatus } from '@crm/shared'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { useVacancies } from '@/hooks/use-vacancies'
import { PageHeader } from '@/components/crm/StickyPageHeader'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { VacancyCard } from './components/VacancyCard'
import { VacancySheet } from './components/VacancySheet'

export const Route = createFileRoute('/_authenticated/vacancies/')({
  component: VacanciesListPage,
})

type StatusFilter = 'ALL' | VacancyStatus

// Exported (in addition to the default route `Route`) so the RBAC-guard test
// can mount this page directly without a full router — same convention as
// `ProjectEditFields` in `projects/$projectId.tsx`.
export function VacanciesListPage() {
  const { t } = useLingui()
  const { denied } = useRoleGuard(['ADMIN', 'HR'])

  const { data: vacancies, isLoading } = useVacancies()
  const [filter, setFilter] = useState<StatusFilter>('ALL')
  const [sheetVacancy, setSheetVacancy] = useState<Vacancy | null | undefined>(undefined)

  const counts = useMemo(() => {
    const list = vacancies ?? []
    return {
      ALL: list.length,
      DRAFT: list.filter((v) => v.status === 'DRAFT').length,
      PUBLISHED: list.filter((v) => v.status === 'PUBLISHED').length,
      CLOSED: list.filter((v) => v.status === 'CLOSED').length,
    }
  }, [vacancies])

  const filtered = useMemo(() => {
    const list = vacancies ?? []
    if (filter === 'ALL') return list
    return list.filter((v) => v.status === filter)
  }, [vacancies, filter])

  // task-i18n-stage3c-pr2 (COPY-L-proj-20 canon) — one counter format
  // everywhere: «Усі (N)» (parentheses carry over to any language unchanged).
  const filterOptions: ReadonlyArray<SegmentedToggleOption<StatusFilter>> = [
    { value: 'ALL', label: t`Усі (${counts.ALL})` },
    { value: 'PUBLISHED', label: t`Опубліковані (${counts.PUBLISHED})` },
    { value: 'DRAFT', label: t`Чернетки (${counts.DRAFT})` },
    { value: 'CLOSED', label: t`Закриті (${counts.CLOSED})` },
  ]

  // Mobile macet (design-mobile.png) itself abbreviates these labels
  // («Усі 8» / «Опубл. 2» / «Чернетки») — 4 full-length labels in one
  // `grid-cols-4` row wrap and collide at <640px (confirmed live).
  const filterOptionsMobile: ReadonlyArray<SegmentedToggleOption<StatusFilter>> = [
    { value: 'ALL', label: t`Усі (${counts.ALL})` },
    { value: 'PUBLISHED', label: t`Опубл. (${counts.PUBLISHED})` },
    { value: 'DRAFT', label: t`Черн. (${counts.DRAFT})` },
    { value: 'CLOSED', label: t`Закр. (${counts.CLOSED})` },
  ]

  // Rules of Hooks: moved here — after every hook above — instead of being
  // the very first statement, before `useVacancies`/`useState`/`useMemo`.
  // `denied` flips false→true mid-mount once `useAuth`'s `isLoading`
  // (inside `useRoleGuard`) resolves to a disallowed role; a guard sitting
  // before other hooks made that transition change the hook count between
  // renders ("Rendered fewer hooks than expected"). This route is also
  // gated at the layout level (see use-role-guard.ts), so this remains
  // defense-in-depth, not the only guard.
  if (denied) return null

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader>
          <div className="flex items-center justify-between">
            <div />
            <Skeleton className="h-10 w-44" />
          </div>
          <Skeleton className="h-11 w-80" />
        </PageHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="vacancies-page">
      <PageHeader>
        <div className="flex items-center justify-between">
          <div />
          <Button
            size="sm"
            onClick={() => setSheetVacancy(null)}
            data-testid="vacancy-create-button"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">
              <Trans>Створити вакансію</Trans>
            </span>
            <span className="sm:hidden">
              <Trans>Створити</Trans>
            </span>
          </Button>
        </div>

        {/* Two variants, swapped by breakpoint (not just width) — see
           filterOptionsMobile comment above for why the labels themselves
           differ, not just the container width. */}
        <SegmentedToggle<StatusFilter>
          value={filter}
          onChange={setFilter}
          options={filterOptionsMobile}
          ariaLabel={t`Фільтр вакансій за статусом`}
          variant="tabs"
          size="sm"
          layoutId="vacancies-status-filter-mobile"
          className="w-full sm:hidden"
          testId="vacancies-status-filter-mobile"
        />
        <SegmentedToggle<StatusFilter>
          value={filter}
          onChange={setFilter}
          options={filterOptions}
          ariaLabel={t`Фільтр вакансій за статусом`}
          variant="tabs"
          size="sm"
          layoutId="vacancies-status-filter"
          className="hidden w-fit sm:grid"
          testId="vacancies-status-filter"
        />
      </PageHeader>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
            data-testid="vacancies-empty-state"
          >
            <div className="flex h-[72px] w-[72px] items-center justify-center rounded-2xl bg-secondary">
              <Briefcase className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-medium">
              {vacancies && vacancies.length > 0 ? (
                <Trans>Немає вакансій із таким статусом</Trans>
              ) : (
                <Trans>Поки немає вакансій</Trans>
              )}
            </p>
            {(!vacancies || vacancies.length === 0) && (
              <>
                <p className="mt-1 text-xs text-muted-foreground max-w-md">
                  <Trans>
                    Створіть першу вакансію, щоб почати приймати відгуки кандидатів. Вона з’явиться
                    в розділі «Вакансії» на сайті після публікації.
                  </Trans>
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setSheetVacancy(null)}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  <Trans>Створити першу вакансію</Trans>
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2" data-testid="vacancies-list">
            {filtered.map((vacancy) => (
              <VacancyCard key={vacancy.id} vacancy={vacancy} onEdit={setSheetVacancy} />
            ))}
          </div>
        )}
      </div>

      <VacancySheet
        vacancy={sheetVacancy ?? null}
        open={sheetVacancy !== undefined}
        onClose={() => setSheetVacancy(undefined)}
      />
    </div>
  )
}
