import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
    seniority: 'UNKNOWN',
    matchedKeywords: [],
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
    scrollRoot: null,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    refreshRequired: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onRestart: vi.fn(),
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
    unmount: view.unmount,
  }
}

/**
 * A controllable IntersectionObserver: `fire(true)` reports the sentinel as visible. Like the real
 * one it reports every target once on `observe`, and after that only on an intersection change.
 */
class FakeObserver {
  static last: FakeObserver | null = null
  static options: IntersectionObserverInit | undefined
  /** What the initial callback reports: is the sentinel already in view when it mounts? */
  static inView = false
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
    this.fire(FakeObserver.inView)
  }
  disconnect() {
    this.observed = []
  }
  unobserve() {}
  takeRecords() {
    return []
  }
  fire(isIntersecting: boolean) {
    this.fireEach([isIntersecting])
  }
  /** One entry per flag, all for the observed sentinel (a batched callback). */
  fireEach(flags: boolean[]) {
    const target = this.observed[0]!
    this.cb(
      flags.map((isIntersecting) => ({ isIntersecting, target }) as IntersectionObserverEntry),
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
    expect(screen.getByTestId('job-queue-loading')).toHaveTextContent('Завантажуємо чергу…')
    expect(screen.getByText('Завантажуємо чергу…')).toHaveClass('sr-only')
    expect(screen.queryByTestId('job-queue-list')).toBeNull()
    // three placeholder rows
    // eslint-disable-next-line testing-library/no-node-access
    expect(screen.getByTestId('job-queue-loading').querySelectorAll('.h-20')).toHaveLength(3)
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
  })

  it('keeps the rows on screen when a refetch fails (status reads only without rows)', () => {
    renderList({ status: 'error' })
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
  })

  it('wide list: one clipped border, rows separated by dividers (no doubled last border)', () => {
    renderList()
    const list = screen.getByTestId('job-queue-list')
    expect(list).toHaveClass('@min-[560px]:overflow-hidden', '@min-[560px]:divide-y')
    expect(screen.getByTestId(`job-queue-row-${B.opportunityId}`)).not.toHaveClass(
      '@min-[560px]:border-b',
    )
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
    ['NEW', 'У черзі немає нових вакансій', 'Нові з’являться після наступного оновлення джерел.'],
    [
      'SUBMITTED',
      'Ваша команда ще нікого не подала',
      'Тут будуть вакансії, на які ваша команда подала сеньйорів.',
    ],
    ['HIDDEN', 'Немає прихованих вакансій', 'Приховані вакансії можна повернути звідси.'],
  ] as const)('shows the %s empty state', (tab, title, body) => {
    renderList({ items: [], tab, total: 0 })
    expect(screen.getByTestId('job-queue-empty')).toHaveTextContent(title)
    expect(screen.getByText(body)).toHaveClass('text-sm', 'text-muted-foreground')
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

  it('shows the count and «Показати ще» while a next page exists', () => {
    renderList({ hasNextPage: true, total: 40 })
    expect(screen.getByTestId('job-queue-shown')).toHaveTextContent(/^Показано 2 із 40$/)
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
    const more = screen.getByRole('button', { name: 'Показати ще' })
    expect(more).toHaveAttribute('data-testid', 'job-queue-load-more')
    expect(more).toHaveAttribute('aria-disabled', 'false')
    expect(more).toHaveClass('min-h-11', 'w-full', '@min-[560px]:w-auto', 'text-foreground')
    expect(screen.queryByTestId('job-queue-end')).toBeNull()
  })

  it('offers no foot button when no next page exists', () => {
    renderList({ hasNextPage: false })
    expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
  })

  it('«Показати ще» loads the next page', async () => {
    const props = renderList({ hasNextPage: true, total: 40 })
    await userEvent.click(screen.getByTestId('job-queue-load-more'))
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('ignores «Показати ще» during any fetch: an append would abort a background refetch', async () => {
    const props = renderList({ hasNextPage: true, isFetching: true })
    const more = screen.getByTestId('job-queue-load-more')
    expect(more).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(more)
    expect(props.onLoadMore).not.toHaveBeenCalled()
  })

  it.each([
    ['search', { hasSearch: true }],
    ['filters', { hasFilters: true }],
  ])('drops the unfiltered total from the count under %s', (_label, over) => {
    const view = renderList({ hasNextPage: true, total: 40, ...over })
    expect(screen.getByTestId('job-queue-shown')).toHaveTextContent(/^Показано 2$/)
    view.rerender({ items: [A, B, C], hasNextPage: true, total: 40, ...over })
    expect(screen.getByTestId('job-queue-shown')).toHaveTextContent(
      /^Завантажено ще 1\. Показано 3$/,
    )
  })

  it('shows no append error on the last page', () => {
    renderList({ hasNextPage: false, isFetchNextPageError: true })
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.getByTestId('job-queue-end')).toHaveTextContent(/^Усі вакансії показано: 2$/)
  })

  it('shows the appending state above the load-more button, disabled', () => {
    renderList({ hasNextPage: true, isFetching: true, isFetchingNextPage: true })
    expect(screen.getByTestId('job-queue-appending')).toHaveTextContent('Завантажуємо ще…')
    expect(screen.getByTestId('job-queue-appending')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('job-queue-load-more')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
  })

  it.each([
    ['no page is in flight', { hasNextPage: true, isFetchingNextPage: false }],
    ['no next page exists', { hasNextPage: false, isFetchingNextPage: true }],
  ])('shows no appending state when %s', (_label, over) => {
    renderList(over)
    expect(screen.queryByTestId('job-queue-appending')).toBeNull()
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

  it('the foot offers the restart while a refresh is required: retrying a dead cursor cannot succeed', async () => {
    const props = renderList({
      hasNextPage: true,
      isFetchNextPageError: true,
      refreshRequired: true,
    })
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toBeInTheDocument()
    expect(screen.getByText('Список змінився')).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-live')).toBeNull()
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
    // the page's notice above the list is the one that announces
    expect(screen.queryByRole('status')).toBeNull()
    const restart = screen.getByRole('button', { name: 'Показати оновлений список' })
    expect(restart).toHaveAttribute('data-testid', 'job-queue-refresh-foot')
    expect(restart).toHaveClass('min-h-11', 'w-full', '@min-[560px]:w-auto')
    await userEvent.click(restart)
    expect(props.onRestart).toHaveBeenCalledTimes(1)
  })

  it('offers no restart in the foot while the cursor is alive', () => {
    renderList({ hasNextPage: true, total: 40 })
    expect(screen.queryByTestId('job-queue-refresh-foot')).toBeNull()
    expect(screen.queryByText('Список змінився')).toBeNull()
  })

  it('centres the foot line, which wraps at 320', () => {
    renderList()
    expect(screen.getByTestId('job-queue-live')).toHaveClass('text-center', 'text-balance')
  })

  describe('infinite scroll (spec §4.4)', () => {
    beforeEach(() => {
      FakeObserver.last = null
      FakeObserver.inView = false
      vi.stubGlobal('IntersectionObserver', FakeObserver)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('loads the next page when the sentinel comes into view, with a 400px margin', () => {
      const scrollRoot = document.createElement('div')
      const props = renderList({ hasNextPage: true, total: 40, scrollRoot })
      const sentinel = screen.getByTestId('job-queue-sentinel')
      expect(FakeObserver.last?.observed).toEqual([sentinel])
      expect(FakeObserver.options).toEqual({ root: scrollRoot, rootMargin: '400px' })
      FakeObserver.last!.fire(false)
      expect(props.onLoadMore).not.toHaveBeenCalled()
      FakeObserver.last!.fire(true)
      expect(props.onLoadMore).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('job-queue-load-more')).toBeInTheDocument()
      expect(screen.queryByTestId('job-queue-retry')).toBeNull()
    })

    it('observes again against the scroller when it appears after the sentinel', () => {
      const view = renderList({ hasNextPage: true, total: 40, scrollRoot: null })
      const scrollRoot = document.createElement('div')
      view.rerender({ scrollRoot })
      expect(FakeObserver.options?.root).toBe(scrollRoot)
      expect(FakeObserver.last?.observed).toEqual([screen.getByTestId('job-queue-sentinel')])
    })

    it('a short first page loads the next one through the initial callback', () => {
      FakeObserver.inView = true
      const view = renderList({ hasNextPage: true, total: 40 })
      expect(view.onLoadMore).toHaveBeenCalledTimes(1)
      // the sentinel unmounts for the flight and remounts in view, so the next page loads too
      view.rerender({ isFetching: true, isFetchingNextPage: true })
      expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
      view.rerender({ items: [A, B, C] })
      expect(view.onLoadMore).toHaveBeenCalledTimes(2)
    })

    it('does not arm the sentinel during a background refetch, and arms it once settled', () => {
      FakeObserver.inView = true
      const view = renderList({ hasNextPage: true, total: 40, isFetching: true })
      expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
      expect(view.onLoadMore).not.toHaveBeenCalled()
      view.rerender({ isFetching: false })
      expect(screen.getByTestId('job-queue-sentinel')).toBeInTheDocument()
      expect(view.onLoadMore).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['while a page is in flight', { isFetching: true, isFetchingNextPage: true }],
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

    it('loads once when any entry of a batched callback intersects', () => {
      const props = renderList({ hasNextPage: true, total: 40 })
      FakeObserver.last!.fireEach([false, true])
      expect(props.onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('calls the latest onLoadMore after a rerender', () => {
      const props = renderList({ hasNextPage: true, total: 40 })
      const latest = vi.fn()
      props.rerender({ onLoadMore: latest })
      FakeObserver.last!.fire(true)
      expect(latest).toHaveBeenCalledTimes(1)
      expect(props.onLoadMore).not.toHaveBeenCalled()
    })

    it('keeps the sentinel armed after a background-refetch error; disarms it after an append error (CR-L-5)', () => {
      FakeObserver.inView = true
      // background refetch settled with an error but not an append error — sentinel stays armed
      const view = renderList({
        hasNextPage: true,
        total: 40,
        isFetching: false,
        isFetchNextPageError: false,
        status: 'error',
      })
      expect(screen.getByTestId('job-queue-sentinel')).toBeInTheDocument()
      expect(view.onLoadMore).toHaveBeenCalledTimes(1)
      // append error — sentinel disarms (no retry storm via scrolling)
      view.rerender({ isFetchNextPageError: true })
      expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
      expect(view.onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('disconnects the observer on unmount', () => {
      const view = renderList({ hasNextPage: true, total: 40 })
      const observer = FakeObserver.last!
      expect(observer.observed).toHaveLength(1)
      view.unmount()
      expect(observer.observed).toEqual([])
    })

    it('stops observing once the sentinel goes away', () => {
      const props = renderList({ hasNextPage: true, total: 40 })
      const observer = FakeObserver.last!
      expect(observer.observed).toHaveLength(1)
      props.rerender({ isFetching: true, isFetchingNextPage: true })
      expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
      expect(observer.observed).toEqual([])
    })
  })

  it('renders without IntersectionObserver support and still offers the button', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    try {
      renderList({ hasNextPage: true, total: 40 })
      expect(screen.getByTestId('job-queue-sentinel')).toBeInTheDocument()
      expect(screen.getByTestId('job-queue-load-more')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores a click on the retry button while the retry is in flight and keeps it mounted', async () => {
    const props = renderList({
      hasNextPage: true,
      isFetchNextPageError: true,
      isFetching: true,
      isFetchingNextPage: true,
    })
    const retry = screen.getByTestId('job-queue-retry')
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    // button.tsx styles only `disabled:`, so the visual state has to come from these
    expect(retry).toHaveClass('aria-disabled:pointer-events-none', 'aria-disabled:opacity-50')
    await userEvent.click(retry)
    expect(props.onLoadMore).not.toHaveBeenCalled()
  })

  it('after a button append, focuses the first new row and announces the delta', async () => {
    const view = renderList({ hasNextPage: true, isFetchNextPageError: true, total: 5 })
    await userEvent.click(screen.getByTestId('job-queue-retry'))
    view.rerender({ items: [A, B, C], isFetchNextPageError: false, total: 5 })
    expect(screen.getByTestId(`job-queue-row-${C.opportunityId}`)).toHaveFocus()
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(
      /^Завантажено ще 1\. Показано 3 із 5$/,
    )
  })

  it('focuses the first new row after a retried append that was in flight', async () => {
    const view = renderList({ hasNextPage: true, isFetchNextPageError: true, total: 5 })
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    // the retry is in flight: same rows, and the query keeps its error flag until it settles
    view.rerender({ isFetchNextPageError: true, isFetchingNextPage: true })
    expect(screen.getByTestId('job-queue-appending')).toBeInTheDocument()
    view.rerender({ items: [A, B, C], isFetchNextPageError: false, isFetchingNextPage: false })
    expect(screen.getByTestId(`job-queue-row-${C.opportunityId}`)).toHaveFocus()
  })

  describe('foot button focus (QA-M-1)', () => {
    const foot = () => screen.getByTestId('job-queue-load-more')
    const focus = (el: HTMLElement) => act(() => el.focus())
    const rowC = () => screen.getByTestId(`job-queue-row-${C.opportunityId}`)
    const rowB = () => screen.getByTestId(`job-queue-row-${B.opportunityId}`)
    const D = item('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Delta role')

    it('Tab landing on the button hands off to the first new row when the page arrives', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(rowC()).toHaveFocus()
    })

    it('hands off on the last page, where the button unmounts in the same commit', () => {
      const view = renderList({ items: [A], hasNextPage: true, isFetching: true, total: 3 })
      focus(foot())
      view.rerender({ items: [A, B, C], hasNextPage: false, total: 3 })
      expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
      expect(rowB()).toHaveFocus()
    })

    it('a click on a browser that does not focus buttons still hands off', () => {
      const view = renderList({ hasNextPage: true, total: 5 })
      fireEvent.click(foot())
      expect(foot()).toHaveFocus()
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(rowC()).toHaveFocus()
    })

    it('does not steal focus from a user who moved on before the page arrived', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      focus(rowB())
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(rowB()).toHaveFocus()
    })

    // a window switch fires the blur but leaves activeElement on the button
    it('a window switch while fetching does not cancel the handoff', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      fireEvent.blur(foot(), { relatedTarget: null })
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(rowC()).toHaveFocus()
    })

    it('a click on the page background cancels the handoff, with no commit before the page', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      act(() => foot().blur())
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(document.body).toHaveFocus()
    })

    it('a click on the page background leaves focus alone when the last page removes the button', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 3 })
      focus(foot())
      act(() => foot().blur())
      view.rerender({ items: [A, B, C], hasNextPage: false, total: 3 })
      expect(document.body).toHaveFocus()
    })

    it('does not move focus when no button held it (a sentinel append)', () => {
      const view = renderList({ hasNextPage: true, total: 5 })
      view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
      expect(rowC()).not.toHaveFocus()
    })

    it('a failure keeps focus on the button, which becomes the retry', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      view.rerender({ hasNextPage: true, isFetchNextPageError: true, total: 5 })
      expect(screen.getByTestId('job-queue-retry')).toHaveFocus()
      expect(screen.getByTestId('job-queue-retry')).toHaveTextContent('Спробувати ще раз')
    })

    it('hands off after a failure when a later page arrives with focus still on the button', async () => {
      const view = renderList({ hasNextPage: true, isFetchNextPageError: true, total: 5 })
      await userEvent.click(screen.getByTestId('job-queue-retry'))
      view.rerender({ isFetchingNextPage: true })
      view.rerender({ isFetchingNextPage: false })
      view.rerender({ items: [A, B, C], isFetchNextPageError: false })
      expect(rowC()).toHaveFocus()
    })

    it('a replaced list is not an append: the button keeps focus, and the next append hands off', async () => {
      const view = renderList({ hasNextPage: true, total: 5 })
      await userEvent.click(foot())
      view.rerender({ items: [C, A, B], hasNextPage: true, total: 5 })
      expect(foot()).toHaveFocus()
      // a longer replaced list is not an append
      expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Показано 3 із 5$/)
      view.rerender({ items: [C, A, B, D], hasNextPage: true, total: 5 })
      expect(screen.getByTestId(`job-queue-row-${D.opportunityId}`)).toHaveFocus()
    })

    it('refresh-required moves focus from the removed button to the refresh button', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 5 })
      focus(foot())
      view.rerender({ hasNextPage: true, refreshRequired: true, total: 5 })
      expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
      expect(screen.getByTestId('job-queue-refresh-foot')).toHaveFocus()
    })

    it('refresh-required leaves focus alone when the button did not hold it', () => {
      const view = renderList({ hasNextPage: true, total: 5 })
      focus(rowB())
      view.rerender({ hasNextPage: true, refreshRequired: true, total: 5 })
      expect(rowB()).toHaveFocus()
    })

    it('an end with no new rows moves focus from the removed button to the last row', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 2 })
      focus(foot())
      view.rerender({ hasNextPage: false, total: 2 })
      expect(rowB()).toHaveFocus()
    })

    it('a list emptied under the button leaves focus on the body', () => {
      const view = renderList({ hasNextPage: true, isFetching: true, total: 2 })
      focus(foot())
      view.rerender({ items: [], hasNextPage: false, total: 0 })
      expect(screen.getByTestId('job-queue-empty')).toBeInTheDocument()
      expect(document.body).toHaveFocus()
    })

    // `added` stays positive after an append, and must not send focus back to that page's first row
    describe('after an append, with focus back on the button', () => {
      const appended = () => {
        const view = renderList({ items: [A], hasNextPage: true, total: 5 })
        focus(foot())
        view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
        expect(rowB()).toHaveFocus()
        focus(foot())
        return view
      }

      it('refresh-required moves focus to the refresh button', () => {
        appended().rerender({
          items: [A, B, C],
          hasNextPage: true,
          refreshRequired: true,
          total: 5,
        })
        expect(screen.getByTestId('job-queue-refresh-foot')).toHaveFocus()
      })

      it('an end with no new rows moves focus to the last row', () => {
        appended().rerender({ items: [A, B, C], hasNextPage: false, total: 3 })
        expect(rowC()).toHaveFocus()
      })

      it('a rerender with the button still mounted keeps focus on it', () => {
        appended().rerender({ items: [A, B, C], hasNextPage: true, isFetching: true, total: 5 })
        expect(foot()).toHaveFocus()
      })
    })

    it('a null active element is not read as the absent button holding focus', () => {
      const view = renderList({ items: [A], hasNextPage: false, total: 5 })
      const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
      view.rerender({ items: [A, B], hasNextPage: false, total: 5 })
      active.mockRestore()
      expect(rowB()).not.toHaveFocus()
    })

    describe('with focus on the refresh button (CR-L-15)', () => {
      const refreshing = () => {
        const view = renderList({ hasNextPage: true, refreshRequired: true, total: 5 })
        focus(screen.getByTestId('job-queue-refresh-foot'))
        return view
      }

      it('a refetch that clears refresh-required moves focus to the load-more button', () => {
        refreshing().rerender({ hasNextPage: true, refreshRequired: false, total: 5 })
        expect(screen.queryByTestId('job-queue-refresh-foot')).toBeNull()
        expect(foot()).toHaveFocus()
      })

      it('with no next page left, focus moves to the last row', () => {
        refreshing().rerender({ hasNextPage: false, refreshRequired: false, total: 2 })
        expect(rowB()).toHaveFocus()
      })

      it('a list emptied under the button leaves focus on the body', () => {
        refreshing().rerender({ items: [], hasNextPage: false, refreshRequired: false, total: 0 })
        expect(screen.getByTestId('job-queue-empty')).toBeInTheDocument()
        expect(document.body).toHaveFocus()
      })

      it('a rerender with the button still mounted keeps focus on it', () => {
        refreshing().rerender({
          hasNextPage: true,
          refreshRequired: true,
          isFetching: true,
          total: 5,
        })
        expect(screen.getByTestId('job-queue-refresh-foot')).toHaveFocus()
      })

      it('an append hands focus to the first new row', () => {
        refreshing().rerender({
          items: [A, B, C],
          hasNextPage: true,
          refreshRequired: false,
          total: 5,
        })
        expect(rowC()).toHaveFocus()
      })
    })
  })

  it('remounts the live region on a tab change instead of re-announcing in place', () => {
    const view = renderList({ hasNextPage: true, total: 5 })
    const live = screen.getByTestId('job-queue-live')
    view.rerender({ total: 6 })
    expect(screen.getByTestId('job-queue-live')).toBe(live)
    view.rerender({ tab: 'SUBMITTED', total: 6 })
    expect(screen.getByTestId('job-queue-live')).not.toBe(live)
  })

  it('announces only the count before any append, and resets when the list is replaced', () => {
    const view = renderList({ items: [A, B, C], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Показано 3 із 5$/)
    view.rerender({ items: [A], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Показано 1 із 5$/)
  })

  it('drops the delta when a same-length list replaces an appended one', () => {
    const view = renderList({ hasNextPage: true, total: 5 })
    view.rerender({ items: [A, B, C], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(
      /^Завантажено ще 1\. Показано 3 із 5$/,
    )
    view.rerender({ items: [C, B, A], hasNextPage: true, total: 5 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Показано 3 із 5$/)
  })

  it('does not count a first page after an empty list as an append', () => {
    const view = renderList({ items: [], total: 0 })
    view.rerender({ items: [A, B], total: 2 })
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Усі вакансії показано: 2$/)
  })

  it('announces the delta with the end of the list after the last page', () => {
    const view = renderList({ hasNextPage: true, total: 3 })
    view.rerender({ items: [A, B, C], hasNextPage: false, total: 3 })
    expect(screen.getByTestId('job-queue-end')).toHaveTextContent(
      /^Завантажено ще 1\. Усі вакансії показано: 3$/,
    )
  })

  it('announces the end of the list', () => {
    renderList()
    expect(screen.getByTestId('job-queue-end')).toHaveTextContent(/^Усі вакансії показано: 2$/)
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
  })

  it('opens a card through the row', async () => {
    const props = renderList()
    await userEvent.click(screen.getByTestId(`job-queue-row-${B.opportunityId}`))
    expect(props.onOpen).toHaveBeenCalledWith(B.opportunityId)
  })
})
