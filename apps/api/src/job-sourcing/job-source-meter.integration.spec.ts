import { randomUUID } from 'node:crypto'
import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jobSourceListSchema, type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { jobAccountMeters, jobSources, users } from '../database/schema'
import * as schema from '../database/schema'
import { specRegistry } from '../test/ledger-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { JobSourcingController } from './job-sourcing.controller'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Task 7.5 — the ADMIN source list projects each source's account meter (`used`, `reserved`,
 * `uncertain`, `limit`, `resetsAt`) through the REAL controller, guard chain and Postgres: one
 * request per role. The unit spec (job-sourcing.list-sources.spec.ts) pins the mapping on doubles;
 * only a real database proves the `bigint` cells arrive as numbers, the join picks the right meter,
 * and an elapsed window reads as `used: 0`.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped. Scratch database only.
 */

const JWT_SECRET = 'job-source-meter-integration-secret-0000000'
const GUARD_REFUSAL_CODE = 'FORBIDDEN_INSUFFICIENT_ROLE'
const URL_PATH = '/api/job-sourcing/sources'

const persona = (role: SessionUser['role']): SessionUser => ({
  id: randomUUID(),
  email: `m75-${role.toLowerCase()}-${randomUUID().slice(0, 6)}@test.spec`,
  displayName: `M75 ${role}`,
  avatarUrl: null,
  role,
  seniorSharePercent: 0,
  legalFullName: null,
})

const ADMIN = persona('ADMIN')
const NON_ADMIN = (['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const).map(persona)
const ALL = [ADMIN, ...NON_ADMIN]

let dbSvcRef: DatabaseService

@Global()
@Module({
  providers: [{ provide: DatabaseService, useFactory: () => dbSvcRef }],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [JobSourcingController],
  providers: [
    Reflector,
    {
      provide: JobSourcingService,
      useFactory: (db: DatabaseService) =>
        new JobSourcingService(db, new HrAccessService(db), specRegistry(['REMOTIVE_API'])),
      inject: [DatabaseService],
    },
    {
      provide: APP_GUARD,
      useFactory: (j: JwtService, reflector: Reflector) => new JwtAuthGuard(j, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class MeterTestModule {}

describe.skipIf(!hasDatabaseUrl())('GET /job-sourcing/sources — the meter projection', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let pool: Pool
  const meterIds: string[] = []
  const sourceIds = { live: '', elapsed: '', none: '' }

  const DAY_MS = 86_400_000
  const tag = randomUUID().slice(0, 8)
  const signFor = (u: SessionUser) => jwt.sign({ id: u.id, email: u.email, role: u.role })

  const insertMeter = async (
    suffix: string,
    over: Partial<typeof jobAccountMeters.$inferInsert>,
  ): Promise<string> => {
    const [row] = await dbSvcRef.db
      .insert(jobAccountMeters)
      .values({
        accountKey: `m75:${suffix}-${tag}`,
        unit: 'REQUEST',
        window: 'MONTH',
        windowStartedAt: new Date(Date.now() - 5 * DAY_MS),
        ...over,
      })
      .returning({ id: jobAccountMeters.id })
    const id = row?.id ?? ''
    meterIds.push(id)
    return id
  }

  const insertSource = async (key: string, accountMeterId: string | null): Promise<string> => {
    const [row] = await dbSvcRef.db
      .insert(jobSources)
      .values({ type: 'REMOTIVE_API', config: { m75: key, tag }, accountMeterId })
      .returning({ id: jobSources.id })
    return row?.id ?? ''
  }

  const listAs = async (as: SessionUser) => {
    const res = await app.inject({ method: 'GET', url: URL_PATH, cookies: { jwt: signFor(as) } })
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvcRef = { pool, db } as unknown as DatabaseService
    await db.insert(users).values(
      ALL.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        googleId: `test-m75-${u.id}`,
      })),
    )

    const live = await insertMeter('live', {
      limitAmount: 200,
      used: 120,
      reserved: 10,
      uncertain: 5,
      resetsAt: new Date(Date.now() + 10 * DAY_MS),
    })
    // The window elapsed 2 days ago and nothing has written to the meter since: the stored `used`
    // still belongs to the previous window.
    const elapsed = await insertMeter('elapsed', {
      limitAmount: 200,
      used: 150,
      reserved: 7,
      uncertain: 3,
      windowStartedAt: new Date(Date.now() - 32 * DAY_MS),
      resetsAt: new Date(Date.now() - 2 * DAY_MS),
    })
    sourceIds.live = await insertSource('live', live)
    sourceIds.elapsed = await insertSource('elapsed', elapsed)
    sourceIds.none = await insertSource('none', null)

    const moduleRef = await Test.createTestingModule({ imports: [MeterTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'job-source-meter-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    if (dbSvcRef !== undefined) {
      await dbSvcRef.db
        .delete(jobSources)
        .where(inArray(jobSources.id, Object.values(sourceIds).filter(Boolean)))
      if (meterIds.length > 0) {
        await dbSvcRef.db.delete(jobAccountMeters).where(inArray(jobAccountMeters.id, meterIds))
      }
      await dbSvcRef.db.delete(users).where(
        inArray(
          users.id,
          ALL.map((u) => u.id),
        ),
      )
    }
    await app?.close()
    await pool?.end()
  })

  const itemOf = (body: Record<string, unknown>, id: string) =>
    jobSourceListSchema.parse(body).items.find((i) => i.id === id)

  it('an ADMIN reads the meter of a source whose window is open', async () => {
    const { status, body } = await listAs(ADMIN)
    expect(status).toBe(200)
    expect(itemOf(body, sourceIds.live)?.meter).toEqual({
      unit: 'REQUEST',
      window: 'MONTH',
      limit: 200,
      used: 120,
      reserved: 10,
      uncertain: 5,
      resetsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    })
  })

  it('an elapsed window reads as used 0 with no reset instant; reserved and uncertain stay', async () => {
    const { body } = await listAs(ADMIN)
    expect(itemOf(body, sourceIds.elapsed)?.meter).toEqual({
      unit: 'REQUEST',
      window: 'MONTH',
      limit: 200,
      used: 0,
      reserved: 7,
      uncertain: 3,
      resetsAt: null,
    })
  })

  it('a source with no meter has meter null', async () => {
    const { body } = await listAs(ADMIN)
    expect(itemOf(body, sourceIds.none)?.meter).toBeNull()
  })

  it.each(NON_ADMIN.map((u) => [u.role, u] as const))(
    '%s is refused by the role guard with 403 and sees no meter',
    async (_role, user) => {
      const { status, body } = await listAs(user)
      expect(status).toBe(403)
      expect(body['code']).toBe(GUARD_REFUSAL_CODE)
      expect(JSON.stringify(body)).not.toContain('meter')
    },
  )

  it('the meter row itself is what the API read (guards against a join on the wrong column)', async () => {
    const [row] = await dbSvcRef.db
      .select({ used: jobAccountMeters.used })
      .from(jobAccountMeters)
      .innerJoin(jobSources, eq(jobSources.accountMeterId, jobAccountMeters.id))
      .where(eq(jobSources.id, sourceIds.elapsed))
    expect(row?.used).toBe(150)
  })
})
