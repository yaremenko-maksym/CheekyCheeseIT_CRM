/**
 * ContractEditor.test.tsx
 *
 * Unit tests for ContractEditor component.
 * Covers:
 * - renders without crashing
 * - readOnly mode shows frozen banner (READY_TO_SIGN / SIGNED semantics)
 * - hint panel shows {{...}} placeholders from CONTRACT_VARIABLE_DESCRIPTIONS_BRACED
 * - onChange callback marks dirty (propagates value changes to parent)
 *
 * CodeMirror is lazy-loaded via React.lazy; we mock the entire module to avoid
 * bundling heavy deps in the unit-test environment.
 */

import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CONTRACT_VARIABLE_DESCRIPTIONS_BRACED } from '@crm/shared'

// ─── Mock CodeMirror (heavy lazy dep) ────────────────────────────────────────
// ContractEditor lazy-imports @uiw/react-codemirror + @codemirror/lang-markdown.
// We replace them with a simple textarea so we can fire onChange events.

vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string
    onChange?: (val: string) => void
    readOnly?: boolean
  }) => (
    <textarea
      data-testid="mock-codemirror"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

vi.mock('@codemirror/lang-markdown', () => ({
  markdown: () => ({}),
}))

import { ContractEditor } from '../ContractEditor'
import type { ContractEditorProps } from '../ContractEditor'

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderEditor(overrides: Partial<ContractEditorProps> = {}) {
  const defaults: ContractEditorProps = {
    value: '# Initial body',
    onChange: vi.fn(),
    readOnly: false,
    ...overrides,
  }
  return { ...render(<ContractEditor {...defaults} />), props: defaults }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContractEditor', () => {
  it('renders without crashing and shows editor area', async () => {
    renderEditor()
    // Lazy Suspense may show skeleton first; wait for actual editor
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('mock-codemirror')).toBeInTheDocument()
  })

  it('shows current value in editor', async () => {
    renderEditor({ value: '# My contract text' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const editor = screen.getByTestId('mock-codemirror')
    expect((editor as HTMLTextAreaElement).value).toBe('# My contract text')
  })

  it('readOnly=true: renders editor as read-only (frozen for READY_TO_SIGN/SIGNED)', async () => {
    renderEditor({ readOnly: true, frozenBanner: 'Редактирование недоступно' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const editor = screen.getByTestId('mock-codemirror') as HTMLTextAreaElement
    // The mock textarea passes readOnly through
    expect(editor.readOnly).toBe(true)
  })

  it('readOnly=true + frozenBanner: shows frozen banner text', async () => {
    renderEditor({
      readOnly: true,
      frozenBanner: 'Контракт заморожен. Вернитесь в черновик для правки.',
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('contract-editor-frozen-banner')).toBeInTheDocument()
    expect(screen.getByTestId('contract-editor-frozen-banner')).toHaveTextContent(
      'Контракт заморожен. Вернитесь в черновик для правки.',
    )
  })

  it('readOnly=false: frozen banner is NOT shown', async () => {
    renderEditor({ readOnly: false })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByTestId('contract-editor-frozen-banner')).not.toBeInTheDocument()
  })

  it('hint panel hidden by default (showHint=false)', async () => {
    renderEditor({ showHint: false })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByTestId('contract-editor-hint-panel')).not.toBeInTheDocument()
  })

  it('hint panel shows {{...}} placeholders from CONTRACT_VARIABLE_DESCRIPTIONS_BRACED when showHint=true', async () => {
    renderEditor({ showHint: true })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('contract-editor-hint-panel')).toBeInTheDocument()

    // Every key in the shared constant should render as a {{...}} code chip
    const bracedKeys = Object.keys(CONTRACT_VARIABLE_DESCRIPTIONS_BRACED)
    expect(bracedKeys.length).toBeGreaterThan(0)

    for (const key of bracedKeys) {
      // key is already in {{...}} form, e.g. "{{fullName}}"
      expect(key).toMatch(/^\{\{.+\}\}$/)
      expect(screen.getByText(key)).toBeInTheDocument()
    }
  })

  it('onToggleHint button present when onToggleHint prop provided', async () => {
    const onToggleHint = vi.fn()
    renderEditor({ onToggleHint })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('contract-editor-hint-toggle')).toBeInTheDocument()
  })

  it('clicking hint toggle calls onToggleHint', async () => {
    const onToggleHint = vi.fn()
    const user = userEvent.setup()
    renderEditor({ onToggleHint })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await user.click(screen.getByTestId('contract-editor-hint-toggle'))
    expect(onToggleHint).toHaveBeenCalledOnce()
  })

  it('onChange is called when editor value changes (marks dirty)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderEditor({ value: 'initial', onChange })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const editor = screen.getByTestId('mock-codemirror')
    // Clear and type new value
    await user.clear(editor)
    await user.type(editor, 'changed text')

    expect(onChange).toHaveBeenCalled()
    // Last call should contain the typed value
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('changed text')
  })

  it('readOnly=true: onChange NOT called when typing (editor is frozen)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderEditor({ readOnly: true, onChange })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const editor = screen.getByTestId('mock-codemirror') as HTMLTextAreaElement
    // readOnly textarea ignores keyboard input
    await user.type(editor, 'should not trigger')

    // onChange should NOT be called for read-only editor
    expect(onChange).not.toHaveBeenCalled()
  })
})
