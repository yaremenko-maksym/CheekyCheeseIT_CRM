/**
 * /vacancies — task-crm-vacancies-ui §4.1. List of vacancies (ADMIN | HR):
 * status-filter SegmentedToggle, grid of VacancyCard, «Создать вакансию» →
 * VacancySheet (also reused for per-card «Редактировать»).
 *
 * No page-level h1/h2 title — matches the established convention across the
 * redesigned CRM pages (project_page_titles_removed: the sidebar nav item
 * already says «Вакансии»; see /projects, /team for the same header shape).
 */
import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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
  const { denied } = useRoleGuard(['ADMIN', 'HR'])
  if (denied) return null

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

  const filterOptions: ReadonlyArray<SegmentedToggleOption<StatusFilter>> = [
    { value: 'ALL', label: `Все ${counts.ALL}` },
    { value: 'PUBLISHED', label: `Опубликованные ${counts.PUBLISHED}` },
    { value: 'DRAFT', label: `Черновики ${counts.DRAFT}` },
    { value: 'CLOSED', label: `Закрытые ${counts.CLOSED}` },
  ]

  // Mobile macet (design-mobile.png) itself abbreviates these labels
  // («Усі 8» / «Опубл. 2» / «Чернетки») — 4 full-length labels in one
  // `grid-cols-4` row wrap and collide at <640px (confirmed live). Same
  // convention, translated to the RU labels this screen actually uses.
  const filterOptionsMobile: ReadonlyArray<SegmentedToggleOption<StatusFilter>> = [
    { value: 'ALL', label: `Все ${counts.ALL}` },
    { value: 'PUBLISHED', label: `Опубл. ${counts.PUBLISHED}` },
    { value: 'DRAFT', label: `Черн. ${counts.DRAFT}` },
    { value: 'CLOSED', label: `Закр. ${counts.CLOSED}` },
  ]

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
            <span className="hidden sm:inline">Создать вакансию</span>
            <span className="sm:hidden">Создать</span>
          </Button>
        </div>

        {/* Two variants, swapped by breakpoint (not just width) — see
           filterOptionsMobile comment above for why the labels themselves
           differ, not just the container width. */}
        <SegmentedToggle<StatusFilter>
          value={filter}
          onChange={setFilter}
          options={filterOptionsMobile}
          ariaLabel="Фильтр вакансий по статусу"
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
          ariaLabel="Фильтр вакансий по статусу"
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
              {vacancies && vacancies.length > 0
                ? 'Нет вакансий с таким статусом'
                : 'Пока нет вакансий'}
            </p>
            {(!vacancies || vacancies.length === 0) && (
              <>
                <p className="mt-1 text-xs text-muted-foreground max-w-md">
                  Создайте первую вакансию, чтобы начать принимать отклики кандидатов. Она появится
                  на странице карьеры после публикации.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setSheetVacancy(null)}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  Создать первую вакансию
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
