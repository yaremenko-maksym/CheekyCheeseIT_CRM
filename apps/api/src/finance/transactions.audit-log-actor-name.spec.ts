/**
 * Unit tests for TransactionsService.getTransactionAuditLog — actor name for a
 * hard-deleted actor (i18n server-text PR4, S4).
 *
 * `transaction_audit_log.actor_id` is `ON DELETE SET NULL`, so the LEFT JOIN on
 * `users` yields no name for a removed user. The server used to substitute a
 * Russian placeholder; it now returns `null` and the client renders the
 * localized «User deleted» fallback. A known actor keeps the real name.
 * ADMIN-only: every other role still gets 403 before any read.
 */
import { describe, expect, it } from 'vitest'
import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const TX_ID = '11111111-1111-4111-8111-111111111111'

function user(role: SessionUser['role']): SessionUser {
  return {
    id: `${role.toLowerCase()}-1`,
    role,
    displayName: `Test ${role}`,
    email: `${role.toLowerCase()}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

function makeService(rows: Array<{ actorId: string | null; actorName: string | null }>) {
  const entries = rows.map((r, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    action: 'DELETE',
    actorId: r.actorId,
    actorName: r.actorName,
    metadata: { reason: 'x' },
    createdAt: new Date(`2025-01-0${i + 1}T00:00:00Z`),
  }))
  const chain: Record<string, unknown> = {}
  chain['from'] = () => chain
  chain['leftJoin'] = () => chain
  chain['where'] = () => chain
  chain['orderBy'] = () => Promise.resolve(entries)
  const dbStub = {
    db: {
      query: { transactions: { findFirst: () => Promise.resolve({ deletedAt: null }) } },
      select: () => chain,
    },
  }
  return makeTransactionsService({ db: dbStub as never })
}

describe('getTransactionAuditLog — actorName', () => {
  it('returns null (not a Russian placeholder) when the actor row is gone', async () => {
    const svc = makeService([{ actorId: null, actorName: null }])
    const log = await svc.getTransactionAuditLog(TX_ID, user('ADMIN'))
    expect(log).toHaveLength(1)
    expect(log[0]?.actorName).toBeNull()
    expect(log[0]?.actorId).toBeNull()
  })

  it('keeps the real displayName for a known actor', async () => {
    const svc = makeService([
      { actorId: '22222222-2222-4222-8222-222222222222', actorName: 'Real Admin' },
      { actorId: null, actorName: null },
    ])
    const log = await svc.getTransactionAuditLog(TX_ID, user('ADMIN'))
    expect(log.map((e) => e.actorName)).toEqual(['Real Admin', null])
  })

  it.each(['ACCOUNTANT', 'SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)(
    '%s is refused before any read (ADMIN-only journal)',
    async (role) => {
      const svc = makeService([{ actorId: null, actorName: null }])
      await expect(svc.getTransactionAuditLog(TX_ID, user(role))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    },
  )
})
