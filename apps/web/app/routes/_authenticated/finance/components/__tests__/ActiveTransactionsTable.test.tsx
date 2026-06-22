/**
 * ActiveTransactionsTable.test.tsx — UT-feedback PR #280 (#4).
 *
 * Pins the dashboard «Активные транзакции» action routing: the inline action
 * buttons must invoke the per-action handlers the dashboard wires to the REUSED
 * finance pay dialogs (SettleSeniorPayout / ConfirmPayout / PaySalary) — NOT a
 * navigate-to-finance shim. Each handler must receive a `TransactionDto` carrying
 * the row `id` AND the `payoutRequestId` projected from the admin summary (so the
 * ConfirmPayoutDialog company-account branch works identically to the Финансы
 * page).
 *
 * The table renders the finance <motion.tr>/<AnimatePresence>; we mock
 * framer-motion to plain DOM and @tanstack/react-router's <Link> to an anchor so
 * the component renders without a router (same pattern as the TransactionRow
 * tests).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminActiveTransaction } from '@crm/shared'

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: Record<string, unknown>) => {
          const Tag = tag as keyof React.JSX.IntrinsicElements
          const { layout, initial, animate, exit, transition, ...rest } = props as Record<
            string,
            unknown
          >
          void layout
          void initial
          void animate
          void exit
          void transition
          return <Tag {...rest}>{children as React.ReactNode}</Tag>
        },
    },
  ),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
    <a {...(props as Record<string, unknown>)}>{children}</a>
  ),
}))

import { ActiveTransactionsTable } from '../ActiveTransactionsTable'

const PAYOUT_ID = 'aa111111-1111-4111-8111-111111111111'
const PAYOUT_REQUEST_ID = 'bb222222-2222-4222-8222-222222222222'
const SENIOR_PAYOUT_ID = 'cc333333-3333-4333-8333-333333333333'
const SALARY_ID = 'dd444444-4444-4444-8444-444444444444'

function makeRow(overrides: Partial<AdminActiveTransaction> = {}): AdminActiveTransaction {
  return {
    id: PAYOUT_ID,
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    senderId: null,
    senderName: 'Senior One',
    senderLabel: 'Senior One',
    receiverId: null,
    receiverName: null,
    receiverLabel: 'CheekyCheeseIT',
    projectId: null,
    projectName: null,
    amount: '500',
    currency: 'USDT',
    txDate: '2026-06-01T10:00:00.000Z',
    payoutRequestId: PAYOUT_REQUEST_ID,
    canPay: true,
    ...overrides,
  }
}

describe('ActiveTransactionsTable — dashboard action routing (#280)', () => {
  it('«Подтвердить оплату» on a PAYOUT row calls onConfirmPayout with id + payoutRequestId', async () => {
    const onConfirmPayout = vi.fn()
    render(
      <ActiveTransactionsTable
        transactions={[makeRow()]}
        loading={false}
        onConfirmPayout={onConfirmPayout}
      />,
    )
    await userEvent.click(screen.getByTestId(`confirm-payout-button-${PAYOUT_ID}`))
    expect(onConfirmPayout).toHaveBeenCalledTimes(1)
    const tx = onConfirmPayout.mock.calls[0]?.[0]
    expect(tx?.id).toBe(PAYOUT_ID)
    // payoutRequestId MUST survive the adapter — the ConfirmPayoutDialog
    // company-account branch confirms off it, not the tx id.
    expect(tx?.payoutRequestId).toBe(PAYOUT_REQUEST_ID)
  })

  it('«Выплатить» on a SENIOR_PENDING_PAYOUT row calls onSettleSeniorPayout with the tx', async () => {
    const onSettleSeniorPayout = vi.fn()
    render(
      <ActiveTransactionsTable
        transactions={[
          makeRow({
            id: SENIOR_PAYOUT_ID,
            type: 'SENIOR_PENDING_PAYOUT',
            status: 'PENDING_PAYMENT',
            payoutRequestId: null,
          }),
        ]}
        loading={false}
        onSettleSeniorPayout={onSettleSeniorPayout}
      />,
    )
    await userEvent.click(screen.getByTestId(`tx-row-settle-senior-payout-${SENIOR_PAYOUT_ID}`))
    expect(onSettleSeniorPayout).toHaveBeenCalledTimes(1)
    expect(onSettleSeniorPayout.mock.calls[0]?.[0]?.id).toBe(SENIOR_PAYOUT_ID)
  })

  it('«Выплатить» on a SALARY row calls onPaySalary with the tx', async () => {
    const onPaySalary = vi.fn()
    render(
      <ActiveTransactionsTable
        transactions={[
          makeRow({
            id: SALARY_ID,
            type: 'SALARY',
            status: 'PENDING',
            canPay: false,
            payoutRequestId: null,
          }),
        ]}
        loading={false}
        onPaySalary={onPaySalary}
      />,
    )
    await userEvent.click(screen.getByTestId(`tx-row-pay-salary-${SALARY_ID}`))
    expect(onPaySalary).toHaveBeenCalledTimes(1)
    expect(onPaySalary.mock.calls[0]?.[0]?.id).toBe(SALARY_ID)
  })

  it('renders no action buttons when no handlers are passed (read-only table)', () => {
    render(<ActiveTransactionsTable transactions={[makeRow()]} loading={false} />)
    expect(screen.queryByTestId(`confirm-payout-button-${PAYOUT_ID}`)).not.toBeInTheDocument()
    // The row itself still renders (finance-style markup is reused).
    expect(screen.getByTestId(`tx-row-${PAYOUT_ID}`)).toBeInTheDocument()
  })

  it('shows the empty state when there are no active transactions', () => {
    render(<ActiveTransactionsTable transactions={[]} loading={false} />)
    expect(screen.getByTestId('admin-active-tx-empty')).toBeInTheDocument()
  })
})
