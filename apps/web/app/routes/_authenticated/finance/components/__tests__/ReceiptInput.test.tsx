/**
 * task-receipts-frontend — `ReceiptInput.explorerOnly` interaction tests
 * (design-spec §4.1).
 *
 * Pins:
 * 1. Default (explorerOnly=false): tab-toggle («Файл»/«Ссылка») renders.
 * 2. explorerOnly=true: tab-toggle is GONE entirely (not disabled — a single
 *    remaining tab in a 2-way toggle reads as broken); only the url field +
 *    explorer hint render.
 * 3. Switching explorerOnly true→false→true doesn't crash and correctly
 *    toggles the tab-toggle's presence.
 * 4. Auto-normalization: when explorerOnly flips to true while state.mode is
 *    'file', the component resets to an empty url-mode state (no orphaned
 *    file-chosen state hidden behind a currency switch).
 * 5. `error` prop renders a destructive ring on the url input (no text —
 *    callers own the error text, existing `fieldErrors.receipt` pattern).
 */
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The "file already selected" harness below seeds a documentId, which makes
// `useDocumentDownloadUrl` (inside ReceiptInput) fire — mock the API boundary
// so that never hits the real network in this unit test.
vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { url: 'https://cdn.example.com/receipt.png' } }),
  },
}))

import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

function Harness({ initialExplorerOnly = false }: { initialExplorerOnly?: boolean }) {
  const [state, setState] = useState<ReceiptState>(emptyReceiptState())
  const [explorerOnly, setExplorerOnly] = useState(initialExplorerOnly)
  return (
    <div>
      <button
        type="button"
        onClick={() => setExplorerOnly((v) => !v)}
        data-testid="toggle-explorer"
      >
        toggle
      </button>
      <ReceiptInput state={state} onChange={setState} explorerOnly={explorerOnly} />
    </div>
  )
}

function renderHarness(initialExplorerOnly = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Harness initialExplorerOnly={initialExplorerOnly} />
    </QueryClientProvider>,
  )
}

describe('ReceiptInput — explorerOnly rendering', () => {
  it('default (explorerOnly=false): tab-toggle renders with both modes', () => {
    renderHarness(false)
    expect(screen.getByTestId('receipt-input-mode-file')).toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-mode-url')).toBeInTheDocument()
    expect(screen.queryByTestId('receipt-input-explorer-hint')).not.toBeInTheDocument()
  })

  it('explorerOnly=true: tab-toggle is entirely absent, only the url field + hint render', () => {
    renderHarness(true)
    expect(screen.queryByTestId('receipt-input-mode-file')).not.toBeInTheDocument()
    expect(screen.queryByTestId('receipt-input-mode-url')).not.toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-url-field')).toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-explorer-hint')).toBeInTheDocument()
  })

  it('toggling explorerOnly back off restores the tab-toggle', () => {
    renderHarness(true)
    fireEvent.click(screen.getByTestId('toggle-explorer'))
    expect(screen.getByTestId('receipt-input-mode-file')).toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-mode-url')).toBeInTheDocument()
  })

  it('typing an explorer url in explorerOnly mode updates the field value', () => {
    renderHarness(true)
    const field = screen.getByTestId('receipt-input-url-field')
    fireEvent.change(field, { target: { value: 'https://etherscan.io/tx/0xabc' } })
    expect(field).toHaveValue('https://etherscan.io/tx/0xabc')
  })

  it('error prop renders a destructive ring on the url input', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const state = emptyReceiptState()
    render(
      <QueryClientProvider client={qc}>
        <ReceiptInput state={state} onChange={() => {}} explorerOnly error="Неверный домен" />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('receipt-input-url-field')).toHaveClass('border-destructive')
  })
})

describe('ReceiptInput — explorerOnly auto-normalization (file → url)', () => {
  it('switching explorerOnly to true while a file is "selected" resets to an empty url state', () => {
    // Start in a file-mode state with a documentId (simulating an already
    // uploaded file), then flip explorerOnly on — the component must reset
    // the state to url-mode with an EMPTY externalUrl (not leave the stale
    // file attached behind the newly-hidden tab-toggle).
    function FileHarness() {
      const [state, setState] = useState<ReceiptState>({
        mode: 'file',
        documentId: 'doc-1',
        externalUrl: '',
        fileName: 'receipt.png',
        previewUrl: null,
        mimeType: 'image/png',
      })
      const [explorerOnly, setExplorerOnly] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setExplorerOnly(true)} data-testid="force-explorer">
            force
          </button>
          <ReceiptInput state={state} onChange={setState} explorerOnly={explorerOnly} />
          <span data-testid="mode-probe">{state.mode}</span>
          <span data-testid="doc-probe">{state.documentId ?? ''}</span>
        </div>
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileHarness />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('mode-probe')).toHaveTextContent('file')
    fireEvent.click(screen.getByTestId('force-explorer'))
    expect(screen.getByTestId('mode-probe')).toHaveTextContent('url')
    expect(screen.getByTestId('doc-probe')).toHaveTextContent('')
    expect(screen.getByTestId('receipt-input-url-field')).toHaveValue('')
  })
})
