import type { ReactNode } from 'react'
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
  /** A search or filter is applied — an empty page then means "nothing matched", not "empty queue". */
  filtered: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  onLoadMore: () => void
  onRetry: () => void
  onOpen: (opportunityId: string) => void
  onResetFilters: () => void
}

const EMPTY: Record<JobQueueTab, { title: MessageDescriptor; body: MessageDescriptor }> = {
  NEW: {
    title: msg`У черзі немає нових вакансій`,
    body: msg`Нові з’являться після наступного оновлення джерел.`,
  },
  SUBMITTED: {
    title: msg`Ваша команда ще нікого не подала`,
    body: msg`Тут з’являться вакансії, на які подано сеньйорів вашої команди.`,
  },
  HIDDEN: {
    title: msg`Немає прихованих вакансій`,
    body: msg`Приховані вакансії можна повернути звідси.`,
  },
}

function StateBlock({
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

  if (status === 'pending') {
    return (
      <div data-testid="job-queue-loading" aria-busy="true" className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  if (status === 'error' || !items) {
    return (
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
    return props.filtered ? (
      <StateBlock
        testId="job-queue-filtered-empty"
        title={<Trans>Нічого не знайдено</Trans>}
        body={<Trans>Змініть пошук або фільтри.</Trans>}
      >
        <Button variant="outline" className="min-h-11" onClick={props.onResetFilters}>
          <Trans>Скинути фільтри</Trans>
        </Button>
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
  return (
    <div className="flex flex-col gap-3">
      <ul
        data-testid="job-queue-list"
        className="flex flex-col gap-2 min-[560px]:gap-0 min-[560px]:rounded-lg min-[560px]:border"
      >
        {items.map((item) => (
          <li key={item.opportunityId} className="min-w-0">
            <JobQueueRow item={item} tab={tab} role={props.role} onOpen={props.onOpen} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <p data-testid="job-queue-live" aria-live="polite" className="tabular-nums">
          {props.hasNextPage ? (
            <span data-testid="job-queue-shown">
              <Trans>
                Показано {shown} із {total}
              </Trans>
            </span>
          ) : (
            <span data-testid="job-queue-end">
              <Trans>Усі вакансії показано: {shown}</Trans>
            </span>
          )}
        </p>
        {props.hasNextPage && props.isFetchNextPageError && (
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
        {props.hasNextPage &&
          (props.isFetchingNextPage ? (
            <p data-testid="job-queue-appending">
              <Trans>Завантажуємо ще…</Trans>
            </p>
          ) : (
            <Button
              data-testid="job-queue-load-more"
              variant="outline"
              className="min-h-11 w-full min-[560px]:w-auto"
              onClick={props.onLoadMore}
            >
              {props.isFetchNextPageError ? (
                <Trans>Спробувати ще</Trans>
              ) : (
                <Trans>Показати ще</Trans>
              )}
            </Button>
          ))}
      </div>
    </div>
  )
}
