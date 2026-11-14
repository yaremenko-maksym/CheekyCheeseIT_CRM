/**
 * ResumeVerificationPanel — the kept-result line (FR-A-2): a staged run whose check was unavailable
 * comes back AWAITING_CONFIRM on the previous result, and one line says which check failed, that the
 * result was kept, and how to go on (repeat the edit or regenerate it). It offers no Retry: Retry is
 * `submit`, which drops the kept result and starts a full run (8b, FX-1). Split out of ResumeVerificationPanel.test.tsx (at the size cap).
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type ResumeVerificationErrorCode,
  type SeniorResumeDto,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, post: postMock, put: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ResumeVerificationPanel } from '../ResumeVerificationPanel'

const USER = '33333333-3333-4333-8333-333333333333'

function resume(code: ResumeVerificationErrorCode | null): SeniorResumeDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: USER,
    content: EMPTY_RESUME_CONTENT,
    status: 'READY',
    errorCode: null,
    errorMessage: null,
    quotaResetsAt: null,
    sourceFileName: null,
    sourceFileSizeBytes: null,
    hasSourceFile: false,
    version: 3,
    updatedByUserId: null,
    updatedByName: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'classic',
    hasCustomTemplate: false,
    renderStatus: 'READY',
    renderError: null,
    pdfUpToDate: true,
    facts: EMPTY_RESUME_FACTS,
    verificationStatus: 'AWAITING_CONFIRM',
    verificationErrorCode: code,
    verificationReport: { gates: [], fallbacks: [] },
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    staged: {
      runId: '22222222-2222-4222-8222-222222222222',
      content: { ...EMPTY_RESUME_CONTENT, summary: 'Backend engineer.' },
      layout: DEFAULT_RESUME_LAYOUT,
      templateName: 'classic',
      pdfAvailable: true,
      editedPaths: [],
    },
    verificationBusy: false,
  }
}

function renderPanel(dto: SeniorResumeDto, isDirty = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
  return render(
    <ResumeVerificationPanel
      userId={USER}
      resume={dto}
      canConfirm
      onChangeFacts={() => {}}
      isDirty={isDirty}
    />,
    { wrapper: wrap },
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  getMock.mockRejectedValue(new Error('no staged PDF here'))
  postMock.mockResolvedValue({ data: { resume: null, canEdit: true, canConfirm: true } })
  await loadCatalog('uk')
})

describe('the kept-result line (FR-A-2)', () => {
  it('names the unavailable check, says the result was kept and how to go on', async () => {
    renderPanel(resume('WRITER_UNAVAILABLE'))
    const line = await screen.findByTestId('resume-verification-kept')
    expect(line).toHaveTextContent(
      'Сервіс написання тексту недоступний. Попередній результат збережено. Повторіть правку або згенеруйте текст заново.',
    )
    // The kept result stays on screen beside the line.
    expect(screen.getByText('Backend engineer.')).toBeInTheDocument()
  })

  it('no control in the line calls submit; confirm and the staged actions stay', async () => {
    renderPanel(resume('ENTAILMENT_UNAVAILABLE'))
    const line = await screen.findByTestId('resume-verification-kept')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Перевірити ще раз' })).toBeNull()
    expect(screen.getByTestId('resume-confirm')).toBeEnabled()
    expect(screen.getByTestId('resume-confirm-change-facts')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('resume-confirm'))
    expect(postMock).not.toHaveBeenCalledWith(`/users/${USER}/resume/submit`)
  })

  it.each(['VISUAL_CHECK_UNAVAILABLE', 'ENTAILMENT_UNAVAILABLE', 'STALLED'] as const)(
    '%s shows the line too',
    async (code) => {
      renderPanel(resume(code))
      expect(await screen.findByTestId('resume-verification-kept')).toBeInTheDocument()
    },
  )

  it('no line for a clean result or a gate code', async () => {
    const { unmount } = renderPanel(resume(null))
    expect(screen.queryByTestId('resume-verification-kept')).toBeNull()
    unmount()
    const gate = renderPanel(resume('RENDER_FAILED'))
    expect(screen.queryByTestId('resume-verification-kept')).toBeNull()
    gate.unmount()
  })
})
