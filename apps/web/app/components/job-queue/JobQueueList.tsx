import { useEffect, useRef, useState, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { JobQueueListItemDto, JobQueueTab } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { JobQueueRow } from './JobQueueRow'

export interface JobQueueListProps {
  items: JobQueueListItemDto[] | undefined
  status: 'pending' | 'error' | 'success'
  tab: JobQueueTab
  role: 'ADMIN' | 'HR'
  /** The authorized count of the current tab (server `counts[tab]`). */
  total: number
  /** A search / filter group is applied — an empty page then means "nothing matched", not "empty queue". */
  hasSearch: boolean
  hasFilters: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  /** The cursor is dead: the page's refresh notice is the only way on, so the foot offers nothing. */
  refreshRequired: boolean
  onLoadMore: () => void
  onRetry: () => void
  onOpen: (opportunityId: string) => void
  onResetFilters: () => void
  onClearSearch: () => void
}

const EMPTY: Record<JobQueueTab, { title: MessageDescriptor; body: MessageDescriptor }> = {
  NEW: {
    title: msg`У черзі немає нових вакансій`,
    body: msg`Нові з’являться після наступного оновлення джерел.`,
  },
  SUBMITTED: {
    title: msg`Ваша команда ще нікого не подала`,
    body: msg`Тут будуть вакансії, на які ваша команда подала сеньйорів.`,
  },
  HIDDEN: {
    title: msg`Немає прихованих вакансій`,
    body: msg`Приховані вакансії можна повернути звідси.`,
  },
}

export function StateBlock({
  testId,
  title,
  body,
  role,
  children,
}: {
  testId: string
  title: ReactNode
  body: ReactNode
  role?: 'alert'
  children?: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      role={role}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center"
    >
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
      {children}
    </div>
  )
}

export function JobQueueList(props: JobQueueListProps) {
  const { i18n } = useLingui()
  const { items, status, tab } = props
  const listRef = useRef<HTMLUListElement>(null)
  // set by a button / keyboard append: the index of the first row to focus once it arrives
  // (Infinity = nothing pending: no list length ever exceeds it)
  const focusFrom = useRef(Infinity)
  const loadMore = useRef(props.onLoadMore)
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)

  // "Завантажено ще N" only for a real append: same first row, longer list. A replaced list resets it.
  const first = items?.[0]?.opportunityId
  const length = items?.length ?? 0
  const [seenFirst, setSeenFirst] = useState(first)
  const [seenLength, setSeenLength] = useState(length)
  // rows added by the last append; 0 (or less, for a shrunk list) = nothing to announce
  const [added, setAdded] = useState(0)
  if (seenFirst !== first || seenLength !== length) {
    setSeenFirst(first)
    setSeenLength(length)
    // an empty list has no first row, so a first page after it never counts as an append
    setAdded(seenFirst === first ? length - seenLength : 0)
  }

  useEffect(() => {
    loadMore.current = props.onLoadMore
  })

  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore.current()
      },
      { rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel])

  // a replaced list (tab / filter / search switch) cancels a pending «Показати ще» focus
  useEffect(() => {
    focusFrom.current = Infinity
  }, [first])

  useEffect(() => {
    const from = focusFrom.current
    if (props.isFetchNextPageError && !props.isFetchingNextPage) {
      focusFrom.current = Infinity
    } else if (length > from) {
      focusFrom.current = Infinity
      // a longer list is always rendered, so the list and the row at `from` both exist
      listRef
        .current!.querySelectorAll<HTMLButtonElement>(':scope > li > button')
        .item(from)
        .focus()
    }
  }, [length, props.isFetchNextPageError, props.isFetchingNextPage])

  // `status` matters only without rows: a failed next page / refetch keeps them on screen
  if (!items) {
    return status === 'pending' ? (
      <div data-testid="job-queue-loading" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">
          <Trans>Завантажуємо чергу…</Trans>
        </span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    ) : (
      <StateBlock
        testId="job-queue-error"
        role="alert"
        title={<Trans>Не вдалося завантажити чергу</Trans>}
        body={<Trans>Спробуйте ще раз.</Trans>}
      >
        <Button variant="outline" className="min-h-11" onClick={props.onRetry}>
          <Trans>Спробувати ще раз</Trans>
        </Button>
      </StateBlock>
    )
  }

  if (items.length === 0) {
    return props.hasSearch || props.hasFilters ? (
      <StateBlock
        testId="job-queue-filtered-empty"
        title={<Trans>Нічого не знайдено</Trans>}
        body={<Trans>Змініть пошук або фільтри.</Trans>}
      >
        <div className="flex flex-wrap justify-center gap-2">
          {props.hasSearch && (
            <Button variant="outline" className="min-h-11" onClick={props.onClearSearch}>
              <Trans>Очистити пошук</Trans>
            </Button>
          )}
          {props.hasFilters && (
            <Button variant="outline" className="min-h-11" onClick={props.onResetFilters}>
              <Trans>Скинути фільтри</Trans>
            </Button>
          )}
        </div>
      </StateBlock>
    ) : (
      <StateBlock
        testId="job-queue-empty"
        title={i18n._(EMPTY[tab].title)}
        body={i18n._(EMPTY[tab].body)}
      />
    )
  }

  const shown = items.length
  const total = props.total
  const armed = props.hasNextPage && !props.isFetchingNextPage && !props.isFetchNextPageError
  const onRetryAppend = () => {
    if (props.isFetchingNextPage) return
    focusFrom.current = shown
    props.onLoadMore()
  }
  return (
    <div className="flex flex-col gap-3">
      <ul
        ref={listRef}
        data-testid="job-queue-list"
        // one outer border, clipped so a hovered row stays inside the rounded corners; rows split by dividers
        className="flex flex-col gap-2 @min-[560px]:gap-0 @min-[560px]:divide-y @min-[560px]:overflow-hidden @min-[560px]:rounded-lg @min-[560px]:border"
      >
        {items.map((item) => (
          <li key={item.opportunityId} className="min-w-0">
            <JobQueueRow item={item} tab={tab} role={props.role} onOpen={props.onOpen} />
          </li>
        ))}
      </ul>
      {!props.refreshRequired && (
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
          {armed && <div ref={setSentinel} data-testid="job-queue-sentinel" aria-hidden="true" />}
          <p data-testid="job-queue-live" aria-live="polite" className="tabular-nums">
            {props.hasNextPage ? (
              <span data-testid="job-queue-shown">
                {added > 0 ? (
                  <Trans>
                    Завантажено ще {added}. Показано {shown} із {total}
                  </Trans>
                ) : (
                  <Trans>
                    Показано {shown} із {total}
                  </Trans>
                )}
              </span>
            ) : (
              <span data-testid="job-queue-end">
                {added > 0 ? (
                  <Trans>
                    Завантажено ще {added}. Усі вакансії показано: {shown}
                  </Trans>
                ) : (
                  <Trans>Усі вакансії показано: {shown}</Trans>
                )}
              </span>
            )}
          </p>
          {/* a retry keeps the query's error flag until it settles; the loading line replaces the alert */}
          {props.hasNextPage && props.isFetchNextPageError && !props.isFetchingNextPage && (
            <div
              data-testid="job-queue-append-error"
              role="alert"
              className="flex flex-col items-center gap-1 text-center"
            >
              <p className="font-medium text-foreground">
                <Trans>Не вдалося завантажити ще</Trans>
              </p>
              <p>
                <Trans>Уже завантажені вакансії залишаються на екрані.</Trans>
              </p>
            </div>
          )}
          {props.hasNextPage && props.isFetchingNextPage && (
            <p data-testid="job-queue-appending" role="status">
              <Trans>Завантажуємо ще…</Trans>
            </p>
          )}
          {/* the only manual control: a retry after a failed append (the sentinel never retries by itself).
              It stays mounted while the retry is in flight, so keyboard focus is not dropped. */}
          {props.hasNextPage && props.isFetchNextPageError && (
            <Button
              data-testid="job-queue-load-more"
              variant="outline"
              className="min-h-11 w-full @min-[560px]:w-auto"
              aria-disabled={props.isFetchingNextPage}
              onClick={onRetryAppend}
            >
              <Trans>Спробувати ще раз</Trans>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
