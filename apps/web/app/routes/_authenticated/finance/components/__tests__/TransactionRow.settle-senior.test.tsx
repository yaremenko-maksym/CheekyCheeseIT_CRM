/**
 * TransactionRow.settle-senior.test.tsx — task-senior-settle-in-tx-row.
 *
 * Pins the new in-row settle flow that replaced the (removed)
 * PendingSettlementCompanyCard:
 *
 *   - ADMIN / ACCOUNTANT see «Выплатить» on a SENIOR_PENDING_PAYOUT row in
 *     PENDING_PAYMENT; clicking calls onSettleSeniorPayout(tx).
 *   - SENIOR / DROP / JUNIOR / HR never see it (privileged money action).
 *   - The button is gated to SENIOR_PENDING_PAYOUT + PENDING_PAYMENT only
 *     (not other types / other statuses).
 *
 * settle-drop-btn: also pins the mirror for DROP_PENDING_PAYOUT rows (same
 * shape, same generic settle-company endpoint — see the second describe block
 * below). The RBAC condition is asserted to be IDENTICAL to the senior branch.
 *
 * The row is a <motion.tr> rendered inside <AnimatePresence>; we mock
 * framer-motion to plain DOM and @tanstack/react-router's <Link> to an anchor
 * so the component renders without a router. SENIOR_PENDING_PAYOUT rows hit the
 * FromTo default branch (no <Link>) anyway, but the mock keeps the test robust.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TransactionDto } from '@crm/shared'

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: Record<string, unknown>) => {
          const Tag = tag as keyof React.JSX.IntrinsicElements
          // Strip framer-only props that React would warn about.
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

import { TransactionRow } from '../TransactionRow'

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const TX_ID = '22222222-2222-4222-8222-222222222222'

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: TX_ID,
    type: 'SENIOR_PENDING_PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '560',
    currency: 'USDT',
    senderId: null,
    senderLabel: 'COMPANY',
    senderName: null,
    receiverId: SENIOR_ID,
    receiverLabel: null,
    receiverName: null,
    projectId: null,
    projectName: null,
    payoutRequestId: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    recipientId: SENIOR_ID,
    createdBy: SENIOR_ID,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

function renderRow(props: {
  tx: TransactionDto
  role: string
  onSettleSeniorPayout?: (tx: TransactionDto) => void
}) {
  return render(
    <table>
      <tbody>
        <TransactionRow
          tx={props.tx}
          role={props.role}
          rates={undefined}
          onValidate={() => {}}
          onEdit={() => {}}
          onAdminEdit={() => {}}
          onDelete={() => {}}
          onPaySalary={() => {}}
          onOpenPayoutDetail={() => {}}
          onConfirmPayout={() => {}}
          {...(props.onSettleSeniorPayout
            ? { onSettleSeniorPayout: props.onSettleSeniorPayout }
            : {})}
        />
      </tbody>
    </table>,
  )
}

const SETTLE_TESTID = `tx-row-settle-senior-payout-${TX_ID}`

describe('TransactionRow — settle senior payout button', () => {
  it('ADMIN sees «Выплатить» on a SENIOR_PENDING_PAYOUT / PENDING_PAYMENT row', () => {
    renderRow({ tx: makeTx(), role: 'ADMIN', onSettleSeniorPayout: () => {} })
    expect(screen.getByTestId(SETTLE_TESTID)).toBeInTheDocument()
    expect(screen.getByTestId(SETTLE_TESTID)).toHaveTextContent('Выплатить')
  })

  it('ACCOUNTANT sees «Выплатить»', () => {
    renderRow({ tx: makeTx(), role: 'ACCOUNTANT', onSettleSeniorPayout: () => {} })
    expect(screen.getByTestId(SETTLE_TESTID)).toBeInTheDocument()
  })

  it('clicking «Выплатить» calls onSettleSeniorPayout with the tx', async () => {
    const onSettle = vi.fn()
    renderRow({ tx: makeTx(), role: 'ADMIN', onSettleSeniorPayout: onSettle })
    await userEvent.click(screen.getByTestId(SETTLE_TESTID))
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onSettle.mock.calls[0]?.[0]?.id).toBe(TX_ID)
  })

  it('SENIOR does NOT see the settle button (privileged action)', () => {
    renderRow({ tx: makeTx(), role: 'SENIOR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('DROP does NOT see the settle button', () => {
    renderRow({ tx: makeTx(), role: 'DROP', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('JUNIOR does NOT see the settle button', () => {
    renderRow({ tx: makeTx(), role: 'JUNIOR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('HR does NOT see the settle button', () => {
    renderRow({ tx: makeTx(), role: 'HR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('not shown when the row is already PAID (ADMIN)', () => {
    renderRow({
      tx: makeTx({ status: 'PAID' }),
      role: 'ADMIN',
      onSettleSeniorPayout: () => {},
    })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('not shown for a non-SENIOR_PENDING_PAYOUT type in PENDING_PAYMENT (ADMIN)', () => {
    renderRow({
      tx: makeTx({ type: 'PAYOUT' }),
      role: 'ADMIN',
      onSettleSeniorPayout: () => {},
    })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('not shown when the onSettleSeniorPayout handler is absent', () => {
    renderRow({ tx: makeTx(), role: 'ADMIN' })
    expect(screen.queryByTestId(SETTLE_TESTID)).not.toBeInTheDocument()
  })
})

// settle-drop-btn: mirror of the SENIOR_PENDING_PAYOUT suite above for
// DROP_PENDING_PAYOUT rows (the company's IOU to a drop from their own
// USDT-project income — same row shape, same generic settle-company endpoint,
// see TransactionRow.tsx canSettleSeniorPayout). The RBAC condition MUST stay
// identical to the senior branch — no additional restriction for the mirror.
const DROP_ID = '33333333-3333-4333-8333-333333333333'
const DROP_TX_ID = '44444444-4444-4444-8444-444444444444'

function makeDropTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return makeTx({
    id: DROP_TX_ID,
    type: 'DROP_PENDING_PAYOUT',
    receiverId: DROP_ID,
    recipientId: DROP_ID,
    createdBy: DROP_ID,
    ...overrides,
  })
}

const DROP_SETTLE_TESTID = `tx-row-settle-senior-payout-${DROP_TX_ID}`

describe('TransactionRow — settle drop payout button (mirror of settle senior)', () => {
  it('ADMIN sees «Выплатить» on a DROP_PENDING_PAYOUT / PENDING_PAYMENT row', () => {
    renderRow({ tx: makeDropTx(), role: 'ADMIN', onSettleSeniorPayout: () => {} })
    expect(screen.getByTestId(DROP_SETTLE_TESTID)).toBeInTheDocument()
    expect(screen.getByTestId(DROP_SETTLE_TESTID)).toHaveTextContent('Выплатить')
  })

  it('ACCOUNTANT sees «Выплатить» on a DROP_PENDING_PAYOUT row', () => {
    renderRow({ tx: makeDropTx(), role: 'ACCOUNTANT', onSettleSeniorPayout: () => {} })
    expect(screen.getByTestId(DROP_SETTLE_TESTID)).toBeInTheDocument()
  })

  it('clicking «Выплатить» on a DROP row calls onSettleSeniorPayout with the tx', async () => {
    const onSettle = vi.fn()
    renderRow({ tx: makeDropTx(), role: 'ADMIN', onSettleSeniorPayout: onSettle })
    await userEvent.click(screen.getByTestId(DROP_SETTLE_TESTID))
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onSettle.mock.calls[0]?.[0]?.id).toBe(DROP_TX_ID)
    expect(onSettle.mock.calls[0]?.[0]?.type).toBe('DROP_PENDING_PAYOUT')
  })

  it('SENIOR does NOT see the settle button on a DROP row (privileged action)', () => {
    renderRow({ tx: makeDropTx(), role: 'SENIOR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('DROP does NOT see the settle button on its own DROP_PENDING_PAYOUT row', () => {
    renderRow({ tx: makeDropTx(), role: 'DROP', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('JUNIOR does NOT see the settle button on a DROP row', () => {
    renderRow({ tx: makeDropTx(), role: 'JUNIOR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('HR does NOT see the settle button on a DROP row', () => {
    renderRow({ tx: makeDropTx(), role: 'HR', onSettleSeniorPayout: () => {} })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('not shown when the DROP row is already PAID (ADMIN)', () => {
    renderRow({
      tx: makeDropTx({ status: 'PAID' }),
      role: 'ADMIN',
      onSettleSeniorPayout: () => {},
    })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })

  it('not shown when the onSettleSeniorPayout handler is absent (DROP row)', () => {
    renderRow({ tx: makeDropTx(), role: 'ADMIN' })
    expect(screen.queryByTestId(DROP_SETTLE_TESTID)).not.toBeInTheDocument()
  })
})
