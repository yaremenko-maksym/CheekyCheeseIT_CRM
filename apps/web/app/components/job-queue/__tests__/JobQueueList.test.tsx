import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JobQueueListItemDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { JobQueueList, type JobQueueListProps } from '../JobQueueList'

function item(id: string, title: string): JobQueueListItemDto {
  return {
    opportunityId: id,
    revision: 1,
    title,
    companyName: 'Acme',
    location: null,
    primarySource: null,
    applicationUrl: null,
    alsoSeenOnCount: 0,
    availability: 'OPEN',
    eligibility: 'LEAD',
    matchedSeniorCount: 0,
    submittedSeniorCount: 0,
    stopListedSeniorCount: 0,
    openedByTeam: false,
    hidden: false,
    publishedAt: null,
    firstSeenAt: new Date().toISOString(),
  }
}

const A = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alpha role')
const B = item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Beta role')

function renderList(over: Partial<JobQueueListProps> = {}) {
  const props: JobQueueListProps = {
    items: [A, B],
    status: 'success',
    tab: 'NEW',
    role: 'HR',
    total: 2,
    hasSearch: false,
    hasFilters: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    refreshRequired: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    onResetFilters: vi.fn(),
    onClearSearch: vi.fn(),
    ...over,
  }
  const view = render(<JobQueueList {...props} />, { wrapper: I18nTestProvider })
  return {
    ...props,
    rerender: (next: Partial<JobQueueListProps>) =>
      view.rerender(<JobQueueList {...props} {...next} />),
  }
}

/** A controllable IntersectionObserver: `fire(true)` reports the sentinel as visible. */
class FakeObserver {
  static last: FakeObserver | null = null
  static options: IntersectionObserverInit | undefined
  observed: Element[] = []
  constructor(
    private readonly cb: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    FakeObserver.last = this
    FakeObserver.options = options
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  disconnect() {
    this.observed = []
  }
  unobserve() {}
  takeRecords() {
    return []
  }
  fire(isIntersecting: boolean) {
    this.cb(
      this.observed.map((target) => ({ isIntersecting, target }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }
}

const C = item('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Gamma role')

describe('JobQueueList', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders one row per item in server order', () => {
    renderList()
    const list = screen.getByTestId('job-queue-list')
    expect(list.tagName).toBe('UL')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toHaveTextContent('Alpha role')
    expect(screen.getByTestId(`job-queue-row-${B.opportunityId}`)).toHaveTextContent('Beta role')
  })

  it('shows skeletons and no list while the first page loads', () => {
    renderList({ items: undefined, status: 'pending' })
    expect(screen.getByTestId('job-queue-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-list')).toBeNull()
  })

  it('shows the load error with a retry', async () => {
    const props = renderList({ items: undefined, status: 'error' })
    const error = screen.getByTestId('job-queue-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('Не вдалося завантажити чергу')
    expect(error).toHaveTextContent('Спробуйте ще раз.')
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['NEW', 'У черзі немає нових вакансій'],
    ['SUBMITTED', 'Ваша команда ще нікого не подала'],
    ['HIDDEN', 'Немає прихованих вакансій'],
  ] as const)('shows the %s empty state', (tab, text) => {
    renderList({ items: [], tab, total: 0 })
    expect(screen.getByTestId('job-queue-empty')).toHaveTextContent(text)
  })

  it('shows filtered-empty with a reset when filters hide everything', async () => {
    const props = renderList({ items: [], hasFilters: true, total: 0 })
    expect(screen.queryByTestId('job-queue-empty')).toBeNull()
    expect(screen.getByTestId('job-queue-filtered-empty')).toHaveTextContent('Нічого не знайдено')
    expect(screen.queryByRole('button', { name: 'Очистити пошук' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }))
    expect(props.onResetFilters).toHaveBeenCalledTimes(1)
  })

  it('offers «Очистити пошук» when only a search is applied', async () => {
    const props = renderList({ items: [], hasSearch: true, total: 0 })
    expect(screen.getByTestId('job-queue-filtered-empty')).toHaveTextContent('Нічого не знайдено')
    expect(screen.queryByRole('button', { name: 'Скинути фільтри' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Очистити пошук' }))
    expect(props.onClearSearch).toHaveBeenCalledTimes(1)
    expect(props.onResetFilters).not.toHaveBeenCalled()
  })

  it('offers both resets when search and filters are applied', () => {
    renderList({ items: [], hasSearch: true, hasFilters: true, total: 0 })
    expect(screen.getByRole('button', { name: 'Очистити пошук' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скинути фільтри' })).toBeInTheDocument()
  })

  it('offers «Показати ще» while a next page exists', async () => {
    const props = renderList({ hasNextPage: true, total: 40 })
    expect(screen.getByTestId('job-queue-shown')).toHaveTextContent('Показано 2 із 40')
    await userEvent.click(screen.getByTestId('job-queue-load-more'))
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('job-queue-end')).toBeNull()
  })

  it('shows the appending state instead of the button', () => {
    renderList({ hasNextPage: true, isFetchingNextPage: true })
    expect(screen.getByTestId('job-queue-appending')).toHaveTextContent('Завантажуємо ще…')
    expect(screen.getByTestId('job-queue-appending')).toHaveAttribute('role', 'status')
    expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
  })

  it('keeps loaded rows on an append error and offers a retry', async () => {
    const props = renderList({ hasNextPage: true, isFetchNextPageError: true })
    expect(screen.getByTestId('job-queue-append-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('drops the append error while the retry is in flight', () => {
    renderList({ hasNextPage: true, isFetchNextPageError: true, isFetchingNextPage: true })
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.queryByText('Не вдалося завантажити ще')).toBeNull()
    expect(screen.getByTestId('job-queue-appending')).toHaveTextContent('Завантажуємо ще…')
  })

  it('shows no foot while a refresh is required: retrying a dead cursor cannot succeed', () => {
    renderList({ hasNextPage: true, isFetchNextPageError: true, refreshRequired: true })
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.queryByTestId('job-queue-end')).toBeNull()
    expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
  })

  describe('infinite scroll (spec §4.4)', () => {
    beforeEach(() => {
      FakeObserver.last = null
      vi.stubGlobal('IntersectionObserver', FakeObserver)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('loads the next page when the sentinel comes into view, with a 400px margin', () => {
      const props = renderList({ hasNextPage: true, total: 40 })
      const sentinel = screen.getByTestId('job-queue-sentinel')
      expect(FakeObserver.last?.observed).toEqual([sentinel])
      expect(FakeObserver.options).toEqual({ rootMargin: '400px' })
      FakeObserver.last!.fire(false)
      expect(props.onLoadMore).not.toHaveBeenCalled()
      FakeObserver.last!.fire(true)
      expect(props.onLoadMore).toHaveBeenCalledTimes(1)
      // the button stays as the keyboard / screen-reader path
      expect(screen.getByTestId('job-queue-load-more')).toHaveTextContent('Показати ще')
    })

    it.each([
      ['while a page is in flight', { isFetchingNextPage: true }],
      ['after an append error (no retry storm)', { isFetchNextPageError: true }],
      ['on the last page', { hasNextPage: false }],
    ])('has no sentinel %s', (_label, over) => {
      renderList({ hasNextPage: true, ...over })
      expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
      expect(FakeObserver.last).toBeNull()
    })

    it('announces a sentinel append without moving focus', () => {
      const view = renderList({ hasNextPage: true, total: 3 })
      FakeObserver.last!.fire(true)
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 3 })
      expect(screen.getByTestId('job-queue-live')).toHaveTextContent(
        'Завантажено ще 1. Показано 3 із 3',
      )
      expect(screen.getByTestId(`job-queue-row-${C.opportunityId}`)).not.toHaveFocus()
    })
  })

  it('after a button append, focuses the first new row and announces the delta', async () => {
    const view = renderList({ hasNextPage: true, total: 5 })
    await userEvent.click(screen.getByTestId('job-queue-load-more'))
    view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
    expect(screen.getByTestId(`job-queue-row-${C.opportunityId}`)).toHaveFocus()
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(
      'Завантажено ще 1. Показано 3 із 5',
    )
  })

  it('announces only the count before any append, and resets when the list is replaced', () => {
    const view = renderList({ items: [A, B, C], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent('Показано 3 із 5')
    expect(screen.getByTestId('job-queue-live')).not.toHaveTextContent('Завантажено')
    view.rerender({ items: [A], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent('Показано 1 із 5')
    expect(screen.getByTestId('job-queue-live')).not.toHaveTextContent('Завантажено')
  })

  it('announces the end of the list', () => {
    renderList()
    expect(screen.getByTestId('job-queue-end')).toHaveTextContent('Усі вакансії показано: 2')
    expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
  })

  it('opens a card through the row', async () => {
    const props = renderList()
    await userEvent.click(screen.getByTestId(`job-queue-row-${B.opportunityId}`))
    expect(props.onOpen).toHaveBeenCalledWith(B.opportunityId)
  })
})
