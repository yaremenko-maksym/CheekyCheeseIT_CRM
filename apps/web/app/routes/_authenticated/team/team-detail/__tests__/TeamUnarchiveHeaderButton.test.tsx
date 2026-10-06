import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

const mutateAsync = vi.hoisted(() => vi.fn())
const useUnarchiveEntity = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-archive', () => ({ useUnarchiveEntity }))

import { TeamUnarchiveHeaderButton } from '../components/TeamUnarchiveHeaderButton'

function renderButton() {
  return render(
    <I18nTestProvider>
      <TeamUnarchiveHeaderButton teamId="t1" />
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  mutateAsync.mockReset()
  mutateAsync.mockResolvedValue(undefined)
  useUnarchiveEntity.mockReset()
  useUnarchiveEntity.mockReturnValue({ mutateAsync, isPending: false })
})

describe('TeamUnarchiveHeaderButton', () => {
  it('renders the labelled button and binds the hook to the team entity', () => {
    renderButton()
    const btn = screen.getByTestId('team-unarchive-button')
    expect(btn.textContent).toBe('Відновити')
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(useUnarchiveEntity).toHaveBeenCalledWith('team', 't1')
  })

  it('click triggers the unarchive mutation with an empty payload', () => {
    renderButton()
    fireEvent.click(screen.getByTestId('team-unarchive-button'))
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({})
  })

  it('is disabled while the mutation is pending and does not fire on click', () => {
    useUnarchiveEntity.mockReturnValue({ mutateAsync, isPending: true })
    renderButton()
    const btn = screen.getByTestId('team-unarchive-button')
    expect(btn.hasAttribute('disabled')).toBe(true)
    fireEvent.click(btn)
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})
