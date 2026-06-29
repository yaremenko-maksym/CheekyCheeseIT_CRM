/**
 * contracts-editor-layout.test.tsx
 *
 * Tests for the full-width admin contract template editor layout (feat: full-width refactor).
 *
 * Covers:
 *   1. ContractPreview — custom variable substitution (defaultValue / key fallback)
 *   2. ContractPreview — system token highlighted (mark.preview-token-system)
 *   3. ContractPreview — unknown token highlighted (mark.preview-token-unknown)
 *   4. ContractPreview — GFM table rendered (thead/tbody/th/td)
 *   5. ContractPreview — custom vars substituted inside table cells
 *   6. ContractEditorPage — full-width editor wrapper present (no 2-column grid)
 *   7. ContractEditorPage — variables panel below editor
 *   8. ContractEditorPage — «Предпросмотр» button present in header
 *   9. ContractEditorPage — preview dialog opens on button click
 *  10. ContractEditorPage — preview dialog closes on «Закрыть» click
 *  11. ContractEditorPage — «Опубликовать» button leads to confirm dialog
 *  12. TosNewPage — full-width editor wrapper present
 *  13. TosNewPage — «Предпросмотр» button present in header
 *  14. TosNewPage — preview dialog opens on button click
 *  15. TosNewPage — preview dialog closes on «Закрыть» click
 */

import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CustomVariable } from '@crm/shared'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// CodeMirror — heavy lazy dep, replace with simple textarea
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (val: string) => void }) => (
    <textarea
      data-testid="mock-codemirror"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => ({}) }))
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }))

// contractTokenHighlight — no-op in tests (no real CM view)
vi.mock('@/components/contracts/contractTokenHighlight', () => ({
  buildTokenHighlightExtension: () => [],
  injectTokenHighlightStyles: () => undefined,
}))

// VariablesPanel — lightweight stub (we test integration of position, not panel internals)
vi.mock('@/components/contracts/VariablesPanel', () => ({
  VariablesPanel: () => <div data-testid="variables-panel-stub">VariablesPanel</div>,
}))

// MarkdownDiff — stub to avoid heavy diffing in unit tests
vi.mock('@/components/admin/MarkdownDiff', () => ({
  MarkdownDiff: () => <div data-testid="markdown-diff-stub" />,
}))

// TanStack Router — stub createFileRoute so Route.options.component is accessible.
// createFileRoute(path) → returns a function that accepts { component } config
// and stores it in `.options`. useNavigate returns a no-op stub.
vi.mock('@tanstack/react-router', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: { component: React.ComponentType }) => ({
      options: opts,
      useParams: vi.fn(() => ({ role: 'senior' })),
    }),
    useNavigate: () => vi.fn(),
  }
})

// TanStack Query — stub useQuery/useMutation for contracts editor
vi.mock('@tanstack/react-query', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: {
        id: 'tpl-1',
        targetRole: 'SENIOR',
        version: 3,
        bodyMarkdown: '# Шаблон\n\nТекст контракта',
        isActive: true,
        customVariables: [],
      },
      isLoading: false,
    })),
    useMutation: vi.fn(() => ({
      mutate: vi.fn(),
      isPending: false,
    })),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(),
    })),
  }
})

// axios API — the contracts editor preview now POSTs to /preview-pdf and renders
// the returned PDF blob via PdfPreview. Default the mock to resolve a blob so the
// preview flow succeeds; individual tests can override.
const apiPostMock = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: (...args: unknown[]) => apiPostMock(...args) },
}))

// URL.createObjectURL / revokeObjectURL are not in happy-dom — stub them so the
// PdfPreview blob flow works in tests.
const FAKE_BLOB_URL = 'blob:preview-pdf'
beforeEach(() => {
  apiPostMock.mockReset()
  apiPostMock.mockResolvedValue({ data: new Blob(['%PDF-1.4'], { type: 'application/pdf' }) })
  URL.createObjectURL = vi.fn(() => FAKE_BLOB_URL)
  URL.revokeObjectURL = vi.fn()
})

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { ContractPreview } from '../contracts.$role'

// ─── ContractPreview unit tests ───────────────────────────────────────────────

const BODY_WITH_CUSTOM = 'Привет, {{clientName}}! Город: {{city}}.'
const BODY_WITH_SYSTEM = 'Имя: {{employeeName}}, дата: {{onboardingDate}}.'
const BODY_WITH_UNKNOWN = 'Ссылка: {{unknownField123}}.'
const BODY_WITH_TABLE = `
| Параметр | Значение |
|----------|----------|
| Имя | {{employeeName}} |
| Город | {{city}} |
`

const CUSTOM_VARS: CustomVariable[] = [
  { key: 'clientName', label: 'Имя клиента', defaultValue: 'Иван Петров' },
  { key: 'city', label: 'Город', defaultValue: 'Київ' },
]

function resolveFlushPromises() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('ContractPreview', () => {
  it('substitutes custom variables using their defaultValue', async () => {
    render(<ContractPreview body={BODY_WITH_CUSTOM} customVariables={CUSTOM_VARS} />)
    await resolveFlushPromises()

    // Custom vars with defaultValue should appear as plain text
    expect(screen.getByText(/Иван Петров/)).toBeInTheDocument()
    expect(screen.getByText(/Київ/)).toBeInTheDocument()
  })

  it('falls back to key when custom variable has no defaultValue', async () => {
    const vars: CustomVariable[] = [{ key: 'noDefault', label: 'Без значения' }]
    render(<ContractPreview body="Привет, {{noDefault}}!" customVariables={vars} />)
    await resolveFlushPromises()

    // fallback = key itself
    expect(screen.getByText(/noDefault/)).toBeInTheDocument()
  })

  it('highlights system tokens with mark.preview-token-system', async () => {
    render(<ContractPreview body={BODY_WITH_SYSTEM} customVariables={[]} />)
    await resolveFlushPromises()

    const marks = document.querySelectorAll('mark.preview-token-system')
    expect(marks.length).toBeGreaterThan(0)

    // At least one mark should contain the system token text
    const markTexts = Array.from(marks).map((m) => m.textContent)
    expect(markTexts.some((t) => t?.includes('employeeName'))).toBe(true)
  })

  it('highlights unknown tokens with mark.preview-token-unknown', async () => {
    render(<ContractPreview body={BODY_WITH_UNKNOWN} customVariables={[]} />)
    await resolveFlushPromises()

    const marks = document.querySelectorAll('mark.preview-token-unknown')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks[0]?.textContent).toContain('unknownField123')
  })

  it('renders GFM table with thead/tbody structure (remarkGfm)', async () => {
    render(<ContractPreview body={BODY_WITH_TABLE} customVariables={CUSTOM_VARS} />)
    await resolveFlushPromises()

    expect(document.querySelector('table')).toBeInTheDocument()
    expect(document.querySelector('thead')).toBeInTheDocument()
    expect(document.querySelector('tbody')).toBeInTheDocument()
  })

  it('substitutes custom vars inside table cells', async () => {
    render(<ContractPreview body={BODY_WITH_TABLE} customVariables={CUSTOM_VARS} />)
    await resolveFlushPromises()

    // {{city}} is a custom var → should render as "Київ" in table cell
    const cells = Array.from(document.querySelectorAll('td'))
    const cityCell = cells.find((c) => c.textContent?.includes('Київ'))
    expect(cityCell).toBeInTheDocument()
  })

  it('highlights system tokens inside table cells', async () => {
    render(<ContractPreview body={BODY_WITH_TABLE} customVariables={CUSTOM_VARS} />)
    await resolveFlushPromises()

    // {{employeeName}} is system → mark.preview-token-system inside td
    const marks = document.querySelectorAll('td mark.preview-token-system')
    expect(marks.length).toBeGreaterThan(0)
  })
})

// ─── ContractEditorPage layout tests ─────────────────────────────────────────

// We import the page component directly — Route.useParams() returns the mocked role
describe('ContractEditorPage layout', () => {
  beforeEach(async () => {
    // Mock useParams to return role=SENIOR for the route component
    const { useQuery } = vi.mocked(await import('@tanstack/react-query'))
    useQuery.mockReturnValue({
      data: {
        id: 'tpl-1',
        targetRole: 'SENIOR',
        version: 3,
        bodyMarkdown: '# Template body',
        isActive: true,
        customVariables: [],
      },
      isLoading: false,
    } as ReturnType<typeof useQuery>)
  })

  async function renderContractEditor() {
    // Dynamically import to get the component after mocks are in place
    const mod = await import('../contracts.$role')

    // Patch Route.useParams inside the module (TanStack Router mock doesn't
    // provide params at unit-test level — we inject directly)
    const { Route } = mod
    vi.spyOn(Route, 'useParams').mockReturnValue({ role: 'senior' })

    // ContractEditorPage is not exported — access via Route.options.component
    const Page = mod.Route.options?.component as React.ComponentType | undefined
    if (!Page) throw new Error('ContractEditorPage component not found on Route')
    return render(<Page />)
  }

  it('renders full-width editor wrapper (not 2-column grid)', async () => {
    await renderContractEditor()
    await resolveFlushPromises()

    const wrapper = screen.getByTestId('contract-editor-wrapper')
    expect(wrapper).toBeInTheDocument()
    // Must NOT be inside a grid-cols-2 element
    expect(wrapper.closest('.grid-cols-2')).toBeNull()
  })

  it('renders variables panel below editor', async () => {
    await renderContractEditor()
    await resolveFlushPromises()

    const editorWrapper = screen.getByTestId('contract-editor-wrapper')
    const varsWrapper = screen.getByTestId('variables-panel-wrapper')
    expect(editorWrapper).toBeInTheDocument()
    expect(varsWrapper).toBeInTheDocument()

    // variables-panel-wrapper must come AFTER contract-editor-wrapper in DOM
    const position =
      editorWrapper.compareDocumentPosition(varsWrapper) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(position).toBeTruthy()
  })

  it('renders «Предпросмотр» button in header', async () => {
    await renderContractEditor()
    await resolveFlushPromises()

    expect(screen.getByTestId('preview-template-button')).toBeInTheDocument()
  })

  it('preview dialog is not in DOM initially (Dialog unmounts when closed)', async () => {
    await renderContractEditor()
    await resolveFlushPromises()

    // shadcn Dialog removes DialogContent from DOM when closed
    expect(screen.queryByTestId('preview-dialog-document')).not.toBeInTheDocument()
  })

  it('preview dialog opens on «Предпросмотр» button click', async () => {
    const user = userEvent.setup()
    await renderContractEditor()
    await resolveFlushPromises()

    const btn = screen.getByTestId('preview-template-button')
    await user.click(btn)

    await waitFor(() => {
      expect(screen.getByTestId('preview-dialog-document')).toBeInTheDocument()
    })
  })

  it('preview drives the PDF flow: POSTs to /preview-pdf and renders PdfPreview (not HTML mock)', async () => {
    const user = userEvent.setup()
    await renderContractEditor()
    await resolveFlushPromises()

    await user.click(screen.getByTestId('preview-template-button'))

    // The dialog now contains the PdfPreview component (PDF iframe), not the old
    // ReactMarkdown HTML document (contract-preview-content).
    await waitFor(() => {
      expect(screen.getByTestId('contract-preview-pdf')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('contract-preview-content')).not.toBeInTheDocument()

    // It fetched the PDF from the new endpoint with the editor markdown + role.
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        '/contracts/templates/preview-pdf',
        expect.objectContaining({ role: 'SENIOR' }),
        expect.objectContaining({ responseType: 'blob' }),
      )
    })
  })

  it('preview dialog closes on «Закрыть» button click', async () => {
    const user = userEvent.setup()
    await renderContractEditor()
    await resolveFlushPromises()

    // Open
    await user.click(screen.getByTestId('preview-template-button'))
    await waitFor(() => {
      expect(screen.getByTestId('preview-dialog-document')).toBeInTheDocument()
    })

    // Close — shadcn Dialog removes content from DOM
    await user.click(screen.getByTestId('preview-dialog-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('preview-dialog-document')).not.toBeInTheDocument()
    })
  })

  it('«Опубликовать» button opens publish-confirm-dialog', async () => {
    const user = userEvent.setup()
    await renderContractEditor()
    await resolveFlushPromises()

    await user.click(screen.getByTestId('publish-template-button'))

    await waitFor(() => {
      expect(screen.getByTestId('publish-confirm-dialog')).toBeVisible()
    })
  })
})

// ─── TosNewPage layout tests ──────────────────────────────────────────────────

describe('TosNewPage layout', () => {
  async function renderTosPage() {
    // TosNewPage is not exported directly; access via Route.options.component
    const mod = await import('../tos.new')
    const TosPage = mod.Route.options?.component as React.ComponentType | undefined
    if (!TosPage) throw new Error('TosNewPage component not found on Route')
    return render(<TosPage />)
  }

  beforeEach(async () => {
    const { useQuery } = vi.mocked(await import('@tanstack/react-query'))
    useQuery.mockReturnValue({
      data: {
        id: 'tos-1',
        version: 2,
        bodyMarkdown: '# Terms of Service\n\nТекст ToS.',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      isLoading: false,
    } as ReturnType<typeof useQuery>)
  })

  it('renders full-width editor wrapper for ToS', async () => {
    await renderTosPage()
    await resolveFlushPromises()

    const wrapper = screen.getByTestId('tos-editor-wrapper')
    expect(wrapper).toBeInTheDocument()
    expect(wrapper.closest('.grid-cols-2')).toBeNull()
  })

  it('renders «Предпросмотр» button in ToS header', async () => {
    await renderTosPage()
    await resolveFlushPromises()

    expect(screen.getByTestId('preview-tos-button')).toBeInTheDocument()
  })

  it('ToS preview dialog opens on button click', async () => {
    const user = userEvent.setup()
    await renderTosPage()
    await resolveFlushPromises()

    await user.click(screen.getByTestId('preview-tos-button'))

    await waitFor(() => {
      expect(screen.getByTestId('preview-tos-dialog-document')).toBeInTheDocument()
    })
  })

  it('ToS preview dialog closes on «Закрыть» click', async () => {
    const user = userEvent.setup()
    await renderTosPage()
    await resolveFlushPromises()

    await user.click(screen.getByTestId('preview-tos-button'))
    await waitFor(() => {
      expect(screen.getByTestId('preview-tos-dialog-document')).toBeInTheDocument()
    })

    // Close — shadcn Dialog removes content from DOM
    await user.click(screen.getByTestId('preview-tos-dialog-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('preview-tos-dialog-document')).not.toBeInTheDocument()
    })
  })
})
