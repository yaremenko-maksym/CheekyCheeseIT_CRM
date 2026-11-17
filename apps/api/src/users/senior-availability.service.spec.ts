/**
 * Unit spec for `SeniorAvailabilityService` (PR #1337 CR-L): the viewer → target rule, the read
 * mapping and the audited write, against a fake DB. The same rule on a real DB is pinned by
 * `senior-availability-rbac.integration.spec.ts`; the HTTP guard chain by
 * `senior-availability.controller.integration.spec.ts`.
 */
import { ForbiddenException, HttpException } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import type { AuditLogService } from './audit-log.service'
import { SeniorAvailabilityService, toAvailabilityDto } from './senior-availability.service'
import { loadUserById } from './user-read.util'

vi.mock('./user-read.util', () => ({ loadUserById: vi.fn() }))

const ADMIN = '5a110014-0000-4000-bb00-0000000000a1'
const SEN_A = '5a110014-0000-4000-bb00-0000000000a2'
const SEN_B = '5a110014-0000-4000-bb00-0000000000a3'
const HR = '5a110014-0000-4000-bb00-0000000000a4'

type Role = 'ADMIN' | 'SENIOR' | 'HR' | 'JUNIOR' | 'ACCOUNTANT'
const PEOPLE: Record<string, { id: string; role: Role; archivedAt: Date | null }> = {
  [ADMIN]: { id: ADMIN, role: 'ADMIN', archivedAt: null },
  [SEN_A]: { id: SEN_A, role: 'SENIOR', archivedAt: null },
  [SEN_B]: { id: SEN_B, role: 'SENIOR', archivedAt: null },
  [HR]: { id: HR, role: 'HR', archivedAt: null },
}

let storedRows: { status: 'FREE' | 'BUSY'; availableFrom: string | null }[]
const inserted: unknown[] = []
const upsertSet: unknown[] = []
const record = vi.fn()

function fakeConn() {
  return {
    // projects like SQL does: only the selected columns come back
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            storedRows.map((r) =>
              Object.fromEntries(Object.keys(cols).map((k) => [k, r[k as keyof typeof r]])),
            ),
          ),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v)
        return {
          onConflictDoUpdate: (o: { set: unknown }) => {
            upsertSet.push(o.set)
            return Promise.resolve()
          },
        }
      },
    }),
  }
}

function makeService() {
  const conn = fakeConn()
  const db = {
    db: { ...conn, transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(fakeConn()) },
  } as unknown as DatabaseService
  return new SeniorAvailabilityService(db, { record } as unknown as AuditLogService)
}

const outcome = async (run: () => Promise<unknown>) => {
  try {
    return { ok: await run() }
  } catch (e) {
    if (e instanceof ZodError) return 'zod'
    if (e instanceof HttpException) return e.getStatus()
    throw e
  }
}

beforeEach(() => {
  vi.mocked(loadUserById).mockReset()
  vi.mocked(loadUserById).mockImplementation((_db, id) =>
    Promise.resolve(PEOPLE[id] as Awaited<ReturnType<typeof loadUserById>>),
  )
  storedRows = []
  inserted.length = 0
  upsertSet.length = 0
  record.mockReset()
})

describe('toAvailabilityDto', () => {
  it('no row is null; BUSY drops any day; FREE keeps its day; FREE without a day is null', () => {
    expect(toAvailabilityDto(undefined)).toBeNull()
    expect(toAvailabilityDto({ status: 'BUSY', availableFrom: '2026-11-01' })).toEqual({
      status: 'BUSY',
    })
    expect(toAvailabilityDto({ status: 'FREE', availableFrom: '2026-11-01' })).toEqual({
      status: 'FREE',
      availableFrom: '2026-11-01',
    })
    expect(toAvailabilityDto({ status: 'FREE', availableFrom: null })).toBeNull()
  })
})

describe('SeniorAvailabilityService.get', () => {
  it('SENIOR → self reads the stored value', async () => {
    storedRows = [{ status: 'FREE', availableFrom: '2026-11-01' }]
    expect(await makeService().get(SEN_A, SEN_A)).toEqual({
      status: 'FREE',
      availableFrom: '2026-11-01',
    })
  })

  it('ADMIN → an active senior reads it; never set is null', async () => {
    expect(await makeService().get(ADMIN, SEN_B)).toBeNull()
  })

  it.each([
    ['SENIOR → another senior', SEN_A, SEN_B],
    ['HR → a senior', HR, SEN_B],
    ['HR → self', HR, HR],
    ['an unknown viewer', '5a110014-0000-4000-bb00-0000000000ee', SEN_A],
  ])('%s: 403, decided before the target is read', async (_what, viewer, target) => {
    expect(await outcome(() => makeService().get(viewer, target))).toBe(403)
    expect(vi.mocked(loadUserById)).toHaveBeenCalledTimes(1)
  })

  it('an archived viewer is refused even on self', async () => {
    vi.mocked(loadUserById).mockResolvedValue({
      ...PEOPLE[SEN_A],
      archivedAt: new Date('2026-10-01T00:00:00Z'),
    } as Awaited<ReturnType<typeof loadUserById>>)
    await expect(makeService().get(SEN_A, SEN_A)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it.each([
    ['a non-senior', HR],
    ['a missing user', '5a110014-0000-4000-bb00-0000000000ff'],
  ])('ADMIN → %s: 404', async (_what, target) => {
    expect(await outcome(() => makeService().get(ADMIN, target))).toBe(404)
  })

  it('ADMIN → an archived senior: 404', async () => {
    vi.mocked(loadUserById).mockImplementation((_db, id) =>
      Promise.resolve(
        (id === SEN_B
          ? { ...PEOPLE[SEN_B], archivedAt: new Date('2026-10-01T00:00:00Z') }
          : PEOPLE[id]) as Awaited<ReturnType<typeof loadUserById>>,
      ),
    )
    expect(await outcome(() => makeService().get(ADMIN, SEN_B))).toBe(404)
  })
})

describe('SeniorAvailabilityService.set', () => {
  it('SENIOR → self FREE: upserts the day and audits the change with the senior as actor', async () => {
    const free = { status: 'FREE', availableFrom: '2026-12-01' }
    expect(await outcome(() => makeService().set(SEN_A, SEN_A, free))).toEqual({ ok: free })
    expect(inserted).toEqual([{ userId: SEN_A, status: 'FREE', availableFrom: '2026-12-01' }])
    expect(upsertSet[0]).toMatchObject({ status: 'FREE', availableFrom: '2026-12-01' })
    // an update stamps the row with the database clock
    expect((upsertSet[0] as { updatedAt: unknown }).updatedAt).toEqual(sql`now()`)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]![0]).toEqual({
      actorId: SEN_A,
      targetId: SEN_A,
      action: 'availability_change',
      changes: { availability: { before: null, after: free } },
    })
    // inside the write's transaction, never a bare connection
    expect(record.mock.calls[0]![1]).toBeDefined()
  })

  it('ADMIN → another senior BUSY: the day is cleared and the ADMIN is the audited actor', async () => {
    storedRows = [{ status: 'FREE', availableFrom: '2026-11-01' }]
    await makeService().set(ADMIN, SEN_B, { status: 'BUSY' })
    expect(inserted).toEqual([{ userId: SEN_B, status: 'BUSY', availableFrom: null }])
    expect(upsertSet[0]).toMatchObject({ status: 'BUSY', availableFrom: null })
    expect(record.mock.calls[0]![0]).toEqual({
      actorId: ADMIN,
      targetId: SEN_B,
      action: 'availability_change',
      changes: {
        availability: {
          before: { status: 'FREE', availableFrom: '2026-11-01' },
          after: { status: 'BUSY' },
        },
      },
    })
  })

  it('an ADMIN impersonating a senior is the audited actor, and the row is marked', async () => {
    await makeService().set(SEN_A, SEN_A, { status: 'BUSY' }, ADMIN)
    expect(record.mock.calls[0]![0]).toEqual({
      actorId: ADMIN,
      targetId: SEN_A,
      action: 'availability_change',
      changes: {
        availability: { before: null, after: { status: 'BUSY' } },
        __impersonation: { before: null, after: true },
      },
    })
  })

  it('saving the value already stored writes no audit row', async () => {
    storedRows = [{ status: 'BUSY', availableFrom: null }]
    await makeService().set(SEN_A, SEN_A, { status: 'BUSY' })
    expect(inserted).toHaveLength(1)
    expect(record).not.toHaveBeenCalled()
  })

  it('a forbidden viewer: 403, nothing written or audited', async () => {
    expect(await outcome(() => makeService().set(HR, SEN_B, { status: 'BUSY' }))).toBe(403)
    expect(inserted).toEqual([])
    expect(record).not.toHaveBeenCalled()
  })

  it('a malformed body is refused before any read', async () => {
    expect(await outcome(() => makeService().set(SEN_A, SEN_A, { status: 'FREE' }))).toBe('zod')
    expect(vi.mocked(loadUserById)).not.toHaveBeenCalled()
    expect(inserted).toEqual([])
  })
})
