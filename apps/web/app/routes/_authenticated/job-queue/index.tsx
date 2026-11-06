/**
 * /job-queue — r5 Task 7.2. The external vacancy queue (ADMIN | HR): status tabs with authorized
 * counts, search + bounded filters (URL state, applied explicitly), the infinite-scroll list,
 * the HR team switcher and the refresh / partial / access-lost notices. Opening a row writes
 * `?card=<id>`; the card itself is Task 7.3. Layout and copy: docs/design/vacancy-queue.md.
 */
import { useRef, useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, RefreshCw, Search, X } from 'lucide-react'
import { z } from 'zod'
import {
  jobAvailabilitySchema,
  jobQueueEligibilitySchema,
  jobQueueTabSchema,
  jobSourceTypeSchema,
  type JobQueueTab,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { useActiveTeams } from '@/hooks/use-active-team'
import { useJobQueue, type QueueScopeSignature } from '@/hooks/use-job-queue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { JobQueueStatusTabs } from '@/components/job-queue/JobQueueStatusTabs'
import { JobQueueList, StateBlock } from '@/components/job-queue/JobQueueList'
import { TeamSwitcher } from '@/components/job-queue/TeamSwitcher'
import {
  JobQueueAppliedFilters,
  JobQueueFilters,
  appliedFilterCount,
  type JobQueueFilterValue,
} from '@/components/job-queue/JobQueueFilters'

// Every param degrades to its default on a bad value (`.catch`) — a hand-edited URL never 500s the page.
const searchSchema = z.object({
  tab: jobQueueTabSchema.catch('NEW').default('NEW'),
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  source: z.array(jobSourceTypeSchema).min(1).optional().catch(undefined),
  eligibility: z.array(jobQueueEligibilitySchema).min(1).optional().catch(undefined),
  availability: z.array(jobAvailabilitySchema).min(1).optional().catch(undefined),
  teamId: z.string().uuid().optional().catch(undefined),
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
  const { teams, isError: teamsFailed, refetch: refetchTeams } = useActiveTeams()
  const search = Route.useSearch()
  // the retry button unmounts on click (error block becomes the skeleton): park focus here
  const bodyRef = useRef<HTMLDivElement>(null)
  // state, not a ref: the sentinel's observer has to rebuild once the scroller exists
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)

  if (denied || !user || (user.role !== 'ADMIN' && user.role !== 'HR')) return null

  let body
  if (user.role === 'ADMIN') {
    body = (
      <QueueBody
        scope={{ actorId: user.id, role: 'ADMIN', teamId: null }}
        search={search}
        scrollRoot={scrollRoot}
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
    const teamId = teams.some((t) => t.id === search.teamId) ? search.teamId! : teams[0]!.id
    body = (
      <QueueBody
        scope={{ actorId: user.id, role: 'HR', teamId }}
        search={search}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        scrollRoot={scrollRoot}
      />
    )
  }

  return (
    // the authenticated layout's `main` is `overflow-hidden`, so the page scrolls itself
    <div
      ref={setScrollRoot}
      data-testid="job-queue-scroll"
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div
        data-testid="job-queue-page"
        className="@container mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6"
      >
        <h1 className="text-xl font-semibold tracking-tight">
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
  teams,
  scrollRoot,
}: {
  scope: QueueScopeSignature & { role: 'ADMIN' | 'HR' }
  search: QueueSearch
  teams?: ReadonlyArray<{ id: string; name: string }>
  scrollRoot: HTMLElement | null
}) {
  const { t } = useLingui()
  const navigate = useNavigate()
  const filterValue: JobQueueFilterValue = compact({
    source: search.source,
    eligibility: search.eligibility,
    availability: search.availability,
  })
  const filters = compact({ ...filterValue, search: search.search })
  const queue = useJobQueue(scope, search.tab, filters)
  // the box shows the applied search and follows the URL (team switch, back / forward)
  const [draftSearch, setDraftSearch] = useState(search.search ?? '')
  const [appliedSearch, setAppliedSearch] = useState(search.search)
  if (appliedSearch !== search.search) {
    setAppliedSearch(search.search)
    setDraftSearch(search.search ?? '')
  }

  const go = (next: Partial<QueueSearch>) =>
    void navigate({ to: '/job-queue', search: compact(next) })
  const base = { tab: search.tab, teamId: search.teamId }
  const page = queue.data?.pages[0]
  const items = queue.data?.pages.flatMap((p) => p.items)
  const clearSearch = () => go({ ...search, search: undefined })
  const resetFilters = () => go({ ...base, search: search.search })

  function onSearchSubmit(e: FormEvent) {
    e.preventDefault()
    go({ ...search, search: draftSearch.trim() || undefined })
  }

  let notice = null
  if (queue.refreshRequired) {
    notice = (
      <div
        data-testid="job-queue-refresh"
        role="status"
        className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-sm @min-[560px]:flex-row @min-[560px]:items-center"
      >
        <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
        <p className="min-w-0 flex-1 font-medium">
          <Trans>Список змінився</Trans>
        </p>
        <Button variant="outline" className="min-h-11" onClick={() => void queue.restart()}>
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
      {/* below 560 px of content only the team switcher stacks; search + filters keep one row */}
      <div className="flex flex-col gap-2 @min-[560px]:flex-row @min-[560px]:items-center">
        {/* only the HR scope carries a team list, and it always has a team id */}
        {teams && (
          <TeamSwitcher
            teams={teams}
            value={scope.teamId!}
            onChange={(teamId) => go({ tab: search.tab, teamId })}
          />
        )}
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
            onApply={(next) =>
              go({
                ...base,
                search: search.search,
                source: next.source,
                eligibility: next.eligibility,
                availability: next.availability,
              })
            }
          />
        </div>
      </div>

      <JobQueueAppliedFilters value={filterValue} onReset={resetFilters} />

      <JobQueueStatusTabs
        value={search.tab}
        counts={page?.counts ?? null}
        onChange={(tab: JobQueueTab) => go({ ...search, tab, card: undefined })}
      >
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
            onOpen={(card) => go({ ...search, card })}
            onResetFilters={resetFilters}
            onClearSearch={clearSearch}
          />
        )}
      </JobQueueStatusTabs>
    </div>
  )
}
