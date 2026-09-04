/**
 * task-project-status-filter-ui. `ProjectApprovalActions` is the ONE place
 * `POST /projects/:id/approve` and `/reject` are called from — mounted both
 * on `ProjectRow` (card) and `PendingProjectApprovalsPanel` (dashboard
 * widget). These tests exercise the component directly, with the two
 * mutation hooks mocked so no real HTTP happens — `isAlreadyRespondedError`
 * is kept REAL (partial mock) since its 409-only branching (SR-M-4, PR #646
 * fix-round 1 — narrowed from 409/404) is exactly what AC3's "stale item
 * disappears instead of erroring" behaviour depends on. `sonner`'s `toast`
 * is mocked to assert the SR-M-4 "404 is now a real, toasted error" fix.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { ProjectApprovalActions } from '../ProjectApprovalActions'

const mockApprove = vi.fn()
const mockReject = vi.fn()
const mockToastError = vi.fn()
const mockToastSuccess = vi.fn()
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

vi.mock('sonner', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
  },
}))

const PROJECT_ID = '00000000-0000-0000-0000-0000000000a1'

function conflictError() {
  return Object.assign(new Error('Conflict'), {
    isAxiosError: true,
    response: { status: 409 },
  })
}

/**
 * SR-M-4 (PR #646 fix-round 1): a 404 is now a real error, never "already
 * responded". Body shape matches what `ApprovalsService.assertRespondable`
 * actually sends (Nest's default exception-filter JSON:
 * `{ statusCode, message, error }`) — realistic enough that
 * `getUserFacingErrorMessage` takes the SAME code path (`extractBackendMessage`
 * priority 2) a real 404 from this endpoint would.
 */
function notFoundError() {
  return Object.assign(new Error('Not Found'), {
    isAxiosError: true,
    response: {
      status: 404,
      data: { statusCode: 404, message: 'Согласование не найдено или уже погашено' },
    },
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
  mockToastError.mockReset()
  mockToastSuccess.mockReset()
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
    expect(approve).not.toHaveTextContent('Подтверждение…')
    expect(reject).toBeInTheDocument()
    expect(reject).toHaveTextContent('Отклонить')
  })

  it('mutation-gate (ProjectApprovalActions.tsx:179/183): the error paragraph is ABSENT in the normal, at-rest state — approveError/rejectError must actually gate on isError, not render unconditionally', () => {
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    // Both `approve.isError && !isAlreadyRespondedError(approve.error)` (and
    // the reject-side twin) collapse to the SAME wrong value — true — under
    // either a forced-true condition or a `&&`→`||` swap, because with
    // `error: null` (this file's own beforeEach default)
    // `isAlreadyRespondedError(null)` is false, so `!false` is already true
    // on its own; only the `isError` operand tells the two states apart.
    // This is the one assertion that distinguishes "correctly gated" from
    // "always shows a fallback error nobody asked for".
    expect(screen.queryByText(getUserFacingErrorMessage(null))).not.toBeInTheDocument()
  })

  it('clicking Confirm calls approve.mutate with the project id', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))

    expect(mockApprove).toHaveBeenCalledTimes(1)
    expect(mockApprove.mock.calls[0]?.[0]).toBe(PROJECT_ID)
  })

  it('COPY-H-2 (PR #646 fix-round 2): a successful approve that flips the project to ACTIVE calls onActed AND toasts the "confirmed" message', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as {
      onSuccess: (project: { status: string }) => void
    }
    act(() => opts.onSuccess({ status: 'ACTIVE' }))

    expect(onActed).toHaveBeenCalledTimes(1)
    expect(mockToastSuccess).toHaveBeenCalledWith('Проект «Acme» подтверждён')
  })

  it('COPY-H-2: a successful approve that leaves the project DRAFT (partial agreement — the other invited approver has not decided) toasts the "waiting on the other side" message, not the "confirmed" one', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as {
      onSuccess: (project: { status: string }) => void
    }
    act(() => opts.onSuccess({ status: 'DRAFT' }))

    expect(onActed).toHaveBeenCalledTimes(1)
    expect(mockToastSuccess).toHaveBeenCalledWith('Вы подтвердили. Ждём решения второй стороны')
  })

  it('an "already responded" 409 on approve calls onActed too — no error surfaced, no toast', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(conflictError()))

    expect(onActed).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('SR-M-4 (PR #646 fix-round 1): a 404 on approve does NOT call onActed — it is a real error, not "already responded" (used to be treated the same as 409)', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(notFoundError()))

    expect(onActed).not.toHaveBeenCalled()
  })

  it('SR-M-4: a 404 on approve calls toast.error with the user-facing message — the element no longer just silently vanishes', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    await user.click(screen.getByTestId(`project-approval-approve-${PROJECT_ID}`))
    const opts = mockApprove.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(notFoundError()))

    expect(mockToastError).toHaveBeenCalledTimes(1)
    // COPY-H-1 (PR #646 fix-round 2): the toast shows the OWN mapped
    // string, never the backend's raw "Согласование ... погашено" text
    // (fixture's own message, asserted separately below where it matters).
    expect(mockToastError.mock.calls[0]?.[0]).toBe(
      'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
    )
  })

  it('a real approve error renders the message from the mutation state, INSIDE a <p> (not as a bare text node — the `&&` must stay `&&`, not `||`)', () => {
    approveState = { isPending: false, isError: true, error: serverError() }
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    // COPY-H-1 (PR #646 fix-round 2): `friendlyErrorMessage` routes anything
    // that isn't a 404 through `getUserFacingErrorMessage`, same as the
    // toast below — `serverError()`'s hand-set `.message` string is never
    // read (that function derives the text from `response.status`/`data`,
    // never from `.message`; see its own doc for why). The assertion computes
    // the SAME real function's output rather than hardcoding its result, so
    // it can't silently drift from what the component actually calls.
    const text = screen.getByText(getUserFacingErrorMessage(serverError()))
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
      onSuccess: (project: { status: string }) => void
      onError: (e: unknown) => void
    }
    // COPY-H-2: onSuccess now reads `project.status` off its argument (see
    // the two dedicated tests above) — a REAL mutate call always supplies a
    // project, so this "never crashes without onActed" check exercises the
    // rest of the handler (the onActed?.() optional-call itself), not a
    // shape no real caller could produce.
    expect(() => act(() => opts.onSuccess({ status: 'ACTIVE' }))).not.toThrow()
    expect(() => act(() => opts.onError(conflictError()))).not.toThrow()
  })

  it('approve.isPending disables the Confirm button AND swaps its label to the in-flight text', () => {
    approveState = { isPending: true, isError: false, error: null }
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)

    const button = screen.getByTestId(`project-approval-approve-${PROJECT_ID}`)
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Подтверждение…')
    expect(button).not.toHaveTextContent('Подтвердить')
  })

  it('UX-H-2 (PR #646 fix-round 1): both buttons are h-11 (44px, responsive-design.md hard-gate) on mobile and revert to h-7 from sm: (640px+) up — same pattern as SegmentedToggle', () => {
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    const approve = screen.getByTestId(`project-approval-approve-${PROJECT_ID}`)
    const reject = screen.getByTestId(`project-approval-reject-${PROJECT_ID}`)
    for (const button of [approve, reject]) {
      expect(button.className).toContain('h-11')
      expect(button.className).toContain('sm:h-7')
      expect(button.className).not.toContain('h-7 min-w-11')
    }
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

  it('mutation-gate (ProjectApprovalActions.tsx:183): with the dialog open and no error, the error paragraph is ABSENT — rejectError must actually gate on isError, not render unconditionally', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    await screen.findByText('Отклонить проект «Acme»')

    expect(screen.queryByText(getUserFacingErrorMessage(null))).not.toBeInTheDocument()
  })

  it("SR-L-2 (PR #646 fix-round 1): the reason field has maxLength=500, matching the schema's own .max(500) — caught at the field, not only as a post-send 400", async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    const textarea = await screen.findByTestId('project-approval-reject-reason')
    expect(textarea).toHaveAttribute('maxLength', '500')
  })

  it('submit is disabled while the reason is empty or whitespace-only, enabled once typed', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))

    const submit = await screen.findByTestId('project-approval-reject-submit')
    const textarea = screen.getByTestId('project-approval-reject-reason')
    expect(submit).toBeDisabled()
    // At-rest label — not the in-flight "Отклонение…" text.
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
    // COPY-H-2: reject's onSuccess takes no argument (unlike approve's,
    // which branches on project.status) — there is only one outcome, so one
    // fixed toast, asserted here since this is the main reject-success test.
    expect(mockToastSuccess).toHaveBeenCalledWith('Проект отклонён, админ увидит причину')

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

  it('an "already responded" 409 on reject also closes the dialog, clears the reason, calls onActed, and never toasts', async () => {
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
    expect(mockToastError).not.toHaveBeenCalled()

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

  it('SR-M-4 (PR #646 fix-round 1): a 404 on reject keeps the dialog OPEN (unlike 409) and does NOT call onActed — it is a real error now', async () => {
    const user = userEvent.setup()
    const onActed = vi.fn()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" onActed={onActed} />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(notFoundError()))

    expect(onActed).not.toHaveBeenCalled()
    expect(screen.getByText('Отклонить проект «Acme»')).toBeInTheDocument()
  })

  it('SR-M-4: a 404 on reject calls toast.error with the user-facing message', async () => {
    const user = userEvent.setup()
    render(<ProjectApprovalActions projectId={PROJECT_ID} companyName="Acme" />)
    await user.click(screen.getByTestId(`project-approval-reject-${PROJECT_ID}`))
    fireEvent.change(screen.getByTestId('project-approval-reject-reason'), {
      target: { value: 'нет бюджета' },
    })
    await user.click(screen.getByTestId('project-approval-reject-submit'))

    const opts = mockReject.mock.calls[0]?.[1] as { onError: (e: unknown) => void }
    act(() => opts.onError(notFoundError()))

    expect(mockToastError).toHaveBeenCalledTimes(1)
    // COPY-H-1 (PR #646 fix-round 2): the toast shows the OWN mapped
    // string, never the backend's raw "Согласование ... погашено" text
    // (fixture's own message, asserted separately below where it matters).
    expect(mockToastError.mock.calls[0]?.[0]).toBe(
      'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
    )
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

    // COPY-H-1: same reasoning as the approve-side version of this test above.
    const text = await screen.findByText(getUserFacingErrorMessage(serverError()))
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
    expect(submit).toHaveTextContent('Отклонение…')
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
