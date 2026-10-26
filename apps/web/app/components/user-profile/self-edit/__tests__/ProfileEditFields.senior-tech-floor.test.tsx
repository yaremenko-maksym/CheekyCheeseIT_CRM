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

// The self-edit form autosaves, so its message also says nothing was saved (CR-M-1).
const FLOOR_UK = 'Не збережено: сеньйору потрібно щонайменше 3 різні технології'
const FLOOR_EN = 'Not saved: a senior needs at least 3 different technologies'

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

  it('CR-M-1: a pending save of a valid stack is dropped when the stack turns invalid — no request goes out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    // A valid edit schedules a save (debounced 800 ms)…
    await user.type(
      screen.getByPlaceholderText('Почніть вводити: React, Node.js…'),
      'Zzcustom{Enter}',
    )
    // …and before it fires the stack drops below the floor.
    await removeChip(user, 'Zzcustom')
    await removeChip(user, 'AWS')
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(mutate.mock.calls.filter(([patch]) => 'techStack' in (patch as object))).toEqual([])
  })

  it('CR-M-1: a pending save of ANOTHER field is not dropped by an invalid stack and still goes out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    await act(() => vi.advanceTimersByTimeAsync(1000)) // flush the phone widget's mount-time save
    mutate.mockReset()
    await user.type(screen.getByLabelText('Ім’я та прізвище'), 'X')
    await removeChip(user, 'AWS')
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(mutate.mock.calls).toEqual([[{ displayName: 'TestX' }]])
  })

  it('CR-M-1: an invalid stack with nothing pending sends nothing and does not throw', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    await act(() => vi.advanceTimersByTimeAsync(1000)) // nothing pending any more
    mutate.mockReset()
    await removeChip(user, 'AWS')
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(mutate.mock.calls).toEqual([])
  })

  it('CR-M-1: a valid change while a stack save is pending replaces it with the latest stack', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    mutate.mockReset()
    const input = screen.getByPlaceholderText('Почніть вводити: React, Node.js…')
    await user.type(input, 'Zzone{Enter}')
    await user.type(input, 'Zztwo{Enter}')
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(mutate.mock.calls).toEqual([[{ techStack: ['React', 'Go', 'AWS', 'Zzone', 'Zztwo'] }]])
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

  it('en: the same refusal renders in English (SPEC-M-2)', async () => {
    await loadCatalog('en')
    const user = userEvent.setup()
    render(<ProfileEditFields user={makeUser('SENIOR', ['React', 'Go', 'AWS'])} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByRole('button', { name: 'Remove AWS' }))
    expect(screen.getByText(FLOOR_EN)).toBeInTheDocument()
  })
})
