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

  it('default (idle, no error) render: exact button labels, own wrapper testid+class, no error paragraphs at all', () => {
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(screen.getByText('Подтвердить')).toBeInTheDocument()
    expect(screen.getByText('Отклонить')).toBeInTheDocument()
    expect(screen.getByTestId(`senior-share-approval-actions-user-${ID}`)).toHaveClass(
      'justify-end',
    )
    // Neither error paragraph exists yet — the approve one is a sibling of
    // the wrapper div, the reject one only exists once the dialog is open.
    // `<p>` maps to the implicit ARIA role "paragraph" — a role-based query
    // stays within Testing Library's own API (no raw container/node access).
    expect(screen.queryAllByRole('paragraph')).toHaveLength(0)
  })

  it('onActed is optional — a successful approve with no onActed prop at all does not throw', () => {
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    act(() => {
      fireEvent.click(screen.getByTestId(`senior-share-approve-user-${ID}`))
    })
    const [, options] = mockApprove.mock.calls[0] as [unknown, { onSuccess?: () => void }]
    expect(() => act(() => options.onSuccess?.())).not.toThrow()
  })

  it('onActed is optional — a successful reject with no onActed prop at all does not throw, and still closes+resets the dialog', async () => {
    const user = userEvent.setup()
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    await user.type(screen.getByTestId('senior-share-reject-reason'), 'причина')
    await user.click(screen.getByTestId('senior-share-reject-submit'))

    const [, options] = mockReject.mock.calls[0] as [string, { onSuccess?: () => void }]
    expect(() => act(() => options.onSuccess?.())).not.toThrow()
    // The dialog's onSuccess closes it and clears the reason — reopening
    // must show an EMPTY textarea, not the just-submitted text.
    expect(screen.queryByTestId('senior-share-reject-reason')).not.toBeInTheDocument()
    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    expect(screen.getByTestId('senior-share-reject-reason')).toHaveValue('')
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

  it('an approve error with neither a mapped status nor a string message falls through to THIS component’s own fallback', () => {
    approveState = {
      isPending: false,
      isError: true,
      error: { not: 'an axios error' },
    }
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(screen.getByText('Не удалось подтвердить')).toBeInTheDocument()
  })

  it('a reject error with neither a mapped status nor a string message falls through to THIS component’s OWN (reject-specific) fallback', () => {
    rejectState = {
      isPending: false,
      isError: true,
      error: { not: 'an axios error' },
    }
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    // The reject error paragraph is inside the dialog body — it only
    // exists once the dialog is open.
    fireEvent.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    expect(screen.getByText('Не удалось отклонить')).toBeInTheDocument()
  })

  it('reject.isPending shows the spinner (own testid) on the trigger button', () => {
    rejectState = { isPending: true, isError: false, error: null }
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(screen.getByTestId(`senior-share-reject-user-${ID}-spinner`)).toBeInTheDocument()
  })

  it('the reason textarea is correctly labelled and described — Label htmlFor/id AND aria-describedby both actually resolve', async () => {
    const user = userEvent.setup()
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    // Only findable this way if `htmlFor` really matches the textarea's `id`
    // — a broken/emptied template on either side makes this query fail even
    // though `getByTestId` would still find the same element.
    const textarea = screen.getByLabelText('Причина отказа *')
    expect(textarea).toHaveAttribute('data-testid', 'senior-share-reject-reason')
    // Only correct if `aria-describedby` really points at the counter
    // paragraph's own `id`.
    expect(textarea).toHaveAccessibleDescription('0/500')
  })

  it('reject: no error yet renders no inline text; a real error renders it (same 409/404 mapping)', () => {
    const { rerender } = render(<SeniorShareApprovalActions scope="user" id={ID} />)
    fireEvent.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    // Baseline with the dialog open is 2 paragraphs (Radix's own
    // DialogDescription + the live char counter) — NOT 0. A
    // `rejectError && <p>` mutated to `rejectError || <p>` would add a
    // THIRD, empty one even while idle; a text-pattern query can't see
    // that (an empty `<p>` matches no text either way), a role-based COUNT
    // does.
    expect(screen.queryAllByRole('paragraph')).toHaveLength(2)

    rejectState = {
      isPending: false,
      isError: true,
      error: Object.assign(new Error('x'), { isAxiosError: true, response: { status: 404 } }),
    }
    rerender(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(
      screen.getByText(
        'Предложение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
      ),
    ).toBeInTheDocument()
  })

  it('a reason of only whitespace keeps the submit button disabled (trim, not raw truthiness)', async () => {
    const user = userEvent.setup()
    render(<SeniorShareApprovalActions scope="user" id={ID} />)
    await user.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    await user.type(screen.getByTestId('senior-share-reject-reason'), '    ')
    expect(screen.getByTestId('senior-share-reject-submit')).toBeDisabled()
  })

  it('reject.isPending swaps the submit button label to "Отклонение…", back to "Отклонить" when idle', () => {
    // Open the dialog WHILE idle — the "Отклонить" trigger button is itself
    // `disabled={reject.isPending}`, so opening it only works before the
    // mutation starts; the label swap on the SUBMIT button is what this
    // test is actually about.
    const { rerender } = render(<SeniorShareApprovalActions scope="user" id={ID} />)
    fireEvent.click(screen.getByTestId(`senior-share-reject-user-${ID}`))
    expect(screen.getByTestId('senior-share-reject-submit')).toHaveTextContent('Отклонить')

    rejectState = { isPending: true, isError: false, error: null }
    rerender(<SeniorShareApprovalActions scope="user" id={ID} />)
    expect(screen.getByTestId('senior-share-reject-submit')).toHaveTextContent('Отклонение…')
  })
})
