import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { TeamSwitcher } from '../TeamSwitcher'

const TEAMS = [
  { id: 't1', name: 'Alpha' },
  { id: 't2', name: 'Beta' },
]

describe('TeamSwitcher', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders nothing for a single team', () => {
    render(<TeamSwitcher teams={[TEAMS[0]!]} value="t1" onChange={() => {}} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.queryByTestId('job-queue-team-switcher')).toBeNull()
  })

  it('shows the current team and reports the picked one', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TeamSwitcher teams={TEAMS} value="t1" onChange={onChange} />, {
      wrapper: I18nTestProvider,
    })
    const trigger = screen.getByTestId('job-queue-team-switcher')
    expect(trigger).toHaveAccessibleName('Команда')
    expect(trigger).toHaveTextContent('Alpha')
    await user.click(trigger)
    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByRole('option', { name: 'Beta' }))
    expect(onChange).toHaveBeenCalledWith('t2')
  })
})
