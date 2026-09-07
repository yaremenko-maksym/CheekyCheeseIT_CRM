/**
 * task-648-fix-round-2 (SR-H-2 / SPEC-H-2 / CR-H-3 / UX-H-3(r2) / QA-HIGH-2).
 *
 * The withdraw control's own behaviour, independent of either surface that
 * embeds it: which URL each scope posts to, what the success toast names, how
 * a 404/409 from a proposal someone else already resolved is worded, and that
 * a failure still refetches (so a dead button does not stay on screen looking
 * alive — QA-MED-5's lesson from round 1, applied to the new mutation).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

const mockPost = vi.fn()
vi.mock('@/lib/axios', () => ({ api: { post: (...a: unknown[]) => mockPost(...a) } }))

import {
  CancelPendingShareButton,
  PendingShareEditNotice,
  pendingShareAudience,
} from '../cancel-pending-share'

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
  return { qc, invalidateSpy }
}

/**
 * task-648-fix-round-3 (COPY-M-14): withdrawing now takes TWO gestures — the
 * button opens a confirmation, the confirmation performs it. Every test below
 * that used to click once goes through this helper, so "the request fires"
 * keeps meaning "the operator actually confirmed", not "the operator brushed
 * a button".
 */
async function withdraw(
  user: ReturnType<typeof userEvent.setup>,
  scope: 'user' | 'project' | 'user-in-dialog' | 'project-in-dialog',
) {
  await user.click(screen.getByTestId(`cancel-pending-share-${scope}`))
  await user.click(await screen.findByTestId(`cancel-pending-share-confirm-button-${scope}`))
}

describe('CancelPendingShareButton — the URL each scope posts to', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
  })

  it('user scope posts to the users endpoint', async () => {
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/users/senior-1/senior-share/cancel'),
    )
  })

  it('project scope posts to the projects endpoint', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 30 } })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="project" id="proj-1" pendingPercent={55} />)
    await withdraw(user, 'project')
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/projects/proj-1/senior-share/cancel'),
    )
  })
})

describe('CancelPendingShareButton — what the operator is told', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('names the percent the SERVER settled on, from the users response shape', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует 26%'),
    )
  })

  it('names it from the PROJECT response shape, which carries a different field', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 30 } })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="project" id="proj-1" pendingPercent={55} />)
    await withdraw(user, 'project')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует 30%'),
    )
  })

  it('falls back to a number-free sentence when the response carries no percent', async () => {
    mockPost.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует прежний процент'),
    )
  })

  it('maps a 404 (already resolved elsewhere) to the shared friendly wording', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: 'Подтверждение не найдено или уже закрыто' } },
    })
    const user = userEvent.setup()
    const { invalidateSpy } = renderWithClient(
      <CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />,
    )
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
      ),
    )
    // QA-MED-5's lesson: refetch on FAILURE too, or a proposal resolved
    // elsewhere leaves a live-looking button.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'senior-1'] })
  })

  it('uses its OWN last-resort wording, not the generic one', async () => {
    mockPost.mockRejectedValue({})
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Не удалось отменить предложение'))
  })

  it('a response with no body at all still yields the number-free sentence', async () => {
    // `?.` on the narrowing casts is load-bearing exactly here — the server
    // could 201 with an empty body and the toast must not throw.
    mockPost.mockResolvedValue({ data: undefined })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует прежний процент'),
    )
  })

  it('the same, on the project scope', async () => {
    mockPost.mockResolvedValue({ data: undefined })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="project" id="proj-1" pendingPercent={55} />)
    await withdraw(user, 'project')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует прежний процент'),
    )
  })

  it('a NULL percent is treated as "no number", not printed as null', async () => {
    // The project DTO's `effectiveSeniorSharePercent` is nullable; «действует
    // null%» would be worse than saying nothing.
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: null } })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="project" id="proj-1" pendingPercent={55} />)
    await withdraw(user, 'project')
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено — действует прежний процент'),
    )
  })

  it('invalidates EVERY user-scope query key the profile surfaces read', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
    const user = userEvent.setup()
    const { invalidateSpy } = renderWithClient(
      <CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />,
    )
    await withdraw(user, 'user')
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    // All four: the profile page, the header's own /me, and both list caches
    // the «Пользователи» screen reads. Missing one leaves a stale индикатор.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'senior-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users-admin'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users'] })
  })

  it('invalidates the PROJECT queries on the project scope, not the profile ones', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 30 } })
    const user = userEvent.setup()
    const { invalidateSpy } = renderWithClient(
      <CancelPendingShareButton scope="project" id="proj-1" pendingPercent={55} />,
    )
    await withdraw(user, 'project')
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects', 'proj-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })
})

describe('PendingShareEditNotice — what the edit dialogs show', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
  })

  it('states the proposed percent, who must answer, and that a new value replaces it', () => {
    renderWithClient(
      <PendingShareEditNotice
        scope="user"
        id="senior-1"
        pendingPercent={40}
        approverName="Олексій Коваленко"
      />,
    )
    const notice = screen.getByTestId('pending-share-edit-notice-user')
    expect(notice).toHaveTextContent('Предложено 40%')
    // task-648-fix-round-3 (COPY-M-15): «ждёт подтверждения <имя>», no colon —
    // the colon made the label read as belonging to the NUMBER.
    expect(notice).toHaveTextContent('ждёт подтверждения Олексій Коваленко')
    expect(notice).toHaveTextContent('Новое значение заменит предложение')
  })

  it('its withdraw button posts to the same endpoint as the icon one', async () => {
    const user = userEvent.setup()
    renderWithClient(
      <PendingShareEditNotice
        scope="project"
        id="proj-1"
        pendingPercent={40}
        approverName="Олексій Коваленко"
      />,
    )
    await withdraw(user, 'project-in-dialog')
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/projects/proj-1/senior-share/cancel'),
    )
  })

  it('names itself while the withdraw is in flight', async () => {
    // Held open on purpose — every other test here resolves too fast for the
    // pending label to be observable.
    let resolvePost!: (v: unknown) => void
    mockPost.mockReturnValue(
      new Promise((res) => {
        resolvePost = res
      }),
    )
    const user = userEvent.setup()
    renderWithClient(
      <PendingShareEditNotice
        scope="user"
        id="senior-1"
        pendingPercent={40}
        approverName="Олексій Коваленко"
      />,
    )
    const button = screen.getByTestId('cancel-pending-share-user-in-dialog')
    expect(button).toHaveTextContent('Отменить предложение')
    await withdraw(user, 'user-in-dialog')
    // task-648-fix-round-3 (COPY-L-12): «Отмена…» sat one dialog away from
    // «Отмена» meaning "close this" — the in-flight label names the process.
    await waitFor(() => expect(button).toHaveTextContent('Отменяем предложение…'))
    resolvePost({ data: { user: { seniorSharePercent: 26 } } })
    await waitFor(() => expect(button).toHaveTextContent('Отменить предложение'))
  })

  // task-648-fix-round-3 (COPY-H-7 / COPY-M-14). This used to read "the ICON
  // button carries an accessible name — it has no visible label", which was
  // the defect, not the property: on touch neither `aria-label` nor `title`
  // surfaces, so the only irreversible control on the screen was an unnamed
  // cross. The name is now the button's own text.
  it('the withdraw button names itself in visible text, not only to a screen reader', () => {
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    const button = screen.getByTestId('cancel-pending-share-user')
    expect(button).toHaveTextContent('Отменить предложение')
    // ...and the visible text IS the accessible name — no `aria-label`
    // shadowing it with something different.
    expect(screen.getByRole('button', { name: 'Отменить предложение' })).toBe(button)
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-3 (COPY-M-14). Withdrawing was one click on an unlabelled
// icon, irreversible, with nothing between the gesture and the loss of a live
// proposal.
// ---------------------------------------------------------------------------
describe('CancelPendingShareButton — the confirmation step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
  })

  it('asks before withdrawing — the first click posts nothing', async () => {
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={45} />)
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    expect(await screen.findByTestId('cancel-pending-share-confirm-user')).toBeInTheDocument()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('names the percent at stake and promises the live share is untouched', async () => {
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={45} />)
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    const dialog = await screen.findByTestId('cancel-pending-share-confirm-user')
    expect(dialog).toHaveTextContent('Отменить предложение 45%?')
    expect(dialog).toHaveTextContent('Действующая доля не изменится')
  })

  it('«Оставить» closes it and withdraws nothing', async () => {
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={45} />)
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    await user.click(await screen.findByTestId('cancel-pending-share-keep-user'))
    await waitFor(() =>
      expect(screen.queryByTestId('cancel-pending-share-confirm-user')).toBeNull(),
    )
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('the in-dialog twin asks the same question, in the same words', async () => {
    const user = userEvent.setup()
    renderWithClient(
      <PendingShareEditNotice
        scope="project"
        id="proj-1"
        pendingPercent={45}
        approverName="Олексій Коваленко"
      />,
    )
    await user.click(screen.getByTestId('cancel-pending-share-project-in-dialog'))
    const dialog = await screen.findByTestId('cancel-pending-share-confirm-project-in-dialog')
    expect(dialog).toHaveTextContent('Отменить предложение 45%?')
    expect(dialog).toHaveTextContent('Действующая доля не изменится')
    expect(mockPost).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-3 (COPY-H-8). The reader test itself, asserted directly
// on the helper both surfaces now share — the two call sites can only stay in
// agreement if the rule has one place to be wrong.
// ---------------------------------------------------------------------------
describe('pendingShareAudience', () => {
  const pending = { approverId: 'a0000000-0000-4000-8000-000000000001' }

  it('nothing pending → null (distinct from "pending, and not yours")', () => {
    expect(pendingShareAudience('anyone', null)).toBeNull()
    expect(pendingShareAudience('anyone', undefined)).toBeNull()
  })

  it('the reader IS the approver → approver', () => {
    expect(pendingShareAudience(pending.approverId, pending)).toBe('approver')
  })

  it('any other reader → observer', () => {
    expect(pendingShareAudience('b0000000-0000-4000-8000-0000000000ff', pending)).toBe('observer')
  })

  it('no reader at all → observer, never approver', () => {
    // `useAuth` returns `null` before the session resolves. A missing viewer
    // must not fall through to first-person copy and action buttons.
    expect(pendingShareAudience(null, pending)).toBe('observer')
    expect(pendingShareAudience(undefined, pending)).toBe('observer')
  })
})

// ---------------------------------------------------------------------------
// task-648-fix-round-3: the indicator button's own in-flight label and the
// confirmation's dismissal. Both were only asserted on the in-dialog twin,
// so the mutation gate could blank this button's label and close-on-confirm
// with every test still green.
// ---------------------------------------------------------------------------
describe('CancelPendingShareButton — in-flight label and dialog dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('names the process while the withdraw is in flight', async () => {
    let resolvePost!: (v: unknown) => void
    mockPost.mockReturnValue(
      new Promise((res) => {
        resolvePost = res
      }),
    )
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    const button = screen.getByTestId('cancel-pending-share-user')
    expect(button).toHaveTextContent('Отменить предложение')
    await withdraw(user, 'user')
    await waitFor(() => expect(button).toHaveTextContent('Отменяем предложение…'))
    resolvePost({ data: { user: { seniorSharePercent: 26 } } })
    await waitFor(() => expect(button).toHaveTextContent('Отменить предложение'))
  })

  it('closes the confirmation once confirmed — it does not stay open over the result', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
    const user = userEvent.setup()
    renderWithClient(<CancelPendingShareButton scope="user" id="senior-1" pendingPercent={55} />)
    await withdraw(user, 'user')
    await waitFor(() =>
      expect(screen.queryByTestId('cancel-pending-share-confirm-user')).toBeNull(),
    )
  })

  it('the in-dialog twin closes its confirmation too', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 26 } } })
    const user = userEvent.setup()
    renderWithClient(
      <PendingShareEditNotice
        scope="user"
        id="senior-1"
        pendingPercent={55}
        approverName="Олексій Коваленко"
      />,
    )
    await withdraw(user, 'user-in-dialog')
    await waitFor(() =>
      expect(screen.queryByTestId('cancel-pending-share-confirm-user-in-dialog')).toBeNull(),
    )
  })
})
