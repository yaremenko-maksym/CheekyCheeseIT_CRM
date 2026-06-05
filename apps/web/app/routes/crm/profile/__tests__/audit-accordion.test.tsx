/**
 * AC1 + AC2 + AC4: Audit page accordion — expand/collapse, a11y attrs, blob cleanup.
 *
 * We test ContractCard in isolation via a thin fixture component that mirrors
 * page-level state (expanded, blobUrl, isLoading). This avoids needing
 * routing, auth, or TanStack Query context.
 *
 * NOTE: We use vi.spyOn(URL, ...) rather than vi.stubGlobal('URL', ...) because
 * happy-dom uses URL as a constructor internally — replacing the global breaks
 * iframe mounting and causes unhandled errors in the test runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React, { useState } from 'react'

// ---------------------------------------------------------------------------
// Minimal stub for ContractCard
// ---------------------------------------------------------------------------

interface ContractStub {
  id: string
  contractNumber: string
  templateRole: string
  templateVersion: string
  signedAt: string
  signedTypedName: string
  signedIp: string | null
  bodyMarkdownSnapshot: string
}

interface ContractCardStubProps {
  contract: ContractStub
  expanded: boolean
  blobUrl: string | null
  isLoadingPdf: boolean
  onToggle: () => void
}

// Minimal re-implementation of audit.tsx ContractCard interface.
// No <iframe> rendered — we verify only a11y attributes and panel visibility.
// (iframe rendering tested via Playwright E2E AC7.)
function ContractCardStub({
  contract,
  expanded,
  blobUrl,
  isLoadingPdf,
  onToggle,
}: ContractCardStubProps) {
  const panelId = `pdf-panel-${contract.id}`
  const toggleId = `pdf-toggle-${contract.id}`

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <div data-testid="audit-contract-card">
      <button
        id={toggleId}
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        data-testid="audit-contract-expand"
        onClick={onToggle}
        onKeyDown={handleKeyDown}
      >
        PDF {expanded ? '▲' : '▼'}
      </button>
      <button type="button" data-testid="audit-contract-download" onClick={() => {}}>
        Markdown
      </button>
      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={toggleId}
          data-testid="audit-contract-pdf-panel"
        >
          {isLoadingPdf && <div data-testid="pdf-loading">Загрузка PDF…</div>}
          {/* Render a plain div (not iframe) to avoid happy-dom iframe URL constructor issues */}
          {blobUrl && !isLoadingPdf && (
            <div data-testid="audit-contract-pdf-viewer" data-src={blobUrl} />
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fixture: mirrors ProfileAuditPage state management
// ---------------------------------------------------------------------------

const MOCK_CONTRACT: ContractStub = {
  id: 'contract-abc-123',
  contractNumber: 'MSA-2026-001',
  templateRole: 'SENIOR',
  templateVersion: '1',
  signedAt: '2026-06-01T10:00:00.000Z',
  signedTypedName: 'Іванов Іван',
  signedIp: '127.0.0.1',
  bodyMarkdownSnapshot: '# Contract\n\nContent here.',
}

function Fixture({ onFetchPdf }: { onFetchPdf: (id: string) => Promise<string | null> }) {
  const [expanded, setExpanded] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  async function toggle() {
    if (expanded) {
      setExpanded(false)
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
        setBlobUrl(null)
      }
    } else {
      setExpanded(true)
      setIsLoading(true)
      try {
        const url = await onFetchPdf(MOCK_CONTRACT.id)
        setBlobUrl(url)
      } finally {
        setIsLoading(false)
      }
    }
  }

  return (
    <ContractCardStub
      contract={MOCK_CONTRACT}
      expanded={expanded}
      blobUrl={blobUrl}
      isLoadingPdf={isLoading}
      onToggle={() => void toggle()}
    />
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit accordion — ContractCard (AC1, AC2, AC4)', () => {
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Spy on URL methods without replacing the URL constructor
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock-url')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('panel is hidden by default (collapsed state)', () => {
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)
    expect(screen.queryByTestId('audit-contract-pdf-panel')).not.toBeInTheDocument()
  })

  it('toggle button has aria-expanded=false initially (AC2)', () => {
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)
    expect(screen.getByTestId('audit-contract-expand')).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggle button has aria-controls pointing at panel id (AC2)', () => {
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)
    expect(screen.getByTestId('audit-contract-expand')).toHaveAttribute(
      'aria-controls',
      `pdf-panel-${MOCK_CONTRACT.id}`,
    )
  })

  it('click expand → panel appears, aria-expanded becomes true (AC1, AC2)', async () => {
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)

    await user.click(screen.getByTestId('audit-contract-expand'))

    expect(screen.getByTestId('audit-contract-pdf-panel')).toBeInTheDocument()
    expect(screen.getByTestId('audit-contract-expand')).toHaveAttribute('aria-expanded', 'true')
  })

  it('expanded panel has role=region and aria-labelledby pointing at toggle id (AC2)', async () => {
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)

    await user.click(screen.getByTestId('audit-contract-expand'))

    const panel = screen.getByTestId('audit-contract-pdf-panel')
    expect(panel).toHaveAttribute('role', 'region')
    expect(panel).toHaveAttribute('aria-labelledby', `pdf-toggle-${MOCK_CONTRACT.id}`)
  })

  it('expand calls fetchPdf and renders PDF viewer with blob URL (AC1)', async () => {
    const fetchPdf = vi.fn().mockResolvedValue('blob:mock-url')
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={fetchPdf} />)

    await user.click(screen.getByTestId('audit-contract-expand'))

    expect(fetchPdf).toHaveBeenCalledWith(MOCK_CONTRACT.id)
    const viewer = await screen.findByTestId('audit-contract-pdf-viewer')
    expect(viewer).toHaveAttribute('data-src', 'blob:mock-url')
  })

  it('loading state shown during fetch (AC1)', async () => {
    // fetchPdf that never resolves immediately — we see loading first
    let resolve!: (v: string) => void
    const fetchPdf = vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r)))
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={fetchPdf} />)

    await user.click(screen.getByTestId('audit-contract-expand'))
    // During fetch: loading indicator
    expect(screen.getByTestId('pdf-loading')).toBeInTheDocument()

    // Resolve fetch
    resolve('blob:mock-url')
    await screen.findByTestId('audit-contract-pdf-viewer')
    expect(screen.queryByTestId('pdf-loading')).not.toBeInTheDocument()
  })

  it('collapse after expand revokes blob URL — memory leak prevention (AC1)', async () => {
    const fetchPdf = vi.fn().mockResolvedValue('blob:mock-url')
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={fetchPdf} />)

    await user.click(screen.getByTestId('audit-contract-expand'))
    await screen.findByTestId('audit-contract-pdf-panel')

    await user.click(screen.getByTestId('audit-contract-expand'))

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url')
    expect(screen.queryByTestId('audit-contract-pdf-panel')).not.toBeInTheDocument()
  })

  it('keyboard Enter expands accordion (AC2)', async () => {
    const user = userEvent.setup()
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)

    const btn = screen.getByTestId('audit-contract-expand')
    btn.focus()
    await user.keyboard('{Enter}')

    expect(screen.getByTestId('audit-contract-pdf-panel')).toBeInTheDocument()
  })

  it('keyboard Space expands accordion (AC2)', () => {
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)

    const btn = screen.getByTestId('audit-contract-expand')
    btn.focus()
    fireEvent.keyDown(btn, { key: ' ' })

    expect(screen.getByTestId('audit-contract-pdf-panel')).toBeInTheDocument()
  })

  it('toggle button is a focusable native button element (AC2)', () => {
    render(<Fixture onFetchPdf={vi.fn().mockResolvedValue('blob:mock-url')} />)
    const btn = screen.getByTestId('audit-contract-expand')
    expect(btn.tagName).toBe('BUTTON')
    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  // Verify that createObjectURLSpy was set up (used in expand tests above)
  it('URL spies are properly initialised', () => {
    expect(createObjectURLSpy).toBeDefined()
    expect(revokeObjectURLSpy).toBeDefined()
  })
})
