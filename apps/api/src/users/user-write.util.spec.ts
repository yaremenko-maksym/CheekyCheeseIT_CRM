/**
 * Senior roles PR 2 (review CR-M-3 / SR-M-1): `updateUserRow` clears `technical_roles` on a role
 * write away from SENIOR. The real-DB outcome for both endpoints is in
 * `senior-roles.realdb.integration.spec.ts`; this pins the `set` handed to Drizzle, which the
 * mutation gate can see.
 */
import { describe, expect, it } from 'vitest'

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
