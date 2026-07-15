/**
 * task-receipts-frontend — `canAttachReceipt()` RBAC+status gate.
 *
 * Pins the RBAC table from the task-file (§ RBAC):
 *   | Role                | Attach (no receipt) | Replace before PAID | Replace after PAID |
 *   |---------------------|----------------------|----------------------|---------------------|
 *   | ADMIN / ACCOUNTANT  | yes                  | yes                  | yes                 |
 *   | Author (createdBy)  | yes                  | yes                  | NO                  |
 *   | Others              | no                   | no                   | no                  |
 *
 * This is the SINGLE shared gate imported by TransactionRow, TransactionDetailDialog
 * and AttachReceiptSheet — pinning it here catches any drift between those three
 * surfaces at the source.
 */
import { describe, expect, it } from 'vitest'
import { canAttachReceipt } from '../receipt-permissions'

const AUTHOR_ID = 'author-1'
const OTHER_ID = 'other-1'

function tx(overrides: Partial<Parameters<typeof canAttachReceipt>[0]> = {}) {
  return {
    createdBy: AUTHOR_ID,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    status: 'PENDING' as const,
    ...overrides,
  }
}

describe('canAttachReceipt — ADMIN / ACCOUNTANT (privileged)', () => {
  it('ADMIN may attach on a receiptless tx regardless of status', () => {
    expect(canAttachReceipt(tx({ status: 'PENDING' }), OTHER_ID, 'ADMIN')).toBe(true)
  })

  it('ADMIN may replace an EXISTING receipt on a PAID tx (privileged override)', () => {
    expect(
      canAttachReceipt(
        tx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'PAID' }),
        OTHER_ID,
        'ADMIN',
      ),
    ).toBe(true)
  })

  it('ACCOUNTANT may replace an EXISTING receipt on a PAID tx too', () => {
    expect(
      canAttachReceipt(
        tx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'PAID' }),
        OTHER_ID,
        'ACCOUNTANT',
      ),
    ).toBe(true)
  })
})

describe('canAttachReceipt — author (createdBy)', () => {
  it('author may attach when the tx has no receipt yet, any status', () => {
    expect(canAttachReceipt(tx({ status: 'PAID' }), AUTHOR_ID, 'SENIOR')).toBe(true)
  })

  it('author may replace their own receipt BEFORE PAID', () => {
    expect(
      canAttachReceipt(
        tx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'VALIDATED' }),
        AUTHOR_ID,
        'SENIOR',
      ),
    ).toBe(true)
  })

  it('author may NOT replace their own receipt AFTER PAID', () => {
    expect(
      canAttachReceipt(
        tx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'PAID' }),
        AUTHOR_ID,
        'SENIOR',
      ),
    ).toBe(false)
  })
})

describe('canAttachReceipt — non-privileged, non-author', () => {
  it('a different user (not author, not privileged) never gets attach/replace', () => {
    expect(canAttachReceipt(tx({ status: 'PENDING' }), OTHER_ID, 'SENIOR')).toBe(false)
    expect(
      canAttachReceipt(
        tx({ receiptExternalUrl: 'https://etherscan.io/tx/0x1', status: 'VALIDATED' }),
        OTHER_ID,
        'SENIOR',
      ),
    ).toBe(false)
  })

  it('a null/undefined currentUserId never matches createdBy (no false-positive author match)', () => {
    expect(canAttachReceipt(tx({ status: 'PENDING' }), null, 'SENIOR')).toBe(false)
    expect(canAttachReceipt(tx({ status: 'PENDING' }), undefined, 'SENIOR')).toBe(false)
  })

  it("HR/JUNIOR (non-privileged roles) get no attach/replace on someone else's tx", () => {
    expect(canAttachReceipt(tx({ status: 'PENDING' }), OTHER_ID, 'HR')).toBe(false)
    expect(canAttachReceipt(tx({ status: 'PENDING' }), OTHER_ID, 'JUNIOR')).toBe(false)
  })
})
