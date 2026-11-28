import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { RoleChips } from '../RoleChips'

async function setup(props: Parameters<typeof RoleChips>[0]) {
  await loadCatalog('uk')
  render(<RoleChips {...props} />, { wrapper: I18nTestProvider })
}

describe('RoleChips', () => {
  it('renders every role as a translated chip, in the given order', async () => {
    await setup({ roles: ['BACKEND_ENGINEER', 'QA_ENGINEER'] })
    const chips = screen.getAllByTestId(/^role-chip-/)
    expect(chips.map((c) => c.dataset['testid'])).toEqual([
      'role-chip-BACKEND_ENGINEER',
      'role-chip-QA_ENGINEER',
    ])
    expect(chips[0]).toHaveTextContent('Бекенд-розробник')
    expect(screen.queryByTestId('role-chips-more')).toBeNull()
  })

  it('a limit shows that many chips and "+N"; the hidden labels stay readable to a screen reader', async () => {
    await setup({
      roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'FULLSTACK_ENGINEER', 'QA_ENGINEER'],
      limit: 3,
    })
    expect(screen.getAllByTestId(/^role-chip-/)).toHaveLength(3)
    expect(screen.queryByTestId('role-chip-QA_ENGINEER')).toBeNull()
    const more = screen.getByTestId('role-chips-more')
    expect(more).toHaveTextContent('+1')
    expect(more).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('role-chips-hidden')).toHaveTextContent(
      'QA-інженер (мануальне тестування)',
    )
    expect(screen.getByTestId('role-chips-hidden')).toHaveClass('sr-only')
  })

  it('a limit equal to the count shows no "+N"', async () => {
    await setup({ roles: ['BACKEND_ENGINEER', 'QA_ENGINEER'], limit: 2 })
    expect(screen.getAllByTestId(/^role-chip-/)).toHaveLength(2)
    expect(screen.queryByTestId('role-chips-more')).toBeNull()
    expect(screen.queryByTestId('role-chips-hidden')).toBeNull()
  })

  it('two hidden roles are joined with a comma', async () => {
    await setup({
      roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'QA_ENGINEER'],
      limit: 1,
    })
    expect(screen.getByTestId('role-chips-more')).toHaveTextContent('+2')
    expect(screen.getByTestId('role-chips-hidden').textContent).toBe(
      'Фронтенд-розробник, QA-інженер (мануальне тестування)',
    )
  })

  it('renders nothing for no roles', async () => {
    await setup({ roles: [] })
    expect(screen.queryByTestId('role-chips')).toBeNull()
  })
})
