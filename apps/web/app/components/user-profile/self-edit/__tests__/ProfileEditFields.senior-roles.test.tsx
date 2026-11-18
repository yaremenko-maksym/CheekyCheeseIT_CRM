/**
 * A SENIOR editing their own profile picks technical roles instead of the stack. Removing the last
 * role shows a polite error and saves nothing (shared floor SENIOR_MIN_ROLES); every other role
 * keeps the stack, with no floor.
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
const FLOOR_UK = 'Не збережено: сеньйору потрібна щонайменше одна технічна роль'
const FLOOR_EN = 'Not saved: a senior needs at least one technical role'
const STACK_PLACEHOLDER = 'Почніть вводити: React, Node.js…'

function makeUser(
  role: string,
  technicalRoles: string[],
  techStack: string[] = [],
): UserProfileDto {
  // Test double: only the fields ProfileEditFields reads are populated.
  const partial = {
    id: 'u1',
    displayName: 'Test',
    role,
    email: 'a@b.c',
    telegram: null,
    phone: null,
    techStack,
    technicalRoles,
  }
  return partial as unknown as UserProfileDto
}

async function setup(user: UserProfileDto) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const ue = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  render(<ProfileEditFields user={user} />, { wrapper: I18nTestProvider })
  await act(() => vi.advanceTimersByTimeAsync(1000)) // flush the phone widget's mount-time save
  mutate.mockReset()
  return ue
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(2000))
const remove = (ue: ReturnType<typeof userEvent.setup>, role: string) =>
  ue.click(screen.getByTestId(`roles-section-remove-${role}`))
async function add(ue: ReturnType<typeof userEvent.setup>, role: string) {
  await ue.click(screen.getByTestId('roles-section-add-trigger'))
  await ue.click(screen.getByTestId(`roles-section-option-${role}`))
}

beforeEach(async () => {
  mutate.mockReset()
  await loadCatalog('uk')
})
afterEach(() => vi.useRealTimers())

describe('ProfileEditFields — SENIOR technical roles', () => {
  it('a SENIOR sees the roles section, not the stack', async () => {
    await setup(makeUser('SENIOR', ['BACKEND_ENGINEER'], ['React']))
    expect(screen.getByTestId('roles-section-chip-BACKEND_ENGINEER')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STACK_PLACEHOLDER)).toBeNull()
  })

  it('adding a role autosaves the sorted roles', async () => {
    const ue = await setup(makeUser('SENIOR', ['QA_ENGINEER']))
    await add(ue, 'BACKEND_ENGINEER')
    await flush()
    expect(mutate.mock.calls).toEqual([[{ technicalRoles: ['BACKEND_ENGINEER', 'QA_ENGINEER'] }]])
  })

  it('removing the last role shows a polite error and saves nothing', async () => {
    const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
    await remove(ue, 'BACKEND_ENGINEER')
    const error = screen.getByTestId('roles-section-error')
    expect(error).toHaveTextContent(FLOOR_UK)
    // A polite live region: it appears while the user is still editing.
    expect(error).toHaveAttribute('role', 'status')
    await flush()
    expect(mutate.mock.calls).toEqual([])
  })

  it('the last role goes with nothing pending: the drop is guarded, no exception reaches jsdom', async () => {
    // The guard `pending && 'technicalRoles' in pending` has to read `pending` first: `in` on
    // `null` throws, and an exception inside a React event handler only surfaces as a window
    // `error` event in jsdom, so the test has to watch for it.
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => {
      errors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener('error', onError)
    try {
      const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
      await remove(ue, 'BACKEND_ENGINEER')
      await flush()
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toEqual([])
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    expect(mutate.mock.calls).toEqual([])
  })

  it('a pending save of roles is dropped when the last role goes', async () => {
    const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
    await add(ue, 'QA_ENGINEER')
    await remove(ue, 'QA_ENGINEER')
    await remove(ue, 'BACKEND_ENGINEER')
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    await flush()
    expect(mutate.mock.calls).toEqual([])
  })

  it('a pending save of ANOTHER field still goes out when the roles turn empty', async () => {
    const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
    await ue.type(screen.getByLabelText('Ім’я та прізвище'), 'X')
    await add(ue, 'QA_ENGINEER')
    await remove(ue, 'QA_ENGINEER')
    await remove(ue, 'BACKEND_ENGINEER')
    await flush()
    expect(mutate.mock.calls).toEqual([[{ displayName: 'TestX' }]])
  })

  it('a role added back clears the error and is saved', async () => {
    const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
    await remove(ue, 'BACKEND_ENGINEER')
    expect(screen.getByText(FLOOR_UK)).toBeInTheDocument()
    await add(ue, 'DATA_ENGINEER')
    expect(screen.queryByText(FLOOR_UK)).toBeNull()
    await flush()
    expect(mutate.mock.calls).toEqual([[{ technicalRoles: ['DATA_ENGINEER'] }]])
  })

  it('a legacy SENIOR with no roles sees no error until an edit', async () => {
    await setup(makeUser('SENIOR', []))
    expect(screen.getByText('Нічого не обрано')).toBeInTheDocument()
    expect(screen.queryByTestId('roles-section-error')).toBeNull()
  })

  it('a JUNIOR keeps the stack: dropping to 1 technology saves with no error', async () => {
    const ue = await setup(makeUser('JUNIOR', [], ['React', 'Go']))
    expect(screen.queryByTestId('roles-section')).toBeNull()
    await ue.click(screen.getByRole('button', { name: 'Видалити Go' }))
    await flush()
    expect(mutate.mock.calls).toEqual([[{ techStack: ['React'] }]])
  })

  it('en: the same refusal renders in English', async () => {
    await loadCatalog('en')
    const ue = await setup(makeUser('SENIOR', ['BACKEND_ENGINEER']))
    await remove(ue, 'BACKEND_ENGINEER')
    expect(screen.getByText(FLOOR_EN)).toBeInTheDocument()
  })
})
