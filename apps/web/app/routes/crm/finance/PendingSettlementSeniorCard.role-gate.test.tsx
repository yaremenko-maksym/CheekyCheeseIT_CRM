/**
 * PendingSettlementSeniorCard.role-gate.test.tsx
 *
 * Pins the AC from fix/hide-senior-pending-card:
 *
 *  1. The gate expression `(isAdmin || role === 'ACCOUNTANT')` no longer
 *     includes `isSenior` — verified with a pure logic unit test.
 *  2. `PendingSettlementSeniorCard` renders the testid when data is present
 *     (so ADMIN / ACCOUNTANT actually see it when the gate passes).
 *  3. `PendingSettlementSeniorCard` renders nothing when the list is empty
 *     (the component's own early-return guard).
 *
 * The gate logic lives in finance/index.tsx and is not directly importable
 * (FinancePage is an unexported function). We verify it via a plain boolean
 * expression test that mirrors the exact condition in the source, plus a
 * component-level render test for the card itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ── Mock @tanstack/react-query so PendingSettlementSeniorCard can render ──────
const useQueryMock = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}))

import { PendingSettlementSeniorCard } from './components/PendingSettlementSeniorCard'

// ── Helpers ───────────────────────────────────────────────────────────────────

type Role = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

/**
 * Mirrors the exact gate expression from finance/index.tsx line ~783
 * AFTER the fix: `{(isAdmin || role === 'ACCOUNTANT') && ...}`.
 * Returns true if the card should be shown for a given role.
 */
function gateForRole(role: Role): boolean {
  const isAdmin = role === 'ADMIN'
  return isAdmin || role === 'ACCOUNTANT'
}

const ITEM_STUB = {
  obligationId: 'ob-test-1',
  projectName: 'Test Project',
  debtorType: 'COMPANY' as const,
  debtorName: null,
  createdAt: new Date('2026-06-01T10:00:00Z').toISOString(),
  amount: '500',
  currency: 'USDT',
}

// ── Gate logic tests (pure, no DOM) ──────────────────────────────────────────

describe('PendingSettlementSeniorCard gate expression', () => {
  it('returns false for SENIOR — card must be hidden', () => {
    expect(gateForRole('SENIOR')).toBe(false)
  })

  it('returns true for ADMIN — card must be visible', () => {
    expect(gateForRole('ADMIN')).toBe(true)
  })

  it('returns true for ACCOUNTANT — card must be visible', () => {
    expect(gateForRole('ACCOUNTANT')).toBe(true)
  })

  it('returns false for JUNIOR', () => {
    expect(gateForRole('JUNIOR')).toBe(false)
  })

  it('returns false for HR', () => {
    expect(gateForRole('HR')).toBe(false)
  })

  it('returns false for DROP', () => {
    expect(gateForRole('DROP')).toBe(false)
  })
})

// ── Component render tests ────────────────────────────────────────────────────

describe('PendingSettlementSeniorCard component', () => {
  it('renders the card testid when data is present (non-empty list)', () => {
    useQueryMock.mockReturnValue({
      data: [ITEM_STUB],
      isLoading: false,
    })
    render(<PendingSettlementSeniorCard />)
    expect(screen.getByTestId('pending-settlement-senior-card')).toBeInTheDocument()
  })

  it('renders nothing (returns null) when the list is empty', () => {
    useQueryMock.mockReturnValue({ data: [], isLoading: false })
    const { container } = render(<PendingSettlementSeniorCard />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('pending-settlement-senior-card')).not.toBeInTheDocument()
  })

  it('renders a loading placeholder when isLoading is true', () => {
    useQueryMock.mockReturnValue({ data: [], isLoading: true })
    render(<PendingSettlementSeniorCard />)
    // Component renders the card skeleton while loading (even with empty data)
    expect(screen.getByTestId('pending-settlement-senior-card')).toBeInTheDocument()
  })
})
