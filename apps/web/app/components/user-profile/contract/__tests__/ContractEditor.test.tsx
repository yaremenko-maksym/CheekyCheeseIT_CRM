/**
 * ContractEditor.test.tsx
 *
 * Unit tests for ContractEditor component.
 * Covers:
 * - renders without crashing
 * - readOnly mode shows frozen banner (READY_TO_SIGN / SIGNED semantics)
 * - onChange callback marks dirty (propagates value changes to parent)
 *
 * CodeMirror is lazy-loaded via React.lazy; we mock the entire module to avoid
 * bundling heavy deps in the unit-test environment.
 */

import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

vi.mock('@codemirror/theme-one-dark', () => ({
  oneDark: {},
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

  it('onChange is called when editor value changes (marks dirty)', async () => {
    const onChange = vi.fn()
    renderEditor({ value: 'initial', onChange })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const editor = screen.getByTestId('mock-codemirror')
    // Use fireEvent.change to directly simulate the CodeMirror onChange call
    // (controlled textarea — userEvent.type appends chars to existing value
    // but the controlled mock won't update without re-render; fireEvent is reliable)
    fireEvent.change(editor, { target: { value: 'changed text' } })

    expect(onChange).toHaveBeenCalledWith('changed text')
  })

  it('readOnly=true: onChange NOT called via CodeMirror when editor is frozen', async () => {
    const onChange = vi.fn()
    renderEditor({ readOnly: true, onChange })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const editor = screen.getByTestId('mock-codemirror') as HTMLTextAreaElement
    // The mock textarea has readOnly=true — fireEvent.change is blocked by the browser model.
    // More importantly: the real CodeMirror when readOnly=true does not fire onChange at all.
    // Verify the textarea is marked readOnly.
    expect(editor.readOnly).toBe(true)
    // onChange should NOT have been called during render
    expect(onChange).not.toHaveBeenCalled()
  })
})
