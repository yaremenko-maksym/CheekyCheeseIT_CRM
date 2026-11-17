/**
 * ResumeVerificationPanel — which block each DTO state shows, the progress stages,
 * the toolbar badge, and the small actions (choose template, retry, the stale notice).
 * Split out of ResumeVerificationPanel.test.tsx (at the size cap).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, post: postMock, put: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { FOCUS_REQUEST_TTL_MS } from '../ResumeConfirmStep'
import { templateTileId } from '../ResumeTemplatePicker'
import {
  ResumeVerificationPanel,
  ResumeVerificationProgress,
  VerificationBadge,
} from '../ResumeVerificationPanel'

const USER = '33333333-3333-4333-8333-333333333333'

const STAGED: NonNullable<SeniorResumeDto['staged']> = {
  runId: '22222222-2222-4222-8222-222222222222',
  content: { ...EMPTY_RESUME_CONTENT, summary: 'Backend engineer.' },
  layout: DEFAULT_RESUME_LAYOUT,
  templateName: 'classic',
  pdfAvailable: true,
  editedPaths: [],
}

function dto(overrides: Partial<SeniorResumeDto> = {}): SeniorResumeDto {
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
    verificationErrorCode: null,
    verificationReport: { gates: [], fallbacks: [] },
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    recheckNeededAt: null,
    staged: null,
    verificationBusy: false,
    ...overrides,
  }
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

function panel(resume: SeniorResumeDto, extra?: ReactNode) {
  return (
    <>
      {extra}
      <ResumeVerificationPanel userId={USER} resume={resume} canConfirm onChangeFacts={() => {}} />
    </>
  )
}

function renderPanel(resume: SeniorResumeDto, extra?: ReactNode) {
  const view = render(panel(resume, extra), { wrapper: wrapper() })
  return { ...view, rerenderWith: (next: SeniorResumeDto) => view.rerender(panel(next, extra)) }
}

const STALE_409 = {
  response: {
    status: 409,
    data: { statusCode: 409, code: 'RESUME_CONFIRM_STALE', message: 'stale' },
  },
}

beforeEach(async () => {
  vi.clearAllMocks()
  getMock.mockRejectedValue(new Error('no staged PDF here'))
  postMock.mockResolvedValue({ data: { resume: null, canEdit: true, canConfirm: true } })
  await loadCatalog('uk')
})

describe('which block a state shows', () => {
  const kept = () => screen.queryByTestId('resume-verification-kept')
  const retryAgain = () => screen.queryByRole('button', { name: 'Перевірити ще раз' })

  it.each([
    ['a VERIFIED row', { verificationStatus: 'VERIFIED' as const, staged: STAGED }],
    ['a FAILED row', { verificationStatus: 'FAILED' as const, staged: STAGED }],
    ['a run without a staged result', { staged: null }],
    ['a busy run', { staged: STAGED, verificationBusy: true }],
  ])('no kept-result line for %s, even on an unavailable-check code', (_, overrides) => {
    renderPanel(dto({ verificationErrorCode: 'STALLED', ...overrides }))
    expect(kept()).toBeNull()
  })

  it('AWAITING_CONFIRM without a staged result offers a fresh check, never a dead end', () => {
    renderPanel(dto())
    expect(retryAgain()).toBeEnabled()
  })

  it.each([
    ['a staged result', { staged: STAGED }],
    ['a running check', { verificationBusy: true }],
    ['a DRAFT row', { verificationStatus: 'DRAFT' as const }],
  ])('no fresh-check button with %s', (_, overrides) => {
    renderPanel(dto(overrides))
    expect(retryAgain()).toBeNull()
  })

  it('the fresh check waits while the facts have unsaved changes', () => {
    render(
      <ResumeVerificationPanel
        userId={USER}
        resume={dto()}
        canConfirm
        onChangeFacts={() => {}}
        isDirty
      />,
      { wrapper: wrapper() },
    )
    expect(retryAgain()).toBeDisabled()
  })

  it('the fresh check posts submit; an answer without a resume is no error', async () => {
    renderPanel(dto())
    fireEvent.click(retryAgain()!)
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/users/${USER}/resume/submit`))
    await waitFor(() => expect(retryAgain()).toBeEnabled())
  })

  it.each([
    ['FAILED', 'resume-verification-failure', 'resume-verification-warning'],
    ['VERIFIED', 'resume-verification-warning', 'resume-verification-failure'],
  ] as const)('%s with a code shows %s', (status, shown, hidden) => {
    renderPanel(dto({ verificationStatus: status, verificationErrorCode: 'ATS_CHECK_FAILED' }))
    expect(screen.getByTestId(shown)).toBeInTheDocument()
    expect(screen.queryByTestId(hidden)).toBeNull()
  })

  it.each([
    ['a running check', { verificationStatus: 'FAILED' as const, verificationBusy: true }],
    ['a DRAFT row', { verificationStatus: 'DRAFT' as const }],
    ['an AWAITING_CONFIRM row', { verificationStatus: 'AWAITING_CONFIRM' as const }],
  ])('no failure panel with %s', (_, overrides) => {
    renderPanel(dto({ verificationErrorCode: 'ATS_CHECK_FAILED', ...overrides }))
    expect(screen.queryByTestId('resume-verification-failure')).toBeNull()
    expect(screen.queryByTestId('resume-verification-warning')).toBeNull()
  })
})

describe('choose template', () => {
  const failed = (overrides: Partial<SeniorResumeDto> = {}) =>
    dto({ verificationStatus: 'FAILED', verificationErrorCode: 'RENDER_FAILED', ...overrides })
  const tile = (name: 'classic' | 'modern') => (
    <div id={templateTileId(name)} tabIndex={-1} data-testid={`tile-${name}`} />
  )

  it('scrolls the current tile to the centre and focuses it', async () => {
    renderPanel(failed({ templateName: 'modern' }), tile('modern'))
    const scroll = vi.fn()
    screen.getByTestId('tile-modern').scrollIntoView = scroll
    fireEvent.click(screen.getByRole('button', { name: 'Обрати шаблон' }))
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    await waitFor(() => expect(screen.getByTestId('tile-modern')).toHaveFocus())
  })

  it('under a personal template it goes to the first tile', async () => {
    renderPanel(failed({ templateName: 'modern', hasCustomTemplate: true }), tile('classic'))
    fireEvent.click(screen.getByRole('button', { name: 'Обрати шаблон' }))
    await waitFor(() => expect(screen.getByTestId('tile-classic')).toHaveFocus())
  })

  it('still focuses the tile where scrollIntoView is missing', async () => {
    renderPanel(failed(), tile('classic'))
    Object.defineProperty(screen.getByTestId('tile-classic'), 'scrollIntoView', {
      value: undefined,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Обрати шаблон' }))
    await waitFor(() => expect(screen.getByTestId('tile-classic')).toHaveFocus())
  })

  it('does nothing harmful when the picker is not on screen', () => {
    renderPanel(failed())
    const choose = screen.getByRole('button', { name: 'Обрати шаблон' })
    expect(() => fireEvent.click(choose)).not.toThrow()
    expect(choose).toBeInTheDocument()
  })
})

describe('the stale notice', () => {
  const confirm = () => screen.getByRole('button', { name: 'Підтвердити' })

  it('is out of the tab order, and a new run clears it', async () => {
    postMock.mockRejectedValue(STALE_409)
    const { rerenderWith } = renderPanel(dto({ staged: STAGED }))
    fireEvent.click(confirm())
    const notice = await screen.findByTestId('resume-verification-stale')
    expect(notice).toHaveAttribute('tabindex', '-1')
    rerenderWith(dto({ staged: STAGED, verificationBusy: true, verificationStatus: 'CHECKING' }))
    expect(screen.queryByTestId('resume-verification-stale')).toBeNull()
  })

  it('takes focus even when the 409 comes after the focus window of the click', async () => {
    let reject: (e: unknown) => void = () => {}
    postMock.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r
        }),
    )
    renderPanel(dto({ staged: STAGED }))
    fireEvent.click(confirm())
    await new Promise((r) => setTimeout(r, FOCUS_REQUEST_TTL_MS + 100))
    reject(STALE_409)
    const notice = await screen.findByTestId('resume-verification-stale')
    await waitFor(() => expect(notice).toHaveFocus())
  })
})

describe('ResumeVerificationProgress', () => {
  const stages = () => screen.getAllByRole('listitem')

  it('QUEUED: the queue is current, the check and HR pending', () => {
    render(<ResumeVerificationProgress status="QUEUED" isTemplateRun={false} />, {
      wrapper: I18nTestProvider,
    })
    const [queue, check, hr] = stages()
    expect(queue).toHaveAttribute('aria-current', 'step')
    expect(check).not.toHaveAttribute('aria-current')
    expect(hr).not.toHaveAttribute('aria-current')
    expect(queue).toHaveTextContent(/^триває: У черзі$/)
    expect(check).toHaveTextContent(/^очікує: Перевірка/)
    expect(check).toHaveClass('text-muted-foreground')
    expect(within(check!).getByTestId('resume-progress-dot')).toHaveClass('border-border')
    expect(screen.getByRole('heading', { name: 'У черзі на перевірку' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
    expect(screen.getByTestId('resume-verification-busy-lock')).toHaveAttribute('tabindex', '-1')
  })

  it('CHECKING: the queue is done, the check current', () => {
    render(<ResumeVerificationProgress status="CHECKING" isTemplateRun={false} />, {
      wrapper: I18nTestProvider,
    })
    const [queue, check] = stages()
    expect(queue).toHaveTextContent(/^готово: У черзі$/)
    expect(check).toHaveAttribute('aria-current', 'step')
    expect(check).toHaveTextContent(/^триває: Перевірка/)
    expect(screen.getByRole('heading', { name: 'Перевіряємо резюме' })).toBeInTheDocument()
  })

  it.each([
    ['done', 0, ['bg-secondary', 'text-foreground'], ['border', 'border-primary']],
    ['current', 1, ['border-2', 'border-primary'], ['bg-secondary', 'border-border']],
    ['pending', 2, ['border', 'border-border'], ['bg-secondary', 'border-primary']],
  ] as const)('a %s stage draws its own dot', (_, index, on, off) => {
    render(<ResumeVerificationProgress status="CHECKING" isTemplateRun={false} />, {
      wrapper: I18nTestProvider,
    })
    const dot = within(stages()[index]!).getByTestId('resume-progress-dot')
    expect(dot).toHaveClass('flex', 'size-5', 'rounded-full', ...on)
    for (const cls of off) expect(dot).not.toHaveClass(cls)
  })

  it('only a done stage has the check mark; only the current label is bold; only pending is muted', () => {
    render(<ResumeVerificationProgress status="CHECKING" isTemplateRun={false} />, {
      wrapper: I18nTestProvider,
    })
    const [done, current, pending] = stages().map((li) => ({
      li,
      dot: within(li).getByTestId('resume-progress-dot'),
      label: within(li).getByTestId('resume-progress-label'),
    }))
    expect(done!.dot.innerHTML).toContain('<svg')
    expect(current!.dot.innerHTML).toBe('')
    expect(pending!.dot.innerHTML).toBe('')
    expect(current!.label).toHaveClass('min-w-0', 'font-medium')
    expect(done!.label).not.toHaveClass('font-medium')
    expect(pending!.label).not.toHaveClass('font-medium')
    expect(pending!.li).toHaveClass('flex', 'text-muted-foreground')
    expect(done!.li).not.toHaveClass('text-muted-foreground')
    expect(current!.li).not.toHaveClass('text-muted-foreground')
  })

  it('a template run is one status line, out of the tab order', () => {
    render(<ResumeVerificationProgress status="VERIFIED" isTemplateRun />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('resume-verification-template-run')).toHaveAttribute('tabindex', '-1')
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('VerificationBadge', () => {
  it.each([
    ['DRAFT', 'Чернетка'],
    ['QUEUED', 'Перевіряється'],
    ['CHECKING', 'Перевіряється'],
    ['AWAITING_CONFIRM', 'Чекає підтвердження'],
    ['FAILED', 'Не пройшло перевірку'],
    ['VERIFIED', 'Перевірено'],
  ] as const)('%s reads %s', (status, text) => {
    render(<VerificationBadge resume={dto({ verificationStatus: status })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('VERIFIED: the medium date and the HR name; the wrapper takes focus by script only', () => {
    render(
      <VerificationBadge
        resume={dto({
          verificationStatus: 'VERIFIED',
          verifiedAt: '2026-11-01T10:00:00.000Z',
          verifiedByName: 'Olena',
        })}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('resume-verified-meta')).toHaveTextContent(
      'Перевірено 1 лист. 2026 р. · Olena',
    )
    expect(screen.getByTestId('resume-verification-status')).toHaveAttribute('tabindex', '-1')
    expect(screen.queryByTestId('resume-recheck-needed')).not.toBeInTheDocument()
  })

  // Backlog 442: an identity change after verification flags the resume.
  it('VERIFIED with a re-check flag: the re-check notice next to the status', () => {
    render(
      <VerificationBadge
        resume={dto({
          verificationStatus: 'VERIFIED',
          verifiedAt: '2026-11-01T10:00:00.000Z',
          recheckNeededAt: '2026-11-02T10:00:00.000Z',
        })}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(
      within(screen.getByTestId('resume-verification-status')).getByTestId('resume-recheck-needed'),
    ).toHaveTextContent('Потрібна повторна перевірка')
  })
})
