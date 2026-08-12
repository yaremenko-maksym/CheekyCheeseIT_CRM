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
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DropSelfSummaryDto } from '@crm/shared'
import { DropBalanceCard } from '../DropBalanceCard'

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

describe('DropBalanceCard (self-view)', () => {
  it('shows a loading skeleton', () => {
    render(<DropBalanceCard summary={undefined} isLoading isError={false} onRetry={vi.fn()} />)
    expect(screen.queryByTestId('drop-balance-card')).not.toBeInTheDocument()
  })

  it('shows an error state with a retry button', () => {
    const onRetry = vi.fn()
    render(<DropBalanceCard summary={undefined} isLoading={false} isError onRetry={onRetry} />)
    expect(screen.getByTestId('drop-balance-card')).toBeInTheDocument()
    expect(screen.getByText('Ошибка загрузки баланса')).toBeInTheDocument()
  })

  describe('§AC1: pending obligation is visible', () => {
    it('renders the booked-but-unpaid amount (the core bug this task fixes)', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 800.48, pendingObligationCount: 2 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('$800.48')
    })

    it('shows a zero pending obligation as $0.00 (no obligations booked)', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 0, pendingObligationCount: 0 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('$0.00')
    })

    it('pluralises the obligation count (1 начисление / 2 начисления)', () => {
      const { rerender } = render(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 300.48, pendingObligationCount: 1 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByTestId('drop-balance-pending-obligation-count')).toHaveTextContent(
        '1 начисление',
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
        '2 начисления',
      )
    })

    it('omits the count suffix when there are no pending obligations', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({ pendingObligationAmount: 0, pendingObligationCount: 0 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      const el = screen.getByTestId('drop-balance-pending-obligation-count')
      expect(el).toHaveTextContent('Ожидает выплаты')
      expect(el).not.toHaveTextContent('начисление')
      expect(el).not.toHaveTextContent('начисления')
    })
  })

  describe('§AC2: accrued and paid never collapse into one number', () => {
    it('balance ($120.75 paid) and pendingObligationAmount ($800.48 accrued) render as DISTINCT figures', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({
            balance: 120.75,
            pendingObligationAmount: 800.48,
            pendingObligationCount: 1,
          })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      // The regression this task closes: a drop seeing 800 booked and 0 paid
      // must never read a blended "$921.23" total anywhere on the card.
      expect(screen.getByTestId('drop-balance-amount')).toHaveTextContent('$120.75')
      expect(screen.getByTestId('drop-balance-pending-obligation')).toHaveTextContent('$800.48')
      expect(screen.queryByText('$921.23')).not.toBeInTheDocument()
    })

    it('paid balance shown as "Выплачено" — a distinct label from "Ожидает выплаты"', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({ balance: 120.75 })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByText('Выплачено')).toBeInTheDocument()
      expect(screen.getByText(/Ожидает выплаты/)).toBeInTheDocument()
    })
  })

  describe('existing metrics still render', () => {
    it('renders share %, В работе, and Долг компании', () => {
      render(
        <DropBalanceCard
          summary={makeSummary({
            dropSharePercent: 7,
            pendingIncomesCount: 3,
            debtToCompany: 42.5,
          })}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByTestId('drop-balance-share-percent')).toHaveTextContent('7%')
      expect(screen.getByTestId('drop-balance-pending-count')).toHaveTextContent('3')
      expect(screen.getByTestId('drop-balance-debt')).toHaveTextContent('$42.50')
    })
  })
})
