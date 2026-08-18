import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { jobSources, users } from '../database/schema'
import * as schema from '../database/schema'
import { DouRssProvider } from './dou.provider'
import { JobSourcingController } from './job-sourcing.controller'
import { JobSourcingService } from './job-sourcing.service'
import type { NormalizedPosting } from './job-source.provider'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * REAL-controller RBAC for the two source endpoints — security review MED-1.
 *
 * WHY THIS FILE EXISTS AND job-matching.integration.spec.ts IS NOT ENOUGH.
 * That spec builds `JobSourcingService` with `new`, which is right for testing
 * ranking and budget arithmetic but walks straight past the guard chain. So the
 * role on `GET /job-sourcing/sources` and `POST /job-sourcing/collect` was
 * pinned by NOTHING: delete `@Roles('ADMIN')` and every test stayed green while
 * any authenticated user could read the source list and press a button that
 * spends a paid quota.
 *
 * This suite drives the ACTUAL `JobSourcingController` through the ACTUAL
 * `JwtAuthGuard` + `RolesGuard` over a real Fastify pipeline, one request per
 * role — the only shape that can fail when the decorator goes missing. It is
 * the "mocked E2E cannot prove a backend guard" lesson this repo has now
 * learned several times over.
 *
 * DB-SKIP-GUARD: with DATABASE_URL unreachable every test returns early.
 */

const JWT_SECRET = 'job-sourcing-rbac-integration-secret-0000000000'

// Seed namespace: e7f8a9b0-1c2d-4e3f-**
const persona = (suffix: string, role: SessionUser['role']): SessionUser => ({
  id: `e7f8a9b0-1c2d-4e3f-cc00-0000000000${suffix}`,
  email: `jsrbac-${role.toLowerCase()}@test.spec`,
  displayName: `JSRBAC ${role}`,
  avatarUrl: null,
  role,
  seniorSharePercent: role === 'SENIOR' ? 26 : 0,
  legalFullName: null,
})

const ADMIN = persona('01', 'ADMIN')
const HR = persona('02', 'HR')
const SENIOR = persona('03', 'SENIOR')
const JUNIOR = persona('04', 'JUNIOR')
const ACCOUNTANT = persona('05', 'ACCOUNTANT')
const DROP = persona('06', 'DROP')
const ALL = [ADMIN, HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]

const SOURCE_ID = 'e7f8a9b0-1c2d-4e3f-cc00-0000000000f1'

/** Never touches the network; also proves a refused request never collects. */
class SilentProvider extends DouRssProvider {
  collectCalls = 0
  override async collect(): Promise<NormalizedPosting[]> {
    this.collectCalls += 1
    return []
  }
}

const provider = new SilentProvider()

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
    { provide: DouRssProvider, useValue: provider },
    {
      provide: HrAccessService,
      useFactory: (db: DatabaseService) => new HrAccessService(db),
      inject: [DatabaseService],
    },
    {
      provide: JobSourcingService,
      useFactory: (db: DatabaseService, hr: HrAccessService) =>
        new JobSourcingService(db, hr, provider),
      inject: [DatabaseService, HrAccessService],
    },
    // JwtAuthGuard as APP_GUARD (populates req.user), exactly as AppModule does.
    //
    // RolesGuard is deliberately NOT registered globally here: the controller
    // declares its own `@UseGuards(RolesGuard)`, and pinning THAT decorator is
    // the whole point of this suite. A global copy would keep answering 403
    // even after someone deleted the controller's guard, which is the silent
    // pass this file exists to prevent.
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class JobSourcingRbacTestModule {}

describe.skipIf(!hasDatabaseUrl())(
  'Job sourcing source endpoints — real-controller RBAC (MED-1)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let pool: Pool

    // `id`, not `sub` — JwtAuthGuard re-validates the payload through
    // `jwtPayloadSchema`, which requires `id`/`email`/`role`. A `sub` token verifies
    // cryptographically and then fails the shape check, which surfaces as 401 and
    // would quietly make every "→ 403" row below pass for the wrong reason.
    const signFor = (u: SessionUser) => jwt.sign({ id: u.id, email: u.email, role: u.role })

    const request = async (method: 'GET' | 'POST', url: string, as: SessionUser) => {
      const res = await app.inject({
        method,
        url,
        cookies: { jwt: signFor(as) },
        payload: method === 'POST' ? {} : undefined,
      })
      const body = res.body ? (JSON.parse(res.body) as { message?: string }) : {}
      return { status: res.statusCode, message: body.message ?? '' }
    }

    const call = async (method: 'GET' | 'POST', url: string, as: SessionUser) =>
      (await request(method, url, as)).status

    /**
     * WHICH LAYER REFUSED — and why a bare 403 is not enough to assert.
     *
     * There are deliberately TWO gates on these routes: the controller's
     * `@Roles('ADMIN')` and `JobSourcingService.assertCanManageSources`. That is
     * the defence in depth MED-1 asked for, but it also means each one MASKS the
     * other: delete either and the request is still refused with 403, so a test
     * that only checks the status stays green with a guard missing — measured,
     * not assumed (all four guard-removal mutations survived the first version of
     * this file).
     *
     * The two layers answer with different messages, so the message is what tells
     * them apart. These HTTP tests pin the DECORATOR by requiring the guard's
     * wording; the service check is pinned separately, by calling the service
     * directly further down. Neither test can now cover for the other's absence.
     */
    const GUARD_REFUSAL = 'Доступ только для ролей'
    const SERVICE_REFUSAL = 'Источники подбора вакансий настраивает ADMIN'

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[job-sourcing rbac] FAILED — no DB reachable at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      // A PLAIN object, deliberately not `Object.create(DatabaseService.prototype)`:
      // an instance of the real class makes Nest run its `onModuleInit`, which
      // builds a second Pool from `this.config` — undefined here, and a connection
      // this suite neither needs nor closes. The service only ever touches `.db`.
      dbSvcRef = { pool, db } as unknown as DatabaseService

      await db
        .insert(users)
        .values(
          ALL.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            googleId: `test-jsrbac-${u.id}`,
          })),
        )
        .onConflictDoNothing()

      const moduleRef = await Test.createTestingModule({
        imports: [JobSourcingRbacTestModule],
      })
        // The controller's own `@UseGuards(RolesGuard)` instantiates the class
        // through the injector, which leaves `reflector` undefined in this test
        // env and surfaces as a 500 for the roles that SHOULD pass. Supplying a
        // properly-constructed real guard keeps the decorator under test.
        .overrideGuard(RolesGuard)
        .useValue(new RolesGuard(new Reflector()))
        .compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'job-sourcing-rbac-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()
      jwt = moduleRef.get(JwtService)
    })

    afterAll(async () => {
      await dbSvcRef.db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
      await dbSvcRef.db.delete(users).where(
        inArray(
          users.id,
          ALL.map((u) => u.id),
        ),
      )
      await app?.close()
      await pool?.end()
    })

    beforeEach(() => {
      provider.collectCalls = 0
    })

    describe('GET /api/job-sourcing/sources — budget state is ADMIN-only', () => {
      for (const p of [HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]) {
        it(`${p.role} → 403, refused by the controller guard`, async () => {
          const { status, message } = await request('GET', '/api/job-sourcing/sources', p)
          expect(status).toBe(403)
          // Asserting WHICH layer refused is what makes the decorator testable at
          // all — see the GUARD_REFUSAL note above.
          expect(message).toContain(GUARD_REFUSAL)
        })
      }

      it('ADMIN → 200 (the control: a 403 for everyone would also pass the rows above)', async () => {
        expect(await call('GET', '/api/job-sourcing/sources', ADMIN)).toBe(200)
      })

      it('no cookie → 401, never an anonymous read of the source list', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/job-sourcing/sources' })
        expect(res.statusCode).toBe(401)
      })
    })

    describe('POST /api/job-sourcing/collect — spending the quota is ADMIN-only', () => {
      for (const p of [HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]) {
        it(`${p.role} → 403 (controller guard) AND nothing is collected`, async () => {
          const { status, message } = await request('POST', '/api/job-sourcing/collect', p)
          expect(status).toBe(403)
          expect(message).toContain(GUARD_REFUSAL)
          // The status code alone would not prove the quota was safe — a refusal
          // that still hit the provider would spend a request per rejected call.
          expect(provider.collectCalls).toBe(0)
        })
      }

      it('ADMIN is not refused by the guard chain', async () => {
        // 503 is this endpoint's own "every source failed" answer (the stub feed
        // returns nothing). The point here is that it is NOT 401/403 — the guard
        // let the ADMIN through.
        const status = await call('POST', '/api/job-sourcing/collect', ADMIN)
        expect([200, 201, 503]).toContain(status)
        expect(status).not.toBe(403)
      })

      it('no cookie → 401', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/job-sourcing/collect',
          payload: {},
        })
        expect(res.statusCode).toBe(401)
      })
    })

    /**
     * The SECOND layer, pinned on its own.
     *
     * These call the service directly, so the controller's decorator cannot cover
     * for a missing service check (and vice versa — the HTTP tests above assert
     * the guard's own wording). This is the half that survives someone deleting
     * `@Roles('ADMIN')` in a refactor, which is the scenario MED-1 is about.
     */
    describe('service refuses independently of the HTTP guard', () => {
      let service: JobSourcingService

      beforeEach(() => {
        service = new JobSourcingService(dbSvcRef, new HrAccessService(dbSvcRef), provider)
      })

      for (const p of [HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]) {
        it(`listSources rejects ${p.role}`, async () => {
          await expect(service.listSources(p)).rejects.toThrow(SERVICE_REFUSAL)
        })
      }

      for (const p of [HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]) {
        it(`collectAllAsActor rejects ${p.role} without collecting`, async () => {
          await expect(service.collectAllAsActor(p)).rejects.toThrow(SERVICE_REFUSAL)
          expect(provider.collectCalls).toBe(0)
        })
      }

      it('CONTROL: ADMIN is allowed through both methods', async () => {
        // Without this, "rejects everything" would satisfy every row above.
        await expect(service.listSources(ADMIN)).resolves.toBeInstanceOf(Array)
        await expect(service.collectAllAsActor(ADMIN)).resolves.toHaveProperty('failures')
      })
    })
  },
)
