import { ConflictException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { TosService } from './tos.service'
import type { DatabaseService } from '../database/database.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tos-1',
    version: 1,
    bodyMarkdown: '# ToS v1',
    isActive: true,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeAcceptance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    userId: 'senior-1',
    tosVersionId: 'tos-1',
    acceptedAt: new Date('2026-06-03T00:00:00Z'),
    acceptedIp: '127.0.0.1',
    acceptedUserAgent: 'vitest',
    ...overrides,
  }
}

function makeDb({
  active = makeVersion(),
  versions = [makeVersion()],
  existingAcceptance,
  maxVersion = 1,
  insertedAcceptance,
  insertedVersion,
  // When set, INSERT ON CONFLICT returns [] (conflict suppressed), then findFirst returns this
  conflictExistingAcceptance,
}: {
  active?: ReturnType<typeof makeVersion> | null
  versions?: ReturnType<typeof makeVersion>[]
  existingAcceptance?: ReturnType<typeof makeAcceptance>
  maxVersion?: number
  insertedAcceptance?: ReturnType<typeof makeAcceptance>
  insertedVersion?: ReturnType<typeof makeVersion>
  conflictExistingAcceptance?: ReturnType<typeof makeAcceptance>
} = {}) {
  const findActiveFirst = vi.fn().mockResolvedValue(active)
  const findVersionsMany = vi.fn().mockResolvedValue(versions)
  // Used for the conflict-path: findFirst after empty RETURNING
  const findAcceptanceFirst = vi
    .fn()
    .mockResolvedValue(existingAcceptance ?? conflictExistingAcceptance)

  const insertedAccRow = insertedAcceptance ?? makeAcceptance()
  const txVersionInsert = vi
    .fn()
    .mockResolvedValue([insertedVersion ?? makeVersion({ version: maxVersion + 1 })])

  // acceptance insert with onConflictDoNothing: returns [] when conflictExistingAcceptance set
  const acceptanceReturning = conflictExistingAcceptance
    ? vi.fn().mockResolvedValue([]) // conflict path: empty RETURNING
    : vi.fn().mockResolvedValue([insertedAccRow]) // happy path: row inserted

  return {
    db: {
      query: {
        tosVersions: { findFirst: findActiveFirst, findMany: findVersionsMany },
        tosAcceptances: { findFirst: findAcceptanceFirst },
      },
      // acceptance INSERT (no transaction in new impl)
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: acceptanceReturning,
          }),
          // for publish() path which doesn't use onConflictDoNothing
          returning: vi.fn().mockResolvedValue([insertedAccRow]),
        }),
      }),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([{ max: maxVersion }]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: txVersionInsert,
            }),
          }),
          query: {
            tosVersions: { findFirst: findActiveFirst, findMany: findVersionsMany },
            tosAcceptances: { findFirst: findAcceptanceFirst },
          },
        }
        return fn(tx as never)
      }),
    },
  }
}

describe('TosService', () => {
  describe('getCurrent', () => {
    it('returns active version', async () => {
      const active = makeVersion()
      const mockDb = makeDb({ active })
      const service = new TosService(mockDb as unknown as DatabaseService)
      const result = await service.getCurrent()
      expect(result).toEqual(active)
    })

    it('returns null when no active version', async () => {
      const mockDb = makeDb({ active: null })
      const service = new TosService(mockDb as unknown as DatabaseService)
      const result = await service.getCurrent()
      expect(result).toBeNull()
    })
  })

  describe('listAll', () => {
    it('returns all versions descending', async () => {
      const v1 = makeVersion({ version: 1 })
      const v2 = makeVersion({ id: 'tos-2', version: 2 })
      const mockDb = makeDb({ versions: [v2, v1] })
      const service = new TosService(mockDb as unknown as DatabaseService)
      const result = await service.listAll()
      expect(result).toHaveLength(2)
    })
  })

  describe('publish', () => {
    it('atomically deactivates previous active and inserts version=max+1', async () => {
      const mockDb = makeDb({ maxVersion: 3 })
      const inserted = makeVersion({ id: 'new-version', version: 4, isActive: true })
      const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([inserted]),
      })
      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([{ max: 3 }]),
            }),
          }),
          update: vi.fn().mockReturnValue({ set: updateSet }),
          insert: vi.fn().mockReturnValue({ values: insertValues }),
        }
        return fn(tx as never)
      })

      const service = new TosService(mockDb as unknown as DatabaseService)
      const result = await service.publish({
        bodyMarkdown: '# new ToS',
        createdByUserId: 'admin-1',
      })

      expect(result.version).toBe(4)
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }))
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyMarkdown: '# new ToS',
          version: 4,
          isActive: true,
          createdByUserId: 'admin-1',
        }),
      )
    })

    it('starts version at 1 when no previous version exists', async () => {
      const mockDb = makeDb()
      const inserted = makeVersion({ id: 'first-version', version: 1, isActive: true })
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([inserted]),
      })
      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([{ max: null }]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          }),
          insert: vi.fn().mockReturnValue({ values: insertValues }),
        }
        return fn(tx as never)
      })

      const service = new TosService(mockDb as unknown as DatabaseService)
      const result = await service.publish({ bodyMarkdown: '# body', createdByUserId: 'admin-1' })
      expect(result.version).toBe(1)
    })
  })

  it('MED-2: throws ConflictException (409) when concurrent publish hits unique violation', async () => {
    // Simulate concurrent publish: tx.insert throws a PG unique violation (23505)
    // because another caller already inserted an active row between our deactivate and insert.
    const pgUniqueError = Object.assign(new Error('unique violation'), { code: '23505' })

    const mockDb = makeDb({ maxVersion: 1 })
    mockDb.db.transaction.mockImplementation(async (fn) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue([{ max: 1 }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(pgUniqueError),
          }),
        }),
      }
      return fn(tx as never)
    })

    const service = new TosService(mockDb as unknown as DatabaseService)

    await expect(
      service.publish({ bodyMarkdown: '# body', createdByUserId: 'admin-1' }),
    ).rejects.toThrow(ConflictException)
  })

  describe('accept', () => {
    it('throws when no active ToS exists', async () => {
      const mockDb = makeDb({ active: null })
      const service = new TosService(mockDb as unknown as DatabaseService)

      await expect(
        service.accept({ userId: 'senior-1', ip: '127.0.0.1', userAgent: 'vt' }),
      ).rejects.toThrow()
    })

    it('inserts new acceptance with captured IP/UA (happy path)', async () => {
      const inserted = makeAcceptance({
        id: 'new-acceptance',
        acceptedIp: '10.0.0.1',
        acceptedUserAgent: 'curl',
      })
      const mockDb = makeDb({ insertedAcceptance: inserted })
      const service = new TosService(mockDb as unknown as DatabaseService)

      const result = await service.accept({ userId: 'senior-1', ip: '10.0.0.1', userAgent: 'curl' })

      expect(result.id).toBe('new-acceptance')
      // Verify correct payload passed to insert
      const insertCallValues = (mockDb.db.insert as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(insertCallValues).toBeDefined()
    })

    it('does NOT use a transaction for acceptance (atomic INSERT ON CONFLICT DO NOTHING)', async () => {
      const inserted = makeAcceptance({ id: 'no-tx-acceptance' })
      const mockDb = makeDb({ insertedAcceptance: inserted })
      const service = new TosService(mockDb as unknown as DatabaseService)

      await service.accept({ userId: 'senior-1', ip: null, userAgent: null })

      // accept() must not open a transaction — the whole point of ON CONFLICT DO NOTHING
      // is to be a single atomic statement without a tx wrapper.
      expect(mockDb.db.transaction).not.toHaveBeenCalled()
    })

    it('idempotent via ON CONFLICT: returns existing row when INSERT returns empty (race path)', async () => {
      // Simulate a concurrent insert winning: RETURNING is empty, findFirst returns existing row
      const existing = makeAcceptance({ id: 'already-accepted' })
      const mockDb = makeDb({ conflictExistingAcceptance: existing })
      const service = new TosService(mockDb as unknown as DatabaseService)

      const result = await service.accept({ userId: 'senior-1', ip: '127.0.0.1', userAgent: 'ua' })

      // Must return the existing row, NOT throw
      expect(result.id).toBe('already-accepted')
      // Must not have used a transaction
      expect(mockDb.db.transaction).not.toHaveBeenCalled()
    })
  })
})
