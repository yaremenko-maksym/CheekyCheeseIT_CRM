import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import { createDrizzleModelHealthStore } from './structuring/model-health-store'

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
  /** Set by a test to make every source fail without the network ("nothing succeeded"). */
  failWith: Error | null = null
  override async collect(): Promise<NormalizedPosting[]> {
    this.collectCalls += 1
    if (this.failWith) throw this.failWith
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

    type Verb = 'GET' | 'POST' | 'PATCH' | 'DELETE'

    const request = async (method: Verb, url: string, as: SessionUser, body?: unknown) => {
      const res = await app.inject({
        method,
        url,
        cookies: { jwt: signFor(as) },
        // A body only where the verb carries one. `undefined` on DELETE/GET, so an
        // empty object is never mistaken for a payload the route must validate.
        payload: method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}),
      })
      const parsed = res.body ? (JSON.parse(res.body) as { code?: string }) : {}
      return { status: res.statusCode, code: parsed.code ?? '' }
    }

    const call = async (method: Verb, url: string, as: SessionUser) =>
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
     * The two layers answer differently, so the response is what tells them
     * apart. These HTTP tests pin the DECORATOR by requiring the guard's api-error
     * code; the service check is pinned separately, by calling the service
     * directly further down. Neither test can now cover for the other's absence.
     *
     * i18n stage-6B Wave 4: the guard now refuses with the generic
     * `FORBIDDEN_INSUFFICIENT_ROLE` code (no role list anywhere in the body), so
     * the test pins the CODE, not a Russian sentence.
     */
    const GUARD_REFUSAL_CODE = 'FORBIDDEN_INSUFFICIENT_ROLE'
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
      provider.failWith = null
    })

    describe('GET /api/job-sourcing/sources — budget state is ADMIN-only', () => {
      for (const p of [HR, SENIOR, JUNIOR, ACCOUNTANT, DROP]) {
        it(`${p.role} → 403, refused by the controller guard`, async () => {
          const { status, code } = await request('GET', '/api/job-sourcing/sources', p)
          expect(status).toBe(403)
          // Asserting WHICH layer refused is what makes the decorator testable at
          // all — see the GUARD_REFUSAL note above.
          expect(code).toBe(GUARD_REFUSAL_CODE)
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
          const { status, code } = await request('POST', '/api/job-sourcing/collect', p)
          expect(status).toBe(403)
          expect(code).toBe(GUARD_REFUSAL_CODE)
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

      describe('H.8: a run where nothing succeeded, through the guard chain and HTTP', () => {
        const store = () => createDrizzleModelHealthStore(dbSvcRef.db)
        const clearFlagRow = () =>
          pool.query(`DELETE FROM job_model_health_flags WHERE flag = 'MODEL_LIMITS_EXHAUSTED'`)

        beforeEach(async () => {
          // One enabled source the MANUAL trigger runs; the stub provider throws, so it fails.
          // Every other enabled source fails too: this harness registers no provider but DOU.
          await dbSvcRef.db
            .insert(jobSources)
            .values({ id: SOURCE_ID, type: 'DOU_RSS', enabled: true, triggerMode: 'BOTH' })
            .onConflictDoUpdate({
              target: jobSources.id,
              set: { enabled: true, triggerMode: 'BOTH' },
            })
          provider.failWith = new Error('stub feed down')
        })

        afterEach(async () => {
          await clearFlagRow()
          await dbSvcRef.db.delete(jobSources).where(eq(jobSources.id, SOURCE_ID))
        })

        it('flag raised → 503 with exactly the static AI-limits body', async () => {
          await store().raiseFlag('MODEL_LIMITS_EXHAUSTED')
          const res = await app.inject({
            method: 'POST',
            url: '/api/job-sourcing/collect',
            cookies: { jwt: signFor(ADMIN) },
            payload: {},
          })
          expect(res.statusCode).toBe(503)
          expect(provider.collectCalls).toBeGreaterThan(0)
          // Exact key set: no provider name, count or time can ride along.
          expect(JSON.parse(res.body)).toStrictEqual({
            statusCode: 503,
            code: 'JOB_SOURCING_AI_LIMITS_EXHAUSTED',
            message:
              'Vacancy search is temporarily unavailable: AI model limits are used up. Try again later.',
          })
        })

        it('CONTROL: flag cleared → the same run answers 503 with JOB_SOURCING_COLLECTION_FAILED (no AI-limits code)', async () => {
          await store().raiseFlag('MODEL_LIMITS_EXHAUSTED')
          await store().clearFlag('MODEL_LIMITS_EXHAUSTED')
          const res = await app.inject({
            method: 'POST',
            url: '/api/job-sourcing/collect',
            cookies: { jwt: signFor(ADMIN) },
            payload: {},
          })
          expect(res.statusCode).toBe(503)
          expect(JSON.parse(res.body)).toStrictEqual({
            statusCode: 503,
            code: 'JOB_SOURCING_COLLECTION_FAILED',
            message: 'Collection failed: no source completed. Try again later.',
          })
        })
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

      it('H.8: the ADMIN run reads the AI-limits flag: raised is the value, cleared is null', async () => {
        // Raised and cleared through the store the model stage writes with (H.2), not raw SQL.
        const store = createDrizzleModelHealthStore(dbSvcRef.db)
        await store.raiseFlag('MODEL_LIMITS_EXHAUSTED')
        try {
          await expect(service.collectAllAsActor(ADMIN)).resolves.toMatchObject({
            sourcingNotice: 'AI_LIMITS_EXHAUSTED',
          })
          await store.clearFlag('MODEL_LIMITS_EXHAUSTED')
          await expect(service.collectAllAsActor(ADMIN)).resolves.toMatchObject({
            sourcingNotice: null,
          })
        } finally {
          await pool.query(
            `DELETE FROM job_model_health_flags WHERE flag = 'MODEL_LIMITS_EXHAUSTED'`,
          )
        }
      })
    })

    /**
     * task-sources-07c — THE QUEUE IS CLOSED TO A SENIOR, AT BOTH LAYERS.
     *
     * Owner decision 2026-11-19: a SENIOR does not work the vacancy queue at all.
     * They used to be in every `@Roles` set on these six routes, reachable through
     * the suggestion dialog on the Interviews page; the dialog is deleted and the
     * role is gone from the decorators. What a senior gets instead is the RESULT —
     * an interview card in stage `SUBMITTED` — through `GET /interviews`, which is
     * untouched.
     *
     * A removed role is the easiest thing in this file to put back by accident: a
     * widened `@Roles` set in a refactor, a copied decorator, a merge that takes
     * the wrong side. So both layers are pinned per endpoint, and the two
     * assertions are deliberately different — the HTTP rows require the GUARD's
     * api-error code, the service rows require the SERVICE's own sentence. Neither
     * can cover for the other's absence, which is the MED-1 lesson above applied
     * to a role rather than to a route.
     */
    describe('task-sources-07c: SENIOR is refused on all six HR/ADMIN queue endpoints', () => {
      const SENIOR_REFUSAL = 'Vacancy sourcing is run by ADMIN and HR'
      const SUGGESTION_ID = 'e7f8a9b0-1c2d-4e3f-cc00-0000000000a1'
      const EXCLUSION_ID = 'e7f8a9b0-1c2d-4e3f-cc00-0000000000a2'
      const ABSENT_ID = 'e7f8a9b0-1c2d-4e3f-cc00-0000000000ff'

      /** Every route whose `@Roles` set lost SENIOR. The six of them, no more. */
      const ROUTES: { verb: Verb; url: string }[] = [
        { verb: 'GET', url: '/api/job-sourcing/suggestions' },
        { verb: 'PATCH', url: '/api/job-sourcing/suggestions/' + SUGGESTION_ID + '/status' },
        { verb: 'POST', url: '/api/job-sourcing/opportunities/' + SUGGESTION_ID + '/open' },
        { verb: 'GET', url: '/api/job-sourcing/exclusions' },
        { verb: 'POST', url: '/api/job-sourcing/exclusions' },
        { verb: 'DELETE', url: '/api/job-sourcing/exclusions/' + EXCLUSION_ID },
      ]

      for (const { verb, url } of ROUTES) {
        it(`${verb} ${url} — SENIOR → 403 from the controller guard`, async () => {
          const { status, code } = await request(verb, url, SENIOR)
          expect(status).toBe(403)
          expect(code).toBe(GUARD_REFUSAL_CODE)
        })

        it(`${verb} ${url} — JUNIOR / ACCOUNTANT / DROP stay refused too`, async () => {
          for (const p of [JUNIOR, ACCOUNTANT, DROP]) {
            const { status, code } = await request(verb, url, p)
            expect(status, `${p.role} on ${verb} ${url}`).toBe(403)
            expect(code, `${p.role} on ${verb} ${url}`).toBe(GUARD_REFUSAL_CODE)
          }
        })

        it(`${verb} ${url} — CONTROL: the guard lets HR and ADMIN through`, async () => {
          // WHY NOT `expect(status).not.toBe(403)`: past the decorator these routes
          // run real service logic against ids that do not exist, and one of them
          // may legitimately answer 403 from its own SCOPE check. The code is what
          // separates "the decorator refused the role" from "the service refused
          // this particular row" — and only the first is what this file pins.
          // Without this row, a decorator that refused EVERYONE would pass above.
          for (const p of [HR, ADMIN]) {
            const { code } = await request(verb, url, p)
            expect(code, `${p.role} on ${verb} ${url}`).not.toBe(GUARD_REFUSAL_CODE)
          }
        })
      }

      it('a SENIOR asking for their OWN board is still refused — it is the role, not the scope', async () => {
        // The tempting "but it is their own data" hole. `?seniorId=<self>` is the
        // exact shape the deleted dialog used, so it is the shape a revert would
        // reach for first.
        for (const url of [
          '/api/job-sourcing/suggestions?seniorId=' + SENIOR.id,
          '/api/job-sourcing/exclusions?seniorId=' + SENIOR.id,
        ]) {
          const { status, code } = await request('GET', url, SENIOR)
          expect(status, url).toBe(403)
          expect(code, url).toBe(GUARD_REFUSAL_CODE)
        }
      })

      it('DELETE of a NONEXISTENT exclusion is 403 for a SENIOR, never 404', async () => {
        // The refusal must precede the lookup, or the status itself becomes an
        // existence oracle: 404 for ids that are absent, 403 for ids that are not,
        // and a senior could enumerate another senior's filters without reading one.
        const { status, code } = await request(
          'DELETE',
          '/api/job-sourcing/exclusions/' + ABSENT_ID,
          SENIOR,
        )
        expect(status).toBe(403)
        expect(code).toBe(GUARD_REFUSAL_CODE)
      })

      it('no cookie → 401 on every one of the six, never an anonymous read', async () => {
        for (const { verb, url } of ROUTES) {
          const res = await app.inject({
            method: verb,
            url,
            payload: verb === 'GET' || verb === 'DELETE' ? undefined : {},
          })
          expect(res.statusCode, `${verb} ${url}`).toBe(401)
        }
      })

      describe('and the service refuses a SENIOR on its own, with no guard in front', () => {
        let service: JobSourcingService

        beforeEach(() => {
          service = new JobSourcingService(dbSvcRef, new HrAccessService(dbSvcRef), provider)
        })

        it('listSuggestions', async () => {
          await expect(service.listSuggestions(undefined, SENIOR)).rejects.toThrow(SENIOR_REFUSAL)
        })

        it('listSuggestions for their OWN id', async () => {
          await expect(service.listSuggestions(SENIOR.id, SENIOR)).rejects.toThrow(SENIOR_REFUSAL)
        })

        it('updateStatus', async () => {
          await expect(
            service.updateStatus(SUGGESTION_ID, { status: 'REJECTED' }, SENIOR),
          ).rejects.toThrow(SENIOR_REFUSAL)
        })

        it('openOpportunity', async () => {
          await expect(service.openOpportunity(SUGGESTION_ID, SENIOR)).rejects.toThrow(
            SENIOR_REFUSAL,
          )
        })

        it('listExclusions', async () => {
          await expect(service.listExclusions(undefined, SENIOR)).rejects.toThrow(SENIOR_REFUSAL)
        })

        it('createExclusion', async () => {
          await expect(
            service.createExclusion(
              { scope: 'GLOBAL', kind: 'COMPANY', value: 'Acme Corp' },
              SENIOR,
            ),
          ).rejects.toThrow(SENIOR_REFUSAL)
        })

        it('deleteExclusion', async () => {
          await expect(service.deleteExclusion(EXCLUSION_ID, SENIOR)).rejects.toThrow(
            SENIOR_REFUSAL,
          )
        })

        it('CONTROL: HR is NOT refused by the SENIOR check', async () => {
          // "rejects everything" would satisfy every row above. HR legitimately
          // fails further in (no such suggestion, no team scope) — what must never
          // appear for HR is THIS sentence.
          const outcomes = await Promise.allSettled([
            service.listSuggestions(undefined, HR),
            service.listExclusions(undefined, HR),
            service.updateStatus(SUGGESTION_ID, { status: 'REJECTED' }, HR),
            service.openOpportunity(SUGGESTION_ID, HR),
            service.deleteExclusion(EXCLUSION_ID, HR),
          ])
          // Collected first, asserted once: HR may legitimately fail on any of these, and the
          // whole claim is about WHICH sentence can never appear. (A conditional `expect` would
          // also silently assert nothing on a run where HR happened to succeed.)
          const refusals = outcomes
            .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
            .map((o) => String((o.reason as Error).message))
          expect(refusals.join(' | ')).not.toContain(SENIOR_REFUSAL)
        })
      })
    })
  },
)
