/**
 * Vacancies — real-backend integration spec (real Postgres + real MinIO +
 * real Cloudflare Turnstile "always passes" test secret).
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson): mocked specs
 * cannot prove that the REAL RolesGuard + REAL SQL WHERE clauses (409 dup
 * slug, applicationsCount aggregation, 24h duplicate window, PUBLISHED-only
 * visibility) actually enforce the contract. This spec drives the REAL
 * VacanciesController + PublicVacanciesController + all 3 real services
 * (VacanciesService, ApplicationsService, TurnstileService) through a real
 * Fastify HTTP pipeline.
 *
 * Covers: AC3 (admin CRUD + status transitions + delete guards +
 * applicationsCount), AC4 (RBAC matrix on every private endpoint), AC5
 * (public visibility + 404s), AC6 (apply happy path — real DB row + real R2
 * object + real notifications), AC8 (rate-limit 429 on the real endpoint),
 * AC9 boundary (89/90/91 day retention cron against real timestamps).
 *
 * Run against the scratch DB:
 *   pnpm --filter @crm/api exec vitest run vacancies.integration
 * (`.env.test` injects DATABASE_URL=…crm_qa automatically for integration runs.)
 *
 * DB-SKIP-GUARD: `dbAvailable = false` when DATABASE_URL is unreachable or the
 * vacancies table is missing (CI unit job / DB not yet pushed) — every test
 * bails early and stays green.
 */
import { Global, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { MAKSYM_ID, type SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { CompressionService } from '../documents/compression.service'
import { S3Service } from '../documents/s3.service'
import { NotificationsService } from '../notifications/notifications.service'
import { notifications, users, vacancies, vacancyApplications } from '../database/schema'
import * as schema from '../database/schema'
import { ApplicationsService } from './applications.service'
import { PublicVacanciesController } from './public-vacancies.controller'
import { TurnstileService } from './turnstile.service'
import { VacanciesController } from './vacancies.controller'
import { VacanciesRetentionCronService } from './vacancies-retention.cron'
import { VacanciesService } from './vacancies.service'

const JWT_SECRET = 'vacancies-integration-secret-32-chars!!'
const DUMMY_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'

/**
 * A genuinely valid, minimal one-page PDF — unlike the unit-spec fixture
 * (`applications.service.spec.ts`'s `PDF_MAGIC_BUF`, which only needs to pass
 * magic-byte detection against a MOCKED CompressionService), this integration
 * spec exercises the REAL `CompressionService.compress()` → real `pdf-lib`
 * `PDFDocument.load()`, which requires an actually well-formed PDF (xref +
 * trailer), not just a `%PDF` header.
 */
async function makeValidPdfBuffer(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  const bytes = await doc.save()
  return Buffer.from(bytes)
}

// ---------------------------------------------------------------------------
// Test personas
// ---------------------------------------------------------------------------

const ADMIN: SessionUser = {
  id: MAKSYM_ID,
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const NS = 'a9b8c7d6-e5f4-4001' // dedicated namespace for THIS spec — no collision
const HR: SessionUser = {
  id: `${NS}-aa00-000000000001`,
  email: 'vac-rbac-hr@test.spec',
  displayName: 'Vacancies RBAC HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: `${NS}-aa00-000000000002`,
  email: 'vac-rbac-senior@test.spec',
  displayName: 'Vacancies RBAC Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: `${NS}-aa00-000000000003`,
  email: 'vac-rbac-junior@test.spec',
  displayName: 'Vacancies RBAC Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: `${NS}-aa00-000000000004`,
  email: 'vac-rbac-accountant@test.spec',
  displayName: 'Vacancies RBAC Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: `${NS}-aa00-000000000005`,
  email: 'vac-rbac-drop@test.spec',
  displayName: 'Vacancies RBAC Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEST_USER_IDS = [HR.id, SENIOR.id, JUNIOR.id, ACCOUNTANT.id, DROP.id]
const DISALLOWED = [SENIOR, JUNIOR, ACCOUNTANT, DROP]

// ---------------------------------------------------------------------------
// Fake ConfigService — S3/MinIO (real local docker-compose MinIO) + Turnstile
// dummy "always passes" secret. Mirrors s3.service.spec.ts's makeConfig()
// helper; avoids requiring the full app validateEnv() (GOOGLE_CLIENT_ID etc
// are irrelevant here and not present in the vitest worker env).
// ---------------------------------------------------------------------------

const fakeEnv: Record<string, unknown> = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'crm-documents',
  S3_FORCE_PATH_STYLE: true,
  S3_USE_SSE: false,
  AWS_ACCESS_KEY_ID: 'minioadmin',
  AWS_SECRET_ACCESS_KEY: 'minioadmin',
  TURNSTILE_SECRET_KEY: DUMMY_TURNSTILE_SECRET,
  NODE_ENV: 'test',
}
const fakeConfigService = { get: (key: string) => fakeEnv[key] } as unknown as ConfigService

// ---------------------------------------------------------------------------
// TestDatabaseModule — same pattern as legends.rbac.integration.spec.ts, EXCEPT
// the pool is captured in a LOCAL closure variable (not a shared file-level
// one) — this spec builds TWO app instances (main `app` + an isolated `rlApp`
// for the rate-limit describe block), and a shared file-level pool reference
// caused a "Called end on pool more than once" cross-instance double-close.
// ---------------------------------------------------------------------------

let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => pool.end(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [VacanciesController, PublicVacanciesController],
  providers: [
    Reflector,
    // RolesGuard itself is provided via `.overrideGuard()` in buildApp() below
    // (esbuild strips constructor param-type metadata — a bare class binding
    // here would leave `reflector` undefined inside RolesGuard at request time).
    { provide: ConfigService, useValue: fakeConfigService },
    {
      provide: S3Service,
      useFactory: (c: ConfigService) => new S3Service(c),
      inject: [ConfigService],
    },
    { provide: CompressionService, useFactory: () => new CompressionService() },
    {
      provide: NotificationsService,
      useFactory: (db: DatabaseService) => new NotificationsService(db),
      inject: [DatabaseService],
    },
    {
      provide: TurnstileService,
      useFactory: (c: ConfigService) => new TurnstileService(c),
      inject: [ConfigService],
    },
    {
      provide: VacanciesService,
      useFactory: (db: DatabaseService) => new VacanciesService(db),
      inject: [DatabaseService],
    },
    {
      provide: ApplicationsService,
      useFactory: (
        db: DatabaseService,
        vac: VacanciesService,
        s3: S3Service,
        comp: CompressionService,
        turnstile: TurnstileService,
        notif: NotificationsService,
      ) => new ApplicationsService(db, vac, s3, comp, turnstile, notif),
      inject: [
        DatabaseService,
        VacanciesService,
        S3Service,
        CompressionService,
        TurnstileService,
        NotificationsService,
      ],
    },
    {
      provide: VacanciesRetentionCronService,
      useFactory: (db: DatabaseService, s3: S3Service) => new VacanciesRetentionCronService(db, s3),
      inject: [DatabaseService, S3Service],
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class VacanciesTestModule {}

async function buildApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [VacanciesTestModule] })
    // The real VacanciesController is decorated with `@UseGuards(RolesGuard)`.
    // In a standalone Test module the controller-scoped guard is not
    // auto-wired with a Reflector (esbuild strips constructor param-type
    // metadata) — override it with a fully-constructed instance so it
    // exercises the REAL RolesGuard logic (getAllAndOverride(@Roles) → 403).
    // Same pattern as company-account.rbac.integration.spec.ts.
    .overrideGuard(RolesGuard)
    .useValue(new RolesGuard(new Reflector()))
    .compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  await app.register(cookie, { secret: 'vacancies-integration-cookie-secret' })
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
  app.setGlobalPrefix('api')
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Hand-rolled multipart/form-data body — no precedent for real multipart HTTP
 * tests elsewhere in this repo, so this is a small, self-contained helper. */
function buildMultipartBody(
  fields: Record<string, string>,
  file?: { fieldname: string; filename: string; contentType: string; buffer: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----VacTestBoundary${Date.now()}`
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    )
    parts.push(file.buffer)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Vacancies — real backend integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService
  const createdVacancyIds: string[] = []

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      const check = await probePool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='vacancies' LIMIT 1`,
      )
      await probePool.end()
      if (check.rowCount === 0) {
        console.warn('[vacancies integration] SKIPPED — vacancies table not found (run db:push)')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[vacancies integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    app = await buildApp()
    jwt = app.get(JwtService)
    dbSvc = app.get(DatabaseService)

    await dbSvc.db
      .insert(users)
      .values([
        {
          id: HR.id,
          email: HR.email,
          displayName: HR.displayName,
          role: 'HR',
          googleId: `test-google-${HR.id}`,
        },
        {
          id: SENIOR.id,
          email: SENIOR.email,
          displayName: SENIOR.displayName,
          role: 'SENIOR',
          googleId: `test-google-${SENIOR.id}`,
        },
        {
          id: JUNIOR.id,
          email: JUNIOR.email,
          displayName: JUNIOR.displayName,
          role: 'JUNIOR',
          googleId: `test-google-${JUNIOR.id}`,
        },
        {
          id: ACCOUNTANT.id,
          email: ACCOUNTANT.email,
          displayName: ACCOUNTANT.displayName,
          role: 'ACCOUNTANT',
          googleId: `test-google-${ACCOUNTANT.id}`,
        },
        {
          id: DROP.id,
          email: DROP.email,
          displayName: DROP.displayName,
          role: 'DROP',
          googleId: `test-google-${DROP.id}`,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      if (createdVacancyIds.length > 0) {
        // notifyAdminsAndHr() fans out to EVERY ADMIN/HR seed user (not just
        // our two test personas) — scope cleanup by `link` (tied to the
        // vacancy ids THIS run created), not by recipient userId, or seed
        // ADMIN/HR notifications from other real users would leak residue.
        await db.delete(notifications).where(
          inArray(
            notifications.link,
            createdVacancyIds.map((id) => `/vacancies/${id}`),
          ),
        )
        // Delete the real R2/MinIO resume objects before dropping the rows
        // that reference them — the AC6 happy-path test really uploads one.
        const appRows = await db.query.vacancyApplications.findMany({
          where: (a, { inArray: ia }) => ia(a.vacancyId, createdVacancyIds),
        })
        const s3 = app.get(S3Service)
        for (const row of appRows) {
          await s3.delete(row.resumeS3Key)
        }
        await db
          .delete(vacancyApplications)
          .where(inArray(vacancyApplications.vacancyId, createdVacancyIds))
        await db.delete(vacancies).where(inArray(vacancies.id, createdVacancyIds))
      }
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 20_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  function trackVacancy(id: string): string {
    createdVacancyIds.push(id)
    return id
  }

  // ── AC3: admin CRUD + status transitions + delete guards ──────────────────

  describe('AC3 — admin CRUD', () => {
    it('ADMIN creates a vacancy (DRAFT, applicationsCount=0)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Senior Frontend Engineer',
          slug: `senior-fe-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as { id: string; status: string; applicationsCount: number }
      trackVacancy(body.id)
      expect(body.status).toBe('DRAFT')
      expect(body.applicationsCount).toBe(0)
    })

    it('create → 409 on duplicate slug', async () => {
      if (!dbAvailable) return
      const slug = `dup-slug-${Date.now()}`
      const payload = {
        title: 'Role A',
        slug,
        descriptionMd: 'Full description of the role goes here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      }
      const first = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload,
      })
      trackVacancy((first.json() as { id: string }).id)
      const second = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { ...payload, title: 'Role B' },
      })
      expect(second.statusCode).toBe(409)
    })

    it('status transitions: DRAFT → PUBLISHED → CLOSED → PUBLISHED (re-open)', async () => {
      if (!dbAvailable) return
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Transition Role',
          slug: `transition-role-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'EDTECH',
          seniority: 'LEAD',
          employmentType: 'CONTRACT',
          location: 'Kyiv',
        },
      })
      const id = trackVacancy((create.json() as { id: string }).id)

      const toPublished = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
      expect(toPublished.statusCode).toBe(200)
      const publishedBody = toPublished.json() as { status: string; publishedAt: string | null }
      expect(publishedBody.status).toBe('PUBLISHED')
      expect(publishedBody.publishedAt).not.toBeNull()

      const toClosed = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'CLOSED' },
      })
      expect(toClosed.statusCode).toBe(200)
      expect((toClosed.json() as { status: string; closedAt: string | null }).status).toBe('CLOSED')
      expect((toClosed.json() as { closedAt: string | null }).closedAt).not.toBeNull()

      const reopened = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
      expect(reopened.statusCode).toBe(200)
      const reopenedBody = reopened.json() as {
        status: string
        closedAt: string | null
        publishedAt: string | null
      }
      expect(reopenedBody.status).toBe('PUBLISHED')
      expect(reopenedBody.closedAt).toBeNull()
      expect(reopenedBody.publishedAt).toEqual(publishedBody.publishedAt) // untouched by re-open
    })

    it('invalid transition (DRAFT → CLOSED) → 409', async () => {
      if (!dbAvailable) return
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Invalid Transition Role',
          slug: `invalid-transition-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'OTHER',
          seniority: 'SENIOR',
          employmentType: 'PART_TIME',
          location: 'Remote',
        },
      })
      const id = trackVacancy((create.json() as { id: string }).id)
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'CLOSED' },
      })
      expect(res.statusCode).toBe(409)
    })

    it('delete guard: 409 when NOT DRAFT; succeeds for a fresh DRAFT with 0 applications', async () => {
      if (!dbAvailable) return
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Delete Guard Role',
          slug: `delete-guard-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      const id = (create.json() as { id: string }).id

      // Publish it → no longer DRAFT → delete must 409.
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
      const blocked = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(blocked.statusCode).toBe(409)

      // Cleanup this one manually (not DRAFT so we can't delete via the API);
      // track it so afterAll still purges it directly from the DB.
      trackVacancy(id)

      // A brand-new DRAFT vacancy with 0 applications CAN be deleted.
      const create2 = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Deletable Draft Role',
          slug: `deletable-draft-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      const id2 = (create2.json() as { id: string }).id
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${id2}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(removed.statusCode).toBe(204)
    })
  })

  // ── AC4: RBAC matrix on every private endpoint ─────────────────────────────

  describe('AC4 — RBAC matrix', () => {
    let rbacVacancyId: string

    beforeAll(async () => {
      if (!dbAvailable) return
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'RBAC Fixture Role',
          slug: `rbac-fixture-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      rbacVacancyId = trackVacancy((create.json() as { id: string }).id)
    })

    it('GET /api/vacancies — ADMIN 200, HR 200', async () => {
      if (!dbAvailable) return
      for (const user of [ADMIN, HR]) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/vacancies',
          cookies: { jwt: tokenFor(user) },
        })
        expect(res.statusCode, `${user.role} should get 200`).toBe(200)
      }
    })

    it.each(DISALLOWED)('GET /api/vacancies — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(user) },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)('POST /api/vacancies — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(user) },
        payload: {
          title: 'Should Not Be Created',
          slug: `should-not-exist-${Date.now()}-${user.role}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)('PATCH /api/vacancies/:id — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${rbacVacancyId}`,
        cookies: { jwt: tokenFor(user) },
        payload: { title: 'Hack attempt' },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)('DELETE /api/vacancies/:id — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${rbacVacancyId}`,
        cookies: { jwt: tokenFor(user) },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)('GET /api/vacancies/:id/applications — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'GET',
        url: `/api/vacancies/${rbacVacancyId}/applications`,
        cookies: { jwt: tokenFor(user) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET /api/vacancies/:id/applications — ADMIN 200, HR 200', async () => {
      if (!dbAvailable) return
      for (const user of [ADMIN, HR]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/vacancies/${rbacVacancyId}/applications`,
          cookies: { jwt: tokenFor(user) },
        })
        expect(res.statusCode, `${user.role} should get 200`).toBe(200)
      }
    })

    it.each(DISALLOWED)('PATCH /api/vacancies/:id/applications/:appId — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${rbacVacancyId}/applications/00000000-0000-4000-8000-000000000000`,
        cookies: { jwt: tokenFor(user) },
        payload: { status: 'VIEWED' },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)('DELETE /api/vacancies/:id/applications/:appId — %s 403', async (user) => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${rbacVacancyId}/applications/00000000-0000-4000-8000-000000000000`,
        cookies: { jwt: tokenFor(user) },
      })
      expect(res.statusCode).toBe(403)
    })

    it.each(DISALLOWED)(
      'GET /api/vacancies/:id/applications/:appId/resume-url — %s 403',
      async (user) => {
        if (!dbAvailable) return
        const res = await app.inject({
          method: 'GET',
          url: `/api/vacancies/${rbacVacancyId}/applications/00000000-0000-4000-8000-000000000000/resume-url`,
          cookies: { jwt: tokenFor(user) },
        })
        expect(res.statusCode).toBe(403)
      },
    )

    it('No JWT → 401 on a private endpoint', async () => {
      if (!dbAvailable) return
      const res = await app.inject({ method: 'GET', url: '/api/vacancies' })
      expect(res.statusCode).toBe(401)
    })
  })

  // ── AC5: public visibility ─────────────────────────────────────────────────

  describe('AC5 — public visibility', () => {
    it('public list only includes PUBLISHED vacancies; detail 404 for DRAFT/CLOSED/missing', async () => {
      if (!dbAvailable) return
      const draftSlug = `public-draft-${Date.now()}`
      const publishedSlug = `public-published-${Date.now()}`

      const draft = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Draft Only',
          slug: draftSlug,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      trackVacancy((draft.json() as { id: string }).id)

      const published = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Published Role',
          slug: publishedSlug,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      const publishedId = trackVacancy((published.json() as { id: string }).id)
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${publishedId}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })

      // List: PUBLISHED slug present, DRAFT slug absent.
      const list = await app.inject({ method: 'GET', url: '/api/public/vacancies' })
      expect(list.statusCode).toBe(200)
      const slugs = (list.json() as { slug: string }[]).map((v) => v.slug)
      expect(slugs).toContain(publishedSlug)
      expect(slugs).not.toContain(draftSlug)

      // Detail: PUBLISHED → 200, DRAFT → 404, missing → 404.
      const publishedDetail = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${publishedSlug}`,
      })
      expect(publishedDetail.statusCode).toBe(200)

      const draftDetail = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${draftSlug}`,
      })
      expect(draftDetail.statusCode).toBe(404)

      const missingDetail = await app.inject({
        method: 'GET',
        url: '/api/public/vacancies/this-slug-does-not-exist',
      })
      expect(missingDetail.statusCode).toBe(404)

      // Close it → detail must 404 again.
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${publishedId}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'CLOSED' },
      })
      const closedDetail = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${publishedSlug}`,
      })
      expect(closedDetail.statusCode).toBe(404)
    })
  })

  // ── AC6: apply happy path (real DB + real MinIO + real notifications) ─────

  describe('AC6 — apply happy path', () => {
    it('POST /api/public/vacancies/:slug/apply → 201, DB row, R2 object, ADMIN+HR notified', async () => {
      if (!dbAvailable) return
      const slug = `apply-happy-${Date.now()}`
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Apply Happy Path Role',
          slug,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      const vacancyId = trackVacancy((create.json() as { id: string }).id)
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${vacancyId}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })

      const email = `candidate-${Date.now()}@example.com`
      const { body, contentType } = buildMultipartBody(
        {
          fullName: 'Ivan Petrenko',
          email,
          turnstileToken: 'any-token-accepted-by-dummy-secret',
        },
        {
          fieldname: 'resume',
          filename: 'resume.pdf',
          contentType: 'application/pdf',
          buffer: await makeValidPdfBuffer(),
        },
      )

      const res = await app.inject({
        method: 'POST',
        url: `/api/public/vacancies/${slug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toEqual({ ok: true })

      // DB row exists.
      const rows = await dbSvc.db.query.vacancyApplications.findMany({
        where: (a, { eq }) => eq(a.vacancyId, vacancyId),
      })
      expect(rows).toHaveLength(1)
      const appRow = rows[0]!
      expect(appRow.email).toBe(email)
      expect(appRow.status).toBe('NEW')

      // R2/MinIO object exists — fetch it back via the real S3Service.
      const s3 = app.get(S3Service)
      const objectBuf = await s3.getObject(appRow.resumeS3Key)
      expect(objectBuf.length).toBeGreaterThan(0)

      // Notifications created for ADMIN + HR (at least — other seed ADMINs
      // may also receive one; we assert OUR two personas got theirs).
      const notifRows = await dbSvc.db.query.notifications.findMany({
        where: (n, { eq }) => eq(n.type, 'VACANCY_APPLICATION'),
      })
      const hrNotif = notifRows.find(
        (n) => n.userId === HR.id && n.link === `/vacancies/${vacancyId}`,
      )
      expect(hrNotif).toBeDefined()
      expect(hrNotif!.title).toContain('Ivan Petrenko')
    })
  })

  // ── AC10: resume-url presigned TTL=600s; object gone from R2 after DELETE ─

  describe('AC10 — resume-url + delete removes the R2 object', () => {
    it('resume-url returns a presigned URL with ~600s TTL; DELETE removes DB row + R2 object', async () => {
      if (!dbAvailable) return
      const slug = `resume-url-${Date.now()}`
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Resume URL Role',
          slug,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      const vacancyId = trackVacancy((create.json() as { id: string }).id)
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${vacancyId}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })

      const { body, contentType } = buildMultipartBody(
        {
          fullName: 'Resume Url Candidate',
          email: `resume-url-${Date.now()}@example.com`,
          turnstileToken: 'any-token-accepted-by-dummy-secret',
        },
        {
          fieldname: 'resume',
          filename: 'resume.pdf',
          contentType: 'application/pdf',
          buffer: await makeValidPdfBuffer(),
        },
      )
      await app.inject({
        method: 'POST',
        url: `/api/public/vacancies/${slug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })

      const appRow = await dbSvc.db.query.vacancyApplications.findFirst({
        where: (a, { eq }) => eq(a.vacancyId, vacancyId),
      })
      expect(appRow).toBeDefined()

      const before = Date.now()
      const resumeUrlRes = await app.inject({
        method: 'GET',
        url: `/api/vacancies/${vacancyId}/applications/${appRow!.id}/resume-url`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(resumeUrlRes.statusCode).toBe(200)
      const { url, expiresAt } = resumeUrlRes.json() as { url: string; expiresAt: string }
      expect(url).toContain('http')
      const ttlMs = new Date(expiresAt).getTime() - before
      // TTL = 600s — allow a small tolerance for test execution time.
      expect(ttlMs).toBeGreaterThan(590_000)
      expect(ttlMs).toBeLessThanOrEqual(600_000 + 5_000)

      // Object is really there before delete.
      const s3 = app.get(S3Service)
      await expect(s3.getObject(appRow!.resumeS3Key)).resolves.toBeInstanceOf(Buffer)

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${vacancyId}/applications/${appRow!.id}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(deleteRes.statusCode).toBe(204)

      // DB row gone.
      const afterDelete = await dbSvc.db.query.vacancyApplications.findFirst({
        where: (a, { eq }) => eq(a.id, appRow!.id),
      })
      expect(afterDelete).toBeUndefined()

      // R2 object gone — real GetObject against MinIO now rejects.
      await expect(s3.getObject(appRow!.resumeS3Key)).rejects.toThrow()
    })
  })

  // ── AC8: rate limit on the REAL apply endpoint (fresh app — clean throttle store) ──

  describe('AC8 — rate limit', () => {
    let rlApp: NestFastifyApplication

    beforeAll(async () => {
      if (!dbAvailable) return
      delete process.env.THROTTLE_RELAXED
      const savedNodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'test'
      rlApp = await buildApp()
      if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv
    })

    afterAll(async () => {
      if (!dbAvailable) return
      if (rlApp) await rlApp.close()
    })

    it('returns 429 on the 6th apply request within the window (VACANCY_APPLY_LIMIT=5)', async () => {
      if (!dbAvailable) return
      // Guards run BEFORE the handler consumes the body — a non-existent slug
      // with no body still counts toward the throttle bucket, and lets this
      // test stay DB-write-free (each call 404s inside the handler after the
      // guard already counted it).
      let hitAt = -1
      for (let i = 1; i <= 6; i++) {
        const res = await rlApp.inject({
          method: 'POST',
          url: '/api/public/vacancies/rate-limit-probe-slug/apply',
        })
        if (res.statusCode === 429) {
          hitAt = i
          break
        }
      }
      expect(hitAt, 'Expected 429 within 6 requests (VACANCY_APPLY_LIMIT=5)').toBe(6)
    })
  })

  // ── AC9: retention cron — real 90-day SQL boundary + idempotency ───────────

  describe('AC9 — retention cron boundary (89/90/91 days) + idempotency', () => {
    const NOW = new Date('2026-08-01T00:00:00Z') // fixed reference instant for deterministic math
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

    let vacancyOpenId: string
    let vacancyClosed91Id: string
    let vacancyClosed89Id: string
    const appIds = {
      rejected89: 'b1c2d3e4-f5a6-4001-8000-000000000001',
      rejected90: 'b1c2d3e4-f5a6-4001-8000-000000000002',
      rejected91: 'b1c2d3e4-f5a6-4001-8000-000000000003',
      closedVacancy91App: 'b1c2d3e4-f5a6-4001-8000-000000000004',
      closedVacancy89App: 'b1c2d3e4-f5a6-4001-8000-000000000005',
    }

    beforeAll(async () => {
      if (!dbAvailable) return
      const db = dbSvc.db

      const openCreate = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Retention Boundary Role (open)',
          slug: `retention-open-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      vacancyOpenId = trackVacancy((openCreate.json() as { id: string }).id)

      const closed91Create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Retention Boundary Role (closed 91d ago)',
          slug: `retention-closed91-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      vacancyClosed91Id = trackVacancy((closed91Create.json() as { id: string }).id)

      const closed89Create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Retention Boundary Role (closed 89d ago)',
          slug: `retention-closed89-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        },
      })
      vacancyClosed89Id = trackVacancy((closed89Create.json() as { id: string }).id)

      // Directly set closed_at (the API always uses `now()`; this test needs
      // exact fixed offsets from NOW, so it writes the column directly).
      await db
        .update(vacancies)
        .set({ status: 'CLOSED', closedAt: daysAgo(91) })
        .where(inArray(vacancies.id, [vacancyClosed91Id]))
      await db
        .update(vacancies)
        .set({ status: 'CLOSED', closedAt: daysAgo(89) })
        .where(inArray(vacancies.id, [vacancyClosed89Id]))

      await db.insert(vacancyApplications).values([
        {
          id: appIds.rejected89,
          vacancyId: vacancyOpenId,
          fullName: 'Boundary 89',
          email: 'boundary89@test.spec',
          resumeS3Key: `vacancy-applications/${vacancyOpenId}/${appIds.rejected89}.pdf`,
          resumeSizeBytes: 1024,
          status: 'REJECTED',
          createdAt: daysAgo(89),
        },
        {
          id: appIds.rejected90,
          vacancyId: vacancyOpenId,
          fullName: 'Boundary 90',
          email: 'boundary90@test.spec',
          resumeS3Key: `vacancy-applications/${vacancyOpenId}/${appIds.rejected90}.pdf`,
          resumeSizeBytes: 1024,
          status: 'REJECTED',
          createdAt: daysAgo(90),
        },
        {
          id: appIds.rejected91,
          vacancyId: vacancyOpenId,
          fullName: 'Boundary 91',
          email: 'boundary91@test.spec',
          resumeS3Key: `vacancy-applications/${vacancyOpenId}/${appIds.rejected91}.pdf`,
          resumeSizeBytes: 1024,
          status: 'REJECTED',
          createdAt: daysAgo(91),
        },
        {
          id: appIds.closedVacancy91App,
          vacancyId: vacancyClosed91Id,
          fullName: 'Closed Vacancy 91d',
          email: 'closedvacancy91@test.spec',
          resumeS3Key: `vacancy-applications/${vacancyClosed91Id}/${appIds.closedVacancy91App}.pdf`,
          resumeSizeBytes: 1024,
          status: 'NEW', // status irrelevant — purged because the VACANCY is >90d closed
          createdAt: NOW,
        },
        {
          id: appIds.closedVacancy89App,
          vacancyId: vacancyClosed89Id,
          fullName: 'Closed Vacancy 89d',
          email: 'closedvacancy89@test.spec',
          resumeS3Key: `vacancy-applications/${vacancyClosed89Id}/${appIds.closedVacancy89App}.pdf`,
          resumeSizeBytes: 1024,
          status: 'NEW',
          createdAt: NOW,
        },
      ])
    }, 20_000)

    it('deletes only the >90-day-expired rows (91d REJECTED + closed>90d vacancy), keeps 89d/90d', async () => {
      if (!dbAvailable) return
      const cron = app.get(VacanciesRetentionCronService)
      const deleted = await cron.purgeExpiredApplications(NOW)
      expect(deleted).toBe(2)

      const remaining = await dbSvc.db.query.vacancyApplications.findMany({
        where: (a, { inArray: ia }) => ia(a.id, Object.values(appIds)),
      })
      const remainingIds = remaining.map((r) => r.id)
      expect(remainingIds).toContain(appIds.rejected89)
      expect(remainingIds).toContain(appIds.rejected90)
      expect(remainingIds).toContain(appIds.closedVacancy89App)
      expect(remainingIds).not.toContain(appIds.rejected91)
      expect(remainingIds).not.toContain(appIds.closedVacancy91App)
    })

    it('idempotency: running the cron again for the same instant deletes nothing more', async () => {
      if (!dbAvailable) return
      const cron = app.get(VacanciesRetentionCronService)
      const deletedSecondRun = await cron.purgeExpiredApplications(NOW)
      expect(deletedSecondRun).toBe(0)
    })
  })
})
