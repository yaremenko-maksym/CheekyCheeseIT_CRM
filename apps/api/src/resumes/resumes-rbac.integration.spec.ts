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
import {
  EMPTY_RESUME_CONTENT,
  RESUME_DOCX_MIME,
  type ResumeContent,
  type SessionUser,
} from '@crm/shared'
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

  // ── R-INT-10: whoever finishes last must NOT automatically win ─────────────

  /**
   * The extraction's terminal write is the one place where a slow background
   * job can silently overwrite something a human just decided. These tests pin
   * BOTH directions: the stale run must lose, and the current run must win.
   *
   * MUTATION: relax `ownedByRun` back to `eq(seniorResumes.id, resumeId)` —
   * "R-INT-10a" and "R-INT-10b" go red together.
   */
  describe('R-INT-10. an extraction may only finish the row it still owns', () => {
    /** A promise this test resolves by hand, so "while the model runs" is real. */
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }

    const extracted = (summary: string) => ({
      ok: true as const,
      content: { ...EMPTY_RESUME_CONTENT, summary },
      tokensUsed: 7,
    })

    async function waitForStatus(status: string): Promise<void> {
      await vi.waitFor(async () => {
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        expect(row?.status).toBe(status)
      })
    }

    it('R-INT-10a. a manual save during extraction is not overwritten by the model', async () => {
      if (!dbAvailable) return
      const model = deferred<ReturnType<typeof extracted>>()
      ai.extractStructure.mockImplementationOnce(() => model.promise)

      await service.ingestText(session(HR_USER), SENIOR_A.id, 'Иван Петров, синьор. '.repeat(20))
      await waitForStatus('RUNNING')

      // HR types the resume by hand while the model is still thinking.
      const saved = await service.updateContent(session(HR_USER), SENIOR_A.id, {
        ...EMPTY_RESUME_CONTENT,
        summary: 'написано человеком',
      })
      expect(saved.resume?.status).toBe('READY')

      // ...and only now does the model answer, with something else entirely.
      model.resolve(extracted('придумано моделью'))
      await vi.waitFor(() => expect(ai.extractStructure).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))

      const after = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(after.resume?.content.summary).toBe('написано человеком')
      expect(after.resume?.status).toBe('READY')
      // The human's save is still the latest version — the run wrote nothing.
      expect(after.resume?.version).toBe(saved.resume?.version)
    })

    it('R-INT-10b. a superseded upload loses to the newer one, whichever finishes first', async () => {
      if (!dbAvailable) return
      const first = deferred<ReturnType<typeof extracted>>()
      const second = deferred<ReturnType<typeof extracted>>()
      ai.extractStructure.mockImplementationOnce(() => first.promise)
      ai.extractStructure.mockImplementationOnce(() => second.promise)

      await service.ingestText(session(HR_USER), SENIOR_A.id, 'Первый вариант резюме. '.repeat(20))
      await waitForStatus('RUNNING')

      // A second submission arrives while the first is still running.
      await service.ingestText(session(HR_USER), SENIOR_A.id, 'Второй вариант резюме. '.repeat(20))
      await waitForStatus('RUNNING')

      // The NEWER run finishes first, the older one second — the order that
      // used to hand victory to the stale attempt.
      second.resolve(extracted('второй файл'))
      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(dto.resume?.status).toBe('READY')
      })
      first.resolve(extracted('первый файл — уже удалён'))
      await new Promise((r) => setTimeout(r, 50))

      const after = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(after.resume?.content.summary).toBe('второй файл')
    })

    /**
     * `version` is the field task-resume-tailoring reads to notice that a
     * tailored variant was built on a base that has since changed. An
     * extraction REPLACES the content, so it has to move that field — writing
     * new content under an unchanged version is precisely the case the
     * follow-up task would fail to detect.
     *
     * MUTATION: drop the `version: sql\`version + 1\`` line — this goes red.
     */
    it('R-INT-10c. a completed extraction bumps version like any other content change', async () => {
      if (!dbAvailable) return
      ai.extractStructure.mockResolvedValueOnce(extracted('распознано моделью'))
      const before = await service.getForUser(session(HR_USER), SENIOR_A.id)

      await service.ingestText(session(HR_USER), SENIOR_A.id, 'Иван Петров, синьор. '.repeat(20))
      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(dto.resume?.status).toBe('READY')
      })

      const after = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(after.resume?.content.summary).toBe('распознано моделью')
      expect(after.resume?.version).toBe((before.resume?.version ?? 0) + 1)
    })
  })

  // ── R-INT-11: the abandoned-QUEUED half of the sweep ──────────────────────

  /**
   * `requeueAbandoned` is the ONLY path in this module that reads the file back
   * out of storage, and until now nothing exercised it — the stuck-RUNNING half
   * was pinned and this half was not, so "the sweep is covered" was half true.
   *
   * MUTATION: make `requeueAbandoned` return 0 without doing anything — all
   * three tests below go red.
   */
  describe('R-INT-11. abandoned QUEUED rows are re-driven from storage', () => {
    const staleTime = () => new Date(Date.now() - STUCK_EXTRACTION_TIMEOUT_MS - 60_000)

    it('R-INT-11a. re-reads the stored source and finishes the extraction', async () => {
      if (!dbAvailable) return
      const docx = buildDocx(['Иван Петров', 'Синьор-разработчик в Acme, 2019–2024'])
      s3.getObject.mockResolvedValueOnce(docx)
      ai.extractStructure.mockResolvedValueOnce({
        ok: true,
        content: { ...EMPTY_RESUME_CONTENT, summary: 'поднято подметателем' },
        tokensUsed: 11,
      })

      // A container died between "row marked QUEUED" and "detached run began".
      await dbSvc.db
        .update(seniorResumes)
        .set({
          status: 'QUEUED',
          sourceS3Key: 'senior-resumes/abandoned.docx',
          sourceMimeType: RESUME_DOCX_MIME,
          extractionRunId: null,
          updatedAt: staleTime(),
        })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      const handled = await service.requeueAbandoned()
      expect(handled).toBeGreaterThanOrEqual(1)
      expect(s3.getObject).toHaveBeenCalledWith('senior-resumes/abandoned.docx')

      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(dto.resume?.status).toBe('READY')
      })
      const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(dto.resume?.content.summary).toBe('поднято подметателем')
    })

    it('R-INT-11b. a stale QUEUED row with no stored file is failed, not left spinning', async () => {
      if (!dbAvailable) return
      s3.getObject.mockClear()
      await dbSvc.db
        .update(seniorResumes)
        .set({
          status: 'QUEUED',
          sourceS3Key: null,
          sourceMimeType: null,
          extractionRunId: null,
          updatedAt: staleTime(),
        })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      expect(await service.requeueAbandoned()).toBeGreaterThanOrEqual(1)
      expect(s3.getObject).not.toHaveBeenCalled()

      const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(dto.resume?.status).toBe('FAILED')
      expect(dto.resume?.errorCode).toBe('STALLED')
      expect(dto.resume?.errorMessage).toMatch(/вручную/i)
    })

    it('R-INT-11c. a QUEUED row still inside its deadline is left alone', async () => {
      if (!dbAvailable) return
      s3.getObject.mockClear()
      await dbSvc.db
        .update(seniorResumes)
        .set({ status: 'QUEUED', extractionRunId: null, updatedAt: new Date() })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      await service.requeueAbandoned()
      expect(s3.getObject).not.toHaveBeenCalled()

      const [row] = await dbSvc.db
        .select()
        .from(seniorResumes)
        .where(eq(seniorResumes.userId, SENIOR_A.id))
      expect(row?.status).toBe('QUEUED')

      await dbSvc.db
        .update(seniorResumes)
        .set({ status: 'READY' })
        .where(eq(seniorResumes.userId, SENIOR_A.id))
    })

    /**
     * A storage failure must not leak its wording to the screen: the message
     * lands in `errorMessage`, which the resume panel renders verbatim. Bucket
     * names, key paths and endpoint hosts are not user-facing copy.
     */
    it('R-INT-11d. a storage failure surfaces OUR wording, not the client’s', async () => {
      if (!dbAvailable) return
      s3.getObject.mockRejectedValueOnce(
        new Error('NoSuchKey: crm-prod-bucket/senior-resumes/x at https://r2.internal'),
      )
      await dbSvc.db
        .update(seniorResumes)
        .set({
          status: 'QUEUED',
          sourceS3Key: 'senior-resumes/gone.docx',
          sourceMimeType: RESUME_DOCX_MIME,
          extractionRunId: null,
          updatedAt: staleTime(),
        })
        .where(eq(seniorResumes.userId, SENIOR_A.id))

      await service.requeueAbandoned()
      await vi.waitFor(async () => {
        const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(dto.resume?.status).toBe('FAILED')
      })

      const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
      expect(dto.resume?.errorMessage).not.toMatch(/NoSuchKey|bucket|https?:/i)
      expect(dto.resume?.errorMessage).toMatch(/вставьте текст/i)
    })
  })
})
