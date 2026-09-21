/**
 * routes/_authenticated/admin/tos.index.tsx — unit tests for `TosEditorPage`
 * (the ToS split-view editor: active version + history + archive preview).
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). This file had ZERO
 * tests before this round — the fix-round-1 mutation-gate follow-up
 * flagged it in "Remaining gap, itemized" (0 survived / 2 no-coverage on a
 * scoped `mutation:changed` run) as pre-existing debt from Steps 1-7.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
    ...options,
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

// CodeMirror — heavy lazy dep, replace with a simple read-only div (mirrors
// contracts-editor-layout.test.tsx's own mock pattern for the SAME dep).
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="mock-codemirror-viewer">{value}</div>
  ),
}))
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => ({}) }))
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }))

vi.mock('@/components/admin/TosPdfPreview', () => ({
  TosPdfPreview: ({ bodyMarkdown }: { bodyMarkdown: string }) => (
    <div data-testid="tos-preview-pane">{bodyMarkdown}</div>
  ),
}))

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: React.PropsWithChildren<{ to: string } & Record<string, unknown>>) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})

const apiGetMock = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { get: (...args: unknown[]) => apiGetMock(...args) },
}))

import { Route } from '../tos.index'

const TosEditorPage = Route.options.component!

const ACTIVE_VERSION = {
  id: 'tos-2',
  version: 2,
  bodyMarkdown: '# Active ToS Body 2',
  isActive: true,
  createdAt: '2026-03-15T10:00:00.000Z',
}

const ARCHIVED_VERSION_1 = {
  id: 'tos-1',
  version: 1,
  bodyMarkdown: '# First ToS Body 1',
  isActive: false,
  createdAt: '2026-01-01T09:00:00.000Z',
}

beforeEach(() => {
  apiGetMock.mockReset()
})

describe('TosEditorPage — active version header (MUT-1: date-fns format call)', () => {
  it('shows the active version number and the EXACT formatted creation date (dd.MM.yyyy)', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION] })
    render(<TosEditorPage />)

    // MUT-1: `format(new Date(activeVersion.createdAt), 'dd.MM.yyyy')` —
    // both operands are StringLiteral mutation targets (no-coverage before
    // this round). Function matcher on the paragraph's full concatenated
    // text catches either: a wrong format string (e.g. `''`) would produce
    // an unformatted/empty date fragment, changing this exact text.
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'Активна версія: v2 · оновлена 15.03.2026',
      ),
    ).toBeInTheDocument()
  })

  it('shows no active-version header line when there is no active ToS at all', async () => {
    apiGetMock.mockResolvedValue({ data: [] })
    render(<TosEditorPage />)

    await screen.findByText('Немає активної версії умов використання. Створіть першу версію.')
    expect(screen.queryByText(/Активна версія/)).not.toBeInTheDocument()
  })
})

describe('TosEditorPage — empty / loaded states', () => {
  it('shows the empty-state message and no split-view when there is no active version', async () => {
    apiGetMock.mockResolvedValue({ data: [] })
    render(<TosEditorPage />)

    expect(
      await screen.findByText('Немає активної версії умов використання. Створіть першу версію.'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('tos-preview-pane')).not.toBeInTheDocument()
  })

  it('renders the split-view (editor + PDF preview) for the active version', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION] })
    render(<TosEditorPage />)

    expect(await screen.findByTestId('tos-preview-pane')).toHaveTextContent(
      ACTIVE_VERSION.bodyMarkdown,
    )
    expect(screen.getByTestId('mock-codemirror-viewer')).toHaveTextContent(
      ACTIVE_VERSION.bodyMarkdown,
    )
  })

  it('"Нова версія умов" button links to /admin/tos/new', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION] })
    render(<TosEditorPage />)

    await screen.findByTestId('tos-preview-pane')
    expect(screen.getByTestId('publish-new-tos-button')).toHaveAttribute('href', '/admin/tos/new')
  })
})

describe('TosEditorPage — history list + archive preview', () => {
  it('lists historical (non-active) versions, newest first, and excludes the active one', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION, ARCHIVED_VERSION_1] })
    render(<TosEditorPage />)

    const list = await screen.findByTestId('tos-history-list')
    expect(list).toBeInTheDocument()
    expect(screen.getByTestId('tos-history-item-v1')).toBeInTheDocument()
    expect(screen.queryByTestId('tos-history-item-v2')).not.toBeInTheDocument()
  })

  it('clicking a historical version previews it (archived banner + version-tagged badge)', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION, ARCHIVED_VERSION_1] })
    const user = userEvent.setup()
    render(<TosEditorPage />)

    await screen.findByTestId('tos-history-item-v1')
    await user.click(screen.getByTestId('tos-history-item-v1'))

    expect(screen.getByTestId('tos-preview-pane')).toHaveTextContent(
      ARCHIVED_VERSION_1.bodyMarkdown,
    )
    expect(screen.getByText('Перегляд архівної версії v1')).toBeInTheDocument()
  })

  it('"До активної версії" returns to the active version, dropping the archive banner', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION, ARCHIVED_VERSION_1] })
    const user = userEvent.setup()
    render(<TosEditorPage />)

    await screen.findByTestId('tos-history-item-v1')
    await user.click(screen.getByTestId('tos-history-item-v1'))
    await user.click(screen.getByTestId('back-to-active-tos'))

    expect(screen.getByTestId('tos-preview-pane')).toHaveTextContent(ACTIVE_VERSION.bodyMarkdown)
    expect(screen.queryByText(/Перегляд архівної версії/)).not.toBeInTheDocument()
  })

  it('no history section renders when every version is active (single-version case)', async () => {
    apiGetMock.mockResolvedValue({ data: [ACTIVE_VERSION] })
    render(<TosEditorPage />)

    await screen.findByTestId('tos-preview-pane')
    expect(screen.queryByTestId('tos-history-list')).not.toBeInTheDocument()
  })
})
