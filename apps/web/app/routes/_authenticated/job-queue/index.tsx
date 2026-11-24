/**
 * /job-queue — r5 Task 7.2. The external vacancy queue (ADMIN | HR): status tabs with authorized
 * counts, search + bounded filters (URL state, applied explicitly), the infinite-scroll list,
 * the refresh / partial / access-lost notices. An HR reads all of their teams at once (no team
 * switch, task-hr-queue-all-teams). Opening a row writes
 * `?card=<id>`, which opens the card (Task 7.3); closing it clears `card`. Layout and copy:
 * docs/design/vacancy-queue.md.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Bookmark, CircleHelp, Plus, RefreshCw, Search, X } from 'lucide-react'
import { z } from 'zod'
import {
  JOB_QUEUE_SALARY_MIN_MONTHLY_MAX,
  JOB_QUEUE_SENIOR_FILTER_MAX,
  jobAvailabilitySchema,
  jobQueueEligibilitySchema,
  jobQueueSalaryCurrencySchema,
  jobQueueSalaryStatedSchema,
  jobQueueTabSchema,
  jobSourceTypeSchema,
  type ExternalVacancyPrefill,
  type JobQueueTab,
  type TeamDto,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { useQuery } from '@tanstack/react-query'
import { TEAMS_QUERY, useActiveTeams } from '@/hooks/use-active-team'
import {
  canonicalSeniorIds,
  useJobQueue,
  useJobQueueSeniorOptions,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { Button } from '@/components/ui/button'
import { JobQueueCard } from '@/components/job-queue/JobQueueCard'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { JobQueueStatusTabs } from '@/components/job-queue/JobQueueStatusTabs'
import { AiLimitsNotice } from '@/components/job-sourcing/AiLimitsNotice'
import { JobQueueList, StateBlock } from '@/components/job-queue/JobQueueList'
import { SourceBudgetPanel } from '@/components/job-sourcing/SourceBudgetPanel'
import { BookmarkletInstallDialog } from '@/components/job-queue/BookmarkletInstallDialog'
import { ExternalSubmissionDialog } from '@/components/job-queue/ExternalSubmissionDialog'
import { ExternalSourcesBlock } from '@/components/job-queue/ExternalSourcesBlock'
import { bookmarkletUsed, takeStashedPrefill } from '@/lib/external-prefill'
import {
  JobQueueAppliedFilters,
  JobQueueFilters,
  appliedFilterCount,
  coherentSalary,
  type JobQueueFilterValue,
} from '@/components/job-queue/JobQueueFilters'

// Every param degrades to its default on a bad value (`.catch`) — a hand-edited URL never 500s the page.
const searchSchema = z.object({
  tab: jobQueueTabSchema.catch('NEW').default('NEW'),
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  source: z.array(jobSourceTypeSchema).min(1).optional().catch(undefined),
  eligibility: z.array(jobQueueEligibilitySchema).min(1).optional().catch(undefined),
  availability: z.array(jobAvailabilitySchema).min(1).optional().catch(undefined),
  // canonical before the bound: a duplicate or a different case never counts toward the limit
  seniorIds: z
    .array(z.string().uuid())
    .min(1)
    .transform(canonicalSeniorIds)
    .pipe(z.array(z.string()).max(JOB_QUEUE_SENIOR_FILTER_MAX))
    .optional()
    .catch(undefined),
  salary: z.array(jobQueueSalaryStatedSchema).min(1).optional().catch(undefined),
  salaryCurrency: jobQueueSalaryCurrencySchema.optional().catch(undefined),
  salaryMinMonthly: z
    .number()
    .int()
    .min(1)
    .max(JOB_QUEUE_SALARY_MIN_MONTHLY_MAX)
    .optional()
    .catch(undefined),
  card: z.string().uuid().optional().catch(undefined),
})
type QueueSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_authenticated/job-queue/')({
  validateSearch: searchSchema,
  component: JobQueuePage,
})

/** Drops `undefined` keys so the URL (and its equality) carries only what is set. */
function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

export function JobQueuePage() {
  const { denied } = useRoleGuard(['ADMIN', 'HR'])
  const { user } = useAuth()
  // a live team of either type (SENIOR or DROP) is a queue scope (owner decision 2026-11-24)
  const { teams, isError: teamsFailed, refetch: refetchTeams } = useActiveTeams()
  // an ADMIN may register for any live team, not only the ones they belong to
  const allTeams = useQuery({ ...TEAMS_QUERY, enabled: user?.role === 'ADMIN' }).data
  const search = Route.useSearch()
  // these buttons unmount on click, so focus parks here: the team-list retry (error block becomes
  // the skeleton) and the two refresh buttons (returnToTop)
  const bodyRef = useRef<HTMLDivElement>(null)
  // state, not a ref: the sentinel's observer has to rebuild once the scroller exists
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const headingId = useId()
  // an HR without a team never mounts the queue, so a stashed hand-off would bounce `/` here forever
  const noTeam = user?.role === 'HR' && teams?.length === 0
  useEffect(() => {
    if (noTeam) takeStashedPrefill()
  }, [noTeam])

  if (denied || !user || (user.role !== 'ADMIN' && user.role !== 'HR')) return null

  // the refresh buttons (list foot and top notice) unmount on click, and the list is replaced from the top
  const returnToTop = () => {
    bodyRef.current!.focus()
    // after the focus, whose own scroll-into-view this overrides
    scrollRoot!.scrollTop = 0
  }

  let body
  if (user.role === 'ADMIN') {
    body = (
      <QueueBody
        scope={{ actorId: user.id, role: 'ADMIN', teamId: null }}
        search={search}
        submissionTeams={allTeams?.filter((t) => !t.archivedAt) ?? []}
        scrollRoot={scrollRoot}
        focusPark={bodyRef}
        onReturnToTop={returnToTop}
      />
    )
  } else if (teams === null) {
    // without the team list there is no scope to load: offer a retry, not an endless skeleton
    body = teamsFailed ? (
      <StateBlock
        testId="job-queue-error"
        role="alert"
        title={<Trans>Не вдалося завантажити чергу</Trans>}
        body={<Trans>Спробуйте ще раз.</Trans>}
      >
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => {
            bodyRef.current!.focus()
            void refetchTeams()
          }}
        >
          <Trans>Спробувати ще раз</Trans>
        </Button>
      </StateBlock>
    ) : (
      <Skeleton
        data-testid="job-queue-loading"
        role="status"
        aria-busy="true"
        className="h-40 w-full"
      >
        <span className="sr-only">
          <Trans>Завантажуємо чергу…</Trans>
        </span>
      </Skeleton>
    )
  } else if (teams.length === 0) {
    body = (
      <div
        data-testid="job-queue-no-team"
        className="rounded-lg border border-dashed px-4 py-10 text-center"
      >
        <p className="font-medium">
          <Trans>Вам не призначено жодної команди</Trans>
        </p>
        <p className="text-sm text-muted-foreground">
          <Trans>Черга з’явиться, коли адміністратор додасть вас до команди.</Trans>
        </p>
      </div>
    )
  } else {
    // every own team at once: with no team id the server reads the union of the HR's teams
    body = (
      <QueueBody
        scope={{ actorId: user.id, role: 'HR', teamId: null }}
        search={search}
        // senior options lack team ids, so we filter by active SENIOR members already loaded in TeamDto.members
        submissionTeams={teams.filter((t) =>
          t.members.some((m) => m.role === 'SENIOR' && !m.leftAt),
        )}
        scrollRoot={scrollRoot}
        focusPark={bodyRef}
        onReturnToTop={returnToTop}
      />
    )
  }

  return (
    // the authenticated layout's `main` is `overflow-hidden`, so the page scrolls itself
    <div
      ref={setScrollRoot}
      data-testid="job-queue-scroll"
      // the only scroller on the page: focusable, or scroll keys do nothing until a row has focus
      tabIndex={0}
      role="region"
      aria-labelledby={headingId}
      className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div
        data-testid="job-queue-page"
        className="@container mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6"
      >
        <h1 id={headingId} className="text-xl font-semibold tracking-tight">
          <Trans>Черга зовнішніх вакансій</Trans>
        </h1>
        <div
          ref={bodyRef}
          tabIndex={-1}
          data-testid="job-queue-body"
          className="flex min-w-0 flex-col gap-4 outline-none"
        >
          {body}
        </div>
      </div>
    </div>
  )
}

function QueueBody({
  scope,
  search,
  submissionTeams,
  scrollRoot,
  focusPark,
  onReturnToTop,
}: {
  scope: QueueScopeSignature & { role: 'ADMIN' | 'HR' }
  search: QueueSearch
  submissionTeams: readonly TeamDto[]
  scrollRoot: HTMLElement | null
  focusPark: RefObject<HTMLDivElement | null>
  onReturnToTop: () => void
}) {
  const { t } = useLingui()
  const navigate = useNavigate()
  // a hand-edited URL with bounds the API refuses is read without them, never sent as a 400
  const filterValue: JobQueueFilterValue = coherentSalary(
    compact({
      source: search.source,
      eligibility: search.eligibility,
      availability: search.availability,
      seniorIds: search.seniorIds,
      salary: search.salary,
      salaryCurrency: search.salaryCurrency,
      salaryMinMonthly: search.salaryMinMonthly,
    }),
  )
  const filters = compact({ ...filterValue, search: search.search })
  const queue = useJobQueue(scope, search.tab, filters)
  const seniorOptions = useJobQueueSeniorOptions(scope)
  // an HR none of whose teams has a senior has nobody to register for
  const canRegister = scope.role === 'ADMIN' || submissionTeams.length > 0
  // the feed links follow the first selected senior, as the submission dialog does
  const feedSenior = seniorOptions.data?.items.find((s) => s.id === search.seniorIds?.[0])
  // the box shows the applied search and follows the URL (back / forward)
  const [draftSearch, setDraftSearch] = useState(search.search ?? '')
  const [appliedSearch, setAppliedSearch] = useState(search.search)
  if (appliedSearch !== search.search) {
    setAppliedSearch(search.search)
    setDraftSearch(search.search ?? '')
  }

  const go = (next: Partial<QueueSearch>) =>
    void navigate({ to: '/job-queue', search: compact(next) })

  // the bookmarklet's payload, stashed at boot (client.tsx); taken once, so a reload does not reopen
  // it. StrictMode calls this initializer twice and keeps the first result (the second take is null).
  const [external, setExternal] = useState<{
    open: boolean
    prefill: ExternalVacancyPrefill | null
  }>(() => {
    const prefill = takeStashedPrefill()
    return { open: prefill !== null, prefill }
  })
  // after the take above, which marks the bookmarklet used: an HR arriving with a payload is not nagged
  const [installOpen, setInstallOpen] = useState(() => scope.role === 'HR' && !bookmarkletUsed())
  const base = { tab: search.tab }
  const page = queue.data?.pages[0]
  const items = queue.data?.pages.flatMap((p) => p.items)
  const clearSearch = () => go({ ...search, search: undefined })
  const resetFilters = () => go({ ...base, search: search.search })

  function onSearchSubmit(e: FormEvent) {
    e.preventDefault()
    go({ ...search, search: draftSearch.trim() || undefined })
  }

  const onRestart = () => {
    onReturnToTop()
    void queue.restart()
  }

  let notice = null
  if (queue.refreshRequired) {
    notice = (
      <div
        data-testid="job-queue-refresh"
        role="status"
        className="flex flex-col gap-2 rounded-lg border border-yellow-muted/40 bg-yellow-subtle p-3 text-sm @min-[560px]:flex-row @min-[560px]:items-center"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="font-medium">
              <Trans>Список змінився</Trans>
            </p>
            <p className="text-foreground/70">
              <Trans>З’явилися оновлення.</Trans>
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          className="min-h-11 border-yellow-muted/40 bg-background"
          onClick={onRestart}
        >
          <Trans>Показати оновлений список</Trans>
        </Button>
      </div>
    )
  } else if (page?.generation?.capped) {
    notice = (
      <p
        data-testid="job-queue-partial"
        className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <Trans>
          Список може бути неповним: показано лише найрелевантніші вакансії. Уточніть пошук або
          фільтри, щоб побачити решту.
        </Trans>
      </p>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* ADMIN only, collapsed: at the top because the list below is infinite and would bury it */}
      <SourceBudgetPanel canView={scope.role === 'ADMIN'} collapsible />
      <div className="flex flex-col gap-2 @min-[560px]:flex-row @min-[560px]:justify-end">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="job-queue-bookmarklet-open"
            className="min-h-11 flex-1 @min-[560px]:flex-none"
            onClick={() => setInstallOpen(true)}
          >
            <Bookmark aria-hidden="true" />
            <Trans>Додати закладку «До CRM»</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="job-queue-bookmarklet-help"
            aria-label={t`Як працює закладка «До CRM»`}
            className="size-11 shrink-0"
            onClick={() => setInstallOpen(true)}
          >
            <CircleHelp aria-hidden="true" />
          </Button>
        </div>
        {canRegister && (
          <Button
            type="button"
            variant="outline"
            data-testid="job-queue-external-open"
            className="min-h-11 w-full @min-[560px]:w-auto"
            onClick={() => setExternal({ open: true, prefill: null })}
          >
            <Plus aria-hidden="true" />
            <Trans>Записати зовнішню подачу</Trans>
          </Button>
        )}
      </div>
      <ExternalSourcesBlock
        // Stryker disable next-line ArrayDeclaration: equivalent, an unknown role builds the same general links
        roles={feedSenior?.technicalRoles ?? []}
        seniorName={feedSenior?.name}
        onRegister={canRegister ? () => setExternal({ open: true, prefill: null }) : undefined}
      />
      <BookmarkletInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
      <ExternalSubmissionDialog
        open={external.open}
        onOpenChange={(open) => setExternal((e) => ({ ...e, open }))}
        scope={scope}
        teams={submissionTeams}
        seniorId={search.seniorIds?.[0]}
        prefill={external.prefill}
        onSubmitted={() => {
          setExternal({ open: false, prefill: null })
          go({ ...search, tab: 'SUBMITTED', card: undefined })
        }}
        onOpenCard={(card) => {
          setExternal({ open: false, prefill: null })
          go({ ...search, card })
        }}
      />
      <div className="flex flex-col gap-2 @min-[560px]:flex-row @min-[560px]:items-center">
        <div data-testid="job-queue-search-row" className="flex min-w-0 flex-1 items-center gap-2">
          <form role="search" onSubmit={onSearchSubmit} className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              enterKeyHint="search"
              data-testid="job-queue-search"
              aria-label={t`Пошук за назвою або компанією`}
              placeholder={t`Назва або компанія`}
              maxLength={200}
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              // the native cancel X would sit under the custom clear button
              className="min-h-11 pl-9 pr-11 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {search.search && (
              <button
                type="button"
                aria-label={t`Очистити пошук`}
                onClick={clearSearch}
                className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted-foreground rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            )}
          </form>
          <JobQueueFilters
            value={filterValue}
            seniors={{
              items: seniorOptions.data?.items,
              isError: seniorOptions.isError,
              onRetry: () => void seniorOptions.refetch(),
            }}
            onApply={(next) =>
              go({
                ...base,
                search: search.search,
                source: next.source,
                eligibility: next.eligibility,
                availability: next.availability,
                seniorIds: next.seniorIds,
                salary: next.salary,
                salaryCurrency: next.salaryCurrency,
                salaryMinMonthly: next.salaryMinMonthly,
              })
            }
          />
        </div>
      </div>

      <JobQueueAppliedFilters
        value={filterValue}
        seniors={seniorOptions.data?.items}
        onReset={resetFilters}
      />

      <JobQueueStatusTabs
        value={search.tab}
        counts={page?.counts ?? null}
        onChange={(tab: JobQueueTab) => go({ ...search, tab, card: undefined })}
      >
        {/* H.8: global state, shown beside (not instead of) the refresh / partial notice */}
        <AiLimitsNotice notice={page?.sourcingNotice} testId="job-queue-ai-limits" />
        {notice}

        {queue.accessLost ? (
          <div
            data-testid="job-queue-access-lost"
            role="alert"
            className="rounded-lg border border-dashed px-4 py-10 text-center"
          >
            <p className="font-medium">
              <Trans>Немає доступу до цієї черги</Trans>
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Можливо, вас вивели з команди. Оновіть сторінку або зверніться до адміністратора.
              </Trans>
            </p>
          </div>
        ) : queue.refreshRequired && !items ? null : (
          <JobQueueList
            items={items}
            // a failed next page / refetch keeps `data` but flips `status` to 'error' (Query v5):
            // loaded rows stay on screen (the list reads `status` only without rows) and the foot
            // shows the append error instead
            status={queue.status}
            tab={search.tab}
            role={scope.role}
            total={page?.counts[search.tab] ?? 0}
            hasSearch={!!search.search}
            hasFilters={appliedFilterCount(filterValue) > 0}
            hasNextPage={queue.hasNextPage}
            isFetching={queue.isFetching}
            isFetchingNextPage={queue.isFetchingNextPage}
            isFetchNextPageError={queue.isFetchNextPageError}
            refreshRequired={queue.refreshRequired}
            scrollRoot={scrollRoot}
            onLoadMore={() => void queue.fetchNextPage()}
            onRetry={() => void queue.refetch()}
            onRestart={onRestart}
            onOpen={(card) => go({ ...search, card })}
            onResetFilters={resetFilters}
            onClearSearch={clearSearch}
          />
        )}
      </JobQueueStatusTabs>
      {search.card && (
        <JobQueueCard
          key={search.card}
          scope={scope}
          opportunityId={search.card}
          onClose={() => go({ ...search, card: undefined })}
          focusFallback={focusPark}
        />
      )}
    </div>
  )
}
