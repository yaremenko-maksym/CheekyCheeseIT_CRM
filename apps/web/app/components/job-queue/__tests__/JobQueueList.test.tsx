import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    filtered: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    onResetFilters: vi.fn(),
    ...over,
  }
  render(<JobQueueList {...props} />, { wrapper: I18nTestProvider })
  return props
}

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
    const props = renderList({ items: [], filtered: true, total: 0 })
    expect(screen.queryByTestId('job-queue-empty')).toBeNull()
    expect(screen.getByTestId('job-queue-filtered-empty')).toHaveTextContent('Нічого не знайдено')
    await userEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }))
    expect(props.onResetFilters).toHaveBeenCalledTimes(1)
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
    expect(screen.queryByTestId('job-queue-load-more')).toBeNull()
  })

  it('keeps loaded rows on an append error and offers a retry', async () => {
    const props = renderList({ hasNextPage: true, isFetchNextPageError: true })
    expect(screen.getByTestId('job-queue-append-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId(`job-queue-row-${A.opportunityId}`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще' }))
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
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
