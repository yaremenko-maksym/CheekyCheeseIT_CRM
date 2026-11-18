/**
 * Senior roles PR 2 (review CR-M-3 / SR-M-1): `updateUserRow` clears `technical_roles` on a role
 * write away from SENIOR. The real-DB outcome for both endpoints is in
 * `senior-roles.realdb.integration.spec.ts`; this pins the `set` handed to Drizzle, which the
 * mutation gate can see.
 */
import { describe, expect, it } from 'vitest'

import { PgDialect } from 'drizzle-orm/pg-core'

import { updateUserRow } from './user-write.util'

function captureSet(): { db: Parameters<typeof updateUserRow>[0]; written: () => unknown } {
  let captured: unknown
  const db = {
    update: () => ({
      set: (s: unknown) => {
        captured = s
        return { where: () => ({ returning: async () => [{ id: 'u1' }] }) }
      },
    }),
  } as unknown as Parameters<typeof updateUserRow>[0]
  return { db, written: () => captured }
}

const ACTIVE = { archivedAt: null }

describe('updateUserRow — technical roles follow the role', () => {
  it('a role write away from SENIOR clears technicalRoles in the same UPDATE', async () => {
    const { db, written } = captureSet()
    await updateUserRow(db, 'u1', ACTIVE, { role: 'JUNIOR', updatedAt: 1 })
    expect(written()).toEqual({ role: 'JUNIOR', updatedAt: 1, technicalRoles: [] })
  })

  it('a SENIOR role write keeps the technicalRoles the caller sent', async () => {
    const { db, written } = captureSet()
    await updateUserRow(db, 'u1', ACTIVE, { role: 'SENIOR', technicalRoles: ['CTO'] })
    expect(written()).toEqual({ role: 'SENIOR', technicalRoles: ['CTO'] })
  })

  it('a write without a role never touches technicalRoles', async () => {
    const { db, written } = captureSet()
    await updateUserRow(db, 'u1', ACTIVE, { monthlySalary: 100 })
    expect(written()).toEqual({ monthlySalary: 100 })
  })
})

/**
 * Review SR-L-2: `existing` is read before this call, so a roles write carries the role it was
 * READ as. The statement therefore re-checks `role = 'SENIOR'` itself, where Postgres evaluates it
 * against the committed row — the same two-layer shape the archival predicate above uses, and the
 * same guard the self-edit path already had (SR2-L-1). The real-DB outcome is in
 * `senior-roles.realdb.integration.spec.ts`; this pins the predicate and the miss split.
 */
describe('updateUserRow — a roles write re-checks the SENIOR role in the statement', () => {
  const whereSql = (condition: unknown) => new PgDialect().sqlToQuery(condition as never).sql

  function captureWhere(rows: unknown[] = [{ id: 'u1' }]) {
    let captured: unknown
    const db = {
      update: () => ({
        set: () => ({
          where: (c: unknown) => {
            captured = c
            return { returning: async () => rows }
          },
        }),
      }),
    } as unknown as Parameters<typeof updateUserRow>[0]
    return { db, where: () => captured }
  }

  it('attaches the role re-check to a non-empty roles write that does not set the role', async () => {
    const { db, where } = captureWhere()
    await updateUserRow(db, 'u1', ACTIVE, { technicalRoles: ['CTO'], updatedAt: 1 })
    expect(whereSql(where())).toContain('"role"')
  })

  it('attaches no role re-check when the same statement sets the role', async () => {
    const { db, where } = captureWhere()
    await updateUserRow(db, 'u1', ACTIVE, { role: 'SENIOR', technicalRoles: ['CTO'] })
    expect(whereSql(where())).not.toContain('"role"')
  })

  it('attaches no role re-check when the roles write clears the list', async () => {
    const { db, where } = captureWhere()
    await updateUserRow(db, 'u1', ACTIVE, { technicalRoles: [], updatedAt: 1 })
    expect(whereSql(where())).not.toContain('"role"')
  })

  function missed(current: { archivedAt: Date | null; role: string } | null) {
    return {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: async () => (current ? [current] : []) }) }),
    } as unknown as Parameters<typeof updateUserRow>[0]
  }

  it('reads a missed roles write on a surviving non-SENIOR row as a 400, not a 404', async () => {
    const err = await updateUserRow(missed({ archivedAt: null, role: 'JUNIOR' }), 'u1', ACTIVE, {
      technicalRoles: ['CTO'],
      updatedAt: 1,
    }).catch((e: unknown) => e as { response?: { code?: string }; status?: number })
    expect(err?.response?.code).toBe('TECHNICAL_ROLES_SENIOR_ONLY')
    expect(err?.status).toBe(400)
  })

  it('reads a missed roles write on a vanished row as a 404', async () => {
    const err = await updateUserRow(missed(null), 'u1', ACTIVE, {
      technicalRoles: ['CTO'],
      updatedAt: 1,
    }).catch((e: unknown) => e as { response?: { code?: string }; status?: number })
    expect(err?.response?.code).toBe('USER_NOT_FOUND')
    expect(err?.status).toBe(404)
  })

  it('keeps reporting an archival miss as the archived-entitlement refusal', async () => {
    const err = await updateUserRow(
      missed({ archivedAt: new Date(), role: 'SENIOR' }),
      'u1',
      ACTIVE,
      { monthlySalary: 100, technicalRoles: ['CTO'] },
    ).catch((e: unknown) => e as { response?: { code?: string } })
    expect(err?.response?.code).toBe('ENTITLEMENT_TARGET_ARCHIVED')
  })
})
