/**
 * DropBalanceCard.test.tsx — unit tests for the redesigned DropBalanceCard
 * component (feat/drop-balances-panel).
 *
 * Covers:
 *   - empty-state («—» amount + «нет выплат» sub-label when balance=0)
 *   - share % badge rendering (always shown — dropSharePercent is non-nullable
 *     after MED-3 fix; backend applies DEFAULT_DROP_SHARE_PERCENT fallback)
 *   - pending badge visibility (pendingCount > 0 / = 0)
 *   - balance colour: green (>0), red (<0), muted (=0 / «—»)
 *   - USDT label shows only when hasBalance
 *   - header counter uses correct ru-RU plural (MED-4): 1 дроп / 2 дропа / 5 дропов
 *   - multiple drop rows with Separator
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { FinanceSummaryDto } from '@crm/shared'
import { DropBalanceCard } from '../components/KpiCards'

const DROP_ID = 'a0000000-0000-4000-8000-000000000007'
const DROP_ID_2 = 'a0000000-0000-4000-8000-000000000008'

function makeSummary(dropBalances: FinanceSummaryDto['dropBalances']): FinanceSummaryDto {
  return {
    totalIncome: 0,
    totalExpenses: 0,
    totalSalaries: 0,
    netBalance: 0,
    adminBalances: [],
    dropBalances,
    monthly: [],
  }
}

describe('DropBalanceCard', () => {
  it('returns null when dropBalances is empty', () => {
    const { container } = render(<DropBalanceCard summary={makeSummary([])} />)
    // `toBeEmptyDOMElement()` instead of `container.firstChild).toBeNull()`
    // (task-lint-teeth): same guarantee — the component rendered nothing —
    // without reaching into DOM internals, and with a far better failure
    // message (it prints what WAS rendered).
    expect(container).toBeEmptyDOMElement()
  })

  describe('empty-state (balance = 0)', () => {
    it('shows «—» instead of $0.00 when balance is zero', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByTestId(`drop-balance-amount-${DROP_ID}`)).toHaveTextContent('—')
    })

    it('shows «нет выплат» sub-label when balance is zero', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByText('нет выплат')).toBeInTheDocument()
    })

    it('does NOT show USDT label when balance is zero', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.queryByText('USDT')).not.toBeInTheDocument()
    })
  })

  describe('share % badge', () => {
    it('renders share badge with the correct percentage', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 7,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByTestId(`drop-balance-share-${DROP_ID}`)).toHaveTextContent('7%')
    })

    it('always shows share badge (dropSharePercent is non-nullable — backend applies default)', () => {
      // MED-3: dropSharePercent is always a number after the schema fix.
      // The backend applies DEFAULT_DROP_SHARE_PERCENT (5) before responding,
      // so the badge is always rendered.
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByTestId(`drop-balance-share-${DROP_ID}`)).toBeInTheDocument()
      expect(screen.getByTestId(`drop-balance-share-${DROP_ID}`)).toHaveTextContent('5%')
    })
  })

  describe('pending badge', () => {
    it('shows «N ожидают» badge when pendingCount > 0', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 3,
            },
          ])}
        />,
      )
      expect(screen.getByTestId(`drop-balance-pending-${DROP_ID}`)).toHaveTextContent('3 ожидают')
    })

    it('hides pending badge when pendingCount = 0', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.queryByTestId(`drop-balance-pending-${DROP_ID}`)).not.toBeInTheDocument()
    })
  })

  describe('balance colour', () => {
    it('applies text-green-500 for positive balance', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 500,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      const el = screen.getByTestId(`drop-balance-amount-${DROP_ID}`)
      expect(el.className).toContain('text-green-500')
    })

    it('applies text-red-500 for negative balance', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: -200,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      const el = screen.getByTestId(`drop-balance-amount-${DROP_ID}`)
      expect(el.className).toContain('text-red-500')
    })

    it('applies text-muted-foreground for zero balance', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      const el = screen.getByTestId(`drop-balance-amount-${DROP_ID}`)
      expect(el.className).toContain('text-muted-foreground')
    })
  })

  describe('USDT label', () => {
    it('shows USDT label for positive balance', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 1250,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByText('USDT')).toBeInTheDocument()
    })

    it('shows USDT label for negative balance', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: -50,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByText('USDT')).toBeInTheDocument()
    })
  })

  describe('header counter', () => {
    it('shows «1 дроп» for single drop', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      expect(screen.getByTestId('drop-balances-count')).toHaveTextContent('1 дроп')
    })

    it('shows «2 дропа» for two drops (correct ru-RU plural, MED-4)', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
            {
              userId: DROP_ID_2,
              displayName: 'Drop User 2',
              balance: 300,
              dropSharePercent: 10,
              pendingCount: 1,
            },
          ])}
        />,
      )
      expect(screen.getByTestId('drop-balances-count')).toHaveTextContent('2 дропа')
    })

    it('shows «5 дропов» for five drops (ru-RU plural, MED-4)', () => {
      const drops = Array.from({ length: 5 }, (_, i) => ({
        userId: `a0000000-0000-4000-8000-00000000000${i}`,
        displayName: `Drop ${i}`,
        balance: 0,
        dropSharePercent: 5,
        pendingCount: 0,
      }))
      render(<DropBalanceCard summary={makeSummary(drops)} />)
      expect(screen.getByTestId('drop-balances-count')).toHaveTextContent('5 дропов')
    })

    it('shows «21 дроп» for twenty-one drops (edge case ru-RU plural, MED-4)', () => {
      const drops = Array.from({ length: 21 }, (_, i) => ({
        userId: `a0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
        displayName: `Drop ${i}`,
        balance: 0,
        dropSharePercent: 5,
        pendingCount: 0,
      }))
      render(<DropBalanceCard summary={makeSummary(drops)} />)
      expect(screen.getByTestId('drop-balances-count')).toHaveTextContent('21 дроп')
    })
  })

  describe('multiple rows', () => {
    it('renders both drop rows with correct names', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 500,
              dropSharePercent: 5,
              pendingCount: 0,
            },
            {
              userId: DROP_ID_2,
              displayName: 'Drop User 2',
              balance: 0,
              dropSharePercent: 10,
              pendingCount: 2,
            },
          ])}
        />,
      )
      expect(screen.getByTestId(`drop-balance-name-${DROP_ID}`)).toHaveTextContent('Drop User')
      expect(screen.getByTestId(`drop-balance-name-${DROP_ID_2}`)).toHaveTextContent('Drop User 2')
    })

    it('shows «нет выплат» only for the zero-balance drop', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 500,
              dropSharePercent: 5,
              pendingCount: 0,
            },
            {
              userId: DROP_ID_2,
              displayName: 'Drop User 2',
              balance: 0,
              dropSharePercent: 10,
              pendingCount: 0,
            },
          ])}
        />,
      )
      // Only one «нет выплат» — for DROP_ID_2
      const emptyLabels = screen.getAllByText('нет выплат')
      expect(emptyLabels).toHaveLength(1)
    })
  })

  describe('full name display', () => {
    it('renders the full display name without truncation class', () => {
      render(
        <DropBalanceCard
          summary={makeSummary([
            {
              userId: DROP_ID,
              displayName: 'Olha Drozdova Serhiivna',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
          ])}
        />,
      )
      const nameEl = screen.getByTestId(`drop-balance-name-${DROP_ID}`)
      expect(nameEl).toHaveTextContent('Olha Drozdova Serhiivna')
      expect(nameEl.className).not.toContain('truncate')
    })
  })
})
