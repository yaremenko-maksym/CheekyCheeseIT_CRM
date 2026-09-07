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

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PendingShareApprovalBanner projectId={PROJECT_ID} currentPercent={26} pending={PENDING} />
    </QueryClientProvider>,
  )
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
