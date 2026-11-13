/**
 * The template picker in the layout panel (verified base resume design §5.6).
 *
 * ResumeTab runs the REAL query and mutation hooks over a stubbed `api`, so the
 * PUT is the request the hook really sends and the VERIFIED screen is the one
 * the server's answer really produces. Only the PDF blob hook is stubbed: jsdom
 * cannot load a blob into a viewer.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, put: putMock, post: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/hooks/use-senior-resume', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-senior-resume')>()),
  useResumePdfBlob: () => ({ blobUrl: null, isLoading: false, hasError: false }),
}))

import { ResumeTab } from '../ResumeTab'

function makeResponse(overrides: Partial<SeniorResumeDto> = {}): SeniorResumeResponse {
  return {
    canEdit: true,
    canConfirm: true,
    resume: {
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'senior-1',
      content: {
        summary: 'Senior developer',
        skills: ['TypeScript'],
        experience: [],
        education: [],
        languages: [],
        links: [],
      },
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
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T10:00:00.000Z',
      layout: DEFAULT_RESUME_LAYOUT,
      templateName: 'classic',
      hasCustomTemplate: false,
      renderStatus: 'READY',
      renderError: null,
      pdfUpToDate: true,
      facts: { ...EMPTY_RESUME_FACTS, headline: 'Backend Engineer' },
      verificationStatus: 'DRAFT',
      verificationErrorCode: null,
      verificationReport: null,
      verifiedVersion: null,
      verifiedAt: null,
      verifiedByName: null,
      staged: null,
      verificationBusy: false,
      ...overrides,
    },
  }
}

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

function serve(response: SeniorResumeResponse) {
  getMock.mockImplementation((url: string) =>
    url === '/users/senior-1/resume'
      ? Promise.resolve({ data: response })
      : Promise.reject(new Error(`unexpected GET ${url}`)),
  )
}

const renderTab = () =>
  render(<ResumeTab userId="senior-1" displayName="Alex Doe" />, { wrapper: Providers })

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('ResumeTemplatePicker in the layout panel', () => {
  it('picker lists 4 templates', async () => {
    serve(makeResponse())
    renderTab()
    const picker = await screen.findByRole('radiogroup', { name: 'Шаблон' })
    const tiles = within(picker).getAllByRole('radio')
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      expect.stringContaining('Класичний'),
      expect.stringContaining('Сучасний'),
      expect.stringContaining('Стислий'),
      expect.stringContaining('Технічний'),
    ])
    // The stored template is the checked tile and carries the "Current" badge.
    const classic = within(picker).getByRole('radio', { name: /Класичний/ })
    expect(classic).toHaveAttribute('aria-checked', 'true')
    expect(classic).toHaveTextContent('Поточний')
    expect(within(picker).getAllByText('Поточний')).toHaveLength(1)
    // Decorative thumbnail (`alt=""`): the tile's name is the label.
    expect(within(classic).getByRole('presentation')).toHaveAttribute(
      'src',
      '/resume-templates/classic.png',
    )
  })

  it('selecting one calls PUT template', async () => {
    serve(makeResponse())
    putMock.mockResolvedValue({ data: makeResponse({ templateName: 'modern' }) })
    renderTab()
    const picker = await screen.findByRole('radiogroup', { name: 'Шаблон' })
    await userEvent.click(within(picker).getByRole('radio', { name: /Сучасний/ }))
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/users/senior-1/resume/template', {
        templateName: 'modern',
      }),
    )
    expect(putMock).toHaveBeenCalledTimes(1)
    // DRAFT only saves: no "starts a layout check" note.
    expect(screen.queryByText(/Зміна шаблону запустить перевірку макета/)).toBeNull()
  })

  it('on VERIFIED shows "checking the new template"', async () => {
    const verified = {
      verificationStatus: 'VERIFIED' as const,
      verifiedVersion: 3,
      verifiedAt: '2026-11-10T11:00:00.000Z',
      verifiedByName: 'Hanna HR',
    }
    serve(makeResponse(verified))
    const running = makeResponse({ ...verified, verificationBusy: true })
    putMock.mockImplementation(() => {
      // The server now answers the busy row to the poll as well.
      serve(running)
      return Promise.resolve({ data: running })
    })
    renderTab()
    const picker = await screen.findByRole('radiogroup', { name: 'Шаблон' })
    expect(screen.getByText(/Зміна шаблону запустить перевірку макета/)).toBeInTheDocument()

    await userEvent.click(within(picker).getByRole('radio', { name: /Технічний/ }))

    expect(await screen.findByText('Перевіряємо нове оформлення')).toBeInTheDocument()
    // The previous PDF stays downloadable while the template run checks the new one.
    expect(screen.getByTestId('resume-download-pdf')).toHaveAttribute(
      'href',
      '/api/users/senior-1/resume/pdf',
    )
    // Busy locks the picker and the layout switches, with one line each.
    expect(screen.getByRole('radiogroup', { name: 'Шаблон' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    for (const tile of within(picker).getAllByRole('radio')) expect(tile).toBeDisabled()
    expect(screen.getByText('Шаблон можна змінити після перевірки.')).toBeInTheDocument()
    expect(screen.getByText('Змінити оформлення можна після перевірки.')).toBeInTheDocument()
    expect(screen.getByTestId('resume-layout-up-skills')).toBeDisabled()
  })

  it('on VERIFIED the en copy reads "Checking the new formatting"', async () => {
    await loadCatalog('en')
    serve(
      makeResponse({ verificationStatus: 'VERIFIED', verificationBusy: true, verifiedVersion: 3 }),
    )
    renderTab()
    expect(await screen.findByText('Checking the new formatting')).toBeInTheDocument()
    expect(screen.getByText('You can change the template after the check.')).toBeInTheDocument()
  })

  it('a custom template shows the catalog note above the grid', async () => {
    serve(makeResponse({ hasCustomTemplate: true }))
    renderTab()
    const panel = await screen.findByTestId('resume-template-picker')
    expect(within(panel).getByTestId('resume-template-custom-note')).toHaveTextContent(
      'Цей шаблон резюме не підтримує перевірку. Оберіть шаблон із каталогу.',
    )
    // No catalog tile is the current one while a personal template is stored.
    expect(within(panel).queryByText('Поточний')).toBeNull()
  })
})
