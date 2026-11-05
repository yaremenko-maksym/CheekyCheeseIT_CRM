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

  it('shows no count when nothing is applied', () => {
    render(<JobQueueFilters value={{}} onApply={() => {}} />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent(/^Фільтри$/)
  })
})
