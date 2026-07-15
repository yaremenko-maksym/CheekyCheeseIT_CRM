/**
 * TransactionRow.from-to.test.tsx — fix/payout-drop-from-to.
 *
 * Guards the `FromTo` switch inside TransactionRow.tsx against the recurring
 * "new transaction type falls through to `default` and renders a bare «—»"
 * class of bug (already fixed once for DROP_PENDING_PAYOUT / DROP_INCOME).
 *
 * This file pins:
 *   - PAYOUT_DROP (settled drop-share, PAID) — company-funded (senderId=null,
 *     senderLabel='COMPANY') shows the «Счёт компании» alias → the drop, NOT
 *     a bare «—».
 *   - PAYOUT_DROP — ADMIN_PERSONAL-funded (senderId/senderName = the paying
 *     admin) shows the admin AND the drop.
 *   - COMPANY_DEPOSIT and DIVIDEND_TO_ADMIN — the other two LIVE money types
 *     found missing a case during the same audit pass (both insert real rows
 *     via CompanyAccountService and are visible to ADMIN/ACCOUNTANT).
 *   - A representative "intentionally empty" placeholder type (TOV_INCOME —
 *     never emitted by any flow) still renders the dash, so the audit's
 *     exclusion list stays honest.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const DROP_ID = '55555555-5555-4555-8555-555555555555'
const DROP_NAME = 'Дарина Дроп'
const ADMIN_ID = '66666666-6666-4666-8666-666666666666'
const ADMIN_NAME = 'Максим Ярёменко'
const TX_ID = '77777777-7777-4777-8777-777777777777'

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: TX_ID,
    type: 'PAYOUT_DROP',
    status: 'PAID',
    amount: '150',
    currency: 'USDT',
    senderId: null,
    senderLabel: 'COMPANY',
    senderName: null,
    receiverId: DROP_ID,
    receiverLabel: null,
    receiverName: DROP_NAME,
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
    recipientId: DROP_ID,
    createdBy: DROP_ID,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  }
}

function renderRow(tx: TransactionDto, role = 'ADMIN') {
  return render(
    <table>
      <tbody>
        <TransactionRow tx={tx} role={role} rates={undefined} />
      </tbody>
    </table>,
  )
}

describe('TransactionRow — FromTo (fix/payout-drop-from-to)', () => {
  it('PAYOUT_DROP (company-funded, PAID) shows «Счёт компании → drop», not a bare «—»', () => {
    renderRow(makeTx())

    // The literal 'COMPANY' backend marker is normalized to the Russian alias.
    expect(screen.getByText('Счёт компании')).toBeInTheDocument()
    expect(screen.getByText(DROP_NAME)).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('PAYOUT_DROP (ADMIN_PERSONAL-funded) shows the paying admin AND the drop', () => {
    renderRow(
      makeTx({
        senderId: ADMIN_ID,
        senderLabel: ADMIN_NAME,
        senderName: ADMIN_NAME,
      }),
    )

    expect(screen.getByText(ADMIN_NAME)).toBeInTheDocument()
    expect(screen.getByText(DROP_NAME)).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    // The admin sender renders as a clickable profile link (id + name present)
    // — Party() only emits <Link> when both id and name are truthy.
    expect(screen.getByText(ADMIN_NAME).tagName).toBe('A')
    expect(screen.getByText(DROP_NAME).tagName).toBe('A')
  })

  it('COMPANY_DEPOSIT shows the submitter → «Счёт компании», not a bare «—»', () => {
    renderRow(
      makeTx({
        type: 'COMPANY_DEPOSIT',
        senderId: DROP_ID,
        senderLabel: DROP_NAME,
        senderName: DROP_NAME,
        receiverId: null,
        receiverLabel: 'Счёт компании',
        receiverName: null,
      }),
    )

    expect(screen.getByText(DROP_NAME)).toBeInTheDocument()
    expect(screen.getByText('Счёт компании')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('DIVIDEND_TO_ADMIN shows «Счёт компании» → the receiving admin, not a bare «—»', () => {
    renderRow(
      makeTx({
        type: 'DIVIDEND_TO_ADMIN',
        senderId: null,
        senderLabel: 'Счёт компании',
        senderName: null,
        receiverId: ADMIN_ID,
        receiverLabel: null,
        receiverName: ADMIN_NAME,
      }),
    )

    expect(screen.getByText('Счёт компании')).toBeInTheDocument()
    expect(screen.getByText(ADMIN_NAME)).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('a genuinely unused placeholder type (TOV_INCOME) still renders the dash (regression guard)', () => {
    renderRow(
      makeTx({
        type: 'TOV_INCOME',
        senderId: null,
        senderLabel: null,
        senderName: null,
        receiverId: null,
        receiverLabel: null,
        receiverName: null,
      }),
    )

    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

/**
 * task-counterparty-role-masking — frontend composition guard.
 *
 * The identity decision lives on the BACKEND (mapTx): a non-privileged viewer
 * (SENIOR/JUNIOR/DROP/HR) already receives senderLabel='CheekyCheeseIT',
 * senderId=null, senderName=null for an internal company counterparty — the
 * admin's identity never reaches the browser. These tests pin that the row
 * renders that already-masked DTO as the neutral brand (non-clickable, no admin
 * name, not a bare «—»), i.e. the clean back↔front composition holds without
 * re-implementing any masking in the component.
 */
describe('TransactionRow — FromTo masking composition (non-privileged DTO)', () => {
  it('masked company-funded PAYOUT_DROP renders «CheekyCheeseIT», not the admin, not «—»', () => {
    // Shape a DROP receives after backend masking of an admin-personal payout.
    renderRow(
      makeTx({
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        senderName: null,
      }),
      'DROP',
    )

    const brand = screen.getByText('CheekyCheeseIT')
    expect(brand).toBeInTheDocument()
    // Non-clickable: Party() emits a <span> (not <Link>) when id is null.
    expect(brand.tagName).toBe('SPAN')
    // The recipient (the drop themselves) is unaffected and still shown.
    expect(screen.getByText(DROP_NAME)).toBeInTheDocument()
    // No admin identity leaked into the render, and no bare dash.
    expect(screen.queryByText(ADMIN_NAME)).not.toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('displaySenderLabel passes «CheekyCheeseIT» through unchanged (only raw «COMPANY» maps to «Счёт компании»)', () => {
    // A privileged viewer would get raw 'COMPANY' → «Счёт компании» (covered by
    // the suite above); the non-privileged viewer already gets the final brand,
    // so «Счёт компании» must NOT appear for them.
    renderRow(
      makeTx({
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        senderName: null,
      }),
      'SENIOR',
    )

    expect(screen.getByText('CheekyCheeseIT')).toBeInTheDocument()
    expect(screen.queryByText('Счёт компании')).not.toBeInTheDocument()
  })
})
