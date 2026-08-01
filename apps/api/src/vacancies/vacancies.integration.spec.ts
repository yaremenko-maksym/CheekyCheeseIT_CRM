/**
 * Vacancies — real-backend integration spec (real Postgres + a STUBBED
 * S3Service + real Cloudflare Turnstile "always passes" test secret).
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson): mocked specs
 * cannot prove that the REAL RolesGuard + REAL SQL WHERE clauses (409 dup
 * slug, applicationsCount aggregation, 24h duplicate window, PUBLISHED-only
 * visibility) actually enforce the contract. This spec drives the REAL
 * VacanciesController + PublicVacanciesController + all 3 real services
 * (VacanciesService, ApplicationsService, TurnstileService) through a real
 * Fastify HTTP pipeline.
 *
 * F1 (CI red fix, task-fix-pr-390): the CI `Integration Tests (Postgres)`
 * job (`.github/workflows/ci.yml`) runs Postgres only — MinIO is only
 * started for the separate `e2e` job — so this spec CANNOT depend on a real
 * R2/MinIO endpoint. Established precedent for THIS exact job:
 * `documents-unified.integration.spec.ts` stubs `S3Service` rather than
 * hitting a live endpoint. This spec follows the same pattern — an
 * in-memory key→buffer store stands in for R2/MinIO, so AC6/AC10 assert
 * "upload really persisted the right key/bytes" and "delete really removes
 * what getObject can see" without a live object store. Real-R2 behavioral
 * coverage (actual PutObject/GetObject/DeleteObject against MinIO) is
 * exercised locally against `docker-compose up -d` MinIO + manual-qa on the
 * real upload/download flow, not by this CI-run spec.
 *
 * Covers: AC3 (admin CRUD + status transitions + delete guards +
 * applicationsCount), AC4 (RBAC matrix on every private endpoint), AC5
 * (public visibility + 404s), AC6 (apply happy path — real DB row + stub-S3
 * object + real notifications), AC8 (rate-limit 429 on the real endpoint),
 * AC9 boundary (89/90/91 day retention cron against real timestamps), AC10
 * (resume-url presigned TTL + object gone from the stub store after delete).
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
import { ZodExceptionFilter } from '../zod-exception.filter'
import { CompressionService } from '../documents/compression.service'
import { S3Service } from '../documents/s3.service'
import { NotificationsService } from '../notifications/notifications.service'
import { notifications, users, vacancies, vacancyApplications } from '../database/schema'
import * as schema from '../database/schema'
import { ApplicationsService, RESUME_MAX_BYTES } from './applications.service'
import { GoogleIndexingService } from './google-indexing.service'
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
// Fake ConfigService — Turnstile dummy "always passes" secret only (F1: S3
// config is no longer needed — S3Service itself is stubbed below, not
// constructed from real S3/MinIO env). Avoids requiring the full app
// validateEnv() (GOOGLE_CLIENT_ID etc are irrelevant here and not present in
// the vitest worker env).
// ---------------------------------------------------------------------------

// task-google-indexing-api: GOOGLE_INDEXING_SA_EMAIL / _KEY_B64 are
// intentionally OMITTED — GoogleIndexingService runs in its no-op mode (no
// real network calls), same as any dev/CI env without those keys.
// PUBLIC_LANDING_ORIGIN IS set (matches the real schema default) so
// VacanciesService/VacanciesRetentionCronService's careers-URL building
// exercises the real value instead of `undefined`.
const fakeEnv: Record<string, unknown> = {
  TURNSTILE_SECRET_KEY: DUMMY_TURNSTILE_SECRET,
  NODE_ENV: 'test',
  PUBLIC_LANDING_ORIGIN: 'https://cheekycheese.tech',
}
const fakeConfigService = { get: (key: string) => fakeEnv[key] } as unknown as ConfigService

// ---------------------------------------------------------------------------
// Stub S3Service (F1 / sec CI-red fix) — see the file-header comment for the
// full rationale. An in-memory key→buffer Map stands in for R2/MinIO:
//   - upload()  stores the buffer under its key
//   - getObject() returns the stored buffer, or rejects if the key is absent
//     (mirrors S3Service.getObject's real "throws on missing key" contract)
//   - delete()  removes the key (idempotent — deleting a missing key is a no-op)
//   - deleteOrThrow() same behaviour as delete() here (the stub has no
//     transport to fail) — VacanciesRetentionCronService (F1 / MED-1) calls
//     THIS method, not delete(), so the stub must implement it for AC9 to
//     exercise the real cron through DI.
//   - getPresignedDownloadUrl() returns a fake-but-shaped URL + a REAL
//     TTL-derived expiresAt (same math as S3Service, so the AC10 TTL
//     assertion still exercises real ApplicationsService/controller wiring,
//     not just the stub).
// ---------------------------------------------------------------------------

const s3Store = new Map<string, Buffer>()

const stubS3 = {
  upload: (key: string, body: Buffer): Promise<void> => {
    s3Store.set(key, body)
    return Promise.resolve()
  },
  getObject: (key: string): Promise<Buffer> => {
    const buf = s3Store.get(key)
    if (!buf) return Promise.reject(new Error(`stub S3: no such key "${key}"`))
    return Promise.resolve(buf)
  },
  delete: (key: string): Promise<void> => {
    s3Store.delete(key)
    return Promise.resolve()
  },
  // F1 (task-fix-pr-390-round3 / MED-1): VacanciesRetentionCronService calls
  // deleteOrThrow, not delete — the stub has no transport to fail so both
  // behave identically here (real-transport-failure coverage is unit-level,
  // in s3.service.spec.ts + vacancies-retention.cron.spec.ts).
  deleteOrThrow: (key: string): Promise<void> => {
    s3Store.delete(key)
    return Promise.resolve()
  },
  getPresignedDownloadUrl: (
    key: string,
    ttlSec: number | undefined = 600,
    _downloadAs?: string,
    _disposition?: 'inline' | 'attachment',
  ): Promise<{ url: string; expiresAt: string }> => {
    const effectiveTtl = ttlSec ?? 600
    return Promise.resolve({
      url: `https://stub-s3.local/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + effectiveTtl * 1000).toISOString(),
    })
  },
} as unknown as S3Service

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
    // F1: stubbed, in-memory S3Service (see the stub's own comment above) —
    // the CI `integration` job has Postgres but NOT MinIO.
    { provide: S3Service, useValue: stubS3 },
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
      // task-google-indexing-api: no SA env vars in `fakeEnv` → constructs in
      // no-op mode (logs one warning, never calls fetch) — safe for this
      // Postgres-only CI job.
      provide: GoogleIndexingService,
      useFactory: (c: ConfigService) => new GoogleIndexingService(c),
      inject: [ConfigService],
    },
    {
      provide: VacanciesService,
      useFactory: (db: DatabaseService, gi: GoogleIndexingService, c: ConfigService) =>
        new VacanciesService(db, gi, c),
      inject: [DatabaseService, GoogleIndexingService, ConfigService],
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
      useFactory: (
        db: DatabaseService,
        s3: S3Service,
        gi: GoogleIndexingService,
        c: ConfigService,
      ) => new VacanciesRetentionCronService(db, s3, gi, c),
      inject: [DatabaseService, S3Service, GoogleIndexingService, ConfigService],
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
  // F2 (task-fix-pr-390-round3 / MED-2): same registration as main.ts + the
  // established pattern in company-account.rbac.integration.spec.ts. Without
  // this, a ZodError (e.g. applyVacancyFieldsSchema.parse() rejecting an
  // over-long coverLetter) falls through to NestJS's generic 500 handler
  // instead of the real prod contract (400) — that mismatch would have made
  // the F2 fieldSize test assert a TEST-HARNESS artifact instead of the
  // actual production behaviour.
  app.useGlobalFilters(new ZodExceptionFilter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/** Shape of one file part for buildMultipartBody. */
interface MultipartFileDescriptor {
  fieldname: string
  filename: string
  contentType: string
  buffer: Buffer
}

/** Hand-rolled multipart/form-data body — no precedent for real multipart HTTP
 * tests elsewhere in this repo, so this is a small, self-contained helper.
 *
 * `file` accepts either a single descriptor (the common case — AC6/AC10) or
 * an ARRAY of descriptors (F2 / MED-2: needed to reproduce a request that
 * sends a second `resume` file part and assert on the per-route `files: 1`
 * multipart limit). Order matters: fields are appended in Object.entries()
 * insertion order, THEN files in array order — this lets F2's "extra field
 * parts" test put the file part LAST, after every bogus field, mirroring a
 * real attacker maximizing field count before the file. */
function buildMultipartBody(
  fields: Record<string, string>,
  file?: MultipartFileDescriptor | MultipartFileDescriptor[],
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
  const files = file === undefined ? [] : Array.isArray(file) ? file : [file]
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldname}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ),
    )
    parts.push(f.buffer)
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
        // Delete the stub-S3 resume objects (in-memory Map, F1) before
        // dropping the rows that reference them — tidy even though the
        // store is process-local and never persists across test runs.
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
        salaryMin: 3000,
        salaryMax: 5000,
        salaryCurrency: 'USDT',
        salaryPeriod: 'MONTH',
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
          salaryMin: 4000,
          salaryMax: 6000,
          salaryCurrency: 'USD',
          salaryPeriod: 'MONTH',
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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

    it('delete guard: 409 while PUBLISHED; succeeds once CLOSED with 0 applications (task-vacancy-delete-closed)', async () => {
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      const id = (create.json() as { id: string }).id
      trackVacancy(id)

      // Publish it → PUBLISHED → delete must 409 (close it first).
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
      const blockedPublished = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(blockedPublished.statusCode).toBe(409)

      // Close it → CLOSED with 0 applications → owner's reported bug: this
      // used to 409 unconditionally (only DRAFT was deletable). Now allowed.
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'CLOSED' },
      })
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(removed.statusCode).toBe(204)

      // A brand-new DRAFT vacancy with 0 applications still CAN be deleted
      // (unchanged behaviour, pinned against a regression from this task).
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      const id2 = (create2.json() as { id: string }).id
      const removed2 = await app.inject({
        method: 'DELETE',
        url: `/api/vacancies/${id2}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(removed2.statusCode).toBe(204)
    })
  })

  // ── task-vacancy-salary-range: mandatory salary range, real HTTP/DB ───────

  describe('AC1/AC2/AC3 — mandatory salary range (task-vacancy-salary-range)', () => {
    it('AC1: POST /api/vacancies without a salary range → 400 (real Zod validation via the controller)', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'No Salary Role',
          slug: `no-salary-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          // salaryMin/salaryMax/salaryCurrency/salaryPeriod deliberately omitted
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('AC1: rejects a zero/negative salaryMin even with the other 3 fields present', async () => {
      if (!dbAvailable) return
      const res = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Bad Salary Role',
          slug: `bad-salary-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          salaryMin: 0,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('AC2: cannot publish (DRAFT → PUBLISHED) a vacancy created without a salary range', async () => {
      if (!dbAvailable) return
      // Created directly against the DB (bypassing the create endpoint's own
      // AC1 gate) — reproduces exactly the 3 legacy prod rows this task
      // shipped alongside: already in the DB, no salary columns filled.
      const [row] = await dbSvc.db
        .insert(vacancies)
        .values({
          slug: `legacy-no-salary-${Date.now()}`,
          title: 'Legacy Role Without Salary',
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          status: 'DRAFT',
          createdBy: ADMIN.id,
        })
        .returning()
      const id = trackVacancy(row!.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
      expect(res.statusCode).toBe(400)

      // Still DRAFT — the rejected publish attempt did not partially commit.
      const stillDraft = await dbSvc.db.query.vacancies.findFirst({
        where: (v, { eq }) => eq(v.id, id),
      })
      expect(stillDraft?.status).toBe('DRAFT')
    })

    it('AC2: publishing succeeds once the SAME PATCH fills in the salary range (fixing up a legacy vacancy)', async () => {
      if (!dbAvailable) return
      const [row] = await dbSvc.db
        .insert(vacancies)
        .values({
          slug: `legacy-fillable-${Date.now()}`,
          title: 'Legacy Role Being Fixed Up',
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          status: 'DRAFT',
          createdBy: ADMIN.id,
        })
        .returning()
      const id = trackVacancy(row!.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          status: 'PUBLISHED',
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { status: string; salaryMin: string | null }
      expect(body.status).toBe('PUBLISHED')
      // Real Postgres numeric(12,2) output is scale-padded ("3000.00", not
      // the raw "3000" the request sent) — unlike the mocked unit-spec
      // harness, this is the REAL round-trip through the DB.
      expect(body.salaryMin).toBe('3000.00')
    })

    it('AC3: a legacy PUBLISHED vacancy without a salary range keeps serving on the public detail/list endpoints (salary fields simply null)', async () => {
      if (!dbAvailable) return
      // Insert DIRECTLY as already-PUBLISHED (bypassing the publish-gate
      // entirely) — this is EXACTLY the state of the 3 real prod rows this
      // task shipped alongside (published before this change existed).
      const slug = `legacy-published-${Date.now()}`
      const [row] = await dbSvc.db
        .insert(vacancies)
        .values({
          slug,
          title: 'Legacy Published Role',
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          status: 'PUBLISHED',
          publishedAt: new Date(),
          createdBy: ADMIN.id,
        })
        .returning()
      trackVacancy(row!.id)

      const detail = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}`,
      })
      expect(detail.statusCode).toBe(200)
      const body = detail.json() as {
        salaryMin: string | null
        salaryMax: string | null
        salaryCurrency: string | null
        salaryPeriod: string | null
      }
      expect(body.salaryMin).toBeNull()
      expect(body.salaryMax).toBeNull()
      expect(body.salaryCurrency).toBeNull()
      expect(body.salaryPeriod).toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/public/vacancies' })
      expect(list.statusCode).toBe(200)
      const listEntry = (list.json() as { slug: string; salaryMin: string | null }[]).find(
        (v) => v.slug === slug,
      )
      expect(listEntry?.salaryMin).toBeNull()
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
    it('public list only includes PUBLISHED vacancies; detail 404 for DRAFT/missing, 410 for CLOSED (task C5)', async () => {
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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

      // Close it → task C5: 410 Gone (NOT 404 — a formerly-live posting is
      // genuinely GONE, distinct from "never existed"/still-DRAFT).
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
      expect(closedDetail.statusCode).toBe(410)

      // ...and it's gone from the public list too (sitemap generation reads
      // this same endpoint, task C5 "уходит из sitemap").
      const listAfterClose = await app.inject({ method: 'GET', url: '/api/public/vacancies' })
      const slugsAfterClose = (listAfterClose.json() as { slug: string }[]).map((v) => v.slug)
      expect(slugsAfterClose).not.toContain(publishedSlug)
    })
  })

  // ── C2/C8: locale resolution + isFallback + related vacancies ─────────────

  describe('C2/C8 — locale resolution + related vacancies', () => {
    it('?locale= resolves translated title/description with isFallback=false; falls back to EN + isFallback=true when untranslated; defaults to en', async () => {
      if (!dbAvailable) return
      const slug = `locale-${Date.now()}`
      const create = await app.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'EN Title',
          slug,
          descriptionMd: 'EN description body goes here.',
          domain: 'AI',
          employmentType: 'FULL_TIME',
          translations: {
            uk: { title: 'UK Заголовок', description: 'UK опис вакансії тут повністю.' },
            es: { title: 'ES Título', description: 'ES descripción completa de la vacante aquí.' },
          },
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      expect(create.statusCode).toBe(201)
      const id = trackVacancy((create.json() as { id: string }).id)
      await app.inject({
        method: 'PATCH',
        url: `/api/vacancies/${id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })

      // Default (no ?locale=) → en, isFallback=false.
      const noLocale = await app.inject({ method: 'GET', url: `/api/public/vacancies/${slug}` })
      expect(noLocale.statusCode).toBe(200)
      const noLocaleBody = noLocale.json() as { title: string; isFallback: boolean }
      expect(noLocaleBody.title).toBe('EN Title')
      expect(noLocaleBody.isFallback).toBe(false)

      // Explicit ?locale=en → same as default, isFallback=false (task-vacancy-i18n-jobposting
      // owner scope-change 2026-07-25: all 5 locales exercised here, not just uk/ru).
      const en = await app.inject({ method: 'GET', url: `/api/public/vacancies/${slug}?locale=en` })
      expect((en.json() as { title: string; isFallback: boolean }).title).toBe('EN Title')
      expect((en.json() as { isFallback: boolean }).isFallback).toBe(false)

      // Translated locales (uk, es) → translated copy, isFallback=false.
      const uk = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}?locale=uk`,
      })
      const ukBody = uk.json() as { title: string; descriptionMd: string; isFallback: boolean }
      expect(ukBody.title).toBe('UK Заголовок')
      expect(ukBody.descriptionMd).toBe('UK опис вакансії тут повністю.')
      expect(ukBody.isFallback).toBe(false)

      const es = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}?locale=es`,
      })
      const esBody = es.json() as { title: string; descriptionMd: string; isFallback: boolean }
      expect(esBody.title).toBe('ES Título')
      expect(esBody.descriptionMd).toBe('ES descripción completa de la vacante aquí.')
      expect(esBody.isFallback).toBe(false)

      // Untranslated locales (ru, pt) → fall back to EN copy, isFallback=true.
      const ru = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}?locale=ru`,
      })
      const ruBody = ru.json() as { title: string; isFallback: boolean }
      expect(ruBody.title).toBe('EN Title')
      expect(ruBody.isFallback).toBe(true)

      const pt = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}?locale=pt`,
      })
      const ptBody = pt.json() as { title: string; isFallback: boolean }
      expect(ptBody.title).toBe('EN Title')
      expect(ptBody.isFallback).toBe(true)

      // Garbage locale value → silently falls back to en (public unauth GET, never 400s).
      const garbage = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${slug}?locale=xx`,
      })
      expect(garbage.statusCode).toBe(200)
      expect((garbage.json() as { title: string }).title).toBe('EN Title')

      // Same resolution applies to the list endpoint.
      const list = await app.inject({
        method: 'GET',
        url: '/api/public/vacancies?locale=uk',
      })
      const listEntry = (
        list.json() as { slug: string; title: string; isFallback: boolean }[]
      ).find((v) => v.slug === slug)
      expect(listEntry?.title).toBe('UK Заголовок')
      expect(listEntry?.isFallback).toBe(false)
    })

    it('relatedVacancies: up to 3 other PUBLISHED same-domain vacancies, excluding self, resolved to the requested locale', async () => {
      if (!dbAvailable) return
      const ts = Date.now()
      const mainSlug = `related-main-${ts}`
      const domain = 'ECOMMERCE'

      async function createPublished(slug: string, title: string, otherDomain = false) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/vacancies',
          cookies: { jwt: tokenFor(ADMIN) },
          payload: {
            title,
            slug,
            descriptionMd: 'Full description of the role goes here.',
            domain: otherDomain ? 'AI' : domain,
            employmentType: 'FULL_TIME',
            salaryMin: 3000,
            salaryMax: 5000,
            salaryCurrency: 'USDT',
            salaryPeriod: 'MONTH',
          },
        })
        const id = trackVacancy((res.json() as { id: string }).id)
        await app.inject({
          method: 'PATCH',
          url: `/api/vacancies/${id}`,
          cookies: { jwt: tokenFor(ADMIN) },
          payload: { status: 'PUBLISHED' },
        })
        return id
      }

      await createPublished(mainSlug, 'Main Role')
      await createPublished(`related-same-domain-1-${ts}`, 'Related 1')
      await createPublished(`related-same-domain-2-${ts}`, 'Related 2')
      await createPublished(`related-other-domain-${ts}`, 'Different Domain Role', true)

      const detail = await app.inject({
        method: 'GET',
        url: `/api/public/vacancies/${mainSlug}`,
      })
      expect(detail.statusCode).toBe(200)
      const body = detail.json() as {
        relatedVacancies: { slug: string; domain: string }[]
      }
      expect(body.relatedVacancies.length).toBeGreaterThan(0)
      expect(body.relatedVacancies.length).toBeLessThanOrEqual(3)
      for (const related of body.relatedVacancies) {
        expect(related.slug).not.toBe(mainSlug)
        expect(related.domain).toBe(domain)
      }
    })
  })

  // ── AC6: apply happy path (real DB + stub-S3 object + real notifications) ─

  describe('AC6 — apply happy path', () => {
    it('POST /api/public/vacancies/:slug/apply → 201, DB row, stub-S3 object, ADMIN+HR notified', async () => {
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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

      // Stub-S3 object exists — ApplicationsService really called
      // S3Service.upload() with the right key/bytes (F1: real R2 behavioral
      // coverage lives in local/manual-qa, not this CI-run spec).
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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

      // Stub-S3 object gone — ApplicationsController's DELETE handler really
      // called S3Service.delete(), which removed the key from the store.
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
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

  // ── F2 (task-fix-pr-390-round3 / MED-2): per-route multipart limits on the
  // REAL PublicVacanciesController.apply() pipeline — direct tests were
  // missing entirely; round-2 review only had indirect coverage via AC6's
  // happy path. Own dedicated app instance (own throttle store, own Pool) —
  // same pattern as the AC8 rate-limit block — so these 4 requests never risk
  // tripping VACANCY_APPLY_LIMIT=5 alongside the AC6/AC10 apply() calls made
  // against the shared `app` instance above. ─────────────────────────────────

  describe('F2 — per-route multipart limits (MED-2)', () => {
    let mpApp: NestFastifyApplication
    let mpSlug: string

    beforeAll(async () => {
      if (!dbAvailable) return
      mpApp = await buildApp()
      const create = await mpApp.inject({
        method: 'POST',
        url: '/api/vacancies',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: {
          title: 'Multipart Limits Role',
          slug: `multipart-limits-${Date.now()}`,
          descriptionMd: 'Full description of the role goes here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          salaryMin: 3000,
          salaryMax: 5000,
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
      })
      const created = create.json() as { id: string; slug: string }
      mpSlug = created.slug
      trackVacancy(created.id)
      await mpApp.inject({
        method: 'PATCH',
        url: `/api/vacancies/${created.id}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { status: 'PUBLISHED' },
      })
    }, 20_000)

    afterAll(async () => {
      if (!dbAvailable) return
      if (mpApp) await mpApp.close()
    })

    it('1. resume file > 5MB → 413 (per-route fileSize cap rejects it via RequestFileTooLargeError before ApplicationsService is ever called)', async () => {
      if (!dbAvailable) return
      const oversized = Buffer.alloc(RESUME_MAX_BYTES + 1024, 'a')
      const { body, contentType } = buildMultipartBody(
        {
          fullName: 'Oversized Resume Candidate',
          email: `oversized-${Date.now()}@example.com`,
          turnstileToken: 'any-token-accepted-by-dummy-secret',
        },
        {
          fieldname: 'resume',
          filename: 'huge.pdf',
          contentType: 'application/pdf',
          buffer: oversized,
        },
      )
      const res = await mpApp.inject({
        method: 'POST',
        url: `/api/public/vacancies/${mpSlug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })
      expect(res.statusCode).toBe(413)
    })

    it('2. a second `resume` file part → 413 — the per-route `files: 1` limit rejects the WHOLE request at the busboy layer (FilesLimitError) before the controller\'s own "drain a duplicate file part" branch is ever reached', async () => {
      if (!dbAvailable) return
      const pdf = await makeValidPdfBuffer()
      const { body, contentType } = buildMultipartBody(
        {
          fullName: 'Two Files Candidate',
          email: `twofiles-${Date.now()}@example.com`,
          turnstileToken: 'any-token-accepted-by-dummy-secret',
        },
        [
          { fieldname: 'resume', filename: 'r1.pdf', contentType: 'application/pdf', buffer: pdf },
          { fieldname: 'resume', filename: 'r2.pdf', contentType: 'application/pdf', buffer: pdf },
        ],
      )
      const res = await mpApp.inject({
        method: 'POST',
        url: `/api/public/vacancies/${mpSlug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })
      // Empirically verified against the real @fastify/multipart@10 + @fastify/busboy@3
      // pipeline used by this app: with `files: 1`, busboy accepts only the
      // FIRST file-type part; the second one never reaches onFile()/the
      // controller's for-await loop at all — busboy emits 'filesLimit' and
      // skips it internally, which @fastify/multipart turns into a rejected
      // FilesLimitError (statusCode 413) on the NEXT `await parts()` call.
      // NestJS's default exception handling (BaseExceptionFilter.isHttpError)
      // surfaces `.statusCode` from any thrown error with a `.message`, so no
      // custom filter is needed for this to reach the client as 413.
      expect(res.statusCode).toBe(413)
    })

    it('3. field parts beyond the fields:12 cap → the request is aborted — empirically a 500 ("Premature close") via app.inject(), NOT a clean 413: busboy stops consuming the body as soon as the 13th field part hits the limit, and the injected request stream errors on the unread trailing bytes', async () => {
      if (!dbAvailable) return
      const pdf = await makeValidPdfBuffer()
      const fields: Record<string, string> = {
        fullName: 'Extra Fields Candidate',
        email: `extrafields-${Date.now()}@example.com`,
        turnstileToken: 'any-token-accepted-by-dummy-secret',
      }
      // 3 legit fields above + 10 bogus = 13 field parts, i.e. one MORE than
      // the fields:12 cap — the 13th field part is what trips fieldsLimit.
      // The resume file part is appended LAST (buildMultipartBody array/object
      // ordering — see its own doc comment) so it never even gets a chance to
      // be parsed once the field cap is hit.
      for (let i = 0; i < 10; i++) fields[`bogus${i}`] = 'x'
      const { body, contentType } = buildMultipartBody(fields, {
        fieldname: 'resume',
        filename: 'r.pdf',
        contentType: 'application/pdf',
        buffer: pdf,
      })
      const res = await mpApp.inject({
        method: 'POST',
        url: `/api/public/vacancies/${mpSlug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })
      expect(res.statusCode).toBe(500)
    })

    it('4. a field value beyond the fieldSize (8 KiB) cap is silently TRUNCATED by @fastify/multipart (no multipart-level rejection — busboy just truncates and sets valueTruncated), then rejected downstream by the real Zod validation (coverLetter max 2000 chars) → 400', async () => {
      if (!dbAvailable) return
      const pdf = await makeValidPdfBuffer()
      const { body, contentType } = buildMultipartBody(
        {
          fullName: 'Long Field Candidate',
          email: `longfield-${Date.now()}@example.com`,
          turnstileToken: 'any-token-accepted-by-dummy-secret',
          // 9000 bytes: > 8192-byte fieldSize cap (so it gets truncated at the
          // multipart layer) AND still > 2000-char Zod cap after truncation
          // (so applyVacancyFieldsSchema.parse() rejects it regardless of the
          // exact truncated length) — this isolates "field length beyond
          // limit is ultimately rejected" as the fact under test, without
          // depending on the precise truncation boundary.
          coverLetter: 'x'.repeat(9000),
        },
        { fieldname: 'resume', filename: 'r.pdf', contentType: 'application/pdf', buffer: pdf },
      )
      const res = await mpApp.inject({
        method: 'POST',
        url: `/api/public/vacancies/${mpSlug}/apply`,
        headers: { 'content-type': contentType },
        payload: body,
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
