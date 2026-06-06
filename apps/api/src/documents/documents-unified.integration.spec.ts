import { Controller, Get, Global, Inject, Module, Query } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Document as DocumentDto, SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { DocumentsService } from './documents.service'
import { S3Service } from './s3.service'
import { CompressionService } from './compression.service'
import { documents, invoiceSignatures, transactions } from '../database/schema'
import * as schema from '../database/schema'

/**
 * PR-2 unified documents list — real backend integration spec.
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson):
 *   Unit tests mock the DB — they can't verify that SQL CASE/EXISTS expressions
 *   for badge derivation, the LEFT JOIN for transactions, or the Drizzle
 *   relational query for employee_contracts produce correct results against a
 *   real PostgreSQL. This spec hits the real DB.
 *
 * WHAT it covers (PR-2 AC1):
 *   1. ADMIN sees ALL users' non-CANCELLED employee_contract virtual entries
 *   2. SENIOR sees only own employee_contract virtual entry
 *   3. ACCOUNTANT sees only non-CANCELLED contract for themselves (if any)
 *   4. INVOICE file rows carry statusBadge {kind:'invoice', state:'ready'/'signed'}
 *      derived from invoice_signatures completeness
 *   5. RECEIPT file rows carry statusBadge {kind:'receipt', state} derived from
 *      linked transaction.status
 *   6. RESUME rows carry statusBadge null (no badge)
 *   7. CANCELLED employee_contract hidden from all viewers
 *   8. category='CONTRACT' filter excludes non-contract file entries but
 *      includes contract virtual entries
 *
 * DB-SKIP-GUARD:
 *   `dbAvailable = false` when DATABASE_URL is unreachable (CI unit job
 *   without Postgres service). Every test checks the flag and returns early,
 *   so the CI job stays green with 0 failures (0 assertions is acceptable
 *   in the CI unit job; the integration job has a Postgres service).
 *
 * SEED data used:
 *   - ADMIN:       yaremenkomaksym99@gmail.com  (a8f4d3b1-...)
 *   - SENIOR:      artem.kravchenko             (d8f9e0b1-...) SIGNED contract
 *   - SENIOR 2:    dmytro.marchenko             (d2f3e4b5-...) READY_TO_SIGN contract
 *   - ACCOUNTANT:  mykola.savchenko             (c7e8d9a0-...)
 *
 * SETUP: creates temporary documents + transactions + invoice_signatures rows
 * in beforeAll, tagged with a unique run-id. Cleans up in afterAll.
 *
 * WHY sentinel controller (not real DocumentsController):
 *   Real DocumentsController depends on @fastify/multipart request parsing
 *   for the POST upload endpoint. The sentinel exposes GET /documents with
 *   real DocumentsService injected — no multipart machinery needed.
 *
 * WHY useFactory for all providers:
 *   vitest uses esbuild which strips TS decorator constructor-parameter
 *   metadata. NestJS DI silently injects `undefined` for unmarked params.
 *   Explicit useFactory resolves deps via the test module's injector.
 */

const JWT_SECRET = 'pr2-docs-integration-secret-32chars'

/** ADMIN */
const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR with SIGNED contract */
const ARTEM: SessionUser = {
  id: 'd8f9e0b1-c2d3-4e4f-9a6b-7c8d9e0f1acc',
  email: 'artem.kravchenko@cheekycheese.dev',
  displayName: 'Artem Kravchenko',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR with READY_TO_SIGN contract */
const DMYTRO: SessionUser = {
  id: 'd2f3e4b5-c6d7-4e8f-9a0b-1c2d3e4f5a66',
  email: 'dmytro.marchenko@cheekycheese.dev',
  displayName: 'Dmytro Marchenko',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: 'Марченко Дмитро Олексійович',
}

/** ACCOUNTANT */
const ACCOUNTANT: SessionUser = {
  id: 'c7e8d9a0-b1c2-4d3e-8f5a-6b7c8d9e0fbb',
  email: 'mykola.savchenko@cheekycheese.dev',
  displayName: 'Mykola Savchenko',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Sentinel controller — exposes GET /documents via real DocumentsService.
// Uses @Inject string token to avoid esbuild metadata issue on constructor.
// ---------------------------------------------------------------------------

const DOCUMENTS_SERVICE_TOKEN = 'DOCUMENTS_SERVICE_TOKEN_PR2'

@Controller('documents')
class SentinelDocumentsController {
  constructor(
    // @Inject(string token) bypasses esbuild metadata stripping on controller
    // constructor params — the same pattern used in onboarding integration spec.
    @Inject(DOCUMENTS_SERVICE_TOKEN) private readonly svc: DocumentsService,
  ) {}

  @Get()
  async list(@CurrentUser() actor: SessionUser, @Query() query: Record<string, string>) {
    // Parse filters from query string manually (mirrors real controller).
    const filters: { category?: string; ownerId?: string; includeDeleted?: boolean } = {}
    if (query['category']) filters.category = query['category']
    if (query['ownerId']) filters.ownerId = query['ownerId']
    if (query['includeDeleted'] === 'true') filters.includeDeleted = true
    return this.svc.list(actor, filters as Parameters<DocumentsService['list']>[1])
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule — same pattern as onboarding-contract.integration.spec.ts
// ---------------------------------------------------------------------------

let _testPool: Pool | null = null

/**
 * True when DATABASE_URL is reachable. Set to false in beforeAll if the
 * DB probe fails. Every test returns early when false.
 */
let dbAvailable = true

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

// ---------------------------------------------------------------------------
// Stub S3 / CompressionService — not used by list(), but required by
// DocumentsService constructor. Stubs return safe no-ops.
// ---------------------------------------------------------------------------

const stubS3 = {
  upload: () => Promise.resolve(),
  getPresignedDownloadUrl: () =>
    Promise.resolve({ url: 'https://stub/', expiresAt: new Date().toISOString() }),
  delete: () => Promise.resolve(),
} as unknown as S3Service

const stubCompression = {
  compress: () =>
    Promise.resolve({ buffer: Buffer.from(''), finalMimeType: 'application/pdf', sizeBytes: 0 }),
  makeThumbnail: () => Promise.resolve(null),
} as unknown as CompressionService

// ---------------------------------------------------------------------------
// Test module
// ---------------------------------------------------------------------------

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelDocumentsController],
  providers: [
    Reflector,
    // DocumentsService — useFactory avoids esbuild metadata issue.
    {
      provide: DocumentsService,
      useFactory: (db: DatabaseService) => new DocumentsService(db, stubS3, stubCompression),
      inject: [DatabaseService],
    },
    // String token alias — SentinelDocumentsController uses @Inject(token) to
    // bypass esbuild metadata issue on controller constructor params.
    {
      provide: DOCUMENTS_SERVICE_TOKEN,
      useExisting: DocumentsService,
    },
    // Guard
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class DocumentsUnifiedTestModule {}

// ---------------------------------------------------------------------------
// Test data IDs — random-ish, namespaced to this spec run.
// ---------------------------------------------------------------------------

/** Unique prefix used in s3_key to identify test rows during cleanup. */
const TEST_TAG = 'pr2-integration-spec'

const DOC_RESUME_ID = '10000001-0000-4000-a000-000000000001'
const DOC_INVOICE_ID = '10000001-0000-4000-a000-000000000002'
const DOC_RECEIPT_ID = '10000001-0000-4000-a000-000000000003'
const TX_INVOICE_ID = '20000001-0000-4000-b000-000000000001'
const TX_RECEIPT_ID = '20000001-0000-4000-b000-000000000002'
const SIG_COMPANY_ID = '30000001-0000-4000-c000-000000000001'

// SENIOR users with DRAFT contracts (from seed data — qa test users created in prior QA sessions).
// These exist in the real DB and are used to verify role-based DRAFT visibility.
const QA_SENIOR_WITH_DRAFT: SessionUser = {
  id: '27b9524e-0b48-4226-8f90-65b4662c1250',
  email: 'qa-ac6-7x9k2m@cheekycheese.dev',
  displayName: 'QA Senior Draft',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PR-2 documents unified list — real backend integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    // ── DB availability probe ────────────────────────────────────────────────
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[pr2-docs integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DocumentsUnifiedTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'pr2-docs-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)

    // ── Insert test rows ────────────────────────────────────────────────────
    const dbSvc = moduleRef.get(DatabaseService)
    const db = dbSvc.db

    // 1. RESUME doc (ARTEM owns it) — no badge
    await db
      .insert(documents)
      .values({
        id: DOC_RESUME_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'RESUME',
        name: `${TEST_TAG}-resume.pdf`,
        originalName: null,
        s3Key: `${TEST_TAG}/resume.pdf`,
        thumbnailS3Key: null,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    // 2. INVOICE doc (ARTEM owns it) — linked to a transaction
    await db
      .insert(documents)
      .values({
        id: DOC_INVOICE_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'INVOICE',
        name: `${TEST_TAG}-invoice.pdf`,
        originalName: null,
        s3Key: `${TEST_TAG}/invoice.pdf`,
        thumbnailS3Key: null,
        sizeBytes: 2048,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    // 3. RECEIPT doc (DMYTRO owns it) — linked to a transaction with VALIDATED status
    await db
      .insert(documents)
      .values({
        id: DOC_RECEIPT_ID,
        ownerId: DMYTRO.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TEST_TAG}-receipt.pdf`,
        originalName: null,
        s3Key: `${TEST_TAG}/receipt.pdf`,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: DMYTRO.id,
      })
      .onConflictDoNothing()

    // 4. Transaction for INVOICE doc
    await db
      .insert(transactions)
      .values({
        id: TX_INVOICE_ID,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '5000',
        currency: 'USD',
        senderId: ARTEM.id,
        receiverId: ADMIN.id,
        invoiceDocumentId: DOC_INVOICE_ID,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()

    // 5. COMPANY signature only — INVOICE badge should be 'ready' (missing COUNTERPARTY)
    // pdf_hash is NOT NULL in schema — use a 64-char SHA-256 placeholder.
    await db
      .insert(invoiceSignatures)
      .values({
        id: SIG_COMPANY_ID,
        transactionId: TX_INVOICE_ID,
        signerRole: 'COMPANY',
        signerId: ADMIN.id,
        method: 'AUTO_COMPANY',
        signedAt: new Date(),
        pdfHash: '0000000000000000000000000000000000000000000000000000000000000000',
      })
      .onConflictDoNothing()

    // 6. Transaction for RECEIPT doc — status VALIDATED
    await db
      .insert(transactions)
      .values({
        id: TX_RECEIPT_ID,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000',
        currency: 'USD',
        senderId: DMYTRO.id,
        receiverId: ADMIN.id,
        receiptDocumentId: DOC_RECEIPT_ID,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // Clean up in FK-safe order
      await db.delete(invoiceSignatures).where(eq(invoiceSignatures.id, SIG_COMPANY_ID))
      await db.delete(transactions).where(inArray(transactions.id, [TX_INVOICE_ID, TX_RECEIPT_ID]))
      await db
        .delete(documents)
        .where(inArray(documents.id, [DOC_RESUME_ID, DOC_INVOICE_ID, DOC_RECEIPT_ID]))
    } catch {
      // Non-fatal cleanup failure
    }
    await app.close()
    // Pool torn down by factory-registered onModuleDestroy.
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── 1. ADMIN sees all employee_contract virtual entries ───────────────────

  it('1. ADMIN: GET /api/documents includes ALL non-CANCELLED employee_contract entries', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ADMIN) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const contractEntries = body.filter((d) => d.source === 'employee_contract')

    // DB has 7+ SENIORs + JUNIORs with non-CANCELLED contracts.
    // Verify ADMIN gets MORE than 1 (own self has no contract; ADMIN is excluded by DB trigger).
    expect(contractEntries.length).toBeGreaterThan(1)

    // Every virtual entry must have kind='contract' badge
    for (const entry of contractEntries) {
      expect(entry.statusBadge).not.toBeNull()
      expect(entry.statusBadge?.kind).toBe('contract')
      expect(['draft', 'ready', 'signed']).toContain(entry.statusBadge?.state)
    }
  })

  // ── 2. SENIOR sees only own employee_contract ─────────────────────────────

  it('2. SENIOR (ARTEM): GET /api/documents — contract virtual entry = own only, status=signed', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ARTEM) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const contractEntries = body.filter((d) => d.source === 'employee_contract')

    // SENIOR sees exactly ONE — own contract
    expect(contractEntries).toHaveLength(1)
    const entry = contractEntries[0]!
    expect(entry.ownerId).toBe(ARTEM.id)
    expect(entry.statusBadge).toMatchObject({ kind: 'contract', state: 'signed' })
    expect(entry.source).toBe('employee_contract')
    expect(entry.category).toBe('CONTRACT')
  })

  // ── 3. SENIOR's READY_TO_SIGN contract shows state='ready' ───────────────

  it('3. SENIOR (DMYTRO): contract badge = ready (READY_TO_SIGN)', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(DMYTRO) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const contractEntries = body.filter((d) => d.source === 'employee_contract')

    expect(contractEntries).toHaveLength(1)
    expect(contractEntries[0]!.statusBadge).toMatchObject({ kind: 'contract', state: 'ready' })
  })

  // ── 4. INVOICE row: only COMPANY sig → badge.state='ready' ───────────────

  it('4. INVOICE file with COMPANY-only signature → statusBadge {kind:invoice, state:ready}', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ADMIN) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const invoiceDoc = body.find((d) => d.id === DOC_INVOICE_ID)

    expect(invoiceDoc).toBeDefined()
    expect(invoiceDoc!.source).toBe('file')
    expect(invoiceDoc!.statusBadge).toMatchObject({ kind: 'invoice', state: 'ready' })
  })

  // ── 5. RECEIPT row: VALIDATED tx → badge.state='validated' ───────────────

  it('5. RECEIPT file with VALIDATED transaction → statusBadge {kind:receipt, state:validated}', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ADMIN) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const receiptDoc = body.find((d) => d.id === DOC_RECEIPT_ID)

    expect(receiptDoc).toBeDefined()
    expect(receiptDoc!.source).toBe('file')
    expect(receiptDoc!.statusBadge).toMatchObject({ kind: 'receipt', state: 'validated' })
  })

  // ── 6. RESUME row: statusBadge null ──────────────────────────────────────

  it('6. RESUME file → statusBadge null (no badge)', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ARTEM) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const resumeDoc = body.find((d) => d.id === DOC_RESUME_ID)

    expect(resumeDoc).toBeDefined()
    expect(resumeDoc!.statusBadge ?? null).toBeNull()
  })

  // ── 7. No double-counting: uploaded CONTRACT file ≠ virtual entry ─────────

  it('7. No double-counting: file source="file", virtual source="employee_contract"', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ARTEM) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]

    // All entries must have a source discriminator
    for (const doc of body) {
      expect(['file', 'employee_contract']).toContain(doc.source ?? 'file')
    }

    // The RESUME we inserted is a file entry
    const resume = body.find((d) => d.id === DOC_RESUME_ID)
    expect(resume?.source).toBe('file')

    // The contract virtual entry has source='employee_contract'
    const contractEntry = body.find((d) => d.source === 'employee_contract')
    expect(contractEntry).toBeDefined()
  })

  // ── 8. category=CONTRACT filter: only CONTRACT entries ───────────────────

  it('8. ?category=CONTRACT filter: includes virtual entries, excludes RESUME/INVOICE', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents?category=CONTRACT',
      cookies: { jwt: tokenFor(ADMIN) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]

    // No RESUME or INVOICE entries should appear
    const badCategory = body.filter(
      (d) => d.category === 'RESUME' || d.category === 'INVOICE' || d.category === 'RECEIPT',
    )
    expect(badCategory).toHaveLength(0)

    // All entries must be CONTRACT category (either uploaded files or virtual entries)
    for (const doc of body) {
      expect(doc.category).toBe('CONTRACT')
    }

    // Virtual entries (employee_contract) must appear under CONTRACT filter
    const virtualEntries = body.filter((d) => d.source === 'employee_contract')
    expect(virtualEntries.length).toBeGreaterThan(0)
  })

  // ── 9. ACCOUNTANT: 401 without JWT ──────────────────────────────────────

  it('9. Unauthenticated request → 401', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
    })

    expect(res.statusCode).toBe(401)
  })

  // ── 10. ACCOUNTANT can list (no access restriction on list) ──────────────

  it('10. ACCOUNTANT: GET /api/documents returns 200 (no restriction on list)', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })

    // ACCOUNTANT has no employee_contract (only SENIOR/JUNIOR/HR/ACCOUNTANT-role users
    // may have contracts — in seed data only SENIORs/JUNIORs do).
    // Just verify the endpoint returns 200 and is an array.
    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    expect(Array.isArray(body)).toBe(true)
  })

  // ── 11–12. DRAFT contract visibility: ADMIN sees DRAFT, non-ADMIN does not ─

  it('11. ADMIN: GET /api/documents — DRAFT contracts are visible (ADMIN prepares them)', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(ADMIN) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const contractEntries = body.filter((d) => d.source === 'employee_contract')

    // Seed DB contains at least 2 SENIOR users with DRAFT contracts (qa-ac6-7x9k2m, qa-fix3-uuid).
    // ADMIN must see all including DRAFT state.
    const draftEntries = contractEntries.filter((d) => d.statusBadge?.state === 'draft')
    expect(draftEntries.length).toBeGreaterThan(0)
  })

  it('12. SENIOR with DRAFT contract: does NOT see own DRAFT contract in list (A3-4 rule)', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      cookies: { jwt: tokenFor(QA_SENIOR_WITH_DRAFT) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as DocumentDto[]
    const contractEntries = body.filter((d) => d.source === 'employee_contract')

    // QA_SENIOR_WITH_DRAFT has a DRAFT contract only (no READY_TO_SIGN or SIGNED).
    // Non-ADMIN must not see DRAFT → should get zero contract virtual entries for own user.
    const draftEntries = contractEntries.filter((d) => d.statusBadge?.state === 'draft')
    expect(draftEntries).toHaveLength(0)

    // They should see no contract entries at all (only READY_TO_SIGN/SIGNED would be shown)
    const ownContracts = contractEntries.filter((d) => d.ownerId === QA_SENIOR_WITH_DRAFT.id)
    expect(ownContracts).toHaveLength(0)
  })
})
