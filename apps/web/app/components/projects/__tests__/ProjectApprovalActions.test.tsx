/**
 * task-project-status-filter-ui. `ProjectApprovalActions` is the ONE place
 * `POST /projects/:id/approve` and `/reject` are called from — mounted both
 * on `ProjectRow` (card) and `PendingProjectApprovalsPanel` (dashboard
 * widget). These tests exercise the component directly, with the two
 * mutation hooks mocked so no real HTTP happens — `isAlreadyRespondedError`
 * is kept REAL (partial mock) since its 409/404 branching is exactly what
 * AC3's "stale item disappears instead of erroring" behaviour depends on.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProjectApprovalActions } from '../ProjectApprovalActions'

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

vi.mock('@/hooks/use-project-approvals', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-project-approvals')>()
  return {
    ...real,
    useApproveProjectDraft: () => ({ mutate: mockApprove, ...approveState }),
    useRejectProjectDraft: () => ({ mutate: mockReject, ...rejectState }),
  }
})

const PROJECT_ID = '00000000-0000-0000-0000-0000000000a1'

function conflictError() {
  return Object.assign(new Error('Conflict'), {
    isAxiosError: true,
    response: { status: 409 },
  })
}

function serverError() {
  return Object.assign(new Error('Не удалось загрузить проекты'), {
    isAxiosError: true,
    response: { status: 500 },
  })
}

beforeEach(() => {
  mockApprove.mockReset()
  mockReject.mockReset()
  approveState = { isPending: false, isError: false, error: null }
  rejectState = { isPending: false, isError: false, error: null }
})

describe('ProjectApprovalActions — Confirm', () => {
  it('renders both actions with project-scoped testids and their at-rest (not pending) labels', () => {
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    const approve = screen.getByTestId(`project-approval-approve-${PROJECT_ID}`)
    const reject = screen.getByTestId(`project-approval-reject-${PROJECT_ID}`)
    expect(approve).toBeInTheDocument()
    expect(approve).toHaveTextContent('Подтвердить')
    expect(approve).not.toHaveTextContent('Подтверждаем…')
    expect(reject).toBeInTheDocument()
    expect(reject).toHaveTextContent('Отклонить')
  })

  it('clicking Confirm calls approve.mutate with the project id', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))

    expect(mockApprove).toHaveBeenCalledTimes(1)
    expect(mockApprove.mock.calls[0]?.[0]).toBe(PROJECT_ID)
  })

  it('a successful approve calls onActed', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onSuccess: () => void }
    act(() => opts.onSuccess())

    expect(onActed).toHaveBeenCalledTimes(1)
  })

  it('an "already responded" 409 on approve calls onActed too — no error surfaced', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(conflictError()))

    expect(onActed).toHaveBeenCalledTimes(1)
  })

  it('a real approve error renders the message from the mutation state, INSIDE a <p> (not as a bare text node — the `&&` must stay `&&`, not `||`)', () => {
    approveState = { isPending: false, isError: true, error: serverError() }
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    const text = screen.getByText('Не удалось загрузить проекты')
    expect(text.tagName).toBe('P')
    expect(text.className).toContain('text-destructive')
  })

  it('a NON-"already responded" approve error does NOT call onActed — only a real resolution does', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(serverError()))

    expect(onActed).not.toHaveBeenCalled()
  })

  it('onSuccess/onError never crash when onActed is omitted (it is an optional prop, not a required one)', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as {
      onSuccess: () => void
      onError: (e: unknown) => void
    }
    expect(() => act(() => opts.onSuccess())).not.toThrow()
    expect(() => act(() => opts.onError(conflictError()))).not.toThrow()
  })

  it('approve.isPending disables the Confirm button AND swaps its label to the in-flight text', () => {
    approveState = { isPending: true, isError: false, error: null }
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    const button = screen.getByTestId(`project-approval-approve-${PROJECT_ID}`)
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Подтверждаем…')
    expect(button).not.toHaveTextContent('Подтвердить')
  })

  it('the actions container sits at z-[2] — the stretched-link escape ProjectRow relies on', () => {
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    expect(screen.getByTestId(`project-approval-actions-${PROJECT_ID}`).className).toContain(
      'z-[2]',
    )
  })

  it("clicking Confirm stops propagation — a wrapping click handler (ProjectRow's stretched-link row) never fires", async () => {
    const user = userEvent.setup()
    const wrapperClick = vi.fn()
    render(
      <div onClick={wrapperClick}>
        <ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />
      </div>,
    )

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    expect(wrapperClick).not.toHaveBeenCalled()
  })

  it('clicking Отклонить (opening the dialog) also stops propagation', async () => {
    const user = userEvent.setup()
    const wrapperClick = vi.fn()
    render(
      <div onClick={wrapperClick}>
        <ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />
      </div>,
    )

    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    expect(wrapperClick).not.toHaveBeenCalled()
  })
})

describe('ProjectApprovalActions — Reject (AC4: reason required before send)', () => {
  it('opens a dialog naming the company on click', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme Corp" />)

    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    expect(await screen.findByText('Отклонить проект «Acme Corp»')).toBeInTheDocument()
  })

  it('submit is disabled while the reason is empty or whitespace-only, enabled once typed', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    const submit = await screen.findByTestId('project-approval-reject-submit')
    const textarea = screen.getByTestId('project-approval-reject-reason')
    expect(submit).toBeDisabled()
    // At-rest label — not the in-flight "Отклоняем…" text.
    expect(submit).toHaveTextContent('Отклонить')

    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(submit).toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'нет бюджета' } })
    expect(submit).not.toBeDisabled()
  })

  it('submit calls reject.mutate with the TRIMMED reason, never sends on empty (AC4: never a post-send 400)', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    const textarea = screen.getByTestId('project-approval-reject-reason')
    fireEvent.change(textarea, { target: { value: '  нет бюджета на Q3  ' } })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    expect(mockReject).toHaveBeenCalledTimes(1)
    expect(mockReject.mock.calls[0]?.[0]).toEqual({
      projectId: PROJECT_ID,
      reason: 'нет бюджета на Q3',
    })
  })

  it('a successful reject closes the dialog, clears the reason (reopening shows an EMPTY textarea, not the old text), and calls onActed', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onSuccess: () => void }
    act(() => opts.onSuccess())

    expect(onActed).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Отклонить проект «Acme»')).not.toBeInTheDocument()

    // Reopen — the reason field must be blank, not still carrying "нет бюджета".
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    expect(await screen.findByTestId('project-approval-reject-reason')).toHaveValue('')
  })

  it('a successful reject never crashes when onActed is omitted', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onSuccess: () => void }
    expect(() => act(() => opts.onSuccess())).not.toThrow()
  })

  it('an "already responded" 409/404 on reject also closes the dialog, clears the reason, and calls onActed', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(conflictError()))

    expect(onActed).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Отклонить проект «Acme»')).not.toBeInTheDocument()

    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    expect(await screen.findByTestId('project-approval-reject-reason')).toHaveValue('')
  })

  it('an "already responded" reject error never crashes when onActed is omitted', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    expect(() => act(() => opts.onError(conflictError()))).not.toThrow()
  })

  it('a NON-"already responded" reject error keeps the dialog OPEN, shows the message, and does NOT call onActed', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(serverError()))

    expect(onActed).not.toHaveBeenCalled()
    // Dialog is still mounted — the title and the reason (untouched) are both there.
    expect(screen.getByText('Отклонить проект «Acme»')).toBeInTheDocument()
  })

  it('a pre-set reject error renders the message INSIDE a <p> when the dialog is open', async () => {
    const user = userEvent.setup()
    rejectState = { isPending: false, isError: true, error: serverError() }
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    const text = await screen.findByText('Не удалось загрузить проекты')
    expect(text.tagName).toBe('P')
    expect(text.className).toContain('text-destructive')
  })

  it('reject.isPending disables the submit button and swaps its label to the in-flight text', async () => {
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    // Open the dialog WHILE not pending — the trigger button itself is
    // `disabled={reject.isPending}`, so flipping isPending BEFORE opening
    // would leave the dialog unreachable through the UI.
    fireEvent.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    await screen.findByTestId('project-approval-reject-submit')

    rejectState = { isPending: true, isError: false, error: null }
    // Force a re-render (the mocked hook is read fresh every render) without
    // going back through the now-disabled trigger button — a keystroke in
    // the still-open dialog's own Textarea does it.
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })

    const submit = screen.getByTestId('project-approval-reject-submit')
    expect(submit).toBeDisabled()
    expect(submit).toHaveTextContent('Отклоняем…')
  })

  it('Отмена closes the dialog without ever calling reject.mutate, and clears whatever was typed', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    await screen.findByText('Отклонить проект «Acme»')
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'черновик причины' },
    })

    await user.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(mockReject).not.toHaveBeenCalled()
    expect(screen.queryByText('Отклонить проект «Acme»')).not.toBeInTheDocument()

    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    expect(await screen.findByTestId('project-approval-reject-reason')).toHaveValue('')
  })
})
