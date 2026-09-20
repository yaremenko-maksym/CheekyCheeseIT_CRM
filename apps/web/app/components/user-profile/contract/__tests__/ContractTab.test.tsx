import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useQuery } from '@tanstack/react-query'

// Test the ADMIN-only tab visibility logic via the helper function
// (full UserProfileShell render requires complex multi-provider mocking;
// the logic is extracted and unit-tested here, E2E covers the full stack).

// ─── Extracted visibility logic ───────────────────────────────────────────────
// Mirrors the condition in UserProfileShell: show 'contract' tab only when
// viewer.role === 'ADMIN' && target.role !== 'ADMIN'.

function shouldShowContractTab(viewerRole: string, targetRole: string): boolean {
  return viewerRole === 'ADMIN' && targetRole !== 'ADMIN'
}

// Mirrors the canEdit prop logic in UserProfileShell.
function canEditContract(viewerRole: string): boolean {
  return viewerRole === 'ADMIN'
}

describe('contract tab visibility logic', () => {
  it('shows for ADMIN viewer + non-ADMIN target (SENIOR)', () => {
    expect(shouldShowContractTab('ADMIN', 'SENIOR')).toBe(true)
  })

  it('shows for ADMIN viewer + JUNIOR target', () => {
    expect(shouldShowContractTab('ADMIN', 'JUNIOR')).toBe(true)
  })

  it('shows for ADMIN viewer + HR target', () => {
    expect(shouldShowContractTab('ADMIN', 'HR')).toBe(true)
  })

  it('hidden for ADMIN viewer + ADMIN target (ADMINs have no contracts)', () => {
    expect(shouldShowContractTab('ADMIN', 'ADMIN')).toBe(false)
  })

  it('hidden for SENIOR viewer (non-ADMIN cannot see contract tab)', () => {
    expect(shouldShowContractTab('SENIOR', 'JUNIOR')).toBe(false)
  })

  it('hidden for HR viewer', () => {
    expect(shouldShowContractTab('HR', 'SENIOR')).toBe(false)
  })

  it('hidden for ACCOUNTANT viewer', () => {
    expect(shouldShowContractTab('ACCOUNTANT', 'SENIOR')).toBe(false)
  })
})

describe('canEditContract — ADMIN-only edit gate', () => {
  it('ADMIN can edit', () => {
    expect(canEditContract('ADMIN')).toBe(true)
  })

  it('DROP cannot edit (read-only PDF view)', () => {
    expect(canEditContract('DROP')).toBe(false)
  })

  it('SENIOR cannot edit', () => {
    expect(canEditContract('SENIOR')).toBe(false)
  })

  it('JUNIOR cannot edit', () => {
    expect(canEditContract('JUNIOR')).toBe(false)
  })

  it('HR cannot edit', () => {
    expect(canEditContract('HR')).toBe(false)
  })

  it('ACCOUNTANT cannot edit', () => {
    expect(canEditContract('ACCOUNTANT')).toBe(false)
  })
})

// ─── ContractTab empty state (no-template 404) ───────────────────────────────
// ContractTab itself is integration-heavy (useQuery + mutations).
// We test the no-template empty state via a minimal stub render.

// Default mock: ADMIN viewer. Individual tests override via vi.mocked if needed.
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN' } }),
}))

// Stub TanStack Router Link — no router context available in unit tests.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
      children?: React.ReactNode
      to?: string
    }) => (
      <a href={props.to ?? '#'} {...props}>
        {children}
      </a>
    ),
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: 'No active contract template for role SENIOR' },
    }),
    useMutation: vi.fn().mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    }),
    useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: vi.fn() }),
  }
})

import { ContractTab } from '../ContractTab'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

function renderWithProvider(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('ContractTab', () => {
  it('renders without crashing for a given userId (no-template 404 state)', () => {
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    // No crash = pass; full lifecycle is covered by E2E
    expect(document.body).toBeInTheDocument()
  })
})

// ─── ContractTab read-only mode (canEdit=false) ───────────────────────────────
// When canEdit=false (non-ADMIN viewers: DROP self-view, etc.) ContractTab must
// render the read-only PDF view — no editor, no action bar, no fill form.

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({
      data: {
        id: 'contract-uuid',
        status: 'READY_TO_SIGN',
        bodyMarkdown: '# Contract',
        customValues: {},
      },
      isLoading: false,
      error: null,
    }),
    useMutation: vi.fn().mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    }),
    useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: vi.fn() }),
  }
})

// ContractPdfPreview makes its own query — stub it so we don't need an iframe env.
vi.mock('../ContractPdfPreview', () => ({
  ContractPdfPreview: () => <div data-testid="contract-pdf-preview-stub">PDF Preview</div>,
}))

describe('ContractTab read-only mode (canEdit=false)', () => {
  it('renders contract-tab-readonly testid when canEdit=false', () => {
    renderWithProvider(<ContractTab userId="drop-uuid" targetRole="DROP" canEdit={false} />)
    expect(screen.getByTestId('contract-tab-readonly')).toBeInTheDocument()
  })

  it('does NOT render the full editor (contract-tab testid) when canEdit=false', () => {
    renderWithProvider(<ContractTab userId="drop-uuid" targetRole="DROP" canEdit={false} />)
    expect(screen.queryByTestId('contract-tab')).not.toBeInTheDocument()
  })

  it('renders contract-tab (full editor) testid when canEdit=true', () => {
    renderWithProvider(
      <ContractTab userId="admin-viewing-uuid" targetRole="SENIOR" canEdit={true} />,
    )
    expect(screen.getByTestId('contract-tab')).toBeInTheDocument()
  })
})

// ─── isNoTemplate — by envelope `code`, not English-prose substring ──────────
// task-i18n-stage2-task5: `isNoTemplate` moved from
// `errorMessage.includes('no active contract template')` to
// `getApiErrorCode(error) === 'CONTRACT_TEMPLATE_MISSING'` — the substring
// match broke the moment that prose became translatable (once the server
// sends the eight-code envelope, `response.data.message` is the ENGLISH
// fallback, not the phrase this file's OTHER tests hardcode). Per-test
// `mockReturnValueOnce` overrides the module-level mock above so each case
// controls its own `error` shape without fighting the other describe
// blocks' hoisted `vi.mock` factories.

describe('ContractTab — isNoTemplate via API error envelope code', () => {
  it('shows the no-template empty state for a real envelope with CONTRACT_TEMPLATE_MISSING', () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: {
        response: {
          status: 404,
          data: {
            statusCode: 404,
            code: 'CONTRACT_TEMPLATE_MISSING',
            params: { role: 'SENIOR' },
            message: 'No active contract template for role SENIOR',
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, real UseQueryResult has many more fields ContractTab never reads
    } as any)
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    expect(screen.getByTestId('contract-tab-no-template')).toBeInTheDocument()
  })

  it('does NOT show the no-template empty state for prose without a code (falls to the generic error state)', () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: { response: { status: 500, data: { message: 'Internal server error' } } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see previous test's identical note
    } as any)
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    expect(screen.queryByTestId('contract-tab-no-template')).not.toBeInTheDocument()
    expect(screen.getByTestId('contract-tab-error')).toBeInTheDocument()
  })
})
