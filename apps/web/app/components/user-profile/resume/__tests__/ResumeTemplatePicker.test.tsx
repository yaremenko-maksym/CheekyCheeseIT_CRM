/**
 * The template picker in the layout panel (verified base resume design §5.6).
 *
 * ResumeTab runs the REAL query and mutation hooks over a stubbed `api`, so the
 * PUT is the request the hook really sends and the VERIFIED screen is the one
 * the server's answer really produces. Only the PDF blob hook is stubbed: jsdom
 * cannot load a blob into a viewer.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    for (const tile of within(picker).getAllByRole('radio'))
      expect(tile).toHaveAttribute('aria-disabled', 'true')
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

describe('the failure panel reaches the picker', () => {
  const failed = (overrides: Partial<SeniorResumeDto>) =>
    makeResponse({
      verificationStatus: 'FAILED',
      verificationReport: { gates: [], fallbacks: [] },
      ...overrides,
    })

  it('"Обрати шаблон" moves focus to the current template tile', async () => {
    serve(failed({ templateName: 'compact', verificationErrorCode: 'RENDER_FAILED' }))
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Обрати шаблон' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /Стислий/ })).toHaveFocus())
  })

  it('with a personal template it focuses the first catalog tile', async () => {
    serve(failed({ hasCustomTemplate: true, verificationErrorCode: 'CUSTOM_TEMPLATE' }))
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Обрати шаблон' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /Класичний/ })).toHaveFocus())
  })
})

describe('review fixes (fix round 1)', () => {
  const verified = {
    verificationStatus: 'VERIFIED' as const,
    verifiedVersion: 3,
    verifiedAt: '2026-11-10T11:00:00.000Z',
    verifiedByName: 'Hanna HR',
  }

  it('arrow keys move focus without sending PUT template', async () => {
    serve(makeResponse())
    renderTab()
    const classic = await screen.findByRole('radio', { name: 'Класичний' })
    classic.focus()
    // Hold the key: Radix moves focus on a timer and checks the tile it lands
    // on only while the arrow is still down, as in a real browser.
    await userEvent.keyboard('{ArrowRight>}')
    expect(screen.getByRole('radio', { name: 'Сучасний' })).toHaveFocus()
    await userEvent.keyboard('{/ArrowRight}{ArrowRight>}')
    expect(screen.getByRole('radio', { name: 'Стислий' })).toHaveFocus()
    await userEvent.keyboard('{/ArrowRight}')
    expect(putMock).not.toHaveBeenCalled()
    // The stored template stays the checked one while focus browses.
    expect(classic).toHaveAttribute('aria-checked', 'true')
  })

  it('a click after an arrow key released outside the picker sends PUT template', async () => {
    serve(makeResponse())
    putMock.mockResolvedValue({ data: makeResponse({ templateName: 'compact' }) })
    renderTab()
    const classic = await screen.findByRole('radio', { name: 'Класичний' })
    classic.focus()
    // Arrow down inside the group, released outside it: no keyup reaches the group.
    fireEvent.keyDown(classic, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Сучасний' })).toHaveFocus())
    fireEvent.keyUp(document.body, { key: 'ArrowRight' })
    await userEvent.click(screen.getByRole('radio', { name: 'Стислий' }))
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/users/senior-1/resume/template', {
        templateName: 'compact',
      }),
    )
    expect(putMock).toHaveBeenCalledTimes(1)
  })

  it('Space on a focused tile sends PUT template', async () => {
    serve(makeResponse())
    putMock.mockResolvedValue({ data: makeResponse({ templateName: 'modern' }) })
    renderTab()
    ;(await screen.findByRole('radio', { name: 'Класичний' })).focus()
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard(' ')
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/users/senior-1/resume/template', {
        templateName: 'modern',
      }),
    )
    expect(putMock).toHaveBeenCalledTimes(1)
  })

  it('Enter on a focused tile sends PUT template', async () => {
    serve(makeResponse())
    putMock.mockResolvedValue({ data: makeResponse({ templateName: 'technical' }) })
    renderTab()
    ;(await screen.findByRole('radio', { name: 'Технічний' })).focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/users/senior-1/resume/template', {
        templateName: 'technical',
      }),
    )
    expect(putMock).toHaveBeenCalledTimes(1)
  })

  it('on AWAITING_CONFIRM the layout panel warns that a change discards the result', async () => {
    const base = makeResponse()
    serve(
      makeResponse({
        verificationStatus: 'AWAITING_CONFIRM',
        verificationReport: { gates: [], fallbacks: [] },
        staged: {
          runId: '22222222-2222-4222-8222-222222222222',
          content: base.resume!.content,
          layout: DEFAULT_RESUME_LAYOUT,
          templateName: 'classic',
          pdfAvailable: true,
          editedPaths: [],
        },
      }),
    )
    renderTab()
    const panel = await screen.findByTestId('resume-layout-panel')
    expect(
      within(panel).getByText('Зміна шаблону чи оформлення скасує результат цієї перевірки.'),
    ).toBeInTheDocument()
    // Picking stays allowed.
    expect(screen.getByRole('radio', { name: 'Сучасний' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('a DRAFT picker shows no discard warning', async () => {
    serve(makeResponse())
    renderTab()
    await screen.findByTestId('resume-template-picker')
    expect(
      screen.queryByText('Зміна шаблону чи оформлення скасує результат цієї перевірки.'),
    ).toBeNull()
  })

  it('focus stays on the picked tile while the template run is busy', async () => {
    serve(makeResponse(verified))
    const running = makeResponse({ ...verified, verificationBusy: true })
    putMock.mockImplementation(() => {
      serve(running)
      return Promise.resolve({ data: running })
    })
    renderTab()
    const technical = await screen.findByRole('radio', { name: 'Технічний' })
    await userEvent.click(technical)
    expect(await screen.findByText('Шаблон можна змінити після перевірки.')).toBeInTheDocument()
    expect(technical).toHaveFocus()
    expect(technical).toHaveAttribute('aria-disabled', 'true')
    // Inert while busy: another pick sends nothing.
    await userEvent.click(screen.getByRole('radio', { name: 'Сучасний' }))
    await userEvent.keyboard('{Enter}')
    expect(putMock).toHaveBeenCalledTimes(1)
  })

  it('a tile is named by the template; the description and badge describe it', async () => {
    serve(makeResponse())
    renderTab()
    const classic = await screen.findByRole('radio', { name: 'Класичний' })
    expect(classic).toHaveAccessibleName('Класичний')
    expect(classic).toHaveAccessibleDescription('Шрифт із засічками, ім’я по центру Поточний')
    expect(screen.getByRole('radio', { name: 'Сучасний' })).toHaveAccessibleDescription(
      'Без засічок, акцентна лінія під заголовками',
    )
  })

  it('a viewer who cannot edit sees no picker', async () => {
    serve({ ...makeResponse(), canEdit: false })
    renderTab()
    await screen.findByTestId('resume-layout-panel')
    expect(screen.queryByTestId('resume-template-picker')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Шаблон' })).toBeNull()
  })
})
