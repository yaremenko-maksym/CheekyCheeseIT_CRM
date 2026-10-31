import { randomUUID } from 'node:crypto'
import { ForbiddenException, Global, Module } from '@nestjs/common'
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
  let service: JobSourceAdminService

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
  // U7 source page
  const HEALTH_URL = '/api/job-sourcing/admin/sources/health'
  const detailUrl = (id: string) => `/api/job-sourcing/admin/sources/${id}`
  const notesUrl = (id: string) => `/api/job-sourcing/admin/sources/${id}/notes`

  const noteRows = async (sourceId: string) =>
    dbSvcRef.db
      .select({
        kind: schema.jobSourceHealthEvents.kind,
        actorId: schema.jobSourceHealthEvents.actorId,
        note: schema.jobSourceHealthEvents.note,
        toState: schema.jobSourceHealthEvents.toState,
      })
      .from(schema.jobSourceHealthEvents)
      .where(eq(schema.jobSourceHealthEvents.sourceId, sourceId))

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
    service = moduleRef.get(JobSourceAdminService)
  })

  afterAll(async () => {
    if (dbSvcRef !== undefined) {
      if (capped) {
        // Health events FK the source AND the actor with onDelete RESTRICT, so the NOTE rows a
        // test wrote must go before the source and the users.
        await dbSvcRef.db
          .delete(schema.jobSourceHealthEvents)
          .where(eq(schema.jobSourceHealthEvents.sourceId, capped))
        await dbSvcRef.db.delete(jobSources).where(eq(jobSources.id, capped))
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

  // ---- U7 source page: the three new endpoints ------------------------------

  describe('U7 AC1: the controller guard refuses every non-ADMIN role', () => {
    for (const p of NON_ADMIN) {
      it(`${p.role}: GET sources/health → 403`, async () => {
        expect(await request('GET', HEALTH_URL, p)).toEqual({
          status: 403,
          code: GUARD_REFUSAL_CODE,
        })
      })

      it(`${p.role}: GET sources/:id → 403`, async () => {
        expect(await request('GET', detailUrl(capped), p)).toEqual({
          status: 403,
          code: GUARD_REFUSAL_CODE,
        })
      })

      it(`${p.role}: POST a note → 403, and no NOTE event is written`, async () => {
        expect(await request('POST', notesUrl(capped), p, { note: 'sneaky' })).toEqual({
          status: 403,
          code: GUARD_REFUSAL_CODE,
        })
        expect(await noteRows(capped)).toEqual([])
      })
    }

    it('without a session: all three → 401', async () => {
      expect((await app.inject({ method: 'GET', url: HEALTH_URL })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: detailUrl(capped) })).statusCode).toBe(401)
      expect(
        (await app.inject({ method: 'POST', url: notesUrl(capped), payload: { note: 'x' } }))
          .statusCode,
      ).toBe(401)
    })
  })

  describe('U7 AC1: the SERVICE BODY refuses a non-ADMIN directly, not only the guard', () => {
    for (const p of NON_ADMIN) {
      it(`${p.role}: listSourceHealth / sourceDetail / addNote all throw Forbidden`, async () => {
        await expect(service.listSourceHealth(p)).rejects.toBeInstanceOf(ForbiddenException)
        await expect(service.sourceDetail(capped, p)).rejects.toBeInstanceOf(ForbiddenException)
        await expect(service.addNote(capped, { note: 'direct' }, p)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
        // And the refused write left the log empty.
        expect(await noteRows(capped)).toEqual([])
      })
    }
  })

  describe('U7 AC2 + the ADMIN control', () => {
    it('GET sources/health → 200, the capped source listed with a null state and null profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: HEALTH_URL,
        cookies: { jwt: signFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const row = (
        JSON.parse(res.body) as {
          items: { id: string; state: string | null; profileSummary: unknown }[]
        }
      ).items.find((i) => i.id === capped)
      // No health event and no manifest id on this seed → both null (not a crash, not a default).
      expect(row).toMatchObject({ state: null, profileSummary: null })
    })

    it('GET sources/:id → 200, with empty run/event lists for a fresh source', async () => {
      const res = await app.inject({
        method: 'GET',
        url: detailUrl(capped),
        cookies: { jwt: signFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as {
        source: { id: string }
        runs: unknown[]
        events: unknown[]
      }
      expect(body.source.id).toBe(capped)
      expect(body.runs).toEqual([])
      expect(body.events).toEqual([])
    })

    it('a malformed UUID on detail / notes → 400', async () => {
      expect((await request('GET', detailUrl('not-a-uuid'), ADMIN)).status).toBe(400)
      expect((await request('POST', notesUrl('not-a-uuid'), ADMIN, { note: 'x' })).status).toBe(400)
    })

    it('a blank / over-long note → 400, nothing written', async () => {
      expect((await request('POST', notesUrl(capped), ADMIN, { note: '   ' })).status).toBe(400)
      expect(
        (await request('POST', notesUrl(capped), ADMIN, { note: 'x'.repeat(501) })).status,
      ).toBe(400)
      expect(await noteRows(capped)).toEqual([])
    })

    it('POST a note → 204, stored as an immutable NOTE event naming the ADMIN', async () => {
      expect(
        (await request('POST', notesUrl(capped), ADMIN, { note: '  provider outage  ' })).status,
      ).toBe(204)
      // Stored trimmed, kind NOTE, the ADMIN as actor, and no transition fields (AC2).
      expect(await noteRows(capped)).toEqual([
        { kind: 'NOTE', actorId: ADMIN.id, note: 'provider outage', toState: null },
      ])
      // Immutable: the controller exposes no PATCH/PUT/DELETE for a note — a second POST only
      // appends, it cannot edit the first.
      await request('POST', notesUrl(capped), ADMIN, { note: 'second' })
      const rows = await noteRows(capped)
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.note).sort()).toEqual(['provider outage', 'second'])
    })
  })
})
