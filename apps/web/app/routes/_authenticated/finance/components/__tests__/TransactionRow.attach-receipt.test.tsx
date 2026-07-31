/**
 * task-receipts-frontend — TransactionRow attach/replace-receipt icon.
 *
 * Pins:
 * 1. hasReceipt=false + canAttachReceipt=true (privileged/author) → clickable
 *    muted `Receipt` button, clicking calls onAttachReceipt(tx).
 * 2. hasReceipt=true + canAttachReceipt=true → clickable emerald `Receipt`
 *    button (replace mode).
 * 3. hasReceipt=true + canAttachReceipt=false (e.g. author + PAID) → a
 *    non-interactive `<span>` indicator, NOT a button — no replace offered.
 * 4. hasReceipt=false + canAttachReceipt=false → nothing rendered (no noise
 *    for viewers with no rights on a receiptless row).
 * 5. Without an `onAttachReceipt` handler at all (e.g. the dashboard's
 *    read-only ActiveTransactionsTable) → no interactive button renders,
 *    even for a privileged role (mirrors every other row action in this
 *    component, which all gate on `handler &&`).
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

const AUTHOR_ID = '11111111-1111-4111-8111-111111111111'
const TX_ID = '22222222-2222-4222-8222-222222222222'

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: TX_ID,
    type: 'ADMIN_INCOME',
    status: 'VALIDATED',
    amount: '500',
    currency: 'USD',
    senderId: AUTHOR_ID,
    senderLabel: null,
    senderName: 'Author',
    receiverId: null,
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
    txFromAddress: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    recipientId: null,
    createdBy: AUTHOR_ID,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

function renderRow(props: {
  tx: TransactionDto
  role: string
  currentUserId?: string | null
  onAttachReceipt?: (tx: TransactionDto) => void
}) {
  return render(
    <table>
      <tbody>
        <TransactionRow
          tx={props.tx}
          role={props.role}
          rates={undefined}
          currentUserId={props.currentUserId ?? null}
          onValidate={() => {}}
          onEdit={() => {}}
          onAdminEdit={() => {}}
          onDelete={() => {}}
          onPaySalary={() => {}}
          onOpenPayoutDetail={() => {}}
          onConfirmPayout={() => {}}
          {...(props.onAttachReceipt ? { onAttachReceipt: props.onAttachReceipt } : {})}
        />
      </tbody>
    </table>,
  )
}

const ATTACH_TESTID = `tx-row-attach-receipt-${TX_ID}`
const INDICATOR_TESTID = `tx-row-receipt-indicator-${TX_ID}`

describe('TransactionRow — attach/replace-receipt icon', () => {
  it('privileged ADMIN + no receipt → clickable muted button; clicking fires onAttachReceipt', async () => {
    const onAttachReceipt = vi.fn()
    renderRow({ tx: makeTx({ status: 'VALIDATED' }), role: 'ADMIN', onAttachReceipt })
    const btn = screen.getByTestId(ATTACH_TESTID)
    expect(btn.tagName).toBe('BUTTON')
    await userEvent.click(btn)
    expect(onAttachReceipt).toHaveBeenCalledTimes(1)
    expect(onAttachReceipt.mock.calls[0]?.[0]?.id).toBe(TX_ID)
  })

  it('ADMIN + EXISTING receipt → clickable emerald button (replace mode)', () => {
    renderRow({
      tx: makeTx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'PAID' }),
      role: 'ADMIN',
      onAttachReceipt: () => {},
    })
    const btn = screen.getByTestId(ATTACH_TESTID)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.className).toMatch(/emerald/)
    expect(screen.queryByTestId(INDICATOR_TESTID)).not.toBeInTheDocument()
  })

  it('author + PAID + existing receipt → non-interactive indicator, no replace button', () => {
    renderRow({
      tx: makeTx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'PAID' }),
      role: 'SENIOR',
      currentUserId: AUTHOR_ID,
      onAttachReceipt: () => {},
    })
    const indicator = screen.getByTestId(INDICATOR_TESTID)
    expect(indicator.tagName).toBe('SPAN')
    expect(screen.queryByTestId(ATTACH_TESTID)).not.toBeInTheDocument()
  })

  it('author BEFORE PAID may still replace (clickable button)', () => {
    renderRow({
      tx: makeTx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'VALIDATED' }),
      role: 'SENIOR',
      currentUserId: AUTHOR_ID,
      onAttachReceipt: () => {},
    })
    expect(screen.getByTestId(ATTACH_TESTID).tagName).toBe('BUTTON')
  })

  it('no receipt + no rights → renders nothing (no noise for uninvolved viewers)', () => {
    renderRow({
      tx: makeTx({ status: 'PENDING' }),
      role: 'SENIOR',
      currentUserId: 'someone-else',
      onAttachReceipt: () => {},
    })
    expect(screen.queryByTestId(ATTACH_TESTID)).not.toBeInTheDocument()
    expect(screen.queryByTestId(INDICATOR_TESTID)).not.toBeInTheDocument()
  })

  it('without an onAttachReceipt handler, no interactive button renders even for ADMIN', () => {
    renderRow({ tx: makeTx({ status: 'PENDING' }), role: 'ADMIN' })
    expect(screen.queryByTestId(ATTACH_TESTID)).not.toBeInTheDocument()
  })
})
