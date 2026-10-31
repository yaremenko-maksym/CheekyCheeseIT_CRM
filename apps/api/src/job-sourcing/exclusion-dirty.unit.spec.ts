import type { SessionUser } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markExclusionDirty } from './dirty-producers'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'

// r5 4.6 S5 (CR-M-6): the producer is inert here; its own behaviour is proven in its own specs.
vi.mock('./dirty-producers')

/**
 * r5 Task 4.6 S5 fix round 2 (CR-M-6): the EXCLUSION producer hooks of `JobSourcingService`
 * against a mocked database, so the mutation gate covers them (it runs unit specs only; the
 * real-DB proof is `dirty-producers.services.integration.spec.ts`).
 */
const ID = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'
const admin = { id: 'admin-1', role: 'ADMIN' } as SessionUser
const row = {
  id: ID,
  seniorId: null,
  kind: 'COMPANY',
  value: 'Acme',
  normalizedValue: 'acme',
  createdAt: new Date('2026-10-31T00:00:00Z'),
}

function harness(inserted: unknown[]) {
  const deleted: unknown[] = []
  const values: unknown[] = []
  const tx = {
    insert: () => ({
      values: (v: unknown) => {
        values.push(v)
        return { onConflictDoNothing: () => ({ returning: async () => inserted }) }
      },
    }),
    delete: () => ({
      where: async (cond: unknown) => {
        deleted.push(cond)
      },
    }),
  }
  const select = () => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
  })
  const db = {
    db: {
      select,
      transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
    },
  }
  const svc = new JobSourcingService(db as never, {} as never, new JobSourceRegistry([]))
  return { svc, tx, deleted, values }
}

describe('JobSourcingService exclusion producers (S5)', () => {
  beforeEach(() => vi.mocked(markExclusionDirty).mockClear())

  it('createExclusion marks the new exclusion dirty on the insert transaction', async () => {
    const { svc, tx, values } = harness([row])
    await expect(
      svc.createExclusion({ scope: 'GLOBAL', kind: 'COMPANY', value: '  Acme  ' } as never, admin),
    ).resolves.toMatchObject({ id: ID, scope: 'GLOBAL', origin: 'MANUAL' })
    expect(values).toEqual([
      {
        seniorId: null,
        kind: 'COMPANY',
        value: 'Acme',
        normalizedValue: 'acme',
        createdBy: 'admin-1',
      },
    ])
    expect(vi.mocked(markExclusionDirty).mock.calls).toEqual([[tx, ID, 'exclusion.create']])
  })

  it('a duplicate create (ON CONFLICT, no row) enqueues nothing and returns the existing one', async () => {
    const { svc } = harness([])
    await expect(
      svc.createExclusion({ scope: 'GLOBAL', kind: 'COMPANY', value: 'Acme' } as never, admin),
    ).resolves.toMatchObject({ id: ID })
    expect(markExclusionDirty).not.toHaveBeenCalled()
  })

  it('deleteExclusion deletes and marks dirty on the same transaction', async () => {
    const { svc, tx, deleted } = harness([])
    await expect(svc.deleteExclusion(ID, admin)).resolves.toBeUndefined()
    expect(deleted).toHaveLength(1)
    expect(vi.mocked(markExclusionDirty).mock.calls).toEqual([[tx, ID, 'exclusion.delete']])
  })

  it('a forbidden delete writes nothing and enqueues nothing', async () => {
    const { svc, deleted } = harness([])
    await expect(
      svc.deleteExclusion(ID, { id: 'j', role: 'JUNIOR' } as SessionUser),
    ).rejects.toThrow()
    expect(deleted).toHaveLength(0)
    expect(markExclusionDirty).not.toHaveBeenCalled()
  })
})
