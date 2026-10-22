/**
 * Unit coverage for PayoutRequestReadService: role-scoped list, field mapping,
 * and the ADMIN/ACCOUNTANT-only audit-field gate. Detail-path RBAC and the
 * obligation merge are pinned through the facade in transactions.rbac-f1-f2.spec.ts.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { PayoutRequestReadService } from './payout-request-read.service'

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-id`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    locale: 'en',
  }
}

function row(id: string, seniorId: string, seniorName: string | null = 'Owner Name') {
  return {
    id,
    seniorId,
    senior: seniorName === null ? null : { displayName: seniorName },
    incomeAmount: '100',
    payableAmount: '74',
    contractAddress: '0xcontract',
    txHash: '0xhash',
    txFromAddress: '0xsender',
    status: 'PAID',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    transactions: [],
  }
}

function makeService(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async () => rows)
  const findFirst = vi.fn(async () => rows[0] ?? null)
  const pendingFindMany = vi.fn(async () => [])
  const db = {
    db: {
      query: {
        payoutRequests: { findMany, findFirst },
        pendingObligations: { findMany: pendingFindMany },
      },
    },
  } as unknown as DatabaseService
  return { svc: new PayoutRequestReadService(db), findMany, findFirst }
}

describe('PayoutRequestReadService.findPayoutRequests', () => {
  const rows = [row('r1', 'senior-id'), row('r2', 'other-id')]

  it('ADMIN and ACCOUNTANT see every request', async () => {
    for (const role of ['ADMIN', 'ACCOUNTANT'] as const) {
      const { svc } = makeService(rows)
      expect((await svc.findPayoutRequests(user(role))).map((r) => r.id)).toEqual(['r1', 'r2'])
    }
  })

  it('SENIOR and DROP see only their own requests', async () => {
    const { svc } = makeService(rows)
    expect((await svc.findPayoutRequests(user('SENIOR'))).map((r) => r.id)).toEqual(['r1'])
    const { svc: svc2 } = makeService([row('r1', 'drop-id'), row('r2', 'x')])
    expect((await svc2.findPayoutRequests(user('DROP'))).map((r) => r.id)).toEqual(['r1'])
  })

  it('JUNIOR and HR see nothing', async () => {
    for (const role of ['JUNIOR', 'HR'] as const) {
      const { svc } = makeService(rows)
      expect(await svc.findPayoutRequests(user(role))).toEqual([])
    }
  })

  it('maps fields and serialises dates', async () => {
    const { svc } = makeService([row('r1', 'senior-id')])
    expect(await svc.findPayoutRequests(user('ADMIN'))).toEqual([
      {
        id: 'r1',
        seniorId: 'senior-id',
        seniorName: 'Owner Name',
        incomeAmount: '100',
        payableAmount: '74',
        contractAddress: '0xcontract',
        txHash: '0xhash',
        txFromAddress: '0xsender',
        status: 'PAID',
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-02-03T04:05:06.000Z',
      },
    ])
  })

  it('falls back to an empty seniorName when the relation is missing', async () => {
    const { svc } = makeService([row('r1', 'senior-id', null)])
    expect((await svc.findPayoutRequests(user('ADMIN')))[0]!.seniorName).toBe('')
  })

  it('exposes the on-chain sender address to ADMIN/ACCOUNTANT only', async () => {
    const own = [row('r1', 'owner')]
    for (const role of ['ADMIN', 'ACCOUNTANT'] as const) {
      const { svc } = makeService(own)
      expect((await svc.findPayoutRequests(user(role)))[0]!.txFromAddress).toBe('0xsender')
    }
    for (const role of ['SENIOR', 'DROP'] as const) {
      const { svc } = makeService(own)
      expect((await svc.findPayoutRequests(user(role, 'owner')))[0]!.txFromAddress).toBeNull()
    }
  })
})

describe('PayoutRequestReadService query shape', () => {
  it('list: newest-first ordering and only the senior display name', async () => {
    const { svc, findMany } = makeService([])
    await svc.findPayoutRequests(user('ADMIN'))
    const arg = findMany.mock.calls[0]![0] as { orderBy: unknown[]; with: unknown }
    expect(arg.orderBy).toHaveLength(1)
    expect(arg.with).toEqual({ senior: { columns: { displayName: true } } })
  })

  it('detail: loads only the columns the masking layer needs', async () => {
    const { svc, findFirst } = makeService([row('r1', 'owner')])
    await svc.findPayoutRequest('r1', user('ADMIN'))
    const arg = findFirst.mock.calls[0]![0] as { where: unknown; with: unknown }
    expect(arg.where).toBeDefined()
    expect(arg.with).toEqual({
      senior: { columns: { displayName: true } },
      transactions: {
        with: {
          sender: { columns: { displayName: true, role: true } },
          receiver: { columns: { displayName: true, role: true } },
          project: { columns: { name: true } },
        },
      },
    })
  })
})

describe('PayoutRequestReadService.findPayoutRequest', () => {
  it('maps the detail and gates the audit field on privileged viewers', async () => {
    const { svc } = makeService([row('r1', 'owner')])
    const admin = await svc.findPayoutRequest('r1', user('ADMIN'))
    expect(admin).toMatchObject({
      id: 'r1',
      seniorId: 'owner',
      seniorName: 'Owner Name',
      incomeAmount: '100',
      payableAmount: '74',
      contractAddress: '0xcontract',
      txHash: '0xhash',
      txFromAddress: '0xsender',
      status: 'PAID',
      transactions: [],
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-02-03T04:05:06.000Z',
    })
    const accountant = await svc.findPayoutRequest('r1', user('ACCOUNTANT'))
    expect(accountant.txFromAddress).toBe('0xsender')
    const owner = await svc.findPayoutRequest('r1', user('SENIOR', 'owner'))
    expect(owner.txFromAddress).toBeNull()
  })

  it('falls back to an empty seniorName on the detail path', async () => {
    const { svc } = makeService([row('r1', 'owner', null)])
    expect((await svc.findPayoutRequest('r1', user('ADMIN'))).seniorName).toBe('')
  })

  it('forbids a non-owner non-privileged viewer', async () => {
    const { svc } = makeService([row('r1', 'owner')])
    await expect(svc.findPayoutRequest('r1', user('HR'))).rejects.toThrow(ForbiddenException)
    await expect(svc.findPayoutRequest('r1', user('DROP', 'someone-else'))).rejects.toThrow(
      ForbiddenException,
    )
    // Matching id alone is not ownership: only SENIOR/DROP can own a request.
    await expect(svc.findPayoutRequest('r1', user('HR', 'owner'))).rejects.toThrow(
      ForbiddenException,
    )
    await expect(svc.findPayoutRequest('r1', user('JUNIOR', 'owner'))).rejects.toThrow(
      ForbiddenException,
    )
  })
})
