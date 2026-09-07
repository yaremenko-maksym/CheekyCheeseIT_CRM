/**
 * task-648-fix-round-4 (COPY-M-18) — the project half's refusal path.
 *
 * COPY-M-18 names four addresses where the older vocabulary survived round 3's
 * choice of «предложение». Three of them already sat under a Vitest test
 * (`cancel-pending-share.test.tsx`, `OverviewTab.pending-share.test.tsx`); the
 * fourth — this banner — was reachable only from Playwright.
 *
 * That is not the same thing as being covered. The mutation gate runs the UNIT
 * suite and cannot execute an E2E spec at all — the same mechanism
 * `.claude/rules/common/mutation-gate-integration-specs.md` describes for
 * integration specs — so a mutant that emptied this dialog's title would have
 * survived with the Playwright case green. The Playwright case still verifies
 * the real click path in a real browser; this file is what lets the gate see
 * the two strings.
 *
 * `PendingShareApprovalBanner` is exported for this, exactly as `InfoRow` and
 * `ProjectEditFields` in the same 2000-line route file already are: mounting
 * the whole route to read a dialog title would test the router, not the words.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetailDto } from '@crm/shared'
import { PendingShareApprovalBanner } from '../$projectId'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'

const PROJECT_ID = 'b0000000-0000-4000-8000-000000000001'

const PENDING: NonNullable<ProjectDetailDto['pendingSeniorShare']> = {
  percent: 55,
  effectivePercentAfterApproval: 55,
  approverId: 'a0000000-0000-4000-8000-000000000001',
  approverName: 'Олексій Коваленко',
}

function renderBanner(pending: NonNullable<ProjectDetailDto['pendingSeniorShare']> = PENDING) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidateQueries = vi.spyOn(qc, 'invalidateQueries')
  const utils = render(
    <QueryClientProvider client={qc}>
      <PendingShareApprovalBanner projectId={PROJECT_ID} currentPercent={26} pending={pending} />
    </QueryClientProvider>,
  )
  return { ...utils, invalidateQueries }
}

/*
 * `testing-library/no-node-access` is disabled for THIS FUNCTION ONLY. The
 * rule exists to stop tests coupling to DOM structure instead of querying the
 * way a user does — but what is under test here is the assembled TEXT of one
 * paragraph, spaces included, and `getByText` normalises exactly the
 * whitespace the assertion is about. Same narrow exemption, same reasoning as
 * `InfoRow.structure.test.tsx` in this directory.
 */

function bannerParagraph(): string {
  return screen.getByTestId('pending-share-approval-banner').querySelector('p')?.textContent ?? ''
}

describe('PendingShareApprovalBanner — the refusal path names the proposal', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  // The percent is not what is being rejected — it stays exactly where it was,
  // which is what the toast's own next clause says one line later. What is
  // rejected is the PROPOSAL to change it, and that is the word every other
  // surface of this feature already uses.
  it('the reject dialog is titled by the object it acts on, not by the number', async () => {
    renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-share-reject-button'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Отклонить предложение')
    expect(dialog).not.toHaveTextContent('Отклонить новый процент')
  })

  it('the success toast says the proposal was rejected, and that the old percent still applies', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-reject-button'))
    await user.type(screen.getByTestId('pending-share-reject-reason'), 'договаривались на 30%')
    await user.click(screen.getByTestId('pending-share-reject-confirm'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Предложение отклонено — действует прежний процент. Админ увидит причину',
      ),
    )
    // «Доля» is the thing that did NOT move. Asserted negatively as well as
    // positively so that a future edit cannot quietly reintroduce the second
    // name for one object while keeping this test green on the first clause.
    expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).not.toMatch(/^Доля отклонена/)
  })
})

/*
 * task-648-fix-round-4, second pass — what exporting this component actually
 * cost, and why the answer is more tests rather than fewer.
 *
 * The two cases above were written to let the mutation gate see two strings.
 * They did that — and they also dragged the WHOLE component into the gate's
 * coverage set. Before the export, every line of `PendingShareApprovalBanner`
 * was `NoCoverage` (a warning the gate does not fail on, because it cannot
 * execute the Playwright spec that does cover them). After it, thirty mutants
 * inside the same component became `Survived` — an error — without a single
 * line of product code changing. The gate went red on CI run 34099515930 for
 * exactly that reason.
 *
 * That is a real message, not gate noise: this banner is the actionable
 * money-path surface (a senior confirming or refusing a change to their own
 * share), and until now its only executable proof lived in a browser. The
 * honest repair is to make the unit suite exercise what the E2E exercises —
 * which URL is called, with what body, what the operator is told, and what
 * gets refetched afterwards — not to un-export the component and let thirty
 * lines fall back into the silence the gate tolerates.
 *
 * The Playwright case keeps its job (a real click in a real browser against a
 * real API). These cases are what the gate can run.
 */
describe('PendingShareApprovalBanner — approving', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  it('POSTs to the project approve route and names the value the server confirmed', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { effectiveSeniorSharePercent: 55 } })
    const { invalidateQueries } = renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-approve-button'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/senior-share/approve`),
    )
    // The number comes from the SERVER's resolved answer, never from the
    // proposal the client happened to be holding — the round-1 lesson
    // (COPY-M-3) that this banner's base-share twin also carries.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Доля по проекту теперь 55%'))
    // Both keys, both spellings: the detail query that this page reads and
    // the list query that the projects index reads. A refetch of one and not
    // the other leaves the other screen showing a proposal that is gone.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('maps a 404 to the friendly text and STILL refetches, so a dead banner cannot stay clickable', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 404 } })
    const { invalidateQueries } = renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-approve-button'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Предложение недоступно: оно устарело или адресовано не вам. Обновите страницу.',
      ),
    )
    // QA-MED-5's lesson, stated as an assertion rather than as a comment:
    // refetch on FAILURE too.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] })
  })

  it('names the failed action when the confirmation itself fails', async () => {
    // The approve twin of the reject case below, and needed for the same
    // reason: an error with neither a status nor a message is the only shape
    // that reaches the NAMED fallback. The 404 case above exercises the
    // shared mapping, not this string — which is exactly why the mutation
    // gate could still empty it with every other test green (COPY-L-9's own
    // point: two buttons on this banner can fail, and the house text does not
    // say which one did).
    vi.mocked(api.post).mockRejectedValue({})
    renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-approve-button'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не удалось подтвердить'))
  })

  it('labels its own buttons', () => {
    renderBanner()
    expect(screen.getByTestId('pending-share-approve-button')).toHaveTextContent('Подтвердить')
    expect(screen.getByTestId('pending-share-reject-button')).toHaveTextContent('Отклонить')
  })
})

describe('PendingShareApprovalBanner — the sentence the senior actually reads', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
  })

  /*
   * Asserted as ONE exact string rather than as a handful of `toContainText`
   * fragments. The difference matters here: the copy is assembled from JSX
   * fragments glued by `{' '}`, and every one of those spaces is a string
   * literal a mutant can empty. Fragment assertions pass happily against
   * «сейчас26%, предлагают55%» — the reader, who is being asked to make a
   * decision about their own money, does not.
   */
  it('reads as a comparison when a percent is proposed', () => {
    renderBanner()
    expect(bannerParagraph()).toBe(
      'Вашу долю по проекту предлагают изменить: сейчас 26%, предлагают 55%. ' +
        'Пока вы не подтвердите, действует 26%.',
    )
  })

  it('reads as a removal when the proposal is to clear the override (percent === null)', () => {
    renderBanner({ ...PENDING, percent: null, effectivePercentAfterApproval: 30 })
    // The «станет» number is the SERVER's resolved fallback, not a number the
    // client guessed from a default — the null branch has never computed it
    // and this pins that it still does not.
    expect(bannerParagraph()).toBe(
      'По проекту предлагают снять индивидуальную долю: сейчас 26%, станет 30%. ' +
        'Пока вы не подтвердите, действует 26%.',
    )
  })
})

describe('PendingShareApprovalBanner — the refusal dialog', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  it('opens with an empty reason and the confirm disabled', async () => {
    renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-share-reject-button'))

    expect(await screen.findByTestId('pending-share-reject-reason')).toHaveValue('')
    expect(screen.getByTestId('pending-share-reject-confirm')).toBeDisabled()
    expect(screen.getByTestId('pending-share-reject-confirm')).toHaveTextContent('Отклонить')
  })

  it('treats a reason of only spaces as no reason at all', async () => {
    renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-share-reject-button'))
    await user.type(await screen.findByTestId('pending-share-reject-reason'), '   ')

    // Without the `.trim()` a non-empty string of spaces enables the button
    // and the admin receives a blank explanation — which is the one thing
    // this dialog exists to prevent («Причина обязательна»).
    expect(screen.getByTestId('pending-share-reject-confirm')).toBeDisabled()
  })

  it('«Отмена» closes the dialog without calling anything', async () => {
    renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('pending-share-reject-button'))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'Отмена' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.post).not.toHaveBeenCalled()
  })

  it('POSTs the reason to the reject route, then closes and forgets it', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    const { invalidateQueries } = renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-reject-button'))
    await user.type(
      await screen.findByTestId('pending-share-reject-reason'),
      'договаривались на 30%',
    )
    await user.click(screen.getByTestId('pending-share-reject-confirm'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/senior-share/reject`, {
        reason: 'договаривались на 30%',
      }),
    )
    // Closed, and — reopened — empty again. A reason that survives its own
    // submission is the next refusal's pre-filled text, addressed to a
    // different proposal.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByTestId('pending-share-reject-button'))
    expect(await screen.findByTestId('pending-share-reject-reason')).toHaveValue('')

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('names the failed action when the refusal itself fails', async () => {
    // Deliberately an error carrying NEITHER a status NOR a message: that is
    // the exact shape COPY-L-9 was about. Anything with a `.message` is
    // reported verbatim by `getApiErrorMessage` and never reaches the
    // fallback, so an `new Error('boom')` here would have asserted nothing.
    vi.mocked(api.post).mockRejectedValue({})
    renderBanner()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('pending-share-reject-button'))
    await user.type(await screen.findByTestId('pending-share-reject-reason'), 'нет')
    await user.click(screen.getByTestId('pending-share-reject-confirm'))

    // COPY-L-9: a NAMED fallback. Two buttons on this banner can fail, and
    // the house text does not say which one did.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не удалось отклонить'))
  })
})
