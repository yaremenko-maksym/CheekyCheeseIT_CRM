/**
 * task-resume-base AC6 — resume RBAC against a REAL Postgres.
 *
 * WHY a real-DB spec and not just the pure `canAccessResume` unit test:
 *   the unit test proves the RULE; this proves the WIRING. A mocked service
 *   cannot show that `SeniorResumesService` actually consults the rule on every
 *   endpoint (read / write / upload / paste / source download / PDF) — and
 *   "the guard exists but one endpoint forgot to call it" is precisely the bug
 *   class this repo keeps hitting (feedback_mocked_e2e_guards, 3 recurrences).
 *
 * NEGATIVE CASES USE AN EXISTING FOREIGN ID. Every "must be denied" assertion
 * targets SENIOR_B — a senior who really exists and really has a resume row
 * with recognisable content. A test that pokes a fabricated uuid passes even
 * with the check deleted (there is no row to leak), so it proves nothing. Here,
 * deleting the comparison in `canAccessResume` makes SENIOR_A read SENIOR_B's
 * actual content and these tests go red. The mutation was run — see the PR body.
 *
 * COVERED (one per row of the §4 table, in both directions):
 *   R-INT-1  ADMIN      -> foreign senior : read + write OK
 *   R-INT-2  HR         -> foreign senior : read + write OK
 *   R-INT-3  SENIOR     -> own            : read + write OK
 *   R-INT-4  SENIOR     -> OTHER senior   : 403 on every endpoint
 *   R-INT-5  JUNIOR     -> foreign senior : 403
 *   R-INT-6  ACCOUNTANT -> foreign senior : 403
 *   R-INT-7  DROP       -> foreign senior : 403
 *   R-INT-8  non-SENIOR target             : 404 (resume is a senior artefact)
 *   R-INT-9  version bump + state machine (QUEUED -> READY / FAILED, sweep)
 *
 * SEED namespace: 7b3d91c4-2e5f-** (unique to this suite)
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL is unreachable (CI unit
 * job) -> every test returns early and the suite stays green.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_CONTENT, type ResumeContent, type SessionUser } from '@crm/shared'
import * as schema from '../database/schema'
import { seniorResumes, users, type User } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { SeniorResumesService, STUCK_EXTRACTION_TIMEOUT_MS } from './resumes.service'
import { buildDocx, buildPdfWithText } from '../test/resume-fixtures'

// ── Personas ────────────────────────────────────────────────────────────────
const SENIOR_A = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000001',
  email: 'resume-senior-a@test.spec',
  displayName: 'Сеньор Первый',
  role: 'SENIOR',
})
const SENIOR_B = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000002',
  email: 'resume-senior-b@test.spec',
  displayName: 'Сеньор Второй',
  role: 'SENIOR',
})
const ADMIN_USER = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000003',
  email: 'resume-admin@test.spec',
  displayName: 'Админ',
  role: 'ADMIN',
})
const HR_USER = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000004',
  email: 'resume-hr@test.spec',
  displayName: 'Эйчар',
  role: 'HR',
})
const JUNIOR_USER = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000005',
  email: 'resume-junior@test.spec',
  displayName: 'Джун',
  role: 'JUNIOR',
})
const ACCOUNTANT_USER = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000006',
  email: 'resume-accountant@test.spec',
  displayName: 'Бухгалтер',
  role: 'ACCOUNTANT',
})
const DROP_USER = makeRow({
  id: '7b3d91c4-2e5f-4a00-aa00-000000000007',
  email: 'resume-drop@test.spec',
  displayName: 'Дроп',
  role: 'DROP',
})

const TEST_USER_IDS = [
  SENIOR_A.id,
  SENIOR_B.id,
  ADMIN_USER.id,
  HR_USER.id,
  JUNIOR_USER.id,
  ACCOUNTANT_USER.id,
  DROP_USER.id,
]

/** SENIOR_B's real, recognisable resume — the thing a broken check would leak. */
const SENIOR_B_SECRET = 'СЕКРЕТНОЕ РЕЗЮМЕ ВТОРОГО СЕНЬОРА'
const SENIOR_B_CONTENT: ResumeContent = { ...EMPTY_RESUME_CONTENT, summary: SENIOR_B_SECRET }

function makeRow(overrides: Partial<User>): User {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'x@y.z',
    displayName: 'X',
    role: 'JUNIOR',
    googleId: null,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    legalFullName: null,
    registrationAddress: null,
    adminNote: null,
    monthlySalary: null,
    salaryCurrency: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User
}

function session(user: User): SessionUser {
  return { id: user.id, email: user.email, role: user.role } as SessionUser
}

describe('Senior resume RBAC — real DB integration (task-resume-base AC6)', () => {
  let dbAvailable = true
  let pool: Pool
  let dbSvc: DatabaseService
  let service: SeniorResumesService
  let s3: {
    upload: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    getObject: ReturnType<typeof vi.fn>
    getPresignedDownloadUrl: ReturnType<typeof vi.fn>
  }
  let ai: { extractStructure: ReturnType<typeof vi.fn> }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[resumes-rbac integration] SKIPPED — no DB at DATABASE_URL (CI unit job)')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    // S3 and the model are stubbed: this suite is about ACCESS + STATE, and
    // the task forbids live Cloudflare calls in tests.
    s3 = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getObject: vi.fn(),
      getPresignedDownloadUrl: vi
        .fn()
        .mockResolvedValue({ url: 'https://example.invalid/s', expiresAt: '2026-01-01T00:00:00Z' }),
    }
    ai = {
      extractStructure: vi.fn().mockResolvedValue({
        ok: true,
        content: { ...EMPTY_RESUME_CONTENT, summary: 'извлечено' },
        tokensUsed: 42,
      }),
    }

    service = new SeniorResumesService(
      dbSvc,
      s3 as never,
      ai as never,
      // Real extraction service — the file fixtures are real PDFs/DOCX.
      new (await import('./resume-text-extraction.service')).ResumeTextExtractionService(),
      { generateResumePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')) } as never,
    )

    await db
      .insert(users)
      .values(
        [SENIOR_A, SENIOR_B, ADMIN_USER, HR_USER, JUNIOR_USER, ACCOUNTANT_USER, DROP_USER].map(
          (u) => ({ ...u, googleId: `test-resume-rbac-${u.id}` }),
        ),
      )
      .onConflictDoNothing()

    // SENIOR_B has a REAL resume with recognisable content — see the header:
    // this is what a deleted access check would hand to SENIOR_A.
    await db
      .insert(seniorResumes)
      .values({ userId: SENIOR_B.id, content: SENIOR_B_CONTENT })
      .onConflictDoNothing({ target: seniorResumes.userId })
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db.delete(seniorResumes).where(inArray(seniorResumes.userId, TEST_USER_IDS))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — never mask test results.
    }
    await pool?.end()
  }, 15_000)

  // ── R-INT-1 / R-INT-2: ADMIN and HR — full access to a foreign resume ──────

  it('R-INT-1. ADMIN reads and writes a foreign senior resume', async () => {
    if (!dbAvailable) return
    const read = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)
    expect(read.resume?.content.summary).toBe(SENIOR_B_SECRET)
    expect(read.canEdit).toBe(true)

    const written = await service.updateContent(session(ADMIN_USER), SENIOR_B.id, {
      ...SENIOR_B_CONTENT,
      skills: ['админ правил'],
    })
    expect(written.resume?.content.skills).toEqual(['админ правил'])
  })

  it('R-INT-2. HR reads and writes a foreign senior resume', async () => {
    if (!dbAvailable) return
    const read = await service.getForUser(session(HR_USER), SENIOR_B.id)
    expect(read.resume?.content.summary).toBe(SENIOR_B_SECRET)

    const written = await service.updateContent(session(HR_USER), SENIOR_B.id, {
      ...SENIOR_B_CONTENT,
      skills: ['hr правил'],
    })
    expect(written.resume?.content.skills).toEqual(['hr правил'])
  })

  // ── R-INT-3: SENIOR — own resume ──────────────────────────────────────────

  it('R-INT-3. SENIOR reads and writes their OWN resume', async () => {
    if (!dbAvailable) return
    const saved = await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
      ...EMPTY_RESUME_CONTENT,
      summary: 'моё резюме',
    })
    expect(saved.resume?.content.summary).toBe('моё резюме')
    expect(saved.canEdit).toBe(true)

    const read = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
    expect(read.resume?.content.summary).toBe('моё резюме')
  })

  // ── R-INT-4: SENIOR -> ANOTHER SENIOR (existing id!) — denied everywhere ───

  describe('R-INT-4. SENIOR A must not reach SENIOR B (an EXISTING senior with a real resume)', () => {
    it('read is denied', async () => {
      if (!dbAvailable) return
      await expect(service.getForUser(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('write is denied', async () => {
      if (!dbAvailable) return
      await expect(
        service.updateContent(session(SENIOR_A), SENIOR_B.id, {
          ...EMPTY_RESUME_CONTENT,
          summary: 'подменено',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)

      // And SENIOR B's stored content is untouched.
      const [row] = await dbSvc.db
        .select()
        .from(seniorResumes)
        .where(eq(seniorResumes.userId, SENIOR_B.id))
      expect((row?.content as ResumeContent).summary).toBe(SENIOR_B_SECRET)
    })

    it('file upload is denied', async () => {
      if (!dbAvailable) return
      await expect(
        service.uploadSource(session(SENIOR_A), SENIOR_B.id, {
          buffer: await buildPdfWithText(['x']),
          mimetype: 'application/pdf',
          originalname: 'cv.pdf',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(s3.upload).not.toHaveBeenCalled()
    })

    it('pasted text is denied', async () => {
      if (!dbAvailable) return
      await expect(
        service.ingestText(session(SENIOR_A), SENIOR_B.id, 'a'.repeat(200)),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('source download is denied', async () => {
      if (!dbAvailable) return
      await expect(
        service.getSourceDownload(session(SENIOR_A), SENIOR_B.id),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled()
    })

    it('PDF export is denied', async () => {
      if (!dbAvailable) return
      await expect(service.generatePdf(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
  })

  // ── R-INT-5..7: roles with no resume surface at all ───────────────────────

  it('R-INT-5. JUNIOR is denied a foreign senior resume', async () => {
    if (!dbAvailable) return
    await expect(service.getForUser(session(JUNIOR_USER), SENIOR_B.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('R-INT-6. ACCOUNTANT is denied a foreign senior resume', async () => {
    if (!dbAvailable) return
    await expect(service.getForUser(session(ACCOUNTANT_USER), SENIOR_B.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('R-INT-7. DROP is denied a foreign senior resume', async () => {
    if (!dbAvailable) return
    await expect(service.getForUser(session(DROP_USER), SENIOR_B.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('R-INT-5b. JUNIOR is denied even their OWN id (no resume surface for the role)', async () => {
    if (!dbAvailable) return
    await expect(service.getForUser(session(JUNIOR_USER), JUNIOR_USER.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  // ── Empty state still carries the permission signal ──────────────────────

  it('a senior with NO resume row yet still gets canEdit=true (so the upload UI shows)', async () => {
    if (!dbAvailable) return
    // SENIOR_A's row may exist from an earlier test in this file — drop it so
    // this exercises the genuine "never created" path.
    await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_A.id))

    const own = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
    expect(own.resume).toBeNull()
    expect(own.canEdit).toBe(true)

    const asAdmin = await service.getForUser(session(ADMIN_USER), SENIOR_A.id)
    expect(asAdmin.resume).toBeNull()
    expect(asAdmin.canEdit).toBe(true)
  })

  // ── R-INT-8: the resource only exists for SENIOR targets ─────────────────

  it('R-INT-8. ADMIN asking for a JUNIOR resume gets 404 (resume is a senior artefact)', async () => {
    if (!dbAvailable) return
    await expect(service.getForUser(session(ADMIN_USER), JUNIOR_USER.id)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  // ── R-INT-9: state machine + version ─────────────────────────────────────

  describe('R-INT-9. extraction state machine (AC3)', () => {
    it('upload answers immediately with QUEUED and reaches READY once the model returns', async () => {
      if (!dbAvailable) return
      const queued = await service.uploadSource(session(SENIOR_A), SENIOR_A.id, {
        buffer: buildDocx(['Иван Петров', 'Синьор-разработчик в Acme, 2019–2024, TypeScript']),
        mimetype: 'application/msword', // deliberately WRONG — bytes win
        originalname: 'резюме.docx',
      })
      // The HTTP-facing return value is the pre-extraction state.
      expect(queued.resume?.status).toBe('QUEUED')
      expect(queued.resume?.hasSourceFile).toBe(true)
      expect(queued.resume?.sourceFileName).toBe('резюме.docx')

      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
        expect(dto.resume?.status).toBe('READY')
      })
      const done = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
      expect(done.resume?.content.summary).toBe('извлечено')
      // The text handed to the model really came out of the DOCX.
      expect(String(ai.extractStructure.mock.calls.at(-1)?.[0])).toContain('Иван Петров')
    })

    it('a text-layer-less file ends in FAILED/NO_TEXT with actionable copy, not silence', async () => {
      if (!dbAvailable) return
      const { buildEmptyPdf } = await import('../test/resume-fixtures')
      await service.uploadSource(session(SENIOR_A), SENIOR_A.id, {
        buffer: await buildEmptyPdf(1),
        mimetype: 'application/pdf',
        originalname: 'scan.pdf',
      })

      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
        expect(dto.resume?.status).toBe('FAILED')
      })
      const failed = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
      expect(failed.resume?.errorCode).toBe('NO_TEXT')
      expect(failed.resume?.errorMessage).toMatch(/вставьте текст/i)
    })

    it('a QUOTA_EXCEEDED model result is persisted with its reset time (AC5)', async () => {
      if (!dbAvailable) return
      const resetAt = '2026-08-08T00:00:00.000Z'
      ai.extractStructure.mockResolvedValueOnce({
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: 'Исчерпан суточный лимит бесплатных запросов к ИИ.',
        quotaResetsAt: resetAt,
        tokensUsed: null,
      })
      await service.ingestText(session(SENIOR_A), SENIOR_A.id, 'Иван Петров, синьор. '.repeat(20))

      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
        expect(dto.resume?.status).toBe('FAILED')
      })
      const failed = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
      expect(failed.resume?.errorCode).toBe('QUOTA_EXCEEDED')
      expect(failed.resume?.quotaResetsAt).toBe(resetAt)

      // AC5: manual completion still works while the quota is exhausted, and
      // saving clears the banner.
      const manual = await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
        ...EMPTY_RESUME_CONTENT,
        summary: 'заполнено руками',
      })
      expect(manual.resume?.status).toBe('READY')
      expect(manual.resume?.errorCode).toBeNull()
      expect(manual.resume?.quotaResetsAt).toBeNull()
    })

    it('version grows by exactly one per save', async () => {
      if (!dbAvailable) return
      const before = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
      const after = await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
        ...EMPTY_RESUME_CONTENT,
        summary: 'ещё правка',
      })
      expect(after.resume?.version).toBe((before.resume?.version ?? 0) + 1)
      expect(after.resume?.updatedByUserId).toBe(SENIOR_A.id)
      expect(after.resume?.updatedByName).toBe(SENIOR_A.displayName)
    })

    it('sweeps a row abandoned in RUNNING into FAILED/STALLED', async () => {
      if (!dbAvailable) return
      const stale = new Date(Date.now() - STUCK_EXTRACTION_TIMEOUT_MS - 60_000)
      await dbSvc.db
        .update(seniorResumes)
        .set({ status: 'RUNNING', extractionStartedAt: stale })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      const swept = await service.sweepStuckExtractions()
      expect(swept).toBeGreaterThanOrEqual(1)

      const dto = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
      expect(dto.resume?.status).toBe('FAILED')
      expect(dto.resume?.errorCode).toBe('STALLED')
    })

    it('does NOT sweep a RUNNING row that is still within its deadline', async () => {
      if (!dbAvailable) return
      await dbSvc.db
        .update(seniorResumes)
        .set({ status: 'RUNNING', extractionStartedAt: new Date() })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      await service.sweepStuckExtractions()

      const [row] = await dbSvc.db
        .select()
        .from(seniorResumes)
        .where(eq(seniorResumes.userId, SENIOR_A.id))
      expect(row?.status).toBe('RUNNING')

      // Leave the row in a terminal state for any later suite.
      await dbSvc.db
        .update(seniorResumes)
        .set({ status: 'READY', extractionStartedAt: null })
        .where(eq(seniorResumes.userId, SENIOR_A.id))
    })

    it('AC2: a renamed executable is rejected before anything is stored', async () => {
      if (!dbAvailable) return
      s3.upload.mockClear()
      await expect(
        service.uploadSource(session(SENIOR_A), SENIOR_A.id, {
          buffer: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]),
          mimetype: 'application/pdf',
          originalname: 'резюме.pdf',
        }),
      ).rejects.toThrow(/PDF и DOCX/)
      expect(s3.upload).not.toHaveBeenCalled()
    })
  })
})
