import { act, renderHook } from '@testing-library/react'
import type { TeamDto, UserProfileDto } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { useTeamSelection } from '../useTeamSelection'

type Args = Parameters<typeof useTeamSelection>[1]

const user = (over: Record<string, unknown>) => ({ id: 'u', ...over }) as unknown as UserProfileDto
const member = (userId: string, role: string, leftAt: string | null = null) => ({
  userId,
  role,
  leftAt,
})
const team = (members: ReturnType<typeof member>[], telegramChannel: string | null = null) =>
  ({ id: 't', members, telegramChannel }) as unknown as TeamDto

const senior = user({ id: 's1', role: 'SENIOR' })
const editArgs = (allTeams: TeamDto[] | undefined, over: Partial<Args> = {}): Args => ({
  editingUser: senior,
  allTeams,
  hrUsers: [],
  accountantUsers: [],
  isCreate: false,
  isEdit: true,
  open: true,
  ...over,
})
const createArgs = (over: Partial<Args> = {}): Args => ({
  editingUser: null,
  allTeams: undefined,
  hrUsers: [],
  accountantUsers: [],
  isCreate: true,
  isEdit: false,
  open: true,
  ...over,
})

function render(args: Args) {
  const setFieldValue = vi.fn()
  const hook = renderHook((a: Args) => useTeamSelection({ setFieldValue }, a), {
    initialProps: args,
  })
  return { setFieldValue, ...hook }
}

describe('useTeamSelection seed effect', () => {
  it('seeds active HRs, accountant and team channel from the senior active team', () => {
    const { result, setFieldValue } = render(
      editArgs([
        team(
          [
            member('s1', 'SENIOR'),
            member('h1', 'HR'),
            member('h2', 'HR', '2026-01-01'),
            member('h3', 'HR'),
            member('a0', 'ACCOUNTANT', '2026-01-01'),
            member('a1', 'ACCOUNTANT'),
          ],
          'chan',
        ),
      ]),
    )
    expect(result.current.selectedHrIds).toEqual(['h1', 'h3'])
    expect(result.current.selectedAccountantId).toBe('a1')
    expect(setFieldValue).toHaveBeenCalledWith('teamTelegramChannel', 'chan')
  })

  it('uses empty accountant and empty channel when team has neither', () => {
    const { result, setFieldValue } = render(editArgs([team([member('s1', 'SENIOR')])]))
    expect(result.current.selectedHrIds).toEqual([])
    expect(result.current.selectedAccountantId).toBe('')
    expect(setFieldValue).toHaveBeenCalledWith('teamTelegramChannel', '')
  })

  it('ignores teams where the senior left or is not a SENIOR member', () => {
    const { result, setFieldValue } = render(
      editArgs([
        team([member('s1', 'SENIOR', '2026-01-01'), member('h1', 'HR')], 'left'),
        team([member('s1', 'HR'), member('h2', 'HR')], 'wrongrole'),
      ]),
    )
    expect(result.current.selectedHrIds).toEqual([])
    expect(setFieldValue).toHaveBeenCalledTimes(1)
    expect(setFieldValue).toHaveBeenCalledWith('teamTelegramChannel', '')
  })

  it('picks the team of the edited senior, not another senior active team listed first', () => {
    const { result, setFieldValue } = render(
      editArgs([
        team([member('other', 'SENIOR'), member('hx', 'HR'), member('ax', 'ACCOUNTANT')], 'theirs'),
        team([member('s1', 'SENIOR'), member('h1', 'HR'), member('a1', 'ACCOUNTANT')], 'mine'),
      ]),
    )
    expect(result.current.selectedHrIds).toEqual(['h1'])
    expect(result.current.selectedAccountantId).toBe('a1')
    expect(setFieldValue).toHaveBeenCalledWith('teamTelegramChannel', 'mine')
  })

  it('edit-from-team seeding needs isEdit: create mode with a SENIOR editingUser uses create defaults', () => {
    const { result, setFieldValue } = render(
      createArgs({
        editingUser: senior,
        allTeams: [team([member('s1', 'SENIOR'), member('h1', 'HR')], 'chan')],
        hrUsers: [user({ id: 'h2' })],
      }),
    )
    expect(result.current.selectedHrIds).toEqual(['h2'])
    expect(setFieldValue).not.toHaveBeenCalled()
  })

  it('clears previous selection when the team disappears', () => {
    const { result, rerender, setFieldValue } = render(
      editArgs([team([member('s1', 'SENIOR'), member('h1', 'HR'), member('a1', 'ACCOUNTANT')])]),
    )
    expect(result.current.selectedHrIds).toEqual(['h1'])
    rerender(editArgs([team([member('other', 'SENIOR')])]))
    expect(result.current.selectedHrIds).toEqual([])
    expect(result.current.selectedAccountantId).toBe('')
    expect(setFieldValue).toHaveBeenLastCalledWith('teamTelegramChannel', '')
  })

  it('does nothing in edit mode for a non-SENIOR or while teams are loading', () => {
    const a = render(
      editArgs([team([member('s1', 'SENIOR'), member('h1', 'HR')])], {
        editingUser: user({ id: 's1', role: 'JUNIOR' }),
      }),
    )
    expect(a.result.current.selectedHrIds).toEqual([])
    expect(a.setFieldValue).not.toHaveBeenCalled()
    const b = render(editArgs(undefined))
    expect(b.result.current.selectedHrIds).toEqual([])
    expect(b.setFieldValue).not.toHaveBeenCalled()
  })

  it('create: pre-selects the only HR / accountant, none when several or zero', () => {
    const one = render(
      createArgs({ hrUsers: [user({ id: 'h1' })], accountantUsers: [user({ id: 'a1' })] }),
    )
    expect(one.result.current.selectedHrIds).toEqual(['h1'])
    expect(one.result.current.selectedAccountantId).toBe('a1')
    expect(one.setFieldValue).not.toHaveBeenCalled()

    const many = render(
      createArgs({
        hrUsers: [user({ id: 'h1' }), user({ id: 'h2' })],
        accountantUsers: [user({ id: 'a1' }), user({ id: 'a2' })],
      }),
    )
    expect(many.result.current.selectedHrIds).toEqual([])
    expect(many.result.current.selectedAccountantId).toBe('')

    const none = render(createArgs())
    expect(none.result.current.selectedHrIds).toEqual([])
    expect(none.result.current.selectedAccountantId).toBe('')
  })

  it('create: does not seed while the dialog is closed', () => {
    const { result } = render(createArgs({ open: false, hrUsers: [user({ id: 'h1' })] }))
    expect(result.current.selectedHrIds).toEqual([])
  })
})

describe('useTeamSelection handlers and refs', () => {
  it('handleHrChange updates ids and clears hrError only for a non-empty selection', () => {
    const { result } = render(createArgs())
    act(() => result.current.setHrError('err'))
    expect(result.current.hrError).toBe('err')
    act(() => result.current.handleHrChange([]))
    expect(result.current.hrError).toBe('err')
    act(() => result.current.handleHrChange(['h9']))
    expect(result.current.selectedHrIds).toEqual(['h9'])
    expect(result.current.hrError).toBeUndefined()
  })

  it('refs track the latest selection (seeded and user-changed)', () => {
    const { result } = render(
      editArgs([team([member('s1', 'SENIOR'), member('h1', 'HR'), member('a1', 'ACCOUNTANT')])]),
    )
    expect(result.current.selectedHrIdsRef.current).toEqual(['h1'])
    expect(result.current.selectedAccountantIdRef.current).toBe('a1')
    act(() => {
      result.current.handleHrChange(['h7', 'h8'])
      result.current.setSelectedAccountantId('a9')
    })
    expect(result.current.selectedHrIdsRef.current).toEqual(['h7', 'h8'])
    expect(result.current.selectedAccountantIdRef.current).toBe('a9')
  })
})
