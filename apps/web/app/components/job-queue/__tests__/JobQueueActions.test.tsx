/** r5 Task 7.4 — the vacancy card's actions (spec §5.3, §5.6–§5.9) on the rendered card. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { openOriginalPosting } from '@/components/job-sourcing/open-original'
import {
  jobQueueScopeKey,
  useJobQueueCard,
  useJobQueueSeniors,
  useJobQueueSources,
  type QueueScopeSignature,
} from '@/hooks/use-job-queue'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { JobQueueCard } from '../JobQueueCard'
import { JOB_QUEUE_TOAST } from '../JobQueueActions'
import {
  cardFixture,
  idleContinuation,
  OPP,
  PRIMARY_SRC,
  senior,
  submission,
} from './card-fixtures'

const post = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { post: (...args: unknown[]) => post(...args), delete: vi.fn(), get: vi.fn() },
}))
vi.mock('@/hooks/use-job-queue', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-job-queue')>()),
  useJobQueueCard: vi.fn(),
  useJobQueueSeniors: vi.fn(),
  useJobQueueSources: vi.fn(),
}))
vi.mock('@/components/job-sourcing/open-original', async (orig) => ({
  ...(await orig<typeof import('@/components/job-sourcing/open-original')>()),
  openOriginalPosting: vi.fn(() => true),
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_TEAM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OLENA = 'aaaaaaaa-0000-4000-8000-000000000001'
const PETRO = 'aaaaaaaa-0000-4000-8000-000000000002'
const HR: QueueScopeSignature = { actorId: 'actor', role: 'HR', teamId: TEAM }
const ADMIN: QueueScopeSignature = { actorId: 'admin', role: 'ADMIN', teamId: null }
const CONFLICT_TEXT = 'Дані змінилися. Оновіть картку й повторіть.'

const cardHook = vi.mocked(useJobQueueCard)
const toastFn = vi.mocked(toast as unknown as ReturnType<typeof vi.fn>)

const httpError = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, data },
})
const coded = (status: number, code: string) =>
  httpError(status, { statusCode: status, code, message: code })
const DUPLICATE = httpError(409, {
  code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
  possibleDuplicates: {
    items: [
      {
        opportunityId: '99999999-9999-4999-8999-999999999999',
        title: 'Same role',
        companyName: 'Acme',
      },
    ],
    totalCount: 1,
  },
})

const taken = (seniorId = PETRO) => ({ submission: submission({ seniorId, state: 'TAKEN' }) })
const submitted = () => ({ data: { submission: submission() } })
const dismissed = (version: number, scope: 'TEAM' | 'STUDIO' = 'TEAM') => ({
  data: { opportunityId: OPP, scope, reason: 'SPAM', hidden: true, version },
})

/** Calls to one route, in order. */
const sent = (path: string) =>
  post.mock.calls.filter(([url]) => url === path).map(([, body]) => body as Record<string, unknown>)
const SUBMIT = `/job-queue/${OPP}/submissions`

let client: QueryClient
let refetch: ReturnType<typeof vi.fn>

function setCard(card: JobQueueCardResponseDto) {
  cardHook.mockReturnValue({
    data: card,
    accessLost: false,
    isPending: false,
    isError: false,
    refetch,
  } as never)
}

function renderCard(scope: QueueScopeSignature = HR, onClose = vi.fn()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
  const view = render(<JobQueueCard scope={scope} opportunityId={OPP} onClose={onClose} />, {
    wrapper,
  })
  const rerender = (next: QueueScopeSignature = scope) =>
    view.rerender(<JobQueueCard scope={next} opportunityId={OPP} onClose={onClose} />)
  return { ...view, onClose, rerender }
}

const submitButton = (seniorId = OLENA) => screen.getByTestId(`job-queue-submit-${seniorId}`)

function twoSeniors(over: Partial<JobQueueCardResponseDto> = {}) {
  return cardFixture({
    seniors: {
      items: [senior(), senior({ seniorId: PETRO, displayName: 'Петро Шевченко' })],
      totalCount: 2,
      nextCursor: null,
    },
    ...over,
  })
}

beforeEach(async () => {
  post.mockReset()
  post.mockResolvedValue({ data: {} })
  toastFn.mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  vi.mocked(openOriginalPosting).mockClear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  refetch = vi.fn(() => Promise.resolve())
  cardHook.mockReset()
  setCard(cardFixture())
  vi.mocked(useJobQueueSeniors).mockReturnValue(idleContinuation() as never)
  vi.mocked(useJobQueueSources).mockReturnValue(idleContinuation() as never)
  await loadCatalog('uk')
})

describe('«Записати подачу» (AC 1, AC 2)', () => {
  it('one primary action per untouched senior, named by the senior; none on a submitted one', () => {
    setCard(
      cardFixture({
        seniors: {
          items: [senior(), senior({ seniorId: PETRO, displayName: 'Петро', ...taken() })],
          totalCount: 2,
          nextCursor: null,
        },
      }),
    )
    renderCard()
    const buttons = screen.getAllByRole('button', { name: /^Записати подачу/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toBe(submitButton())
    expect(buttons[0]).toHaveAccessibleName('Записати подачу: Олена Коваль')
    expect(buttons[0]).toHaveTextContent('Записати подачу')
    expect(screen.queryByTestId(`job-queue-submit-${PETRO}`)).toBeNull()
  })

  it('posts the card revision; a double click sends one request; disabled with a spinner until it settles', async () => {
    let settle!: (value: unknown) => void
    post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    renderCard()
    fireEvent.click(submitButton())
    fireEvent.click(submitButton())
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(1))
    expect(sent(SUBMIT)[0]).toMatchObject({
      teamId: TEAM,
      seniorId: OLENA,
      expectedOpportunityRevision: 3,
    })
    expect(sent(SUBMIT)[0]).not.toHaveProperty('expectedVersion')
    expect(sent(SUBMIT)[0]).not.toHaveProperty('confirmPossibleDuplicate')
    // QA-MED-1 / UX-L-2: unavailable but not `disabled`, so a browser keeps the focus on it
    await waitFor(() => expect(submitButton()).toHaveAttribute('aria-disabled', 'true'))
    expect(submitButton()).not.toBeDisabled()
    expect(submitButton()).toHaveAttribute('aria-busy', 'true')
    expect(submitButton()).toHaveClass('aria-disabled:pointer-events-none')
    expect(submitButton()).toHaveTextContent('Записуємо…')
    await act(async () => settle(submitted()))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Подачу записано: Олена Коваль', JOB_QUEUE_TOAST),
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    ['HR', HR],
    ['ADMIN', ADMIN],
  ])(
    'QA-LOW-1 (plan r5: a submission is a fact about the senior, shown to every team without a name) — %s: a senior submitted by another team offers no write',
    (_, scope) => {
      setCard(
        cardFixture({
          seniors: {
            items: [senior({ submission: { submittedElsewhere: true } })],
            totalCount: 1,
            nextCursor: null,
          },
        }),
      )
      renderCard(scope)
      expect(screen.queryByTestId(`job-queue-submit-${OLENA}`)).toBeNull()
      expect(screen.queryByRole('button', { name: /Дії адміністратора:/ })).toBeNull()
      expect(screen.queryByTestId('job-queue-apply-first')).toBeNull()
    },
  )

  it('a released own submission is re-submitted with its version', async () => {
    setCard(
      cardFixture({
        seniors: {
          items: [senior({ submission: submission({ state: 'RELEASED', version: 4 }) })],
          totalCount: 1,
          nextCursor: null,
        },
      }),
    )
    renderCard()
    fireEvent.click(submitButton())
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(1))
    expect(sent(SUBMIT)[0]).toMatchObject({ expectedVersion: 4, expectedOpportunityRevision: 3 })
  })

  it('a 409 conflict refreshes the card and shows the one note, naming nobody; the same action retries', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    renderCard()
    fireEvent.click(submitButton())
    const note = await screen.findByTestId('job-queue-conflict')
    expect(note).toHaveTextContent(CONFLICT_TEXT)
    expect(note).toHaveTextContent(/^Дані змінилися\. Оновіть картку й повторіть\.$/)
    expect(note).toHaveAttribute('role', 'alert')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobQueueScopeKey(HR) })
    expect(toast.error).not.toHaveBeenCalled()
    await waitFor(() => expect(submitButton()).toBeEnabled())
    fireEvent.click(submitButton())
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(2))
    await waitFor(() => expect(screen.queryByTestId('job-queue-conflict')).toBeNull())
  })

  it('an idempotency conflict reads the same as a version conflict', async () => {
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_IDEMPOTENCY_CONFLICT'))
    renderCard()
    fireEvent.click(submitButton())
    expect(await screen.findByTestId('job-queue-conflict')).toHaveTextContent(CONFLICT_TEXT)
  })

  it('UX-L-3: every toast of the submit flow carries the 44 px mobile targets', async () => {
    post.mockRejectedValueOnce(httpError(500, {}))
    renderCard()
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Не вдалося записати подачу. Спробуйте ще раз.',
        JOB_QUEUE_TOAST,
      ),
    )
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Подачу записано: Олена Коваль', JOB_QUEUE_TOAST),
    )
  })

  it("UX-L-2: after the actor's own write meets a newer revision, focus lands on «Оновити картку»", async () => {
    setCard(twoSeniors())
    const { rerender } = renderCard()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    // a real click focuses the button it presses
    act(() => submitButton().focus())
    fireEvent.click(submitButton())
    await screen.findByTestId('job-queue-conflict')
    setCard(twoSeniors({ revision: 4 }))
    rerender()
    expect(screen.getByRole('button', { name: 'Оновити картку' })).toHaveFocus()
  })

  it('UX-L-2: a newer revision nobody acted on does not steal focus', () => {
    setCard(twoSeniors())
    const { rerender } = renderCard()
    setCard(twoSeniors({ revision: 4 }))
    rerender()
    expect(screen.getByRole('button', { name: 'Оновити картку' })).not.toHaveFocus()
  })

  it('QA-MED-1 (r3): Escape while a plain «Записати подачу» is pending keeps the card open; once settled it closes', async () => {
    const user = userEvent.setup()
    let settle!: (value: unknown) => void
    post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const { onClose } = renderCard()
    await user.click(submitButton())
    await waitFor(() => expect(submitButton()).toHaveAttribute('aria-busy', 'true'))
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => settle(submitted()))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('QA-MED-1 (r3): a submit that lands after the card closed still shows its success', async () => {
    let settle!: (value: unknown) => void
    post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const view = renderCard()
    fireEvent.click(submitButton())
    view.unmount()
    await act(async () => settle(submitted()))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Подачу записано: Олена Коваль', JOB_QUEUE_TOAST),
    )
  })

  it('QA-MED-1 (r3): a submit that fails after the card closed still shows its failure', async () => {
    let fail!: (reason: unknown) => void
    post.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)))
    const view = renderCard()
    fireEvent.click(submitButton())
    view.unmount()
    await act(async () => fail(httpError(400, {})))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Не вдалося записати подачу. Спробуйте ще раз.',
        JOB_QUEUE_TOAST,
      ),
    )
  })

  it('UX-M-1 (r3): a press inside the toaster is not "outside" the card; any other outside press closes it', async () => {
    const { onClose } = renderCard()
    const toaster = document.createElement('ol')
    toaster.setAttribute('data-sonner-toaster', '')
    const close = document.createElement('button')
    toaster.append(close)
    const elsewhere = document.createElement('button')
    document.body.append(toaster, elsewhere)
    // Radix registers its outside listener a tick after mount, and a modal dismisses on the click
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    const press = (target: Element) => {
      fireEvent.pointerDown(target)
      fireEvent.click(target)
    }
    press(close)
    expect(onClose).not.toHaveBeenCalled()
    press(elsewhere)
    expect(onClose).toHaveBeenCalledTimes(1)
    toaster.remove()
    elsewhere.remove()
  })

  it('a failed write toasts the failure and the same button sends again', async () => {
    post.mockRejectedValueOnce(httpError(500, {}))
    renderCard()
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Не вдалося записати подачу. Спробуйте ще раз.',
        JOB_QUEUE_TOAST,
      ),
    )
    expect(screen.queryByTestId('job-queue-conflict')).toBeNull()
    await waitFor(() => expect(submitButton()).toBeEnabled())
    fireEvent.click(submitButton())
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(2))
  })

  it('a lost card (404) is left to the close: no failure toast from the button', async () => {
    post.mockRejectedValueOnce(coded(404, 'JOB_OPPORTUNITY_NOT_FOUND'))
    renderCard()
    fireEvent.click(submitButton())
    await waitFor(() => expect(submitButton()).toBeEnabled())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('seniors are independent: one in flight leaves the other enabled', async () => {
    setCard(twoSeniors())
    post.mockReturnValueOnce(new Promise(() => {}))
    renderCard()
    fireEvent.click(submitButton(OLENA))
    await waitFor(() => expect(submitButton(OLENA)).toHaveAttribute('aria-disabled', 'true'))
    expect(submitButton(PETRO)).toBeEnabled()
    expect(submitButton(PETRO)).toHaveTextContent('Записати подачу')
    fireEvent.click(submitButton(PETRO))
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(2))
    expect(sent(SUBMIT).map((body) => body.seniorId)).toEqual([OLENA, PETRO])
  })

  it('two teams are independent: another team scope posts its own team with its own key', async () => {
    post.mockReturnValueOnce(new Promise(() => {}))
    const { rerender } = renderCard(HR)
    fireEvent.click(submitButton())
    await waitFor(() => expect(submitButton()).toHaveAttribute('aria-disabled', 'true'))
    rerender({ ...HR, teamId: OTHER_TEAM })
    await waitFor(() => expect(submitButton()).toBeEnabled())
    fireEvent.click(submitButton())
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(2))
    const [first, second] = sent(SUBMIT)
    expect(first).toMatchObject({ teamId: TEAM })
    expect(second).toMatchObject({ teamId: OTHER_TEAM })
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey)
  })
})

describe('possible-duplicate confirm (AC 3, §5.8)', () => {
  async function openConfirm() {
    post.mockRejectedValueOnce(DUPLICATE)
    const view = renderCard()
    fireEvent.click(submitButton())
    const confirm = await screen.findByTestId(`job-queue-duplicate-confirm-${OLENA}`)
    return { ...view, confirm }
  }

  it('the 409 expands the senior block inline: «Не записувати» is primary and takes focus', async () => {
    const { confirm } = await openConfirm()
    expect(
      within(screen.getByTestId(`job-queue-senior-${OLENA}`)).getByTestId(
        `job-queue-duplicate-confirm-${OLENA}`,
      ),
    ).toBe(confirm)
    expect(screen.queryByTestId(`job-queue-submit-${OLENA}`)).toBeNull()
    expect(confirm).toHaveTextContent('Цього сеньйора вже подано на схожу вакансію')
    expect(confirm).toHaveTextContent('Ви впевнені, що це інша вакансія?')
    const keep = within(confirm).getByRole('button', { name: 'Не записувати' })
    await waitFor(() => expect(keep).toHaveFocus())
    // the safe choice is the filled (primary) button, the override the outline one
    expect(keep).toHaveClass('bg-primary')
    const anyway = within(confirm).getByRole('button', { name: 'Так, записати все одно' })
    expect(anyway).toHaveClass('border')
    expect(anyway).not.toHaveClass('bg-primary')
    expect(confirm).not.toHaveTextContent('Скасувати')
    expect(toast.error).not.toHaveBeenCalled()
    // UX-L-3 (card-dupconfirm-320.png): stacked at content width on mobile, not stretched
    // the layout lives on the buttons' row, which has no role of its own
    // eslint-disable-next-line testing-library/no-node-access
    expect(keep.parentElement).toHaveClass('items-start', 'sm:flex-row')
  })

  it('«Так, записати все одно» re-sends the same submission confirmed', async () => {
    const { confirm } = await openConfirm()
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(2))
    expect(sent(SUBMIT)[1]).toMatchObject({
      seniorId: OLENA,
      expectedOpportunityRevision: 3,
      confirmPossibleDuplicate: true,
    })
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Подачу записано: Олена Коваль', JOB_QUEUE_TOAST),
    )
  })

  it('CR-L-1: while the confirmed request runs, «Не записувати» is unavailable too (and does nothing)', async () => {
    const { confirm, onClose } = await openConfirm()
    let settle!: (value: unknown) => void
    post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    const keep = within(confirm).getByRole('button', { name: 'Не записувати' })
    await waitFor(() => expect(keep).toHaveAttribute('aria-disabled', 'true'))
    fireEvent.click(keep)
    expect(screen.getByTestId(`job-queue-duplicate-confirm-${OLENA}`)).toBeInTheDocument()
    await act(async () => settle(submitted()))
    expect(onClose).not.toHaveBeenCalled()
  })

  // QA-MED-1: a real browser moves focus off a `disabled` button to <body>, outside the
  // `[data-escape-scope]` the card spares, so Escape closed the card mid-request. jsdom does not
  // blur a disabled button, so this asserts the mechanism: the focused buttons are never `disabled`.
  it('QA-MED-1: while the confirmed request runs, focus stays in the confirm and Escape keeps the card open', async () => {
    const user = userEvent.setup()
    const { confirm, onClose } = await openConfirm()
    let settle!: (value: unknown) => void
    post.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const anyway = within(confirm).getByRole('button', { name: 'Так, записати все одно' })
    await user.click(anyway)
    await waitFor(() => expect(anyway).toHaveAttribute('aria-busy', 'true'))
    expect(anyway).not.toBeDisabled()
    expect(within(confirm).getByRole('button', { name: 'Не записувати' })).not.toBeDisabled()
    // UX-L-2 (r3): the house pattern for a pending control, no hover feedback
    for (const pendingButton of within(confirm).getAllByRole('button'))
      expect(pendingButton).toHaveClass('aria-disabled:pointer-events-none')
    expect(anyway).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId(`job-queue-duplicate-confirm-${OLENA}`)).toBeInTheDocument()
    fireEvent.click(anyway)
    expect(sent(SUBMIT)).toHaveLength(2)
    await act(async () => settle(submitted()))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Подачу записано: Олена Коваль', JOB_QUEUE_TOAST),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  // CR-M-3: in a real browser Radix FocusScope parks focus on the dialog container when the focused
  // confirm button unmounts. That is not "the actor moved on": the restore still lands on the senior.
  it('CR-M-3: focus parked on the card dialog after a confirmed success still returns to the senior', async () => {
    const { confirm, rerender } = await openConfirm()
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    act(() => screen.getByTestId('job-queue-card').focus())
    setCard(
      cardFixture({ seniors: { items: [senior(taken(OLENA))], totalCount: 1, nextCursor: null } }),
    )
    rerender()
    await waitFor(() => expect(screen.getByTestId(`job-queue-senior-${OLENA}`)).toHaveFocus())
  })

  it('P2-1: once the actor focuses another control, even inside the senior row, focus is not pulled back', async () => {
    const { confirm, rerender } = await openConfirm()
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await waitFor(() => expect(submitButton()).toHaveFocus())
    // a second control in the row (the ADMIN «⋯» is one); added by hand to keep the setup HR-only
    const other = document.createElement('button')
    screen.getByTestId(`job-queue-senior-${OLENA}`).append(other)
    act(() => other.focus())
    rerender()
    expect(other).toHaveFocus()
    setCard(
      cardFixture({ seniors: { items: [senior(taken(OLENA))], totalCount: 1, nextCursor: null } }),
    )
    rerender()
    expect(other).toHaveFocus()
  })

  it('UX-M-1 / UX-L-1: the confirm subtext and the outline button read on the amber surface', async () => {
    const { confirm } = await openConfirm()
    expect(screen.getByText('Ви впевнені, що це інша вакансія?')).toHaveClass('text-foreground/70')
    expect(within(confirm).getByRole('button', { name: 'Так, записати все одно' })).toHaveClass(
      'border-yellow-muted',
    )
  })

  it('G3-1: a newer revision while the confirm is open disables «Так, записати все одно» only', async () => {
    const { confirm, rerender } = await openConfirm()
    setCard(cardFixture({ revision: 4 }))
    rerender()
    const anyway = within(confirm).getByRole('button', { name: 'Так, записати все одно' })
    expect(anyway).toBeDisabled()
    fireEvent.click(anyway)
    expect(sent(SUBMIT)).toHaveLength(1)
    const keep = within(confirm).getByRole('button', { name: 'Не записувати' })
    expect(keep).toBeEnabled()
    fireEvent.click(keep)
    expect(screen.queryByTestId(`job-queue-duplicate-confirm-${OLENA}`)).toBeNull()
  })

  it('G3-1: a vacancy closed while the confirm is open disables «Так, записати все одно» too', async () => {
    const { confirm, rerender } = await openConfirm()
    setCard(cardFixture({ availability: 'CLOSED' }))
    rerender()
    expect(within(confirm).getByRole('button', { name: 'Так, записати все одно' })).toBeDisabled()
  })

  it('CR note: a senior submitted elsewhere on the refetch settles the restore; focus is not pulled back later', async () => {
    const { confirm, rerender } = await openConfirm()
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    setCard(
      cardFixture({
        seniors: {
          items: [senior({ submission: { submittedElsewhere: true } })],
          totalCount: 1,
          nextCursor: null,
        },
      }),
    )
    rerender()
    expect(screen.getByTestId(`job-queue-senior-${OLENA}`)).toHaveFocus()
    const card = screen.getByTestId('job-queue-card')
    act(() => card.focus())
    rerender()
    expect(card).toHaveFocus()
  })

  it('CR-L-2: a confirmed success puts focus on the senior: its button, then its row once submitted', async () => {
    const { confirm, rerender } = await openConfirm()
    post.mockResolvedValueOnce(submitted())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await waitFor(() => expect(submitButton()).toHaveFocus())
    // the refetch: the senior is submitted, the button is gone, the row keeps the focus
    setCard(
      cardFixture({ seniors: { items: [senior(taken(OLENA))], totalCount: 1, nextCursor: null } }),
    )
    rerender()
    await waitFor(() => expect(screen.getByTestId(`job-queue-senior-${OLENA}`)).toHaveFocus())
  })

  it('CR-L-2: a confirmed request that fails returns focus to «Записати подачу»', async () => {
    const { confirm } = await openConfirm()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Так, записати все одно' }))
    await screen.findByTestId('job-queue-conflict')
    await waitFor(() => expect(submitButton()).toHaveFocus())
  })

  it('«Не записувати» cancels without a request and returns focus to «Записати подачу»', async () => {
    const { confirm } = await openConfirm()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Не записувати' }))
    await waitFor(() => expect(submitButton()).toHaveFocus())
    expect(sent(SUBMIT)).toHaveLength(1)
  })

  it('Escape cancels the confirm only: the card stays open and focus returns to the senior button', async () => {
    const user = userEvent.setup()
    const { confirm, onClose } = await openConfirm()
    await waitFor(() =>
      expect(within(confirm).getByRole('button', { name: 'Не записувати' })).toHaveFocus(),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(submitButton()).toHaveFocus())
    expect(screen.queryByTestId(`job-queue-duplicate-confirm-${OLENA}`)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('job-queue-card')).toBeInTheDocument()
    expect(sent(SUBMIT)).toHaveLength(1)
  })
})

describe('apply-first reminder (AC 4)', () => {
  it('a persistent note under the seniors heading, above the first senior; not a toast', () => {
    renderCard()
    const note = screen.getByTestId('job-queue-apply-first')
    expect(note).toHaveAttribute('role', 'note')
    expect(note).toHaveTextContent(
      'Спершу подайте на сайті джерела («Відкрити оригінал»), потім запишіть подачу тут.',
    )
    expect(
      note.compareDocumentPosition(screen.getByTestId('job-queue-seniors-list')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      within(screen.getByTestId('job-queue-seniors')).getByTestId('job-queue-apply-first'),
    ).toBe(note)
    expect(within(note).queryByRole('button')).toBeNull()
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('stays while one button is still enabled, even with another senior submitted', () => {
    setCard(
      cardFixture({
        seniors: {
          items: [senior(), senior({ seniorId: PETRO, displayName: 'Петро', ...taken() })],
          totalCount: 2,
          nextCursor: null,
        },
      }),
    )
    renderCard()
    expect(screen.getByTestId('job-queue-apply-first')).toBeVisible()
  })

  it('hidden when every senior is already submitted (no enabled button left)', () => {
    setCard(
      cardFixture({
        seniors: { items: [senior(taken(OLENA))], totalCount: 1, nextCursor: null },
      }),
    )
    renderCard()
    expect(screen.queryByTestId('job-queue-apply-first')).toBeNull()
  })
})

describe('blocking notes (AC 5, §5.7)', () => {
  const expectNoEnabledSubmit = async () => {
    const buttons = screen.getAllByRole('button', { name: /^Записати подачу/ })
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) expect(button).toBeDisabled()
    const user = userEvent.setup()
    for (let i = 0; i < 12; i += 1) {
      await user.tab()
      for (const button of buttons) expect(button).not.toHaveFocus()
    }
  }

  it('a newer revision while open blocks every «Записати подачу» until «Оновити картку»', async () => {
    setCard(twoSeniors())
    const { rerender } = renderCard()
    expect(screen.queryByTestId('job-queue-stale')).toBeNull()
    setCard(twoSeniors({ revision: 4 }))
    rerender()
    const note = screen.getByTestId('job-queue-stale')
    expect(note).toHaveAttribute('role', 'alert')
    expect(note).toHaveTextContent('З’явилася новіша версія вакансії')
    expect(note).toHaveTextContent('Ця картка застаріла, тому записати подачу з неї не можна.')
    expect(screen.queryByTestId('job-queue-apply-first')).toBeNull()
    await expectNoEnabledSubmit()
    fireEvent.click(submitButton(OLENA))
    expect(sent(SUBMIT)).toHaveLength(0)

    fireEvent.click(within(note).getByRole('button', { name: 'Оновити картку' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('job-queue-stale')).toBeNull()
    expect(submitButton(OLENA)).toBeEnabled()
    expect(submitButton(PETRO)).toBeEnabled()
    expect(screen.getByTestId('job-queue-apply-first')).toBeVisible()
    fireEvent.click(submitButton(OLENA))
    await waitFor(() => expect(sent(SUBMIT)).toHaveLength(1))
    expect(sent(SUBMIT)[0]).toMatchObject({ expectedOpportunityRevision: 4 })
  })

  it('closed at the source: disabled for good, with the earlier count; a refresh does not lift it', async () => {
    setCard(twoSeniors({ availability: 'CLOSED', submittedSeniorCount: 2 }))
    const { rerender } = renderCard()
    const note = screen.getByTestId('job-queue-closed')
    expect(note).toHaveTextContent('Вакансію закрито на джерелі')
    expect(note).toHaveTextContent('Нові подачі неможливі.')
    expect(note).toHaveTextContent('Раніше подано: 2.')
    expect(within(note).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('job-queue-apply-first')).toBeNull()
    await expectNoEnabledSubmit()
    setCard(twoSeniors({ availability: 'CLOSED', submittedSeniorCount: 2, revision: 5 }))
    rerender()
    expect(screen.queryByTestId('job-queue-stale')).toBeNull()
    expect(submitButton(OLENA)).toBeDisabled()
  })

  it('COPY-M-2: expired blocks like closed but says expired; no earlier count at 0', () => {
    setCard(cardFixture({ availability: 'EXPIRED', submittedSeniorCount: 0 }))
    renderCard()
    const note = screen.getByTestId('job-queue-closed')
    expect(note).toHaveTextContent('Термін вакансії на джерелі минув')
    expect(note).not.toHaveTextContent('закрито')
    expect(note).toHaveTextContent('Нові подачі неможливі.')
    expect(note).not.toHaveTextContent('Раніше подано')
    expect(submitButton()).toBeDisabled()
  })

  it('CR-L-3: a 409 that turns out to be a newer revision shows the stale note only; refresh clears both', async () => {
    setCard(twoSeniors())
    const { rerender } = renderCard()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    fireEvent.click(submitButton())
    await screen.findByTestId('job-queue-conflict')
    // the refetch brings the bumped revision (and the list's own «updated» note)
    setCard(twoSeniors({ revision: 4, newerThanList: true }))
    rerender()
    expect(screen.getByTestId('job-queue-stale')).toBeVisible()
    expect(screen.queryByTestId('job-queue-conflict')).toBeNull()
    expect(screen.queryByTestId('job-queue-card-updated')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Оновити картку' }))
    expect(screen.queryByTestId('job-queue-stale')).toBeNull()
    expect(screen.queryByTestId('job-queue-conflict')).toBeNull()
  })

  it('CR-M-2: focus the actor moved after the 409 is not pulled to «Оновити картку» by the refetch', async () => {
    setCard(twoSeniors())
    const { rerender } = renderCard()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    fireEvent.click(submitButton())
    await screen.findByTestId('job-queue-conflict')
    const other = screen.getByRole('button', { name: 'Відкрити оригінал' })
    act(() => other.focus())
    setCard(twoSeniors({ revision: 4 }))
    rerender()
    expect(screen.getByTestId('job-queue-stale')).toBeVisible()
    expect(other).toHaveFocus()
  })

  it('UX-M-1, UX-L-1, UX-L-2: destructive titles, border-only notes, a refresh icon, a content-width button', () => {
    setCard(twoSeniors({ availability: 'CLOSED' }))
    const closed = renderCard()
    const closedNote = screen.getByTestId('job-queue-closed')
    expect(within(closedNote).getByText('Вакансію закрито на джерелі')).toHaveClass(
      'text-destructive',
    )
    expect(closedNote).not.toHaveClass('bg-destructive/10')
    closed.unmount()

    setCard(twoSeniors())
    const { rerender } = renderCard()
    setCard(twoSeniors({ revision: 4 }))
    rerender()
    const stale = screen.getByTestId('job-queue-stale')
    expect(within(stale).getByText('З’явилася новіша версія вакансії')).toHaveClass(
      'text-destructive',
    )
    expect(stale).not.toHaveClass('bg-destructive/10')
    // the icon is aria-hidden, so no query by role reaches it
    // eslint-disable-next-line testing-library/no-node-access
    expect(stale.querySelector('svg')).toHaveClass('lucide-refresh-cw')
    const refresh = within(stale).getByRole('button', { name: 'Оновити картку' })
    expect(refresh).toHaveClass('min-h-11', 'self-start')
    expect(refresh).not.toHaveClass('w-full')
  })
})

describe('«Відкрити оригінал» (AC 6)', () => {
  it('marks the click once and opens the primary posting inside the same click', () => {
    renderCard()
    const footer = screen.getByTestId('job-queue-card-footer')
    fireEvent.click(within(footer).getByRole('button', { name: 'Відкрити оригінал' }))
    // no await: both run synchronously inside the gesture
    expect(openOriginalPosting).toHaveBeenCalledTimes(1)
    expect(openOriginalPosting).toHaveBeenCalledWith('https://jobs.dou.ua/1')
    expect(sent(`/job-queue/${OPP}/opened`)).toEqual([
      { teamId: TEAM, sourceRecordId: PRIMARY_SRC },
    ])
  })

  it('a manual card opens its application link, with no source to mark', () => {
    setCard(cardFixture({ primarySource: null, applicationUrl: 'https://acme.example/apply' }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити оригінал' }))
    expect(openOriginalPosting).toHaveBeenCalledWith('https://acme.example/apply')
    expect(post).not.toHaveBeenCalled()
  })

  it('no link at all: no button', () => {
    setCard(cardFixture({ primarySource: null, applicationUrl: null }))
    renderCard()
    expect(screen.queryByRole('button', { name: 'Відкрити оригінал' })).toBeNull()
  })
})

describe('«Приховати» (AC 6, §5.9)', () => {
  const DISMISS = `/job-queue/${OPP}/dismiss`
  const UNDO = `/job-queue/${OPP}/undo`

  async function hideAsSpam(scope: QueueScopeSignature = HR) {
    const user = userEvent.setup()
    const { onClose, unmount } = renderCard(scope)
    const trigger = screen.getByRole('button', { name: 'Приховати' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: 'Нерелевантна' })).toHaveFocus(),
    )
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Спам' })).toHaveFocus()
    await user.keyboard('{Enter}')
    return { user, trigger, onClose, unmount }
  }

  /** The undo toast's own action, as sonner would run it. */
  async function lastUndo() {
    await waitFor(() => expect(toastFn).toHaveBeenCalled())
    const [title, options] = toastFn.mock.calls.at(-1) as [
      string,
      { duration: number; action: { label: string; onClick: () => void } },
    ]
    return { title, options }
  }

  it('the menu states the team scope first, then the three fixed reasons', async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Приховати' }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent(/^Буде приховано для вашої команди/)
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Нерелевантна', 'Спам', 'Мертве посилання'])
  })

  it('keyboard: Arrow keys move, Enter picks a reason, the dismiss is scoped, the undo toast lasts 8 s', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    const { onClose } = await hideAsSpam()
    await waitFor(() => expect(sent(DISMISS)).toHaveLength(1))
    expect(sent(DISMISS)[0]).toMatchObject({ teamId: TEAM, scope: 'TEAM', reason: 'SPAM' })
    expect(sent(DISMISS)[0]).not.toHaveProperty('expectedVersion')
    const { title, options } = await lastUndo()
    expect(title).toBe('Приховано')
    expect(options.duration).toBe(8000)
    expect(options.action.label).toBe('Скасувати')
    // the modal card would leave the toast unreachable, so a hide closes it once the toast is up
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the menu without a request and returns focus to «Приховати»', async () => {
    const user = userEvent.setup()
    const { onClose } = renderCard()
    const trigger = screen.getByRole('button', { name: 'Приховати' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger).toHaveFocus()
    expect(post).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('undo restores the item in the same scope with the dismissal version', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    await hideAsSpam()
    const { options } = await lastUndo()
    post.mockResolvedValueOnce({ data: { ...dismissed(3).data, hidden: false } })
    act(() => options.action.onClick())
    await waitFor(() => expect(sent(UNDO)).toHaveLength(1))
    expect(sent(UNDO)[0]).toMatchObject({ teamId: TEAM, scope: 'TEAM', expectedVersion: 2 })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a version change between hide and undo is surfaced, not silently applied', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    await hideAsSpam()
    const { options } = await lastUndo()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    act(() => options.action.onClick())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CONFLICT_TEXT, JOB_QUEUE_TOAST))
    expect(sent(UNDO)).toHaveLength(1)
    expect(sent(UNDO)[0]).toMatchObject({ expectedVersion: 2 })
  })

  it('the undo still answers once the card is gone (a hide closes it)', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    const { unmount } = await hideAsSpam()
    const { options } = await lastUndo()
    unmount()
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    act(() => options.action.onClick())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CONFLICT_TEXT, JOB_QUEUE_TOAST))
    expect(sent(UNDO)[0]).toMatchObject({ teamId: TEAM, scope: 'TEAM', expectedVersion: 2 })
  })

  it('a second hide after an undo carries the version the undo returned', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    const { user, trigger } = await hideAsSpam()
    const { options } = await lastUndo()
    post.mockResolvedValueOnce({ data: { ...dismissed(3).data, hidden: false } })
    act(() => options.action.onClick())
    await waitFor(() => expect(sent(UNDO)).toHaveLength(1))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: 'Нерелевантна' }))
    await waitFor(() => expect(sent(DISMISS)).toHaveLength(2))
    expect(sent(DISMISS)[1]).toMatchObject({ reason: 'NOT_RELEVANT', expectedVersion: 3 })
  })

  it('CR-M-1: the version outlives the card: hide, undo, close, reopen, hide again carries it', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    const { unmount } = await hideAsSpam()
    const { options } = await lastUndo()
    post.mockResolvedValueOnce({ data: { ...dismissed(3).data, hidden: false } })
    act(() => options.action.onClick())
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    // a hide closes the card, so the menu that kept the version is gone before the next hide
    unmount()
    post.mockResolvedValueOnce(dismissed(4))
    await hideAsSpam()
    await waitFor(() => expect(sent(DISMISS)).toHaveLength(2))
    expect(sent(DISMISS)[1]).toMatchObject({ reason: 'SPAM', expectedVersion: 3 })
  })

  it('COPY-M-1: the toast action reads «Скасувати» in uk and "Undo" in en, apart from the shared Cancel', async () => {
    await loadCatalog('en')
    post.mockResolvedValueOnce(dismissed(2))
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Spam' }))
    const { title, options } = await lastUndo()
    expect(title).toBe('Hidden')
    expect(options.action.label).toBe('Undo')
  })

  it('QA-MED-2: the undo action and the close button get 44 px targets on mobile, on this toast only', async () => {
    post.mockResolvedValueOnce(dismissed(2))
    await hideAsSpam()
    const { options } = (await lastUndo()) as unknown as {
      options: { classNames: { actionButton: string; closeButton: string; toast: string } }
    }
    expect(options.classNames.actionButton).toContain('max-sm:min-h-11!')
    // QA-LOW-2: a transparent 44 px hit area around the 20 px circle, not a 44 px circle
    expect(options.classNames.closeButton).toContain('max-sm:before:-inset-3')
    // QA-LOW-2 (r3): the 20 px circle sits inside the toast; the content moves right to clear it
    expect(options.classNames.closeButton).toContain('max-sm:transform-none!')
    expect(options.classNames.closeButton).toContain('max-sm:top-1.5!')
    expect(options.classNames.closeButton).toContain('max-sm:left-1.5!')
    expect(options.classNames.toast).toContain('max-sm:pl-10!')
    expect(options.classNames.closeButton).not.toContain('max-sm:size-11!')
  })

  it('UX-L-3: the hide failure and conflict toasts get the same mobile targets', async () => {
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    await hideAsSpam()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CONFLICT_TEXT, JOB_QUEUE_TOAST))
  })

  it('a failed hide toasts its failure and offers no undo', async () => {
    post.mockRejectedValueOnce(httpError(500, {}))
    const { onClose } = await hideAsSpam()
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Не вдалося приховати вакансію. Спробуйте ще раз.',
        JOB_QUEUE_TOAST,
      ),
    )
    expect(toastFn).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a hide conflict shows the conflict text', async () => {
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    await hideAsSpam()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CONFLICT_TEXT, JOB_QUEUE_TOAST))
  })

  it('ADMIN in the studio scope hides for the whole studio', async () => {
    const user = userEvent.setup()
    post.mockResolvedValueOnce(dismissed(1, 'STUDIO'))
    renderCard(ADMIN)
    await user.click(screen.getByRole('button', { name: 'Приховати' }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent(/^Буде приховано для всієї студії/)
    await user.click(within(menu).getByRole('menuitem', { name: 'Мертве посилання' }))
    await waitFor(() => expect(sent(DISMISS)).toHaveLength(1))
    expect(sent(DISMISS)[0]).toMatchObject({ scope: 'STUDIO', reason: 'DEAD_LINK' })
    expect(sent(DISMISS)[0]).not.toHaveProperty('teamId')
  })
})

describe('RBAC: ADMIN menus (AC 6, §5.6)', () => {
  const cardWithSubmitted = () =>
    cardFixture({
      seniors: {
        items: [senior(), senior({ seniorId: PETRO, displayName: 'Петро Шевченко', ...taken() })],
        totalCount: 2,
        nextCursor: null,
      },
    })
  const SENIOR_SCOPE: QueueScopeSignature = { actorId: 's', role: 'SENIOR', teamId: TEAM }

  it('HR: the three own-scope actions, no administrator menu', () => {
    setCard(cardWithSubmitted())
    renderCard(HR)
    expect(submitButton()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Відкрити оригінал' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Приховати' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Дії адміністратора/ })).toBeNull()
    expect(screen.queryByText(/Скасувати подачу/)).toBeNull()
  })

  // SR-L-1: SENIOR has no queue at all (route redirect; API @Roles('ADMIN', 'HR')); this only
  // proves the card itself never draws an administrator menu for a non-ADMIN role
  it('SENIOR (no queue access): the card, were it drawn, renders no administrator menu', () => {
    setCard(cardWithSubmitted())
    renderCard(SENIOR_SCOPE)
    expect(screen.queryByRole('button', { name: /Дії адміністратора/ })).toBeNull()
    expect(screen.queryByText(/Скасувати подачу/)).toBeNull()
  })

  it('ADMIN: the vacancy menu states the studio scope and offers suppress; no reassign', async () => {
    const user = userEvent.setup()
    renderCard(ADMIN)
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора' }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent(/^Буде приховано для всієї студії/)
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Приховати для всіх…'])
  })

  it('ADMIN: suppress asks first, the safe button takes focus, confirming suppresses and closes', async () => {
    const user = userEvent.setup()
    const { onClose } = renderCard(ADMIN)
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Приховати для всіх…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Приховати для всієї студії?' })
    expect(dialog).toHaveTextContent('Вакансія зникне з черги для всіх команд.')
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Не приховувати' })).toHaveFocus(),
    )
    expect(post).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Приховати для всіх' }))
    await waitFor(() => expect(sent(`/job-queue/${OPP}/suppress`)).toHaveLength(1))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Приховано', JOB_QUEUE_TOAST)
  })

  it('ADMIN: «Не приховувати» keeps the vacancy, with no request', async () => {
    const user = userEvent.setup()
    const { onClose } = renderCard(ADMIN)
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Приховати для всіх…' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Не приховувати' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(post).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ADMIN: a submitted senior gets «⋯» with «Скасувати подачу…», cancelling that submission at its version', async () => {
    const user = userEvent.setup()
    setCard(cardWithSubmitted())
    renderCard(ADMIN)
    expect(screen.queryByRole('button', { name: 'Дії адміністратора: Олена Коваль' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора: Петро Шевченко' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Скасувати подачу…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Скасувати подачу…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Скасувати подачу?' })
    expect(dialog).toHaveTextContent(
      'Подачу «Петро Шевченко» буде скасовано. Записати її можна буде знову.',
    )
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Залишити' })).toHaveFocus(),
    )
    post.mockResolvedValueOnce({
      data: { submission: submission({ seniorId: PETRO, state: 'RELEASED', version: 2 }) },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати подачу' }))
    const path = `/job-queue/${OPP}/submissions/${submission().id}/cancel`
    await waitFor(() => expect(sent(path)).toHaveLength(1))
    expect(sent(path)[0]).toMatchObject({ expectedVersion: 1 })
    expect(sent(path)[0]).not.toHaveProperty('teamId')
  })

  it('UX-L-4: after a cancel the «⋯» goes away with the refetch; focus lands on that senior’s new button', async () => {
    const user = userEvent.setup()
    setCard(cardWithSubmitted())
    const { rerender } = renderCard(ADMIN)
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора: Петро Шевченко' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Скасувати подачу…' }))
    post.mockResolvedValueOnce({
      data: {
        submission: submission({
          seniorId: PETRO,
          state: 'RELEASED',
          version: 2,
          cancelledAt: '2026-11-10T10:00:00.000Z',
        }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Скасувати подачу' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    // the refetch: the submission is released, so the senior gets «Записати подачу» back
    setCard(twoSeniors())
    rerender()
    await waitFor(() => expect(submitButton(PETRO)).toHaveFocus())
  })

  it('QA-LOW-1 (r3): focus Radix returns to the senior\u2019s own «⋯» is not a choice; it still lands on the new button', async () => {
    const user = userEvent.setup()
    setCard(cardWithSubmitted())
    const { rerender } = renderCard(ADMIN)
    const trigger = screen.getByRole('button', { name: 'Дії адміністратора: Петро Шевченко' })
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: 'Скасувати подачу…' }))
    post.mockResolvedValueOnce({
      data: {
        submission: submission({
          seniorId: PETRO,
          state: 'RELEASED',
          version: 2,
          cancelledAt: '2026-11-10T10:00:00.000Z',
        }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Скасувати подачу' }))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    act(() => trigger.focus())
    rerender()
    setCard(twoSeniors())
    rerender()
    expect(submitButton(PETRO)).toHaveFocus()
  })

  it('ADMIN: a cancel conflict shows the one conflict note', async () => {
    const user = userEvent.setup()
    setCard(cardWithSubmitted())
    renderCard(ADMIN)
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    await user.click(screen.getByRole('button', { name: 'Дії адміністратора: Петро Шевченко' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Скасувати подачу…' }))
    await user.click(await screen.findByRole('button', { name: 'Скасувати подачу' }))
    expect(await screen.findByTestId('job-queue-conflict')).toHaveTextContent(CONFLICT_TEXT)
  })
})

describe('touch targets and layout (AC 8)', () => {
  it('every card action is at least 44 px tall on mobile; the senior button is full width there', () => {
    setCard(
      cardFixture({
        seniors: {
          items: [senior(), senior({ seniorId: PETRO, displayName: 'Петро', ...taken() })],
          totalCount: 2,
          nextCursor: null,
        },
      }),
    )
    renderCard(ADMIN)
    expect(submitButton()).toHaveClass('min-h-11', 'w-full', 'sm:w-auto')
    for (const name of ['Відкрити оригінал', 'Приховати']) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11')
    }
    expect(screen.getByRole('button', { name: 'Дії адміністратора' })).toHaveClass('size-11')
    expect(screen.getByRole('button', { name: 'Дії адміністратора: Петро' })).toHaveClass('size-11')
  })
})
