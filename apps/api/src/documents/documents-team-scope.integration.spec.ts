import { Controller, Get, Global, Inject, Module, Param, Query } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentListFilters, SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { DocumentsService } from './documents.service'
import type { S3Service } from './s3.service'
import type { CompressionService } from './compression.service'
import { documents, projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * DocumentsService team/project-scoped RESUME/SCAN — real-backend integration
 * spec (security-review round 1, HIGH-2).
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson + HIGH-2 finding):
 *   documents.service.spec.ts's team-scope tests are unit-level with a mocked
 *   DB — the mock can (and, in the first version of this fix, DID) assert a
 *   fixture shape that is IMPOSSIBLE in the real schema (a JUNIOR as an
 *   active `team_members` row), which encodes the exact defect the review
 *   found as if it were correct behaviour. documents-unified.integration.spec.ts
 *   (the only pre-existing real-DB spec for this service) never exercises a
 *   SENIOR/HR reading a DIFFERENT user's RESUME/SCAN at all.
 *
 *   This spec seeds data via the SAME shape the real app produces
 *   (`UsersService.createUser`: a JUNIOR is inserted into `project_members`,
 *   NEVER `team_members` — see teams.service.ts's `addMember` explicitly
 *   REJECTING a JUNIOR with an active project) and hits the real
 *   `DocumentsService` + real Postgres through a sentinel controller.
 *
 * WHAT it covers:
 *   SENIOR reads OWN project's JUNIOR's RESUME/SCAN            → 200
 *   SENIOR reads a JUNIOR NOT on their project                 → 404
 *   SENIOR reads a teammate SENIOR's SCAN (pure team overlap)  → 200
 *   SENIOR reads a non-teammate SENIOR's SCAN                  → 404
 *   HR reads their team's SENIOR's JUNIOR's SCAN (team+project) → 200
 *   HR reads an unrelated JUNIOR's SCAN                        → 404
 *   ACCOUNTANT reads SCAN of a user with a transaction         → 200
 *   ACCOUNTANT reads SCAN of a user with NO transaction        → 404
 *   list() with category=RESUME only returns team+project-scoped rows
 *
 * DB-SKIP-GUARD: `dbAvailable = false` when DATABASE_URL is unreachable
 * (CI unit job without Postgres) — every test returns early, 0 assertions
 * is acceptable there; the integration job has a Postgres service.
 */

const JWT_SECRET = 'documents-team-scope-integration-secret-32c'

// ---------------------------------------------------------------------------
// Test personas — fresh UUIDs namespaced to this spec (no collision).
// ---------------------------------------------------------------------------

const SENIOR: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000001',
  email: 'doc-scope-senior@test.spec',
  displayName: 'Doc Scope Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR sharing NO team/project with SENIOR — the negative-case owner. */
const SENIOR_OUTSIDE: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000002',
  email: 'doc-scope-senior-outside@test.spec',
  displayName: 'Doc Scope Senior Outside',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR sharing a TEAM with SENIOR (peer, not a project relationship). */
const SENIOR_TEAMMATE: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000003',
  email: 'doc-scope-senior-teammate@test.spec',
  displayName: 'Doc Scope Senior Teammate',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** JUNIOR on SENIOR's project — never a team_members row (system invariant). */
const JUNIOR_ON_PROJECT: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000004',
  email: 'doc-scope-junior-on-project@test.spec',
  displayName: 'Doc Scope Junior On Project',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** JUNIOR NOT on SENIOR's project (different project, different senior). */
const JUNIOR_ELSEWHERE: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000005',
  email: 'doc-scope-junior-elsewhere@test.spec',
  displayName: 'Doc Scope Junior Elsewhere',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR sharing SENIOR's team. */
const HR_TEAMMATE: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000006',
  email: 'doc-scope-hr-teammate@test.spec',
  displayName: 'Doc Scope HR Teammate',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR with no team overlap with SENIOR at all. */
const HR_OUTSIDE: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000007',
  email: 'doc-scope-hr-outside@test.spec',
  displayName: 'Doc Scope HR Outside',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ACCOUNTANT: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000008',
  email: 'doc-scope-accountant@test.spec',
  displayName: 'Doc Scope Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Owner of a SCAN with a transaction on record (ACCOUNTANT should reach it). */
const OWNER_WITH_TX: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-000000000009',
  email: 'doc-scope-owner-with-tx@test.spec',
  displayName: 'Doc Scope Owner With Tx',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Owner of a SCAN with NO transaction on record (ACCOUNTANT should NOT reach it). */
const OWNER_NO_TX: SessionUser = {
  id: 'd0c5a1e2-0000-4000-aa00-00000000000a',
  email: 'doc-scope-owner-no-tx@test.spec',
  displayName: 'Doc Scope Owner No Tx',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEST_USER_IDS = [
  SENIOR.id,
  SENIOR_OUTSIDE.id,
  SENIOR_TEAMMATE.id,
  JUNIOR_ON_PROJECT.id,
  JUNIOR_ELSEWHERE.id,
  HR_TEAMMATE.id,
  HR_OUTSIDE.id,
  ACCOUNTANT.id,
  OWNER_WITH_TX.id,
  OWNER_NO_TX.id,
]

const PROJ_SENIOR_ID = 'd0c5a1e2-0000-4000-bb00-000000000010'
const PROJ_ELSEWHERE_ID = 'd0c5a1e2-0000-4000-bb00-000000000011'
const TEAM_MAIN_ID = 'd0c5a1e2-0000-4000-bb00-000000000020'
const TEAM_ELSEWHERE_ID = 'd0c5a1e2-0000-4000-bb00-000000000021'
const PROJ_MEMBER_JUNIOR_ON_PROJECT = 'd0c5a1e2-0000-4000-bb00-000000000030'
const PROJ_MEMBER_JUNIOR_ELSEWHERE = 'd0c5a1e2-0000-4000-bb00-000000000031'

const DOC_JUNIOR_RESUME_ID = 'd0c5a1e2-0000-4000-cc00-000000000001'
const DOC_JUNIOR_SCAN_ID = 'd0c5a1e2-0000-4000-cc00-000000000002'
const DOC_SENIOR_TEAMMATE_SCAN_ID = 'd0c5a1e2-0000-4000-cc00-000000000003'
const DOC_OWNER_WITH_TX_SCAN_ID = 'd0c5a1e2-0000-4000-cc00-000000000004'
const DOC_OWNER_NO_TX_SCAN_ID = 'd0c5a1e2-0000-4000-cc00-000000000005'
const ALL_DOC_IDS = [
  DOC_JUNIOR_RESUME_ID,
  DOC_JUNIOR_SCAN_ID,
  DOC_SENIOR_TEAMMATE_SCAN_ID,
  DOC_OWNER_WITH_TX_SCAN_ID,
  DOC_OWNER_NO_TX_SCAN_ID,
]

const TX_ID = 'd0c5a1e2-0000-4000-dd00-000000000001'

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors the 2 real DocumentsController routes this
// spec needs. Real DocumentsController pulls in @fastify/multipart parsing
// for the POST upload route, which this sentinel doesn't need.
// ---------------------------------------------------------------------------

const DOCUMENTS_SERVICE_TOKEN = 'DOCUMENTS_SERVICE_TOKEN_TEAM_SCOPE'

@Controller('documents')
class SentinelDocumentsController {
  constructor(@Inject(DOCUMENTS_SERVICE_TOKEN) private readonly svc: DocumentsService) {}

  @Get()
  list(@Query() query: Record<string, string>, @CurrentUser() user: SessionUser) {
    const filters: DocumentListFilters = {
      category: (query['category'] as DocumentListFilters['category']) || undefined,
    }
    return this.svc.list(user, filters)
  }

  @Get(':id/download')
  download(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.getDownloadUrl(user, id)
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule — same pattern as legends.rbac.integration.spec.ts /
// documents-unified.integration.spec.ts.
// ---------------------------------------------------------------------------

let _testPool: Pool | null = null
let dbAvailable = true

const stubS3 = {
  upload: () => Promise.resolve(),
  getPresignedDownloadUrl: () =>
    Promise.resolve({ url: 'https://stub/x', expiresAt: new Date().toISOString() }),
  delete: () => Promise.resolve(),
} as unknown as S3Service

const stubCompression = {} as unknown as CompressionService

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _testPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_testPool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _testPool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _testPool?.end() ?? Promise.resolve(),
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
  ],
  controllers: [SentinelDocumentsController],
  providers: [
    Reflector,
    {
      provide: DocumentsService,
      useFactory: (db: DatabaseService) =>
        new DocumentsService(db, stubS3, stubCompression, new HrAccessService(db)),
      inject: [DatabaseService],
    },
    {
      provide: DOCUMENTS_SERVICE_TOKEN,
      useExisting: DocumentsService,
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class DocumentsTeamScopeTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DocumentsService team/project-scoped RESUME/SCAN — real backend integration (HIGH-2)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[documents-team-scope integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DocumentsTeamScopeTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'documents-team-scope-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed test data (idempotent via onConflictDoNothing) ────────────────

    // 1. Users
    await db
      .insert(users)
      .values(
        [
          SENIOR,
          SENIOR_OUTSIDE,
          SENIOR_TEAMMATE,
          JUNIOR_ON_PROJECT,
          JUNIOR_ELSEWHERE,
          HR_TEAMMATE,
          HR_OUTSIDE,
          ACCOUNTANT,
          OWNER_WITH_TX,
          OWNER_NO_TX,
        ].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // 2. Projects — SENIOR owns PROJ_SENIOR; SENIOR_OUTSIDE owns PROJ_ELSEWHERE
    await db
      .insert(projects)
      .values([
        {
          id: PROJ_SENIOR_ID,
          name: 'Doc Scope Project (Senior)',
          companyName: 'Test Corp',
          domain: 'e-commerce',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          currency: 'USDT',
          rate: '100',
        },
        {
          id: PROJ_ELSEWHERE_ID,
          name: 'Doc Scope Project (Elsewhere)',
          companyName: 'Test Corp 2',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR_OUTSIDE.id,
          currency: 'USDT',
          rate: '100',
        },
      ])
      .onConflictDoNothing()

    // 3. Project members — the ONLY path a JUNIOR reaches "SENIOR's scope"
    //    through, matching UsersService.createUser's real insert shape
    //    (JUNIOR → project_members ONLY, never team_members).
    await db
      .insert(projectMembers)
      .values([
        {
          id: PROJ_MEMBER_JUNIOR_ON_PROJECT,
          projectId: PROJ_SENIOR_ID,
          userId: JUNIOR_ON_PROJECT.id,
          joinedAt: new Date(),
        },
        {
          id: PROJ_MEMBER_JUNIOR_ELSEWHERE,
          projectId: PROJ_ELSEWHERE_ID,
          userId: JUNIOR_ELSEWHERE.id,
          joinedAt: new Date(),
        },
      ])
      .onConflictDoNothing()

    // 4. Teams — TEAM_MAIN: SENIOR + SENIOR_TEAMMATE + HR_TEAMMATE.
    //    TEAM_ELSEWHERE: HR_OUTSIDE only (no overlap with SENIOR).
    await db
      .insert(teams)
      .values([
        { id: TEAM_MAIN_ID, name: 'Doc Scope Team Main' },
        { id: TEAM_ELSEWHERE_ID, name: 'Doc Scope Team Elsewhere' },
      ])
      .onConflictDoNothing()

    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_MAIN_ID, userId: SENIOR.id, joinedAt: new Date() },
        { teamId: TEAM_MAIN_ID, userId: SENIOR_TEAMMATE.id, joinedAt: new Date() },
        { teamId: TEAM_MAIN_ID, userId: HR_TEAMMATE.id, joinedAt: new Date() },
        { teamId: TEAM_ELSEWHERE_ID, userId: HR_OUTSIDE.id, joinedAt: new Date() },
        // SENIOR_OUTSIDE is in NO team with SENIOR.
      ])
      .onConflictDoNothing()

    // 5. Documents — RESUME/SCAN rows owned by the JUNIORs/SENIORs above.
    await db
      .insert(documents)
      .values([
        {
          id: DOC_JUNIOR_RESUME_ID,
          ownerId: JUNIOR_ON_PROJECT.id,
          category: 'RESUME',
          name: 'resume.pdf',
          s3Key: `documents/RESUME/${JUNIOR_ON_PROJECT.id}/${DOC_JUNIOR_RESUME_ID}-resume.pdf`,
          sizeBytes: 1024,
          mimeType: 'application/pdf',
          uploadedBy: JUNIOR_ON_PROJECT.id,
        },
        {
          id: DOC_JUNIOR_SCAN_ID,
          ownerId: JUNIOR_ON_PROJECT.id,
          category: 'SCAN',
          name: 'passport.jpg',
          s3Key: `documents/SCAN/${JUNIOR_ON_PROJECT.id}/${DOC_JUNIOR_SCAN_ID}-passport.jpg`,
          sizeBytes: 1024,
          mimeType: 'image/jpeg',
          uploadedBy: JUNIOR_ON_PROJECT.id,
        },
        {
          id: DOC_SENIOR_TEAMMATE_SCAN_ID,
          ownerId: SENIOR_TEAMMATE.id,
          category: 'SCAN',
          name: 'passport.jpg',
          s3Key: `documents/SCAN/${SENIOR_TEAMMATE.id}/${DOC_SENIOR_TEAMMATE_SCAN_ID}-passport.jpg`,
          sizeBytes: 1024,
          mimeType: 'image/jpeg',
          uploadedBy: SENIOR_TEAMMATE.id,
        },
        {
          id: DOC_OWNER_WITH_TX_SCAN_ID,
          ownerId: OWNER_WITH_TX.id,
          category: 'SCAN',
          name: 'passport.jpg',
          s3Key: `documents/SCAN/${OWNER_WITH_TX.id}/${DOC_OWNER_WITH_TX_SCAN_ID}-passport.jpg`,
          sizeBytes: 1024,
          mimeType: 'image/jpeg',
          uploadedBy: OWNER_WITH_TX.id,
        },
        {
          id: DOC_OWNER_NO_TX_SCAN_ID,
          ownerId: OWNER_NO_TX.id,
          category: 'SCAN',
          name: 'passport.jpg',
          s3Key: `documents/SCAN/${OWNER_NO_TX.id}/${DOC_OWNER_NO_TX_SCAN_ID}-passport.jpg`,
          sizeBytes: 1024,
          mimeType: 'image/jpeg',
          uploadedBy: OWNER_NO_TX.id,
        },
      ])
      .onConflictDoNothing()

    // 6. One transaction where OWNER_WITH_TX is the receiver (MED-1 fixture) —
    //    OWNER_NO_TX deliberately has none.
    await db
      .insert(schema.transactions)
      .values({
        id: TX_ID,
        type: 'SALARY',
        amount: '100',
        currency: 'USDT',
        status: 'PAID',
        senderId: SENIOR.id,
        receiverId: OWNER_WITH_TX.id,
        createdBy: ACCOUNTANT.id,
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(schema.transactions).where(inArray(schema.transactions.id, [TX_ID]))
      await db.delete(documents).where(inArray(documents.id, ALL_DOC_IDS))
      await db
        .delete(projectMembers)
        .where(
          inArray(projectMembers.id, [PROJ_MEMBER_JUNIOR_ON_PROJECT, PROJ_MEMBER_JUNIOR_ELSEWHERE]),
        )
      await db
        .delete(teamMembers)
        .where(inArray(teamMembers.teamId, [TEAM_MAIN_ID, TEAM_ELSEWHERE_ID]))
      await db.delete(projects).where(inArray(projects.id, [PROJ_SENIOR_ID, PROJ_ELSEWHERE_ID]))
      await db.delete(teams).where(inArray(teams.id, [TEAM_MAIN_ID, TEAM_ELSEWHERE_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  it("SENIOR downloads their OWN project's JUNIOR RESUME → 200 (the HIGH-1 fix)", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_JUNIOR_RESUME_ID}/download`,
      cookies: { jwt: tokenFor(SENIOR) },
    })
    expect(res.statusCode).toBe(200)
  })

  it("SENIOR downloads their OWN project's JUNIOR SCAN → 200", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_JUNIOR_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(SENIOR) },
    })
    expect(res.statusCode).toBe(200)
  })

  it("SENIOR_OUTSIDE (no team/project overlap) CANNOT download the JUNIOR's RESUME → 404, not 403", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_JUNIOR_RESUME_ID}/download`,
      cookies: { jwt: tokenFor(SENIOR_OUTSIDE) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('SENIOR downloads a TEAMMATE SENIOR’s SCAN (pure team_members overlap, no project) → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_SENIOR_TEAMMATE_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(SENIOR) },
    })
    expect(res.statusCode).toBe(200)
  })

  it("HR_TEAMMATE downloads their team's SENIOR's JUNIOR SCAN (team+project chain) → 200", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_JUNIOR_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(HR_TEAMMATE) },
    })
    expect(res.statusCode).toBe(200)
  })

  it("HR_OUTSIDE (no team overlap with SENIOR) CANNOT download the JUNIOR's SCAN → 404", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_JUNIOR_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(HR_OUTSIDE) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('ACCOUNTANT downloads SCAN of an owner WITH a transaction on record → 200 (MED-1)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_OWNER_WITH_TX_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
  })

  it('ACCOUNTANT CANNOT download SCAN of an owner with NO transaction → 404 (MED-1)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${DOC_OWNER_NO_TX_SCAN_ID}/download`,
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(404)
  })

  it("list(category=RESUME) for SENIOR includes their project JUNIOR's resume", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents?category=RESUME',
      cookies: { jwt: tokenFor(SENIOR) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string }[]
    expect(body.some((d) => d.id === DOC_JUNIOR_RESUME_ID)).toBe(true)
  })

  it("list(category=RESUME) for SENIOR_OUTSIDE does NOT include the unrelated JUNIOR's resume", async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents?category=RESUME',
      cookies: { jwt: tokenFor(SENIOR_OUTSIDE) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string }[]
    expect(body.some((d) => d.id === DOC_JUNIOR_RESUME_ID)).toBe(false)
  })
})
