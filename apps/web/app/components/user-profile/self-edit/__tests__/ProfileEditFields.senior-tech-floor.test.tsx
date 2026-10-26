/**
 * A SENIOR editing their own stack: below the shared floor (3 distinct
 * technologies) the inline error shows, is tied to the input, and nothing is saved.
 */
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import type { UserProfileDto } from '@crm/shared'

const mutate = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate, isPending: false }),
}))

import { ProfileEditFields } from '../ProfileEditFields'

const FLOOR_UK = 'Сеньйору потрібно щонайменше 3 різні технології'

function makeUser(role: string, techStack: string[]): UserProfileDto {
  // Test double: only the fields ProfileEditFields reads are populated.
  const partial = {
    id: 'u1',
    displayName: 'Test',
    role,
    email: 'a@b.c',
    telegram: null,
    phone: null,
    techStack,
  }
  return partial as unknown as UserProfileDto
}

const removeChip = (user: ReturnType<typeof userEvent.setup>, tech: string) =>
  user.click(screen.getByRole('button', { name: `Видалити ${tech}` }))

beforeEach(async () => {
  mutate.mockReset()
  await loadCatalog('uk')
})
afterEach(() => vi.useRealTimers())

describe('ProfileEditFields — SENIOR technology floor', () => {
  it('a SENIOR dropping from 3 to 2 sees the error tied to the input and nothing is saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    await removeChip(user, 'AWS')
    const error = screen.getByText(FLOOR_UK)
    const input = screen.getByPlaceholderText('Почніть вводити: React, Node.js…')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(screen.getByText('Технології').className).toContain('text-destructive')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    // The phone widget's own mount-time save of its seeded "+380" is unrelated; no techStack is sent.
    expect(mutate.mock.calls.filter(([patch]) => 'techStack' in (patch as object))).toEqual([])
  })

  it('a JUNIOR dropping to 1 technology saves with no error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('JUNIOR', ['React', 'Go'])} />, {
      wrapper: I18nTestProvider,
    })
    await removeChip(user, 'Go')
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
    expect(screen.getByText('Технології').className).not.toContain('text-destructive')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(mutate).toHaveBeenCalledWith({ techStack: ['React'] })
  })
})
