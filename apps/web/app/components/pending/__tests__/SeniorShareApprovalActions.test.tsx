/**
 * task-pending-screen (design spec §5.2 п.1). `SeniorShareApprovalActions`
 * is the SHARE_APPROVAL counterpart of `ProjectApprovalActions` — same
 * mocking shape as `ProjectApprovalActions.test.tsx`, pointed at
 * `useApproveSeniorShareChange`/`useRejectSeniorShareChange`
 * (use-user-profile.ts), now generalized by a `scope` param (task addendum
 * item 2).
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SeniorShareApprovalActions } from '../SeniorShareApprovalActions'

const mockApprove = vi.fn()
const mockReject = vi.fn()
let approveState: { isPending: boolean; isError: boolean; error: unknown } = {
  isPending: false,
  isError: false,
  error: null,
}
let rejectState: { isPending: boolean; isError: boolean; error: unknown } = {
  isPending: false,
  isError: false,
  error: null,
}
let capturedScopes: string[] = []
let capturedIds: string[] = []

vi.mock('@/hooks/use-user-profile', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-user-profile')>()
  return {
    ...real,
    useApproveSeniorShareChange: (scope: string, id: string) => {
      capturedScopes.push(scope)
      capturedIds.push(id)
      return { mutate: mockApprove, ...approveState }
    },
    useRejectSeniorShareChange: (scope: string, id: string) => {
      capturedScopes.push(scope)
      capturedIds.push(id)
      return { mutate: mockReject, ...rejectState }
    },
  }
})

beforeEach(() => {
  mockApprove.mockReset()
  mockReject.mockReset()
  approveState = { isPending: false, isError: false, error: null }
  rejectState = { isPending: false, isError: false, error: null }
  capturedScopes = []
  capturedIds = []
})

const ID = '00000000-0000-0000-0000-0000000000b1'

describe('SeniorShareApprovalActions', () => {
  it('threads scope + id straight into both mutation hooks', () => {
    render(<SeniorShareApprovalActions scope="project" id={ID} />)
    expect(capturedScopes).toEqual(['project', 'project'])
    expect(capturedIds).toEqual([ID, ID])
  })

  it('Подтвердить calls approve.mutate(undefined, { onSuccess }) and fires onActed on success', () => {
    const onActed = vi.fn()
    render(<SeniorShareApprovalActions scope="user" id={ID} onActed={onActed} />)

    act(() => {
      fireEvent.click(screen.getByTestId(`senior-share-approve-user-${ID}`))
    })

    expect(mockApprove).toHaveBeenCalledTimes(1)
    const [variables, options] = mockApprove.mock.calls[0] as [unknown, { onSuccess?: () => void }]
    expect(variables).toBeUndefined()
    expect(onActed).not.toHaveBeenCalled()
    options.onSuccess?.()
    expect(onActed).toHaveBeenCalledTimes(1)
  })

  it('Отклонить opens a dialog; submit is disabled until a reason is typed, then calls reject.mutate(reason.trim(), …)', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<SeniorShareApprovalActions scope="user" id={ID} onActed={onActed} />)

    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    const submit = screen.getByTestId('senior-share-reject-submit')
    expect(submit).toBeDisabled()

    await user.type(screen.getByTestId('senior-share-reject-reason'), '  ошиблись с расчётом  ')
    expect(submit).toBeEnabled()

    await user.click(submit)

    expect(mockReject).toHaveBeenCalledTimes(1)
    const [reason, options] = mockReject.mock.calls[0] as [string, { onSuccess?: () => void }]
    expect(reason).toBe('ошиблись с расчётом')
    options.onSuccess?.()
    expect(onActed).toHaveBeenCalledTimes(1)
  })

  it('reason field enforces the 500-char cap and shows a live counter', async () => {
    const user = userEvent.setup()
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))

    const textarea = screen.getByTestId('senior-share-reject-reason')
    expect(textarea).toHaveAttribute('maxLength', '500')
    await user.type(textarea, 'abc')
    expect(screen.getByText('3/500')).toBeInTheDocument()
  })

  it('approve.isPending disables the button and swaps the icon for a spinner', () => {
    approveState = { isPending: true, isError: false, error: null }
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(screen.getByTestId(`senior-share-approve-user-${ID}`)).toBeDisabled()
    expect(screen.getByTestId(`senior-share-approve-user-${ID}-spinner`)).toBeInTheDocument()
    expect(screen.getByText('Подтверждение…')).toBeInTheDocument()
  })

  it('a real approve error renders inline error text below the buttons (409/404 mapped by seniorShareErrorMessage)', () => {
    approveState = {
      isPending: false,
      isError: true,
      error: Object.assign(new Error('x'), { isAxiosError: true, response: { status: 409 } }),
    }
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(
      screen.getByText('Решение по этому предложению уже принято. Обновите страницу.'),
    ).toBeInTheDocument()
  })
})
