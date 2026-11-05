import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { JobQueueFilters } from '../JobQueueFilters'

describe('JobQueueFilters', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
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
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent('Фільтри3')
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
