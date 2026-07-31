/**
 * CompanySharePayoutStrip.test.tsx — task-company-share-cta (AC1).
 *
 * Covers:
 *   - null when nothing outstanding (zero rows, or still loading)
 *   - renders when there IS outstanding validated income for the CURRENT user
 *   - project count + amount reflect the actual (payable, not gross) data
 *   - другой senior's rows never count towards MY banner (receiverId scoping)
 *   - click calls onOpen
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TransactionDto } from '@crm/shared'
import { CompanySharePayoutStrip } from '../CompanySharePayoutStrip'

const ME = '00000000-0000-4000-a000-000000000001'
const OTHER_SENIOR = '00000000-0000-4000-a000-000000000002'

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '1000',
    currency: 'USDT',
    senderId: null,
    senderName: null,
    senderLabel: 'Client Co',
    receiverId: ME,
    receiverName: 'Senior',
    receiverLabel: null,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    dropSharePercent: null,
    dropSharePercentSource: null,
    projectId: 'p1',
    projectName: 'Project One',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: 'accountant-1',
    validatedAt: '2026-07-01T00:00:00.000Z',
    createdBy: ME,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('CompanySharePayoutStrip', () => {
  it('renders nothing when there is no outstanding income', () => {
    const { container } = render(
      <CompanySharePayoutStrip
        transactions={[]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while transactions are still loading (no empty->filled flash)', () => {
    const { container } = render(
      <CompanySharePayoutStrip
        transactions={[makeTx()]}
        isLoading
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('ignores VALIDATED income already attached to a payout request', () => {
    const { container } = render(
      <CompanySharePayoutStrip
        transactions={[makeTx({ payoutRequestId: 'pr-1' })]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("ignores another senior's outstanding income (receiverId scoping)", () => {
    const { container } = render(
      <CompanySharePayoutStrip
        transactions={[makeTx({ receiverId: OTHER_SENIOR })]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the strip with project count and the PAYABLE (not gross) amount', () => {
    render(
      <CompanySharePayoutStrip
        transactions={[makeTx({ amount: '1000', seniorSharePercent: 26 })]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    const strip = screen.getByTestId('company-share-cta-strip')
    expect(strip).toBeInTheDocument()
    expect(strip).toHaveTextContent('1')
    // Payable = 1000 * (1 - 0.26) = 740 — the gross 1000 must NOT appear as
    // the headline amount (AC1's exact regression concern).
    const amount = screen.getByTestId('company-share-cta-amount')
    expect(amount).toHaveTextContent('740')
    expect(amount).not.toHaveTextContent('1 000,00 USDT')
  })

  it('counts distinct projects, not distinct transactions', () => {
    render(
      <CompanySharePayoutStrip
        transactions={[
          makeTx({ id: 't1', projectId: 'p1' }),
          makeTx({ id: 't2', projectId: 'p1' }),
          makeTx({ id: 't3', projectId: 'p2' }),
        ]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('company-share-cta-strip')).toHaveTextContent('2')
  })

  it('calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(
      <CompanySharePayoutStrip
        transactions={[makeTx()]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('company-share-cta-strip'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('shows the mixed-currency subtitle when the outstanding income spans multiple currencies', () => {
    render(
      <CompanySharePayoutStrip
        transactions={[
          makeTx({ id: 't1', currency: 'USDT' }),
          makeTx({ id: 't2', currency: 'EUR' }),
        ]}
        isLoading={false}
        currentUserId={ME}
        userSeniorSharePercent={26}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('company-share-cta-strip')).toHaveTextContent(
      'Несколько валют — точная сумма в модалке',
    )
  })
})
