/**
 * task-archived-user-completeness — AC3, unit-level.
 *
 * `archived-money-paths.realdb.integration.spec.ts` already drives these two
 * guards against a real Postgres and asserts nothing is booked. This file
 * exists because that suite is invisible to two things the repo relies on:
 * the mutation gate (Stryker runs the UNIT suite — integration specs are
 * excluded from discovery on any run without the `integration.spec` filter,
 * see vitest.config.mts) and the unit-only CI job. Without a unit-level
 * assertion, deleting either guard is a change every gate accepts.
 *
 * Both tests assert the REFUSAL TEXT by fragment, not by importing a constant:
 * an assertion that compares a message with the very literal it should be
 * pinning cannot fail when that literal is emptied.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { CompanyAccountService } from './company-account.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'

const ADMIN: SessionUser = {
  id: '11111111-0000-4000-aa00-000000000001',
  email: 'archived-money-out-admin@test.spec',
  displayName: 'Admin A',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const RECEIVER_ID = '11111111-0000-4000-aa00-000000000002'
const RECEIPT = 'https://etherscan.io/tx/0xarchivedmoneyoutunitspec'

const archivedAdminRow = {
  id: RECEIVER_ID,
  role: 'ADMIN' as const,
  archivedAt: new Date('2026-02-28T00:00:00.000Z'),
}

/**
 * A DB double that answers the two lookups these paths make before the guard
 * and then FAILS LOUDLY on anything further. The loudness is the point: if a
 * guard is removed, the call does not quietly succeed against a permissive
 * stub — it reaches a transaction that throws a recognisable error, and the
 * `rejects.toThrow(/…/)` assertion on the refusal text still goes red.
 */
function makeDb(userRow: unknown) {
  return {
    db: {
      query: {
        // Idempotency probe in createDividend — no previous dividend.
        transactions: { findFirst: vi.fn().mockResolvedValue(undefined) },
        users: { findFirst: vi.fn().mockResolvedValue(userRow) },
      },
      transaction: vi.fn().mockRejectedValue(new Error('DB WRITE REACHED — guard did not fire')),
      execute: vi.fn().mockRejectedValue(new Error('DB WRITE REACHED — guard did not fire')),
      insert: vi.fn(() => {
        throw new Error('DB WRITE REACHED — guard did not fire')
      }),
    },
  } as never
}

const stubEtherscan = {} as unknown as EtherscanService

describe('AC3 — dividends to an archived ADMIN partner', () => {
  it('createDividend refuses, naming dividends', async () => {
    const svc = new CompanyAccountService(makeDb(archivedAdminRow), stubEtherscan)

    await expect(
      svc.createDividend(
        {
          amount: 100,
          adminId: RECEIVER_ID,
          idempotencyKey: '9f1c0f6e-0000-4000-aa00-000000000001',
          receiptExternalUrl: RECEIPT,
        },
        ADMIN,
      ),
    ).rejects.toThrow(/дивиденды/)
  })

  it('CONTROL: an active ADMIN receiver gets past the archival guard', async () => {
    // Proves the refusal above is caused by `archivedAt` and nothing else: the
    // identical call with the flag cleared reaches the write stage (which this
    // double refuses on purpose, with a different message).
    const svc = new CompanyAccountService(
      makeDb({ ...archivedAdminRow, archivedAt: null }),
      stubEtherscan,
    )

    await expect(
      svc.createDividend(
        {
          amount: 100,
          adminId: RECEIVER_ID,
          idempotencyKey: '9f1c0f6e-0000-4000-aa00-000000000002',
          receiptExternalUrl: RECEIPT,
        },
        ADMIN,
      ),
    ).rejects.toThrow(/DB WRITE REACHED/)
  })
})

describe('AC3 — partner transfers to an archived ADMIN', () => {
  it('createAdminTransfer refuses the RECEIVER, naming the transfer', async () => {
    const svc = makeTransactionsService({ db: makeDb(archivedAdminRow) })

    await expect(
      svc.createAdminTransfer(
        { receiverId: RECEIVER_ID, amount: 50, receiptExternalUrl: RECEIPT },
        ADMIN,
      ),
    ).rejects.toThrow(/перевод невозможен/)
  })

  it('CONTROL: an active ADMIN receiver gets past the archival guard', async () => {
    const svc = makeTransactionsService({
      db: makeDb({ ...archivedAdminRow, archivedAt: null }),
    })

    await expect(
      svc.createAdminTransfer(
        { receiverId: RECEIVER_ID, amount: 50, receiptExternalUrl: RECEIPT },
        ADMIN,
      ),
    ).rejects.toThrow(/DB WRITE REACHED/)
  })
})
