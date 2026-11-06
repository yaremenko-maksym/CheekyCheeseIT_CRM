import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import {
  JobQueueAppliedFilters,
  JobQueueFilters,
  appliedFilterCount,
  type JobQueueFilterValue,
} from '../JobQueueFilters'

describe('appliedFilterCount', () => {
  it.each<[JobQueueFilterValue, number]>([
    [{}, 0],
    [{ source: [] }, 0],
    [{ source: ['DOU_RSS', 'LEVER_ATS', 'REMOTEOK_API'] }, 1],
    [{ eligibility: ['LEAD'] }, 1],
    [{ availability: ['OPEN', 'CLOSED'] }, 1],
    [{ source: ['DOU_RSS'], eligibility: ['LEAD'], availability: ['OPEN'] }, 3],
  ])('%j counts %i groups', (value, expected) => {
    expect(appliedFilterCount(value)).toBe(expected)
  })
})

describe('JobQueueFilters', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('summarizes the applied groups in source · eligibility · availability order', async () => {
    const onReset = vi.fn()
    render(
      <JobQueueAppliedFilters
        value={{ availability: ['OPEN', 'CLOSED'], eligibility: ['TRIAGE'], source: ['DOU_RSS'] }}
        onReset={onReset}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
      'Застосовано: DOU · Потребує розгляду · Відкрита, Закрита',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('renders no summary while nothing is applied', () => {
    render(<JobQueueAppliedFilters value={{ source: [] }} onReset={vi.fn()} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.queryByTestId('job-queue-applied')).toBeNull()
  })

  it('applies the picked selection only on «Застосувати»', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={onApply} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByTestId('job-queue-filters-panel')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Потребує розгляду' }))
    await user.click(screen.getByRole('checkbox', { name: 'Закрита' }))
    await user.click(screen.getByRole('checkbox', { name: 'DOU' }))
    expect(onApply).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({
      eligibility: ['TRIAGE'],
      availability: ['CLOSED'],
      source: ['DOU_RSS'],
    })
  })

  it('caps the panel to the viewport and keeps Apply/Clear outside the scroll region', async () => {
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={vi.fn()} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByTestId('job-queue-filters-panel')).toHaveClass(
      'max-h-[var(--radix-popover-content-available-height)]',
      'overflow-hidden',
    )
    const body = screen.getByTestId('job-queue-filters-body')
    const footer = screen.getByTestId('job-queue-filters-footer')
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain')
    expect(footer).toHaveClass('shrink-0')
    expect(body).toContainElement(screen.getByRole('checkbox', { name: 'DOU' }))
    for (const id of ['job-queue-filters-apply', 'job-queue-filters-clear']) {
      expect(footer).toContainElement(screen.getByTestId(id))
      expect(body).not.toContainElement(screen.getByTestId(id))
    }
  })

  it('unchecking the last value of a group drops the group', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{ eligibility: ['LEAD'] }} onApply={onApply} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    const lead = screen.getByRole('checkbox', { name: 'Збіг за стеком' })
    expect(lead).toBeChecked()
    await user.click(lead)
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({})
  })

  it('shows how many filters are applied and «Скинути вибір» clears the draft', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(
      <JobQueueFilters
        value={{ eligibility: ['TRIAGE'], availability: ['OPEN', 'UNKNOWN'] }}
        onApply={onApply}
      />,
      { wrapper: I18nTestProvider },
    )
    // the badge counts groups (eligibility + availability), not options
    // visible: «Фільтри» + «2»; screen readers also hear what the 2 means
    const button = screen.getByTestId('job-queue-filters-button')
    expect(button).toHaveTextContent('Фільтри2Активних фільтрів: 2')
    expect(screen.getByText('2')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('Активних фільтрів: 2')).toHaveClass('sr-only')
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByTestId('job-queue-filters-clear'))
    expect(screen.getByRole('checkbox', { name: 'Потребує розгляду' })).not.toBeChecked()
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({})
  })

  it('unchecking one value keeps the rest of its group, and «Застосувати» closes the panel', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{ availability: ['OPEN', 'CLOSED'] }} onApply={onApply} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByRole('checkbox', { name: 'Відкрита' }))
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({ availability: ['CLOSED'] })
    expect(screen.queryByTestId('job-queue-filters-panel')).toBeNull()
  })

  it('discards an unapplied draft when the panel closes', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={onApply} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByRole('checkbox', { name: 'Закрита' }))
    expect(screen.getByRole('checkbox', { name: 'Закрита' })).toBeChecked()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('job-queue-filters-panel')).toBeNull()
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByRole('checkbox', { name: 'Закрита' })).not.toBeChecked()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('has one scroll region: no filter group scrolls on its own', async () => {
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={vi.fn()} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    for (const name of ['Джерело', 'Статус на джерелі']) {
      // eslint-disable-next-line testing-library/no-node-access
      expect(screen.getByRole('group', { name }).querySelector('div')).not.toHaveAttribute('class')
    }
  })

  it('names the unknown and expired availability values', () => {
    render(
      <JobQueueAppliedFilters value={{ availability: ['UNKNOWN', 'EXPIRED'] }} onReset={vi.fn()} />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
      /^Застосовано: Невідомо, ПростроченаСкинути фільтри$/,
    )
  })

  it('shows no count when nothing is applied', () => {
    render(<JobQueueFilters value={{}} onApply={() => {}} />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent(/^Фільтри$/)
  })
})
