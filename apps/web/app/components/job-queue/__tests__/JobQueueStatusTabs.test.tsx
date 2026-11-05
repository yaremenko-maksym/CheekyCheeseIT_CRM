import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { JobQueueStatusTabs } from '../JobQueueStatusTabs'

describe('JobQueueStatusTabs', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders the three tabs in API order with their authorized counts', () => {
    render(
      <JobQueueStatusTabs
        value="NEW"
        counts={{ NEW: 12, SUBMITTED: 3, HIDDEN: 0 }}
        onChange={() => {}}
      />,
      { wrapper: I18nTestProvider },
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('data-testid'))).toEqual([
      'job-queue-tab-NEW',
      'job-queue-tab-SUBMITTED',
      'job-queue-tab-HIDDEN',
    ])
    expect(screen.getByTestId('job-queue-tab-NEW')).toHaveTextContent('Нові12')
    expect(screen.getByTestId('job-queue-tab-SUBMITTED')).toHaveTextContent('Подані3')
    expect(screen.getByTestId('job-queue-tab-HIDDEN')).toHaveTextContent('Приховані0')
  })

  it('marks the current tab as selected', () => {
    render(
      <JobQueueStatusTabs
        value="HIDDEN"
        counts={{ NEW: 1, SUBMITTED: 1, HIDDEN: 1 }}
        onChange={() => {}}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-tab-HIDDEN')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('job-queue-tab-NEW')).toHaveAttribute('aria-selected', 'false')
  })

  it('caps a count above 999 as «999+» and keeps 999 exact', () => {
    render(
      <JobQueueStatusTabs
        value="NEW"
        counts={{ NEW: 1000, SUBMITTED: 999, HIDDEN: 0 }}
        onChange={() => {}}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-tab-NEW')).toHaveTextContent('Нові999+')
    expect(screen.getByTestId('job-queue-tab-SUBMITTED')).toHaveTextContent('Подані999')
  })

  it('shows labels only (no count) before the first page arrives', () => {
    render(<JobQueueStatusTabs value="NEW" counts={null} onChange={() => {}} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('job-queue-tab-NEW')).toHaveTextContent(/^Нові$/)
  })

  it('wraps its content in the tabpanel the selected tab controls (no dangling aria-controls)', () => {
    render(
      <JobQueueStatusTabs value="SUBMITTED" counts={null} onChange={() => {}}>
        <p>queue body</p>
      </JobQueueStatusTabs>,
      { wrapper: I18nTestProvider },
    )
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveTextContent('queue body')
    // UX-M-4: the panel is a tab stop, so it needs a visible focus ring
    expect(panel).toHaveClass(
      'rounded-lg',
      'focus-visible:outline-none',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-2',
      'focus-visible:ring-offset-background',
    )
    expect(screen.getByTestId('job-queue-tab-SUBMITTED')).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      screen.getByTestId('job-queue-tab-SUBMITTED').id,
    )
  })

  it('reports the clicked tab status', async () => {
    const onChange = vi.fn()
    render(
      <JobQueueStatusTabs
        value="NEW"
        counts={{ NEW: 1, SUBMITTED: 2, HIDDEN: 3 }}
        onChange={onChange}
      />,
      { wrapper: I18nTestProvider },
    )
    await userEvent.click(screen.getByTestId('job-queue-tab-SUBMITTED'))
    expect(onChange).toHaveBeenCalledWith('SUBMITTED')
  })
})
