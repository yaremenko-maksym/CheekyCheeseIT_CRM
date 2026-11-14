/**
 * Real-DB RBAC for GET / PUT `/users/:id/availability` (vacancy-queue design §5.2), through
 * `SeniorAvailabilityService` (the layer that holds the rule; `@Roles` is only the coarse gate).
 *
 * Viewer → target:
 *   SENIOR → self: read + write;  ADMIN → active SENIOR: read + write;
 *   ADMIN → a non-senior / archived / missing user: 404;
 *   SENIOR → another senior, HR / JUNIOR / ACCOUNTANT → anyone: 403, and nothing is written.
 *
 * Seed rows are namespaced `savail-` and deleted in afterAll (the availability rows cascade).
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-availability-rbac.integration.spec
 */
import { HttpException } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { ZodError } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { seniorAvailability, users } from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { SeniorAvailabilityService } from './senior-availability.service'

const ID = {
  admin: '5a110014-0000-4000-bb00-0000000000a1',
  senA: '5a110014-0000-4000-bb00-0000000000a2',
  senB: '5a110014-0000-4000-bb00-0000000000a3',
  hr: '5a110014-0000-4000-bb00-0000000000a4',
  junior: '5a110014-0000-4000-bb00-0000000000a5',
  accountant: '5a110014-0000-4000-bb00-0000000000a6',
  archivedSenior: '5a110014-0000-4000-bb00-0000000000a7',
  missing: '5a110014-0000-4000-bb00-0000000000ff',
} as const
const SEEDED = [ID.admin, ID.senA, ID.senB, ID.hr, ID.junior, ID.accountant, ID.archivedSenior]
const FREE = { status: 'FREE', availableFrom: '2026-11-01' } as const

let pool: Pool
let db: DatabaseService['db']
let service: SeniorAvailabilityService

const status = async (run: () => Promise<unknown>): Promise<number | 'ok' | 'zod'> => {
  try {
    await run()
    return 'ok'
  } catch (e) {
    if (e instanceof ZodError) return 'zod'
    if (e instanceof HttpException) return e.getStatus()
    throw e
  }
}
const stored = async (userId: string) =>
  (await db.select().from(seniorAvailability).where(eq(seniorAvailability.userId, userId)))[0]

describe.skipIf(!hasDatabaseUrl())('senior availability RBAC (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await pool.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(pool, { schema })
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })
    service = new SeniorAvailabilityService(dbSvc)
    const user = (id: string, role: (typeof users.$inferInsert)['role'], archived = false) => ({
      id,
      email: `savail-${id}@test.spec`,
      displayName: `savail ${role}`,
      role,
      ...(archived ? { archivedAt: new Date('2026-10-01T00:00:00Z') } : {}),
    })
    await db.delete(users).where(inArray(users.id, SEEDED))
    await db
      .insert(users)
      .values([
        user(ID.admin, 'ADMIN'),
        user(ID.senA, 'SENIOR'),
        user(ID.senB, 'SENIOR'),
        user(ID.hr, 'HR'),
        user(ID.junior, 'JUNIOR'),
        user(ID.accountant, 'ACCOUNTANT'),
        user(ID.archivedSenior, 'SENIOR', true),
      ])
  }, 60_000)

  afterAll(async () => {
    await db?.delete(users).where(inArray(users.id, SEEDED))
    await pool?.end()
  })

  it('SENIOR → self: never set is null; a write is read back', async () => {
    expect(await service.get(ID.senA, ID.senA)).toBeNull()
    expect(await service.set(ID.senA, ID.senA, FREE)).toEqual(FREE)
    expect(await service.get(ID.senA, ID.senA)).toEqual(FREE)
    expect(await service.set(ID.senA, ID.senA, { status: 'BUSY' })).toEqual({ status: 'BUSY' })
    expect(await stored(ID.senA)).toMatchObject({ status: 'BUSY', availableFrom: null })
  })

  it('ADMIN → an active SENIOR: read and write', async () => {
    expect(await service.set(ID.admin, ID.senB, FREE)).toEqual(FREE)
    expect(await service.get(ID.admin, ID.senB)).toEqual(FREE)
  })

  it('SENIOR → another senior: 403 on read and write, the row is untouched', async () => {
    const before = await stored(ID.senB)
    expect(await status(() => service.set(ID.senA, ID.senB, { status: 'BUSY' }))).toBe(403)
    expect(await status(() => service.get(ID.senA, ID.senB))).toBe(403)
    expect(await stored(ID.senB)).toEqual(before)
  })

  it.each([
    ['HR', ID.hr],
    ['JUNIOR', ID.junior],
    ['ACCOUNTANT', ID.accountant],
  ])('%s → a senior: 403 on read and write, nothing written', async (_role, viewer) => {
    const before = await stored(ID.senB)
    expect(await status(() => service.set(viewer, ID.senB, { status: 'BUSY' }))).toBe(403)
    expect(await status(() => service.get(viewer, ID.senB))).toBe(403)
    expect(await stored(ID.senB)).toEqual(before)
  })

  it('a forbidden viewer gets the same 403 for a missing target (no existence oracle)', async () => {
    expect(await status(() => service.get(ID.hr, ID.missing))).toBe(403)
    expect(await status(() => service.get(ID.senA, ID.missing))).toBe(403)
  })

  it('an archived SENIOR cannot write their own availability', async () => {
    expect(await status(() => service.set(ID.archivedSenior, ID.archivedSenior, FREE))).toBe(403)
    expect(await stored(ID.archivedSenior)).toBeUndefined()
  })

  it.each([
    ['an HR user', ID.hr],
    ['an archived senior', ID.archivedSenior],
    ['a missing user', ID.missing],
  ])('ADMIN → %s: 404, nothing written', async (_what, target) => {
    expect(await status(() => service.set(ID.admin, target, FREE))).toBe(404)
    expect(await stored(target)).toBeUndefined()
  })

  it('a body that breaks the shape is refused before any read or write', async () => {
    const before = await stored(ID.senA)
    for (const body of [
      { status: 'FREE' },
      { status: 'BUSY', availableFrom: '2026-11-01' },
      { status: 'FREE', availableFrom: '2026-02-30' },
      { status: 'AWAY' },
      null,
    ]) {
      expect(await status(() => service.set(ID.senA, ID.senA, body))).toBe('zod')
    }
    expect(await stored(ID.senA)).toEqual(before)
  })
})
