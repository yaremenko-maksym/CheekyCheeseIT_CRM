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
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../../auth/jwt.guard'
import { RolesGuard } from '../../common/guards/roles.guard'
import { DatabaseService } from '../../database/database.service'
import { jobSources, users } from '../../database/schema'
import * as schema from '../../database/schema'
import { specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ZodExceptionFilter } from '../../zod-exception.filter'
import { JobSourceRegistry } from '../registry/job-source-registry'
import { createProductionLedger } from '../runtime/production-worker'
import { JobSourceAdminController } from './job-source-admin.controller'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * r5 Task 2.5 T9 AC 1 and AC 3 through the REAL guard chain: the actual controller behind the
 * actual JwtAuthGuard + RolesGuard over a real Fastify pipeline, one request per role. A mocked
 * E2E cannot prove a backend guard.
 *
 * Two gates refuse a non-ADMIN (`@Roles('ADMIN')` and the service's role check), and each would
 * mask the other's absence behind a bare 403. So the HTTP rows require the GUARD's error code,
 * which pins the decorator; the service check is pinned by job-source-admin.integration.spec.ts.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped. Scratch database only.
 */

const JWT_SECRET = 'job-source-admin-rbac-integration-secret-000000'
const GUARD_REFUSAL_CODE = 'FORBIDDEN_INSUFFICIENT_ROLE'

const persona = (role: SessionUser['role']): SessionUser => ({
  id: randomUUID(),
  email: `t9rbac-${role.toLowerCase()}-${randomUUID().slice(0, 6)}@test.spec`,
  displayName: `T9RBAC ${role}`,
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
  controllers: [JobSourceAdminController],
  providers: [
    Reflector,
    { provide: JobSourceRegistry, useValue: specRegistry(['REMOTIVE_API']) },
    {
      provide: JobSourceAdminService,
      // T7: the service runs on THE ledger; here the production one over the spec registry.
      useFactory: (db: DatabaseService, registry: JobSourceRegistry) =>
        new JobSourceAdminService(db, createProductionLedger(db.db, registry)),
      inject: [DatabaseService, JobSourceRegistry],
    },
    // JwtAuthGuard as APP_GUARD, as AppModule does. RolesGuard is NOT global: the controller's own
    // `@UseGuards(RolesGuard)` is what is under test.
    {
      provide: APP_GUARD,
      useFactory: (j: JwtService, reflector: Reflector) => new JwtAuthGuard(j, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class AdminRbacTestModule {}

describe.skipIf(!hasDatabaseUrl())('T9 admin endpoints — real-controller RBAC', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let pool: Pool
  let capped: string

  const signFor = (u: SessionUser) => jwt.sign({ id: u.id, email: u.email, role: u.role })

  const request = async (
    method: 'GET' | 'POST',
    url: string,
    as: SessionUser,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, cookies: { jwt: signFor(as) }, payload })
    const body = res.body ? (JSON.parse(res.body) as { code?: string }) : {}
    return { status: res.statusCode, code: body.code ?? '' }
  }

  const resetUrl = (id: string) => `/api/job-sourcing/admin/sources/${id}/reset-failures`
  const LIST_URL = '/api/job-sourcing/admin/sources/excluded'

  const rowOf = async (id: string) => {
    const [row] = await dbSvcRef.db
      .select({
        failures: jobSources.consecutiveFailures,
        history: jobSources.adminStateHistory,
      })
      .from(jobSources)
      .where(eq(jobSources.id, id))
    return row
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
        googleId: `test-t9rbac-${u.id}`,
      })),
    )
    const [row] = await db
      .insert(jobSources)
      .values({ type: 'REMOTIVE_API', config: { t9rbac: true }, consecutiveFailures: 3 })
      .returning({ id: jobSources.id })
    capped = row?.id ?? ''

    const moduleRef = await Test.createTestingModule({ imports: [AdminRbacTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'job-source-admin-rbac-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    if (dbSvcRef !== undefined) {
      if (capped) await dbSvcRef.db.delete(jobSources).where(eq(jobSources.id, capped))
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

  describe('AC 1: every non-ADMIN role is refused by the controller guard', () => {
    for (const p of NON_ADMIN) {
      it(`${p.role}: GET excluded → 403`, async () => {
        expect(await request('GET', LIST_URL, p)).toEqual({
          status: 403,
          code: GUARD_REFUSAL_CODE,
        })
      })

      it(`${p.role}: POST reset → 403, and nothing is written`, async () => {
        expect(await request('POST', resetUrl(capped), p, { reason: 'try' })).toEqual({
          status: 403,
          code: GUARD_REFUSAL_CODE,
        })
        expect(await rowOf(capped)).toEqual({ failures: 3, history: [] })
      })
    }

    it('without a session: both endpoints → 401', async () => {
      expect((await app.inject({ method: 'GET', url: LIST_URL })).statusCode).toBe(401)
      expect(
        (await app.inject({ method: 'POST', url: resetUrl(capped), payload: { reason: 'x' } }))
          .statusCode,
      ).toBe(401)
    })
  })

  describe('AC 3: a bad body or a malformed id → 400, nothing written', () => {
    it.each([
      ['no body', undefined],
      ['no reason', {}],
      ['a blank reason', { reason: '  ' }],
      ['an over-long reason', { reason: 'x'.repeat(501) }],
    ])('%s', async (_label, payload) => {
      expect((await request('POST', resetUrl(capped), ADMIN, payload)).status).toBe(400)
      expect(await rowOf(capped)).toEqual({ failures: 3, history: [] })
    })

    it('a malformed UUID', async () => {
      expect((await request('POST', resetUrl('not-a-uuid'), ADMIN, { reason: 'x' })).status).toBe(
        400,
      )
      expect(await rowOf(capped)).toEqual({ failures: 3, history: [] })
    })
  })

  describe('ADMIN (the control: a 403 for everyone would pass the rows above)', () => {
    it('GET excluded → 200, listing the capped source', async () => {
      const res = await app.inject({
        method: 'GET',
        url: LIST_URL,
        cookies: { jwt: signFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const items = (JSON.parse(res.body) as { items: { sourceId: string; reasons: string[] }[] })
        .items
      expect(items.find((i) => i.sourceId === capped)?.reasons).toContain('FAILURE_CAP')
    })

    it('POST reset of an unknown source → 404', async () => {
      expect((await request('POST', resetUrl(randomUUID()), ADMIN, { reason: 'x' })).status).toBe(
        404,
      )
    })

    it('POST reset → 204, one RESET_FAILURES entry naming the ADMIN', async () => {
      expect((await request('POST', resetUrl(capped), ADMIN, { reason: 'fixed' })).status).toBe(204)
      const row = await rowOf(capped)
      expect(row?.failures).toBe(0)
      expect(row?.history).toEqual([
        expect.objectContaining({ kind: 'RESET_FAILURES', actor: ADMIN.id, reason: 'fixed' }),
      ])
    })
  })
})
