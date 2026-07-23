/**
 * /vacancies/$vacancyId — task-crm-vacancies-ui §4.3. Detail page: header
 * (back link, title, status badge, status/site actions), tag row, tabs
 * («Детали» inline-edit form / «Отклики» candidate list).
 *
 * §4.3 wants an INLINE edit form here (NOT a Sheet, unlike the list page's
 * «Редактировать» button) — reuses the SAME `VacancyFormFields` as
 * `VacancySheet` (golden rule #8, no duplicated field JSX).
 *
 * Hooks-order safety: ALL hooks (useForm/useState/useEffect/queries) are
 * called BEFORE the `isLoading`/`vacancy === null` early returns — the
 * loading state flips within a single mount (unlike the `denied` guard,
 * which resolves once at navigation time), so putting a hook after those
 * checks would change hook count across renders of the SAME instance
 * (the exact class of bug from project_ui_perf_pass — Rules-of-Hooks crash
 * caught only by a live Mode B pass, not by unit/CI).
 */
import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { z } from 'zod'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ArrowLeft, ArrowUp, Globe, RotateCcw, Users, X } from 'lucide-react'
import type { CreateVacancy, VacancyApplicationStatus } from '@crm/shared'
import { createVacancySchema } from '@crm/shared'
import { useRoleGuard } from '@/hooks/use-role-guard'
import {
  useDeleteVacancy,
  useUpdateVacancy,
  useVacancy,
  useVacancyApplications,
} from '@/hooks/use-vacancies'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedTabs } from '@/components/ui/animated-tabs'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { DeleteVacancyButton } from './components/VacancyCard'
import { CandidateCard } from './components/CandidateCard'
import { VacancyFormFields } from './components/VacancyFormFields'
import {
  APPLICATION_STATUS_LABELS,
  DOMAIN_DOT_COLOR,
  DOMAIN_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  SENIORITY_LABELS,
  VACANCY_STATUS_BADGE,
  VACANCY_STATUS_LABELS,
} from './constants'

// §4.3: the landing /careers page lives on a separate Vite app/domain
// (apps/landing, cheekycheese.tech) — no shared route tree with apps/web.
// Same env-override convention as VITE_API_URL (lib/axios.ts).
const LANDING_URL = import.meta.env['VITE_LANDING_URL'] ?? 'https://cheekycheese.tech'

const detailSearchSchema = z.object({
  tab: z.enum(['details', 'applications']).optional(),
})

export const Route = createFileRoute('/_authenticated/vacancies/$vacancyId')({
  validateSearch: (search) => detailSearchSchema.parse(search),
  component: VacancyDetailPage,
})

type ApplicationsFilter = 'ALL' | VacancyApplicationStatus

function emptyFormValues(): CreateVacancy {
  return {
    title: '',
    slug: '',
    descriptionMd: '',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: '',
  }
}

function VacancyDetailPage() {
  const { denied } = useRoleGuard(['ADMIN', 'HR'])
  const { vacancyId } = Route.useParams()
  const search = Route.useSearch()
  if (denied) return null

  const { data: vacancy, isLoading } = useVacancy(vacancyId)
  const applicationsQuery = useVacancyApplications(vacancyId)
  const updateMutation = useUpdateVacancy()
  const deleteMutation = useDeleteVacancy()

  const [activeTab, setActiveTab] = useState<'details' | 'applications'>(
    search.tab === 'applications' ? 'applications' : 'details',
  )
  const [applicationsFilter, setApplicationsFilter] = useState<ApplicationsFilter>('ALL')
  // Never auto-links on the detail page — the vacancy already has a live
  // slug; typing in "Название" here must not silently rewrite it.
  const [slugAutoLinked, setSlugAutoLinked] = useState(false)

  const form = useForm({
    defaultValues: vacancy
      ? {
          title: vacancy.title,
          slug: vacancy.slug,
          descriptionMd: vacancy.descriptionMd,
          domain: vacancy.domain,
          seniority: vacancy.seniority,
          employmentType: vacancy.employmentType,
          location: vacancy.location,
        }
      : emptyFormValues(),
    onSubmit: async ({ value }) => {
      if (!vacancy) return
      const dto: CreateVacancy = {
        title: value.title.trim(),
        slug: value.slug.trim(),
        descriptionMd: value.descriptionMd,
        domain: value.domain,
        seniority: value.seniority,
        employmentType: value.employmentType,
        location: value.location.trim(),
      }
      const parsed = createVacancySchema.safeParse(dto)
      if (!parsed.success) return
      await updateMutation.mutateAsync({ id: vacancy.id, dto: parsed.data })
    },
  })

  // Re-seed the inline form once the vacancy loads / changes — `useForm`'s
  // `defaultValues` only apply at mount, and on first render `vacancy` is
  // still `undefined` while the query resolves.
  useEffect(() => {
    if (vacancy) {
      form.reset({
        title: vacancy.title,
        slug: vacancy.slug,
        descriptionMd: vacancy.descriptionMd,
        domain: vacancy.domain,
        seniority: vacancy.seniority,
        employmentType: vacancy.employmentType,
        location: vacancy.location,
      })
    }
    // Keyed on vacancy?.id only — re-running on every refetch would clobber in-progress edits.
  }, [vacancy?.id])

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 px-6 pt-4 pb-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-7 w-64" />
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    )
  }

  if (!vacancy) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          data-testid="vacancy-not-found"
        >
          <p className="text-sm font-medium">Вакансия не найдена</p>
          <Button asChild size="sm" variant="outline" className="mt-4">
            <Link to="/vacancies">Ко всем вакансиям</Link>
          </Button>
        </div>
      </div>
    )
  }

  const canDelete = vacancy.status === 'DRAFT' && vacancy.applicationsCount === 0
  const deleteTooltip =
    vacancy.status === 'DRAFT'
      ? 'Нельзя удалить вакансию с откликами'
      : 'Удалить можно только вакансию в статусе DRAFT'
  const statusBadge = VACANCY_STATUS_BADGE[vacancy.status]
  const dotColor = DOMAIN_DOT_COLOR[vacancy.domain]

  const applications = applicationsQuery.data ?? []
  const newCount = applications.filter((a) => a.status === 'NEW').length
  const filteredApplications =
    applicationsFilter === 'ALL'
      ? applications
      : applications.filter((a) => a.status === applicationsFilter)

  const applicationsFilterOptions: ReadonlyArray<SegmentedToggleOption<ApplicationsFilter>> = [
    { value: 'ALL', label: `Все ${applications.length}` },
    { value: 'NEW', label: `Новые ${newCount}` },
    { value: 'VIEWED', label: APPLICATION_STATUS_LABELS.VIEWED },
    { value: 'REJECTED', label: APPLICATION_STATUS_LABELS.REJECTED },
  ]

  // Mobile variant (design-fidelity fix, ui-ux-designer Mode D, PR #396 review):
  // at 320px the 4 equal grid columns give each option ~66px — «Просмотрено»/
  // «Отклонено» (9-11 chars) don't fit and, with no wrap/truncate on the label
  // span, visually overlap the neighbouring column instead of shrinking. Same
  // fix already applied to the vacancy-list status filter (`filterOptionsMobile`
  // in `../index.tsx`) — mirror that convention here instead of touching the
  // shared `SegmentedToggle` primitive (narrower blast radius for a
  // single-screen fix; see PR #396 fidelity review).
  const applicationsFilterOptionsMobile: ReadonlyArray<SegmentedToggleOption<ApplicationsFilter>> =
    [
      { value: 'ALL', label: `Все ${applications.length}` },
      { value: 'NEW', label: `Новые ${newCount}` },
      { value: 'VIEWED', label: 'Просм.' },
      { value: 'REJECTED', label: 'Откл.' },
    ]

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5 px-6 pt-4 pb-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Button
            asChild
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            data-testid="back-button"
          >
            <Link to="/vacancies" aria-label="Все вакансии">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-pretty">{vacancy.title}</h1>
              <Badge
                variant={statusBadge.variant}
                className={statusBadge.className}
                data-testid="vacancy-detail-status-badge"
              >
                {VACANCY_STATUS_LABELS[vacancy.status]}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="gap-1.5">
                {dotColor && (
                  <span
                    aria-hidden
                    className="h-[6px] w-[6px] rounded-full"
                    style={{ backgroundColor: dotColor }}
                  />
                )}
                {DOMAIN_LABELS[vacancy.domain]}
              </Badge>
              <Badge variant="secondary">{SENIORITY_LABELS[vacancy.seniority]}</Badge>
              <Badge variant="secondary">{EMPLOYMENT_TYPE_LABELS[vacancy.employmentType]}</Badge>
              <span className="text-xs text-muted-foreground">{vacancy.location}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {(vacancy.status === 'PUBLISHED' || vacancy.status === 'CLOSED') && (
            <Button asChild size="sm" variant="outline">
              <a
                href={`${LANDING_URL}/careers/${vacancy.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="vacancy-view-on-site"
              >
                <Globe className="mr-1.5 h-3.5 w-3.5" />
                На сайте
              </a>
            </Button>
          )}
          {vacancy.status === 'PUBLISHED' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateMutation.mutate({ id: vacancy.id, dto: { status: 'CLOSED' } })}
              disabled={updateMutation.isPending}
              data-testid="vacancy-detail-close"
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Закрыть вакансию
            </Button>
          )}
          {vacancy.status === 'CLOSED' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
              }
              disabled={updateMutation.isPending}
              data-testid="vacancy-detail-reopen"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Восстановить
            </Button>
          )}
        </div>
      </div>

      <AnimatedTabs
        tabs={[
          { value: 'details', label: 'Детали' },
          {
            value: 'applications',
            label: `Отклики${vacancy.applicationsCount ? ` · ${vacancy.applicationsCount}` : ''}`,
          },
        ]}
        value={activeTab}
        onChange={(v) => setActiveTab(v as 'details' | 'applications')}
      />

      {activeTab === 'details' && (
        <div className="flex flex-col gap-[22px] lg:flex-row">
          <Card className="flex-1 lg:min-w-[420px]">
            <CardContent className="p-4 space-y-4">
              <h2 className="text-sm font-semibold">Общая информация</h2>
              <VacancyFormFields
                form={form}
                slugAutoLinked={slugAutoLinked}
                onSlugAutoLinkedChange={setSlugAutoLinked}
              />
              <div className="flex items-center gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    form.reset({
                      title: vacancy.title,
                      slug: vacancy.slug,
                      descriptionMd: vacancy.descriptionMd,
                      domain: vacancy.domain,
                      seniority: vacancy.seniority,
                      employmentType: vacancy.employmentType,
                      location: vacancy.location,
                    })
                  }
                  data-testid="vacancy-edit-cancel"
                >
                  Отмена
                </Button>
                <Button
                  onClick={() => void form.handleSubmit()}
                  disabled={updateMutation.isPending}
                  data-testid="vacancy-edit-submit"
                >
                  Сохранить изменения
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-[22px] lg:w-[308px] lg:shrink-0">
            <Card>
              <CardContent className="p-4 space-y-2">
                <h2 className="text-sm font-semibold">Статус</h2>
                <Badge variant={statusBadge.variant} className={statusBadge.className}>
                  {VACANCY_STATUS_LABELS[vacancy.status]}
                </Badge>
                {vacancy.status === 'DRAFT' && (
                  <Button
                    size="sm"
                    className="w-full mt-2"
                    onClick={() =>
                      updateMutation.mutate({ id: vacancy.id, dto: { status: 'PUBLISHED' } })
                    }
                    disabled={updateMutation.isPending}
                    data-testid="vacancy-detail-publish"
                  >
                    <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
                    Опубликовать
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-2">
                <h2 className="text-sm font-semibold">Статистика</h2>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  <span>Откликов: {vacancy.applicationsCount}</span>
                  {newCount > 0 && <Badge>{newCount}</Badge>}
                </div>
                <Separator />
                <p className="text-xs text-muted-foreground">
                  Создано: {format(new Date(vacancy.createdAt), 'd MMM yyyy', { locale: ru })}
                </p>
                <p className="text-xs text-muted-foreground">
                  Опубликовано:{' '}
                  {vacancy.publishedAt
                    ? format(new Date(vacancy.publishedAt), 'd MMM yyyy', { locale: ru })
                    : '—'}
                </p>
              </CardContent>
            </Card>

            <Card className="border-destructive/30">
              <CardContent className="p-4 space-y-2">
                <h2 className="text-sm font-semibold text-destructive">Опасная зона</h2>
                <DeleteVacancyButton
                  vacancy={vacancy}
                  canDelete={canDelete}
                  tooltip={deleteTooltip}
                  onDelete={() => deleteMutation.mutate(vacancy.id)}
                  isPending={deleteMutation.isPending}
                  variant="full"
                />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'applications' && (
        <div className="space-y-4">
          {/* Two variants, swapped by breakpoint — see applicationsFilterOptionsMobile
             comment above for why the labels themselves differ, not just the
             container width (mirrors the vacancy-list filter in ../index.tsx). */}
          <SegmentedToggle<ApplicationsFilter>
            value={applicationsFilter}
            onChange={setApplicationsFilter}
            options={applicationsFilterOptionsMobile}
            ariaLabel="Фильтр откликов по статусу"
            variant="tabs"
            size="sm"
            layoutId="applications-status-filter-mobile"
            className="w-full sm:hidden"
            testId="applications-status-filter-mobile"
          />
          <SegmentedToggle<ApplicationsFilter>
            value={applicationsFilter}
            onChange={setApplicationsFilter}
            options={applicationsFilterOptions}
            ariaLabel="Фильтр откликов по статусу"
            variant="tabs"
            size="sm"
            layoutId="applications-status-filter"
            className="hidden w-fit sm:grid"
            testId="applications-status-filter"
          />

          {applicationsQuery.isLoading ? (
            <div className="space-y-3 max-w-[768px]">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-xl" />
              ))}
            </div>
          ) : filteredApplications.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
              data-testid="applications-empty-state"
            >
              <Users className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-4 text-sm font-medium">
                {applications.length === 0 ? 'Пока нет откликов' : 'Нет откликов с таким статусом'}
              </p>
              {applications.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground max-w-md">
                  Кандидаты появятся здесь, как только отправят заявку через страницу карьеры.
                </p>
              )}
              {applications.length === 0 &&
                (vacancy.status === 'PUBLISHED' || vacancy.status === 'CLOSED') && (
                  <Button asChild size="sm" variant="outline" className="mt-4">
                    <a
                      href={`${LANDING_URL}/careers/${vacancy.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Посмотреть на сайте
                    </a>
                  </Button>
                )}
            </div>
          ) : (
            <div className="space-y-4 max-w-[768px]" data-testid="applications-list">
              {filteredApplications.map((application) => (
                <CandidateCard
                  key={application.id}
                  vacancyId={vacancy.id}
                  application={application}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
