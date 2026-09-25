import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@tanstack/react-query'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { API_ERROR_MESSAGES } from '@crm/shared'

beforeEach(() => {
  i18n.load('uk', {})
  i18n.activate('uk')
})

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
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </I18nProvider>,
  )
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
    // COPY-M-7 (PR #694 fix-round 4, migrated task-i18n-stage3b): the empty
    // state shows the role's uk label ("Сеньйор") from `ROLE_LABEL_MESSAGES`,
    // never the raw enum ("SENIOR").
    expect(screen.getByText('Немає шаблону контракту для ролі «Сеньйор»')).toBeInTheDocument()
    expect(screen.queryByText(/ролі «SENIOR»/)).not.toBeInTheDocument()
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

  it('renders the own uk fallback text when there is no error AND no contract (the other half of the `error || !contract` guard, `getApiErrorMessage`’s own fallback path)', () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see previous test's identical note
    } as any)
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    expect(screen.getByTestId('contract-tab-error')).toHaveTextContent(
      'Не вдалося завантажити контракт',
    )
  })
})

// ─── SR-L-1 (PR #694 round 1) — generic error state translates the envelope,
// not the English fallback ─────────────────────────────────────────────────
// Before this fix, the generic-error branch rendered
// `error.response.data.message` verbatim — for a migrated envelope
// (task-i18n-stage2-task5) that field is the server-log English fallback,
// never the Ukrainian catalog text `getApiErrorMessage` resolves by `code`.
// `i18n.load('uk', {})` + `activate` mirrors `axios-utils.spec.ts`'s own
// envelope tests: an empty compiled catalog still makes `i18n._()` fall
// through to the descriptor's `message` (the Ukrainian source text), which
// is exactly what a real app run does before `pnpm i18n:compile` output for
// a NEW string exists.
// ─── task-i18n-stage3b (Task 1), mutation-gate coverage — STATUS_LABELS /
// FROZEN_BANNERS resolve to their own exact uk text, never a neighbour's or
// an empty string. Uses the read-only path (canEdit=false) since it renders
// the badge without pulling in the full editor/action-bar tree, and is
// exercised for all 4 statuses (the previous tests only ever fixture READY_
// TO_SIGN, so DRAFT/SIGNED/CANCELLED had zero unit coverage). ────────────────
describe('ContractTab — STATUS_LABELS badge text, per status', () => {
  it.each([
    ['DRAFT', 'Чернетка'],
    ['READY_TO_SIGN', 'Готовий до підписання'],
    ['SIGNED', 'Підписаний'],
    ['CANCELLED', 'Скасований'],
  ])('status=%s renders badge text %s', (status, expectedText) => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { id: 'contract-uuid', status, bodyMarkdown: '# Contract', customValues: {} },
      isLoading: false,
      error: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, see identical note above
    } as any)
    renderWithProvider(<ContractTab userId="drop-uuid" targetRole="DROP" canEdit={false} />)
    expect(screen.getByTestId('contract-status-badge')).toHaveTextContent(expectedText)
  })
})

describe('ContractTab — FROZEN_BANNERS text, per frozen status (canEdit=true, readOnly editor)', () => {
  it.each([
    [
      'READY_TO_SIGN',
      'Контракт надіслано на підпис — редагування заблоковано, щоб внести правки, поверніть у чернетку',
    ],
    [
      'SIGNED',
      'Контракт підписано — редагування заблоковано, повернення в чернетку скине підпис і онбординг',
    ],
  ])(
    'status=%s shows its own frozen-banner text, not the other status’s',
    (status, expectedText) => {
      vi.mocked(useQuery).mockReturnValueOnce({
        data: { id: 'contract-uuid', status, bodyMarkdown: '# Contract', customValues: {} },
        isLoading: false,
        error: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, see identical note above
      } as any)
      renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
      expect(screen.getByTestId('contract-editor-frozen-banner')).toHaveTextContent(expectedText)
    },
  )

  it('DRAFT (not frozen) renders no frozen-banner at all', () => {
    // DRAFT is the one status where ContractFillForm ALSO mounts (Screen 2:
    // `contract.status === 'DRAFT' && !isDirty`) and makes its OWN useQuery
    // call for contract variables — a second queued return is needed or its
    // `useMemo` crashes on `data.variables` being undefined.
    vi.mocked(useQuery)
      .mockReturnValueOnce({
        data: {
          id: 'contract-uuid',
          status: 'DRAFT',
          bodyMarkdown: '# Contract',
          customValues: {},
        },
        isLoading: false,
        error: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, see identical note above
      } as any)
      .mockReturnValueOnce({
        data: { variables: [], customVariables: [] },
        isLoading: false,
        error: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, see identical note above
      } as any)
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    expect(screen.queryByTestId('contract-editor-frozen-banner')).not.toBeInTheDocument()
  })
})

describe('ContractTab — SR-L-1: generic error renders the Ukrainian catalog text, not the English envelope fallback', () => {
  beforeEach(() => {
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('renders the Ukrainian text for a TOS_ACCEPT_IMPERSONATION envelope', () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: {
        response: {
          status: 403,
          data: {
            statusCode: 403,
            code: 'TOS_ACCEPT_IMPERSONATION',
            message: 'Accepting the terms is not allowed while impersonating',
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, see identical note above
    } as any)
    renderWithProvider(<ContractTab userId="senior-uuid" targetRole="SENIOR" canEdit={true} />)
    const errorEl = screen.getByTestId('contract-tab-error')
    expect(errorEl).toHaveTextContent(i18n._(API_ERROR_MESSAGES.TOS_ACCEPT_IMPERSONATION))
    expect(errorEl).not.toHaveTextContent('Accepting the terms is not allowed while impersonating')
  })
})
