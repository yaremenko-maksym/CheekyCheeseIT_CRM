/**
 * DropBalanceCard.test.tsx — unit tests for the DROP self-view balance card
 * (task-drop-sees-own-obligations). Renders `GET /finance/drop/me/summary`
 * (DropSelfSummaryDto) — NOT to be confused with the ADMIN-facing multi-drop
 * panel of the same name in `finance/components/KpiCards.tsx`.
 *
 * Covers:
 *   - loading / error states
 *   - §AC1: pending obligation amount is rendered (the core bug this task fixes)
 *   - §AC2: "выплачено" (balance) and "ожидает выплаты" (pendingObligationAmount)
 *     are two SEPARATE numbers, never summed into one figure
 *   - pending-obligation count pluralisation copy
 *   - existing metrics (share %, В работе, Долг компании) still render
 *
 * task-i18n-stage3a (Task 1), Step 4: money now goes through
 * `formatMoney(value, 'USD', locale)` (`@crm/shared`) instead of a local
 * `toLocaleString('en-US', { style: 'currency', ... })` — its contract is
 * always `<amount> <CODE>` (see `format.ts`'s own doc comment), so "$800.48"
 * became "800,48 USD" (uk-UA separator). The obligation-count copy moved off "начисление" —
 * `_Избегать_`-listed — onto "зобов'язання" (Plural, uk grammar).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DropSelfSummaryDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { DropBalanceCard } from '../DropBalanceCard'

beforeEach(async () => {
  await loadCatalog('uk')
})

function makeSummary(overrides: Partial<DropSelfSummaryDto> = {}): DropSelfSummaryDto {
  return {
    balance: 0,
    dropSharePercent: 5,
    pendingIncomesCount: 0,
    debtToCompany: 0,
    pendingObligationAmount: 0,
    pendingObligationCount: 0,
    ...overrides,
  }
}

function renderCard(props: Parameters<typeof DropBalanceCard>[0]) {
  return render(<DropBalanceCard {...props} />, { wrapper: I18nTestProvider })
}

describe('DropBalanceCard (self-view)', () => {
  it('shows a loading skeleton', () => {
    renderCard({ summary: undefined, isLoading: true, isError: false, onRetry: vi.fn() })
    expect(screen.queryByTestId('drop-balance-card')).not.toBeInTheDocument()
  })

  it('shows an error state with a retry button', () => {
    const onRetry = vi.fn()
    renderCard({ summary: undefined, isLoading: false, isError: true, onRetry })
    expect(screen.getByTestId('drop-balance-card')).toBeInTheDocument()
    expect(screen.getByText('Помилка завантаження балансу')).toBeInTheDocument()
  })

  describe('§AC1: pending obligation is visible', () => {
    it('renders the booked-but-unpaid amount (the core bug this task fixes)', () => {
      renderCard({
        summary: makeSummary({ pendingObligationAmount: 800.48, pendingObligationCount: 2 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('800,48 USD')
    })

    it('shows a zero pending obligation as 0,00 USD (no obligations booked, uk-UA separator)', () => {
      renderCard({
        summary: makeSummary({ pendingObligationAmount: 0, pendingObligationCount: 0 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('0,00 USD')
    })

    it("pluralises the obligation count (1 зобов'язання / 2 зобов'язання)", () => {
      const { rerender } = render(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 300.48, pendingObligationCount: 1 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByTestId('drop-balance-pending-obligation-count')).toHaveTextContent(
        "1 зобов'язання",
      )

      rerender(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 800.48, pendingObligationCount: 2 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByTestId('drop-balance-pending-obligation-count')).toHaveTextContent(
        "2 зобов'язання",
      )
    })

    it('omits the count suffix when there are no pending obligations', () => {
      renderCard({
        summary: makeSummary({ pendingObligationAmount: 0, pendingObligationCount: 0 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      const el = screen.getByTestId('drop-balance-pending-obligation-count')
      expect(el).toHaveTextContent('Очікує виплати')
      expect(el).not.toHaveTextContent("зобов'язання")
      expect(el).not.toHaveTextContent("зобов'язань")
      // Exact-text (not substring) check — mutation-gate round 2: a
      // survivor mutated the empty branch to a non-empty literal, which
      // every substring-only assertion above happily ignored, since it only
      // ever checks that certain words are ABSENT, never that the node's
      // full text is EXACTLY "Очікує виплати" with nothing appended.
      expect(el.textContent).toBe('Очікує виплати')
    })
  })

  // task-drop-sees-own-obligations, security-review round 2 (PR #523,
  // MED-gate "9 presentational mutants"): `hasPendingObligation` drives the
  // amber-vs-foreground colour of the pending-obligation figure, but no test
  // read `className` at all — every existing assertion here only checks
  // `textContent`, so the colour ternary (and its own base-class string) could
  // be flipped, forced to always-true/always-false, or emptied outright and
  // every test above would still pass. Kills, per mutant found by
  // `mutation-gate.mjs --changed` scoped to this file:
  //   - line 61 ConditionalExpression → `false` / `true` (forced constant)
  //   - line 61 EqualityOperator `> 0` → `<= 0` / `>= 0` (boundary flip)
  //   - line 100 StringLiteral (shared base classes) → `""`
  //   - line 101 StringLiteral (either ternary branch) → `""`
  describe('pending-obligation colour reflects hasPendingObligation (mutation-gate closure)', () => {
    it('amber when an obligation is booked (pendingObligationAmount > 0)', () => {
      renderCard({
        summary: makeSummary({ pendingObligationAmount: 800.48, pendingObligationCount: 2 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      const el = screen.getByTestId('drop-balance-pending-obligation')
      expect(el).toHaveClass('text-3xl', 'font-bold', 'tabular-nums', 'text-amber-500')
      expect(el).not.toHaveClass('text-foreground')
    })

    it('neutral foreground when nothing is booked (pendingObligationAmount === 0, the boundary itself)', () => {
      renderCard({
        summary: makeSummary({ pendingObligationAmount: 0, pendingObligationCount: 0 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      const el = screen.getByTestId('drop-balance-pending-obligation')
      expect(el).toHaveClass('text-3xl', 'font-bold', 'tabular-nums', 'text-foreground')
      expect(el).not.toHaveClass('text-amber-500')
    })
  })

  describe('§AC2: accrued and paid never collapse into one number', () => {
    it('balance (120.75 paid) and pendingObligationAmount (800.48 accrued) render as DISTINCT figures', () => {
      renderCard({
        summary: makeSummary({
          balance: 120.75,
          pendingObligationAmount: 800.48,
          pendingObligationCount: 1,
        }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      // The regression this task closes: a drop seeing 800 booked and 0 paid
      // must never read a blended "921,23 USD" total anywhere on the card.
      expect(screen.getByTestId('drop-balance-amount')).toHaveTextContent('120,75 USD')
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('800,48 USD')
      expect(screen.queryByText('921,23 USD')).not.toBeInTheDocument()
    })

    it('paid balance shown as "Виплачено" — a distinct label from "Очікує виплати"', () => {
      renderCard({
        summary: makeSummary({ balance: 120.75 }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      expect(screen.getByText('Виплачено')).toBeInTheDocument()
      expect(screen.getByText(/Очікує виплати/)).toBeInTheDocument()
    })
  })

  describe('existing metrics still render', () => {
    it('renders share %, У роботі, and the "pay the company" debt label', () => {
      renderCard({
        summary: makeSummary({
          dropSharePercent: 7,
          pendingIncomesCount: 3,
          debtToCompany: 42.5,
        }),
        isLoading: false,
        isError: false,
        onRetry: vi.fn(),
      })
      expect(screen.getByTestId('drop-balance-share-percent')).toHaveTextContent('7%')
      expect(screen.getByTestId('drop-balance-pending-count')).toHaveTextContent('3')
      expect(screen.getByTestId('drop-balance-debt')).toHaveTextContent('42,50 USD')
    })
  })
})
