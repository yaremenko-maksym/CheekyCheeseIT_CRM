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
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, CI unit job). A DATABASE_URL that IS set but
 * unreachable throws in beforeAll (reports FAILED) — neither case can look
 * like "passed" with zero assertions.
 */
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  RESUME_DOCX_MIME,
  type ResumeContent,
  type ResumeFacts,
  type SessionUser,
} from '@crm/shared'
import * as schema from '../database/schema'
import { seniorResumes, teamMembers, teams, users, type User } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import {
  SeniorResumesService,
  STUCK_EXTRACTION_TIMEOUT_MS,
  STUCK_RENDER_TIMEOUT_MS,
} from './resumes.service'
import { ResumeVerificationService } from './verification/resume-verification.service'
import { buildDocx, buildPdfWithText } from '../test/resume-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'

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

/** A model result whose marker survives into the facts (as an experience company). */
function extractedContent(marker: string): ResumeContent {
  return {
    ...EMPTY_RESUME_CONTENT,
    summary: marker,
    experience: [{ company: marker, role: 'Engineer', period: '', bullets: [] }],
  }
}

/** The marker an extraction left in the facts. */
function factsMarker(response: { resume: { facts: ResumeFacts } | null }): string | undefined {
  return response.resume?.facts.experience[0]?.company
}

function session(user: User): SessionUser {
  return { id: user.id, email: user.email, role: user.role } as SessionUser
}

describe.skipIf(!hasDatabaseUrl())(
  'Senior resume RBAC — real DB integration (task-resume-base AC6)',
  () => {
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
    let typst: { fingerprint: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> }
    /** The check run is Task 14's own spec: here a submit only queues it. */
    const runner = { run: vi.fn().mockResolvedValue(undefined) }

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[resumes-rbac integration] FAILED — no DB at DATABASE_URL (CI unit job)')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
        pool,
        db,
      })

      // S3 and the model are stubbed: this suite is about ACCESS + STATE, and
      // the task forbids live Cloudflare calls in tests.
      s3 = {
        upload: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        getObject: vi.fn(),
        getPresignedDownloadUrl: vi.fn().mockResolvedValue({
          url: 'https://example.invalid/s',
          expiresAt: '2026-01-01T00:00:00Z',
        }),
      }
      ai = {
        extractStructure: vi.fn().mockResolvedValue({
          ok: true,
          content: extractedContent('извлечено'),
          tokensUsed: 42,
        }),
      }

      // The Typst renderer is stubbed, deliberately. This suite is about ACCESS
      // and STATE; spawning a typesetter per case would add seconds and a system
      // dependency to a DB test that asserts neither. The real binary is exercised
      // in resume-typst.service.spec.ts and the responsiveness spec.
      //
      // `fingerprint` is a real (if trivial) function of the input rather than a
      // constant: the service decides PDF freshness by comparing fingerprints, so
      // a stub returning the same string for everything would make every stored
      // PDF look permanently current and hide exactly the bug this stub could
      // otherwise cause.
      typst = {
        fingerprint: vi.fn((input: unknown) =>
          createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        ),
        render: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
      }

      service = new SeniorResumesService(
        dbSvc,
        s3 as never,
        ai as never,
        // Real extraction service — the file fixtures are real PDFs/DOCX.
        new (await import('./resume-text-extraction.service')).ResumeTextExtractionService(),
        typst as never,
        new ResumeVerificationService(dbSvc, s3 as never, runner as never),
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

    /**
     * Let detached work land, THEN forget it happened.
     *
     * Saving content now queues a render, and that render uploads a PDF — so a
     * write in one test adds `s3.upload` calls that arrive after it has finished.
     * Several assertions here are of the form "a denied request did no work", and
     * they must mean "this request", not "nothing since the suite began".
     *
     * The sleep is the load-bearing half: clearing without waiting only moves the
     * stray call into the NEXT test, which is how a suite acquires a flake that
     * reproduces once a fortnight.
     */
    beforeEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      s3.upload.mockClear()
      s3.delete.mockClear()
      s3.getObject.mockClear()
      s3.getPresignedDownloadUrl.mockClear()
      ai.extractStructure.mockClear()
      typst.render.mockClear()
      typst.fingerprint.mockClear()
    })

    afterAll(async () => {
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
        await expect(service.getForUser(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
      })

      it('write is denied', async () => {
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
        await expect(
          service.ingestText(session(SENIOR_A), SENIOR_B.id, 'a'.repeat(200)),
        ).rejects.toBeInstanceOf(ForbiddenException)
      })

      it('source download is denied', async () => {
        await expect(
          service.getSourceDownload(session(SENIOR_A), SENIOR_B.id),
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled()
      })

      it('PDF export is denied', async () => {
        await expect(service.getRenderedPdf(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
        // Denied BEFORE any render is queued — a 403 must not cost CPU.
        expect(typst.render).not.toHaveBeenCalled()
      })

      it('changing the layout of a foreign resume is denied', async () => {
        await expect(
          service.updateLayout(session(SENIOR_A), SENIOR_B.id, DEFAULT_RESUME_LAYOUT),
        ).rejects.toBeInstanceOf(ForbiddenException)
      })
    })

    // ── R-INT-5..7: roles with no resume surface at all ───────────────────────

    it('R-INT-5. JUNIOR is denied a foreign senior resume', async () => {
      await expect(service.getForUser(session(JUNIOR_USER), SENIOR_B.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('R-INT-6. ACCOUNTANT is denied a foreign senior resume', async () => {
      await expect(
        service.getForUser(session(ACCOUNTANT_USER), SENIOR_B.id),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('R-INT-7. DROP is denied a foreign senior resume', async () => {
      await expect(service.getForUser(session(DROP_USER), SENIOR_B.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('R-INT-5b. JUNIOR is denied even their OWN id (no resume surface for the role)', async () => {
      await expect(service.getForUser(session(JUNIOR_USER), JUNIOR_USER.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    // ── Empty state still carries the permission signal ──────────────────────

    it('a senior with NO resume row yet still gets canEdit=true (so the upload UI shows)', async () => {
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
      await expect(service.getForUser(session(ADMIN_USER), JUNIOR_USER.id)).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })

    // ── R-INT-9: state machine + version ─────────────────────────────────────

    describe('R-INT-9. extraction state machine (AC3)', () => {
      it('upload answers immediately with QUEUED and reaches READY once the model returns', async () => {
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
        expect(factsMarker(done)).toBe('извлечено')
        // The text handed to the model really came out of the DOCX.
        expect(String(ai.extractStructure.mock.calls.at(-1)?.[0])).toContain('Иван Петров')
      })

      it('a text-layer-less file ends in FAILED/NO_TEXT with actionable copy, not silence', async () => {
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
        content: extractedContent(summary),
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
        const first = deferred<ReturnType<typeof extracted>>()
        const second = deferred<ReturnType<typeof extracted>>()
        ai.extractStructure.mockImplementationOnce(() => first.promise)
        ai.extractStructure.mockImplementationOnce(() => second.promise)

        await service.ingestText(
          session(HR_USER),
          SENIOR_A.id,
          'Первый вариант резюме. '.repeat(20),
        )
        await waitForStatus('RUNNING')

        // A second submission arrives while the first is still running.
        await service.ingestText(
          session(HR_USER),
          SENIOR_A.id,
          'Второй вариант резюме. '.repeat(20),
        )
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
        expect(factsMarker(after)).toBe('второй файл')
      })

      /**
       * MED / cost. Discarding the loser's RESULT was only half the problem: the
       * loser had already been PAID for.
       *
       * The supersede has to happen while the run is still LOADING (reading the
       * file, extracting its text) — that is the window the fix covers, and the
       * one a real second upload lands in. Superseding after the model call has
       * already gone out proves nothing: those tokens are spent either way.
       *
       * MUTATION: delete the `stillOwnsRun` check before `ai.extractStructure`
       * and this goes red — the model is called twice for one usable answer.
       */
      it('R-INT-10d. a run superseded while loading never reaches the model', async () => {
        ai.extractStructure.mockClear()
        ai.extractStructure.mockResolvedValue(extracted('победитель'))

        // Park a row in QUEUED and drive it by hand, so the slow step is LOADING.
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        const resumeId = row?.id as string
        await dbSvc.db
          .update(seniorResumes)
          .set({ status: 'QUEUED', extractionRunId: null })
          .where(eq(seniorResumes.id, resumeId))

        const slowLoad = deferred<string>()
        const stale = service.runExtraction(resumeId, () => slowLoad.promise)
        await waitForStatus('RUNNING')
        expect(ai.extractStructure).not.toHaveBeenCalled()

        // A newer submission takes the row while the old run is still loading.
        await service.ingestText(session(HR_USER), SENIOR_A.id, 'Новый вариант резюме. '.repeat(20))
        await vi.waitFor(() => expect(ai.extractStructure).toHaveBeenCalledTimes(1))

        // Now the stale run finishes loading — and must stop before spending.
        slowLoad.resolve('Текст устаревшего прогона. '.repeat(20))
        await stale
        await new Promise((r) => setTimeout(r, 50))

        expect(ai.extractStructure).toHaveBeenCalledTimes(1)
        ai.extractStructure.mockResolvedValue({
          ok: true,
          content: extractedContent('извлечено'),
          tokensUsed: 42,
        })
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
        ai.extractStructure.mockResolvedValueOnce(extracted('распознано моделью'))
        const before = await service.getForUser(session(HR_USER), SENIOR_A.id)

        await service.ingestText(session(HR_USER), SENIOR_A.id, 'Иван Петров, синьор. '.repeat(20))
        await vi.waitFor(async () => {
          const dto = await service.getForUser(session(HR_USER), SENIOR_A.id)
          expect(dto.resume?.status).toBe('READY')
        })

        const after = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(factsMarker(after)).toBe('распознано моделью')
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
        const docx = buildDocx(['Иван Петров', 'Синьор-разработчик в Acme, 2019–2024'])
        s3.getObject.mockResolvedValueOnce(docx)
        ai.extractStructure.mockResolvedValueOnce({
          ok: true,
          content: extractedContent('поднято подметателем'),
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
        expect(factsMarker(dto)).toBe('поднято подметателем')
      })

      it('R-INT-11b. a stale QUEUED row with no stored file is failed, not left spinning', async () => {
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
       * MED-3. `failUnclaimed` used to write unconditionally, so between the
       * sweep's SELECT and its UPDATE it could stamp FAILED over a row that had
       * just been re-queued — showing a failure for work that is running, and
       * orphaning the run that had taken the row (its terminal write then matches
       * nothing).
       *
       * The race is made deterministic rather than hoped for: the sweep now
       * processes oldest-first, so SENIOR_A (older, has a file) is handled first
       * and its storage read is the seam where SENIOR_B is re-queued underneath
       * the batch — exactly the interleaving that happens in production when an
       * upload lands mid-sweep.
       *
       * MUTATION: drop the `status`/`updatedAt` predicate from `failUnclaimed`
       * and this goes red.
       */
      it('R-INT-11e. does not fail a row that was re-queued mid-sweep', async () => {
        const older = new Date(Date.now() - STUCK_EXTRACTION_TIMEOUT_MS - 120_000)
        const newer = new Date(Date.now() - STUCK_EXTRACTION_TIMEOUT_MS - 60_000)

        // A: stale, HAS a stored file -> the sweep reads storage for it first.
        await dbSvc.db
          .update(seniorResumes)
          .set({
            status: 'QUEUED',
            sourceS3Key: 'senior-resumes/a.docx',
            sourceMimeType: RESUME_DOCX_MIME,
            extractionRunId: null,
            updatedAt: older,
          })
          .where(eq(seniorResumes.userId, SENIOR_A.id))

        // B: stale, NO stored file -> the failUnclaimed path.
        await dbSvc.db
          .insert(seniorResumes)
          .values({ userId: SENIOR_B.id, content: SENIOR_B_CONTENT })
          .onConflictDoNothing({ target: seniorResumes.userId })
        await dbSvc.db
          .update(seniorResumes)
          .set({
            status: 'QUEUED',
            sourceS3Key: null,
            sourceMimeType: null,
            extractionRunId: null,
            updatedAt: newer,
          })
          .where(eq(seniorResumes.userId, SENIOR_B.id))

        s3.getObject.mockReset()
        s3.getObject.mockImplementation(async () => {
          // A new upload lands for SENIOR_B while the batch is mid-flight.
          await dbSvc.db
            .update(seniorResumes)
            .set({ status: 'QUEUED', updatedAt: new Date() })
            .where(eq(seniorResumes.userId, SENIOR_B.id))
          return buildDocx(['Иван Петров', 'Синьор-разработчик'])
        })

        await service.requeueAbandoned()

        // B was re-queued after the sweep read it, so the sweep must leave it be.
        const [rowB] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_B.id))
        expect(rowB?.status).toBe('QUEUED')
        expect(rowB?.errorCode).toBeNull()

        s3.getObject.mockReset()
        await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_B.id))
      })

      /**
       * A storage failure must not leak its wording to the screen: the message
       * lands in `errorMessage`, which the resume panel renders verbatim. Bucket
       * names, key paths and endpoint hosts are not user-facing copy.
       */
      it('R-INT-11d. a storage failure surfaces OUR wording, not the client’s', async () => {
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

    // ── R-INT-12: erasure (personal data) ─────────────────────────────────────

    /**
     * A resume is personal data held on behalf of a person who may ask for it to
     * be erased, and there was no way to do that: fields could be blanked, but
     * the row stayed and — the part that matters — so did the uploaded PDF/DOCX
     * in object storage, which is where the raw document actually lives.
     *
     * Access is checked per ROW of the §4 table, exactly like every other
     * mutation, and every negative case targets SENIOR_B — a senior who really
     * exists and really has a resume. A test that deletes a fabricated uuid
     * passes with the check removed and proves nothing.
     */
    describe('R-INT-12. deleting a resume', () => {
      /** Give SENIOR_B a resume with a stored file, and report the key. */
      async function giveSeniorBaStoredResume(): Promise<string> {
        const key = `senior-resumes/${SENIOR_B.id}/original.docx`
        await dbSvc.db
          .insert(seniorResumes)
          .values({ userId: SENIOR_B.id, content: SENIOR_B_CONTENT })
          .onConflictDoNothing({ target: seniorResumes.userId })
        await dbSvc.db
          .update(seniorResumes)
          .set({ content: SENIOR_B_CONTENT, sourceS3Key: key, sourceMimeType: RESUME_DOCX_MIME })
          .where(eq(seniorResumes.userId, SENIOR_B.id))
        return key
      }

      it('R-INT-12a. ADMIN erases the row AND the stored original', async () => {
        const key = await giveSeniorBaStoredResume()
        s3.delete.mockClear()

        const after = await service.deleteResume(session(ADMIN_USER), SENIOR_B.id)

        expect(after.resume).toBeNull()
        expect(after.canEdit).toBe(true)
        // The file is what actually holds the document — blanking fields is not erasure.
        expect(s3.delete).toHaveBeenCalledWith(key)
        const rows = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_B.id))
        expect(rows).toHaveLength(0)
      })

      /**
       * AC7 for the artefact this task ADDED.
       *
       * The rendered PDF is a second, complete copy of the same personal data
       * sitting in object storage under a different key. An erase that took only
       * the uploaded original would report success while leaving the whole CV
       * behind — and nothing sweeps the `senior-resumes/` prefix, so it would
       * stay for good.
       */
      it('R-INT-12a2. erasing takes the RENDERED PDF with it, not just the original', async () => {
        const sourceKey = await giveSeniorBaStoredResume()
        const pdfKey = `senior-resumes/${SENIOR_B.id}/pdf/rendered.pdf`
        await dbSvc.db
          .update(seniorResumes)
          .set({ pdfS3Key: pdfKey, pdfFingerprint: 'abc', pdfRenderStatus: 'READY' })
          .where(eq(seniorResumes.userId, SENIOR_B.id))
        s3.delete.mockClear()

        await service.deleteResume(session(ADMIN_USER), SENIOR_B.id)

        const erased = s3.delete.mock.calls.map(([key]: [string]) => key)
        expect(erased).toContain(sourceKey)
        expect(erased).toContain(pdfKey)
      })

      it('R-INT-12b. HR may erase a foreign senior resume', async () => {
        await giveSeniorBaStoredResume()
        const after = await service.deleteResume(session(HR_USER), SENIOR_B.id)
        expect(after.resume).toBeNull()
      })

      it('R-INT-12c. SENIOR erases their OWN resume', async () => {
        await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
          ...EMPTY_RESUME_CONTENT,
          summary: 'моё резюме',
        })
        const after = await service.deleteResume(session(SENIOR_A), SENIOR_A.id)
        expect(after.resume).toBeNull()

        const reread = await service.getForUser(session(SENIOR_A), SENIOR_A.id)
        expect(reread.resume).toBeNull()
        expect(reread.canEdit).toBe(true) // still may create a new one
      })

      it('R-INT-12d. SENIOR A must not erase SENIOR B’s resume', async () => {
        await giveSeniorBaStoredResume()
        s3.delete.mockClear()

        await expect(service.deleteResume(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
        // Nothing was touched — not the row, not the file.
        expect(s3.delete).not.toHaveBeenCalled()
        const survived = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)
        expect(survived.resume?.content.summary).toBe(SENIOR_B_SECRET)
      })

      it.each([
        ['JUNIOR', () => JUNIOR_USER],
        ['ACCOUNTANT', () => ACCOUNTANT_USER],
        ['DROP', () => DROP_USER],
      ])('R-INT-12e. %s may not erase a resume', async (_role, who) => {
        await giveSeniorBaStoredResume()
        s3.delete.mockClear()

        await expect(service.deleteResume(session(who()), SENIOR_B.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
        expect(s3.delete).not.toHaveBeenCalled()
        const survived = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)
        expect(survived.resume?.content.summary).toBe(SENIOR_B_SECRET)
      })

      /**
       * MED-2. `source_s3_key` was read once and then used to delete, so an upload
       * landing in that window meant we erased the OLD object and dropped the row
       * pointing at the NEW one. The user is told "deleted"; the raw resume stays
       * in the bucket forever, because nothing sweeps the `senior-resumes/` prefix.
       *
       * MUTATION: drop the `IS NOT DISTINCT FROM` predicate from the DELETE and
       * this goes red — the second object survives with no row referencing it.
       */
      it('R-INT-12h. an upload racing the erase does not strand its file', async () => {
        const firstKey = await giveSeniorBaStoredResume()
        const secondKey = `senior-resumes/${SENIOR_B.id}/replacement.docx`
        s3.delete.mockClear()

        // Simulate the upload landing between the read and the row delete.
        let swapped = false
        s3.delete.mockImplementation(async () => {
          if (!swapped) {
            swapped = true
            await dbSvc.db
              .update(seniorResumes)
              .set({ sourceS3Key: secondKey })
              .where(eq(seniorResumes.userId, SENIOR_B.id))
          }
        })

        const after = await service.deleteResume(session(ADMIN_USER), SENIOR_B.id)
        expect(after.resume).toBeNull()

        // BOTH objects were erased — no orphan left behind.
        const deletedKeys = s3.delete.mock.calls.map((c) => c[0] as string)
        expect(deletedKeys).toContain(firstKey)
        expect(deletedKeys).toContain(secondKey)

        const rows = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_B.id))
        expect(rows).toHaveLength(0)
        s3.delete.mockReset()
        s3.delete.mockResolvedValue(undefined)
      })

      it('R-INT-12i. gives up honestly when the source keeps changing', async () => {
        await giveSeniorBaStoredResume()
        s3.delete.mockReset()
        let n = 0
        // Every attempt is outrun by a new upload.
        s3.delete.mockImplementation(async () => {
          n += 1
          await dbSvc.db
            .update(seniorResumes)
            .set({ sourceS3Key: `senior-resumes/${SENIOR_B.id}/v${n}.docx` })
            .where(eq(seniorResumes.userId, SENIOR_B.id))
        })

        await expect(service.deleteResume(session(ADMIN_USER), SENIOR_B.id)).rejects.toThrow(
          /изменяется прямо сейчас/,
        )
        // The row is still there, so the user can retry — nothing silently lost.
        const survived = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)
        expect(survived.resume).not.toBeNull()
        s3.delete.mockReset()
        s3.delete.mockResolvedValue(undefined)
      })

      it('R-INT-12f. erasing a resume that does not exist is a 404, not a silent success', async () => {
        await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_A.id))
        await expect(service.deleteResume(session(ADMIN_USER), SENIOR_A.id)).rejects.toBeInstanceOf(
          NotFoundException,
        )
      })

      /**
       * If storage refuses, the row must SURVIVE. Deleting it first and then
       * failing would strand the file: no row, no key, no code path that can ever
       * reach it again — undeletable personal data.
       */
      it('R-INT-12g. a storage failure leaves the row intact so the erase can be retried', async () => {
        await giveSeniorBaStoredResume()
        s3.delete.mockRejectedValueOnce(new Error('R2 unavailable'))

        await expect(service.deleteResume(session(ADMIN_USER), SENIOR_B.id)).rejects.toThrow()

        const survived = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)
        expect(survived.resume?.content.summary).toBe(SENIOR_B_SECRET)
      })
    })

    // ── The render job: state, freshness and supersession, against a real DB ──

    describe('rendered PDF', () => {
      /** Drain the detached render kicked off by a save. */
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

      it('a save queues a render and the finished PDF is served from storage', async () => {
        typst.render.mockClear()

        await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
          ...EMPTY_RESUME_CONTENT,
          summary: 'резюме для рендера',
        })
        await settle()

        // The save did NOT render inline — it queued, and the job did the work.
        expect(typst.render).toHaveBeenCalledTimes(1)

        s3.getObject.mockResolvedValueOnce(Buffer.from('%PDF-1.7 stored'))
        const served = await service.getRenderedPdf(session(SENIOR_A), SENIOR_A.id)
        expect(served.ready).toBe(true)
        // Served from the bucket, not typeset again for this request.
        expect(typst.render).toHaveBeenCalledTimes(1)
      })

      it('a stale PDF is never served as the current one — it is re-queued', async () => {
        await service.updateContent(session(SENIOR_A), SENIOR_A.id, {
          ...EMPTY_RESUME_CONTENT,
          summary: 'первая версия',
        })
        await settle()

        // Content moves underneath the stored render, without going through the
        // service — the shape a restored backup or a manual fix would leave.
        await dbSvc.db
          .update(seniorResumes)
          .set({ content: { ...EMPTY_RESUME_CONTENT, summary: 'вторая версия' } })
          .where(eq(seniorResumes.userId, SENIOR_A.id))

        const served = await service.getRenderedPdf(session(SENIOR_A), SENIOR_A.id)
        expect(served.ready).toBe(false)
        // ...and the fingerprint mismatch is what noticed, so nothing stale went out.
        expect(s3.getObject).not.toHaveBeenCalled()
      })

      it('a render superseded while it ran erases its own output instead of stranding it', async () => {
        const row = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        const resumeId = row[0]?.id
        if (!resumeId) throw new Error('fixture missing')

        // Claimable, then superseded the moment the renderer hands its bytes back.
        await dbSvc.db
          .update(seniorResumes)
          .set({ pdfRenderStatus: 'QUEUED', pdfRenderRunId: null })
          .where(eq(seniorResumes.id, resumeId))

        s3.delete.mockClear()
        typst.render.mockImplementationOnce(async () => {
          await dbSvc.db
            .update(seniorResumes)
            .set({ pdfRenderRunId: null })
            .where(eq(seniorResumes.id, resumeId))
          return Buffer.from('%PDF-1.7 superseded')
        })

        await service.runRender(resumeId, { displayName: 'Синьор А', email: SENIOR_A.email })

        // The bytes were written, then found to belong to nobody — so they are
        // erased. Left alone they would be an unreferenced CV in the bucket.
        const erased = s3.delete.mock.calls.map(([key]: [string]) => key)
        expect(erased.some((key) => key.includes('/pdf/'))).toBe(true)
        const after = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.id, resumeId))
        expect(after[0]?.pdfRenderStatus).not.toBe('READY')
      })

      /**
       * bug-44 (AC4) — a storage failure AFTER a successful render must not
       * leave the row RUNNING.
       *
       * Before the fix, `s3.upload` sat outside the try/catch that guards the
       * Typst render, so a rejected upload propagated out of `runRender`
       * uncaught: the row stayed exactly as `runRender` had just claimed it
       * (RUNNING, `pdfRenderStartedAt` still null because the fire-and-forget
       * `markRenderStarted` call may not have landed yet) until the stuck-render
       * sweep re-queued it two minutes later. The user watched a spinner with
       * no error for up to that long.
       */
      it('an upload failure after a successful render fails the row instead of leaving it RUNNING', async () => {
        // Self-contained fixture (not relying on an earlier test in this
        // describe block having already created SENIOR_A's row) — same
        // get-or-create the service itself uses.
        await dbSvc.db
          .insert(seniorResumes)
          .values({ userId: SENIOR_A.id, content: EMPTY_RESUME_CONTENT })
          .onConflictDoNothing({ target: seniorResumes.userId })
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        const resumeId = row?.id
        if (!resumeId) throw new Error('fixture missing')

        await dbSvc.db
          .update(seniorResumes)
          .set({ pdfRenderStatus: 'QUEUED', pdfRenderRunId: null })
          .where(eq(seniorResumes.id, resumeId))

        s3.upload.mockRejectedValueOnce(new Error('storage unreachable'))

        await service.runRender(resumeId, { displayName: 'Синьор А', email: SENIOR_A.email })

        const [after] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.id, resumeId))

        // The whole point of the bug: this must NOT be RUNNING.
        expect(after?.pdfRenderStatus).not.toBe('RUNNING')
        expect(after?.pdfRenderStatus).toBe('FAILED')
        // A human-readable reason, same field the render-failure path fills.
        expect(after?.pdfRenderError).toBeTruthy()
        // The claim is released — nothing keeps pointing at a dead run.
        expect(after?.pdfRenderRunId).toBeNull()
      })

      /**
       * The stuck-render sweep, and the trap in enabling it.
       *
       * `sweepStuckRenders` existed but was called from nowhere, so a render
       * abandoned by a container restart — every deploy — stayed RUNNING for
       * ever while the tab polled it forever showing "готовим PDF".
       *
       * Wiring it up is only safe because the RUNNING stamp and the start
       * timestamp were separated first. There are two slots and a queue: a
       * perfectly healthy render can sit claimed-but-waiting for a long time, and
       * a sweep that aged renders from the claim would restart live work on top
       * of itself — multiplying the very queue it exists to clear. Both halves
       * are asserted here, against real SQL, because the distinction lives in a
       * WHERE clause.
       */
      it('sweeps a render abandoned mid-flight back into the queue', async () => {
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        if (!row) throw new Error('fixture missing')

        // Claimed, started, and then the process died.
        await dbSvc.db
          .update(seniorResumes)
          .set({
            pdfRenderStatus: 'RUNNING',
            pdfRenderStartedAt: new Date(Date.now() - STUCK_RENDER_TIMEOUT_MS - 60_000),
            pdfRenderRunId: randomUUID(),
          })
          .where(eq(seniorResumes.id, row.id))

        const swept = await service.sweepStuckRenders()
        expect(swept).toBeGreaterThan(0)

        const [after] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.id, row.id))
        // QUEUED, not FAILED: a render needs no uploaded file and no paid model
        // call to retry, so the honest recovery is to do it again.
        expect(after?.pdfRenderStatus).toBe('QUEUED')
        expect(after?.pdfRenderRunId).toBeNull()
      })

      it('leaves a render that is only WAITING FOR A SLOT alone', async () => {
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, SENIOR_A.id))
        if (!row) throw new Error('fixture missing')

        const runId = randomUUID()
        // Claimed long ago, never started — exactly what a queued render behind
        // a busy semaphore looks like.
        await dbSvc.db
          .update(seniorResumes)
          .set({
            pdfRenderStatus: 'RUNNING',
            pdfRenderStartedAt: null,
            pdfRenderRunId: runId,
            updatedAt: new Date(Date.now() - STUCK_RENDER_TIMEOUT_MS - 60_000),
          })
          .where(eq(seniorResumes.id, row.id))

        await service.sweepStuckRenders()

        const [after] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.id, row.id))
        // Untouched: still RUNNING, still owned by the same attempt. Restarting
        // it would race a render that is about to begin.
        expect(after?.pdfRenderStatus).toBe('RUNNING')
        expect(after?.pdfRenderRunId).toBe(runId)
      })

      it('changing a layout switch persists it and rebuilds the PDF', async () => {
        typst.render.mockClear()

        const updated = await service.updateLayout(session(HR_USER), SENIOR_A.id, {
          ...DEFAULT_RESUME_LAYOUT,
          hiddenSections: ['links'],
          density: 'compact',
        })
        await settle()

        expect(updated.resume?.layout.hiddenSections).toEqual(['links'])
        expect(updated.resume?.layout.density).toBe('compact')
        expect(typst.render).toHaveBeenCalledTimes(1)
      })

      /**
       * The template is code and stays server-side. Nothing in the DTO may carry
       * it — that is what makes "the model never sees the template" a property of
       * the wire format rather than a promise about future callers.
       */
      it('never serialises the template source, only a label', async () => {
        await dbSvc.db
          .update(seniorResumes)
          .set({ templateSource: '#let render(data) = [СЕКРЕТНЫЙ ШАБЛОН]', templateName: 'Личный' })
          .where(eq(seniorResumes.userId, SENIOR_A.id))

        const response = await service.getForUser(session(SENIOR_A), SENIOR_A.id)

        // A non-catalog label maps to the default catalog template (spec §6).
        expect(response.resume?.templateName).toBe('classic')
        expect(response.resume?.hasCustomTemplate).toBe(true)
        expect(JSON.stringify(response)).not.toContain('СЕКРЕТНЫЙ ШАБЛОН')
        expect(JSON.stringify(response)).not.toContain('#let render')
      })
    })

    // ── Verified base resume (Task 13): facts, status rule, 409 while busy ──────

    describe('verified base resume — facts, DRAFT reset, 409 while busy', () => {
      const FACTS: ResumeFacts = {
        ...EMPTY_RESUME_FACTS,
        headline: 'Senior Backend Engineer',
        skills: ['TypeScript'],
      }
      const RUN_ID = '0b9a1c3e-0000-4000-8000-0000000000aa'
      const OTHER_RUN_ID = '0b9a1c3e-0000-4000-8000-0000000000bb'
      /** Run-scoped, like the runner writes it: `resumes/<id>/staged/<runId>.pdf`. */
      let stagedKey = ''

      async function rowOf(userId: string) {
        const [row] = await dbSvc.db
          .select()
          .from(seniorResumes)
          .where(eq(seniorResumes.userId, userId))
        if (!row) throw new Error('row missing')
        return row
      }

      function setState(userId: string, patch: Partial<typeof seniorResumes.$inferInsert>) {
        return dbSvc.db.update(seniorResumes).set(patch).where(eq(seniorResumes.userId, userId))
      }

      async function expectBusy(promise: Promise<unknown>) {
        const err: unknown = await promise.then(
          () => null,
          (e: unknown) => e,
        )
        expect(err).toBeInstanceOf(HttpException)
        expect((err as HttpException).getStatus()).toBe(409)
        expect((err as HttpException).getResponse()).toMatchObject({
          code: 'RESUME_VERIFICATION_BUSY',
        })
      }

      const awaiting = () => ({
        verificationStatus: 'AWAITING_CONFIRM' as const,
        verificationRunId: RUN_ID,
        verificationKind: 'full',
        stagedContent: { ...EMPTY_RESUME_CONTENT, summary: 'staged summary' },
        stagedLayout: DEFAULT_RESUME_LAYOUT,
        stagedTemplateName: 'modern',
        stagedPdfS3Key: stagedKey,
        stagedEditedPaths: [{ path: 'summary', userId: HR_USER.id }],
      })

      beforeEach(async () => {
        await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_A.id))
        await service.saveFacts(session(SENIOR_A), SENIOR_A.id, FACTS)
        stagedKey = `resumes/${(await rowOf(SENIOR_A.id)).id}/staged/${RUN_ID}.pdf`
        s3.delete.mockClear()
      })

      it('PUT facts bumps version and sets DRAFT', async () => {
        await setState(SENIOR_A.id, {
          verificationStatus: 'FAILED',
          verificationErrorCode: 'STALLED',
        })
        const before = await rowOf(SENIOR_A.id)

        const saved = await service.saveFacts(session(HR_USER), SENIOR_A.id, {
          ...FACTS,
          headline: 'Staff Engineer',
        })

        expect(saved.resume?.version).toBe(before.version + 1)
        expect(saved.resume?.verificationStatus).toBe('DRAFT')
        expect(saved.resume?.verificationErrorCode).toBeNull()
        expect(saved.resume?.facts.headline).toBe('Staff Engineer')
        expect((await rowOf(SENIOR_A.id)).facts?.headline).toBe('Staff Engineer')
      })

      it('PUT facts while CHECKING returns 409 and leaves the row unchanged', async () => {
        await setState(SENIOR_A.id, { verificationStatus: 'CHECKING', verificationRunId: RUN_ID })
        const before = await rowOf(SENIOR_A.id)

        await expectBusy(
          service.saveFacts(session(HR_USER), SENIOR_A.id, { ...FACTS, headline: 'changed' }),
        )

        expect(await rowOf(SENIOR_A.id)).toEqual(before)
      })

      it('PUT content, layout and template while QUEUED all return 409', async () => {
        await setState(SENIOR_A.id, { verificationStatus: 'QUEUED', verificationRunId: RUN_ID })
        const before = await rowOf(SENIOR_A.id)

        await expectBusy(
          service.updateContent(session(HR_USER), SENIOR_A.id, {
            ...EMPTY_RESUME_CONTENT,
            summary: 'x',
          }),
        )
        await expectBusy(
          service.updateLayout(session(HR_USER), SENIOR_A.id, {
            ...DEFAULT_RESUME_LAYOUT,
            density: 'compact',
          }),
        )
        await expectBusy(service.setTemplate(session(HR_USER), SENIOR_A.id, 'modern'))
        expect(await rowOf(SENIOR_A.id)).toEqual(before)
      })

      it('CD-4: DELETE while QUEUED returns 409; the row and its keys stay', async () => {
        await setState(SENIOR_A.id, {
          verificationStatus: 'QUEUED',
          verificationRunId: RUN_ID,
          stagedPdfS3Key: stagedKey,
        })
        const before = await rowOf(SENIOR_A.id)

        await expectBusy(service.deleteResume(session(HR_USER), SENIOR_A.id))

        expect(await rowOf(SENIOR_A.id)).toEqual(before)
        expect(s3.delete).not.toHaveBeenCalled()
      })

      it('facts edit in AWAITING_CONFIRM clears staged columns', async () => {
        await setState(SENIOR_A.id, awaiting())
        const shown = await service.getForUser(session(HR_USER), SENIOR_A.id)
        expect(shown.resume?.staged).toMatchObject({
          runId: RUN_ID,
          templateName: 'modern',
          pdfAvailable: true,
          editedPaths: [{ path: 'summary', userId: HR_USER.id }],
        })
        expect(shown.resume?.staged?.content.summary).toBe('staged summary')

        const saved = await service.saveFacts(session(HR_USER), SENIOR_A.id, FACTS)

        expect(saved.resume?.verificationStatus).toBe('DRAFT')
        expect(saved.resume?.staged).toBeNull()
        const row = await rowOf(SENIOR_A.id)
        expect(row).toMatchObject({
          verificationRunId: null,
          stagedContent: null,
          stagedLayout: null,
          stagedTemplateName: null,
          stagedPdfS3Key: null,
          stagedEditedPaths: [],
        })
        expect(s3.delete).toHaveBeenCalledWith(stagedKey)
      })

      it('a run landing between the read and the write: 409, row unchanged, its PDF kept', async () => {
        await setState(SENIOR_A.id, awaiting())
        const stale = await rowOf(SENIOR_A.id)
        // A newer run's result landed after our read: new run id, new staged key.
        const newKey = `resumes/${stale.id}/staged/${OTHER_RUN_ID}.pdf`
        await setState(SENIOR_A.id, { verificationRunId: OTHER_RUN_ID, stagedPdfS3Key: newKey })
        const before = await rowOf(SENIOR_A.id)
        const verification = new ResumeVerificationService(dbSvc, s3 as never, runner as never)

        await expectBusy(verification.saveFacts(stale, { ...FACTS, headline: 'raced' }, HR_USER.id))
        await expectBusy(verification.setTemplate(stale, 'technical', HR_USER.id))

        expect(await rowOf(SENIOR_A.id)).toEqual(before)
        expect(s3.delete).not.toHaveBeenCalled()
      })

      it('a failed staged-object delete is logged and does not fail the write', async () => {
        await setState(SENIOR_A.id, awaiting())
        s3.delete.mockRejectedValueOnce(new Error('storage down'))

        const saved = await service.saveFacts(session(HR_USER), SENIOR_A.id, FACTS)

        expect(saved.resume?.verificationStatus).toBe('DRAFT')
        expect((await rowOf(SENIOR_A.id)).stagedPdfS3Key).toBeNull()
      })

      it("SENIOR may PUT own facts, not another senior's (403)", async () => {
        const own = await service.saveFacts(session(SENIOR_A), SENIOR_A.id, {
          ...FACTS,
          headline: 'mine',
        })
        expect(own.resume?.facts.headline).toBe('mine')
        expect(own.canConfirm).toBe(false)

        const bBefore = await rowOf(SENIOR_B.id)
        await expect(
          service.saveFacts(session(SENIOR_A), SENIOR_B.id, FACTS),
        ).rejects.toBeInstanceOf(ForbiddenException)
        await expect(
          service.setTemplate(session(SENIOR_A), SENIOR_B.id, 'modern'),
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(await rowOf(SENIOR_B.id)).toEqual(bBefore)
      })

      it('ACCOUNTANT gets 403', async () => {
        await expect(
          service.saveFacts(session(ACCOUNTANT_USER), SENIOR_A.id, FACTS),
        ).rejects.toBeInstanceOf(ForbiddenException)
        await expect(
          service.setTemplate(session(ACCOUNTANT_USER), SENIOR_A.id, 'modern'),
        ).rejects.toBeInstanceOf(ForbiddenException)
        await expect(
          service.saveFacts(session(JUNIOR_USER), SENIOR_A.id, FACTS),
        ).rejects.toBeInstanceOf(ForbiddenException)
      })

      it('ADMIN and HR may confirm, the senior may not (canConfirm)', async () => {
        expect((await service.getForUser(session(ADMIN_USER), SENIOR_A.id)).canConfirm).toBe(true)
        expect((await service.getForUser(session(HR_USER), SENIOR_A.id)).canConfirm).toBe(true)
        expect((await service.getForUser(session(SENIOR_A), SENIOR_A.id)).canConfirm).toBe(false)
      })

      describe('POST submit: who may queue the check run', () => {
        // Complete facts and a Latin display name, so an accepted submit passes the completeness
        // check and a refusal can only come from the access rule.
        const COMPLETE: ResumeFacts = {
          ...FACTS,
          location: { city: 'Lisbon', country: 'Portugal' },
          skills: ['TypeScript', 'NestJS', 'PostgreSQL', 'Docker', 'Kafka'],
          experience: [
            {
              company: 'Acme Corp',
              role: 'Tech Lead',
              location: null,
              start: '2021-03',
              end: null,
              current: true,
              technologies: ['TypeScript'],
              notes: ['Led the payments team'],
            },
          ],
          languages: [{ name: 'English', level: 'C1' }],
        }

        beforeEach(async () => {
          await service.saveFacts(session(SENIOR_A), SENIOR_A.id, COMPLETE)
          await dbSvc.db
            .update(users)
            .set({ displayName: 'Senior First' })
            .where(eq(users.id, SENIOR_A.id))
          runner.run.mockClear()
        })

        afterEach(async () => {
          await dbSvc.db
            .update(users)
            .set({ displayName: SENIOR_A.displayName })
            .where(eq(users.id, SENIOR_A.id))
        })

        it("SENIOR on another senior's resume is 403 and queues nothing", async () => {
          // B's row is made submittable like A's, so only the access rule can stop the submit.
          const seeded = await rowOf(SENIOR_B.id)
          await service.saveFacts(session(ADMIN_USER), SENIOR_B.id, COMPLETE)
          await dbSvc.db
            .update(users)
            .set({ displayName: 'Senior Second' })
            .where(eq(users.id, SENIOR_B.id))
          try {
            const bBefore = await rowOf(SENIOR_B.id)
            await expect(service.submit(session(SENIOR_A), SENIOR_B.id)).rejects.toBeInstanceOf(
              ForbiddenException,
            )
            expect(await rowOf(SENIOR_B.id)).toEqual(bBefore)
            expect(runner.run).not.toHaveBeenCalled()
          } finally {
            await setState(SENIOR_B.id, {
              facts: seeded.facts,
              verificationStatus: seeded.verificationStatus,
              version: seeded.version,
            })
            await dbSvc.db
              .update(users)
              .set({ displayName: SENIOR_B.displayName })
              .where(eq(users.id, SENIOR_B.id))
          }
        })

        it.each([
          ['JUNIOR', JUNIOR_USER],
          ['ACCOUNTANT', ACCOUNTANT_USER],
        ])('%s is 403 and queues nothing', async (_role, viewer) => {
          const before = await rowOf(SENIOR_A.id)
          await expect(service.submit(session(viewer), SENIOR_A.id)).rejects.toBeInstanceOf(
            ForbiddenException,
          )
          expect(await rowOf(SENIOR_A.id)).toEqual(before)
          expect(runner.run).not.toHaveBeenCalled()
        })

        it.each([
          ['SENIOR on their own resume', SENIOR_A],
          ['HR', HR_USER],
        ])('%s is accepted: the row is QUEUED and the runner starts once', async (_who, viewer) => {
          const out = await service.submit(session(viewer), SENIOR_A.id)

          expect(out.resume?.verificationStatus).toBe('QUEUED')
          const row = await rowOf(SENIOR_A.id)
          expect(row.verificationStatus).toBe('QUEUED')
          expect(row.verificationKind).toBe('full')
          expect(row.updatedByUserId).toBe(viewer.id)
          expect(runner.run.mock.calls).toEqual([[row.id, row.verificationRunId]])
        })

        it("the senior's Telegram handle in a note makes the facts incomplete: 422, nothing queued", async () => {
          const experience = COMPLETE.experience.map((item) => ({
            ...item,
            notes: ['Led the payments team, ping SENIOR_TG_A'],
          }))
          await service.saveFacts(session(SENIOR_A), SENIOR_A.id, { ...COMPLETE, experience })
          await dbSvc.db
            .update(users)
            .set({ telegram: '@senior_tg_a' })
            .where(eq(users.id, SENIOR_A.id))
          try {
            const err: unknown = await service.submit(session(SENIOR_A), SENIOR_A.id).then(
              () => null,
              (e: unknown) => e,
            )
            expect((err as HttpException).getStatus()).toBe(422)
            expect((err as HttpException).getResponse()).toMatchObject({
              code: 'RESUME_INCOMPLETE',
            })
            expect(runner.run).not.toHaveBeenCalled()
          } finally {
            await dbSvc.db
              .update(users)
              .set({ telegram: SENIOR_A.telegram ?? null })
              .where(eq(users.id, SENIOR_A.id))
          }
        })
      })

      it('legacy row without facts reads mapped facts and status DRAFT', async () => {
        await setState(SENIOR_B.id, {
          facts: null,
          verificationStatus: 'DRAFT',
          content: {
            ...EMPTY_RESUME_CONTENT,
            experience: [
              { company: 'Acme', role: 'Developer', period: '2019 – 2021', bullets: ['Built X'] },
            ],
          },
        })

        const read = await service.getForUser(session(ADMIN_USER), SENIOR_B.id)

        expect(read.resume?.verificationStatus).toBe('DRAFT')
        expect(read.resume?.facts.experience).toEqual([
          expect.objectContaining({ company: 'Acme', role: 'Developer', notes: ['Built X'] }),
        ])
        // Reads never write: the mapping is persisted only by the first facts save.
        expect((await rowOf(SENIOR_B.id)).facts).toBeNull()
      })

      it('PUT layout on DRAFT writes it without a run', async () => {
        const before = await rowOf(SENIOR_A.id)

        const saved = await service.updateLayout(session(HR_USER), SENIOR_A.id, {
          ...DEFAULT_RESUME_LAYOUT,
          density: 'compact',
        })

        expect(saved.resume?.layout.density).toBe('compact')
        expect(saved.resume?.version).toBe(before.version + 1)
        expect(saved.resume?.verificationStatus).toBe('DRAFT')
        expect(saved.resume?.verificationBusy).toBe(false)
        expect((await rowOf(SENIOR_A.id)).verificationRunId).toBeNull()
      })

      it('PUT layout on VERIFIED does not set DRAFT', async () => {
        const start = await rowOf(SENIOR_A.id)
        await setState(SENIOR_A.id, {
          verificationStatus: 'VERIFIED',
          verifiedVersion: start.version,
          verifiedAt: new Date(),
          verifiedByUserId: HR_USER.id,
        })

        const saved = await service.updateLayout(session(HR_USER), SENIOR_A.id, {
          ...DEFAULT_RESUME_LAYOUT,
          density: 'relaxed',
        })

        // P1: a template run starts; status, live layout and version stay.
        expect(saved.resume?.verificationStatus).toBe('VERIFIED')
        expect(saved.resume?.layout.density).toBe(start.layout.density)
        expect(saved.resume?.version).toBe(start.version)
        expect(saved.resume?.verificationBusy).toBe(true)
        expect(saved.resume?.verifiedByName).toBe(HR_USER.displayName)
        expect(saved.resume?.staged).toBeNull() // no staged PDF yet: no confirm step
        const row = await rowOf(SENIOR_A.id)
        expect(row.verificationRunId).not.toBeNull()
        expect(row.verificationKind).toBe('template')
        expect(row.verificationBaseVersion).toBe(start.version)
        expect(row.stagedLayout?.density).toBe('relaxed')
        expect(row.stagedTemplateName).toBe(start.templateName)
        expect(row.verificationQueuedAt).not.toBeNull()

        // The run makes the row busy: a facts write now answers 409.
        await expectBusy(service.saveFacts(session(HR_USER), SENIOR_A.id, FACTS))
      })

      it('PUT template on VERIFIED stages the template and keeps the live one', async () => {
        const start = await rowOf(SENIOR_A.id)
        await setState(SENIOR_A.id, {
          verificationStatus: 'VERIFIED',
          verifiedVersion: start.version,
          templateName: 'classic',
        })

        const saved = await service.setTemplate(session(HR_USER), SENIOR_A.id, 'technical')

        expect(saved.resume?.templateName).toBe('classic')
        const row = await rowOf(SENIOR_A.id)
        expect(row.stagedTemplateName).toBe('technical')
        expect(row.verificationKind).toBe('template')
      })

      it('PUT template in AWAITING_CONFIRM returns to DRAFT and drops the staged PDF', async () => {
        await setState(SENIOR_A.id, awaiting())
        const before = await rowOf(SENIOR_A.id)

        const saved = await service.setTemplate(session(HR_USER), SENIOR_A.id, 'compact')

        expect(saved.resume?.templateName).toBe('compact')
        expect(saved.resume?.verificationStatus).toBe('DRAFT')
        expect(saved.resume?.version).toBe(before.version + 1)
        expect(saved.resume?.staged).toBeNull()
        expect(s3.delete).toHaveBeenCalledWith(stagedKey)
      })

      it('PUT template on FAILED writes it and keeps FAILED', async () => {
        await setState(SENIOR_A.id, { verificationStatus: 'FAILED' })
        const before = await rowOf(SENIOR_A.id)

        const saved = await service.setTemplate(session(SENIOR_A), SENIOR_A.id, 'modern')

        expect(saved.resume?.templateName).toBe('modern')
        expect(saved.resume?.verificationStatus).toBe('FAILED')
        expect(saved.resume?.version).toBe(before.version + 1)
      })

      it('extraction result lands in facts, content unchanged', async () => {
        await setState(SENIOR_A.id, {
          ...awaiting(),
          content: { ...EMPTY_RESUME_CONTENT, summary: 'live summary' },
        })
        const before = await rowOf(SENIOR_A.id)
        ai.extractStructure.mockResolvedValueOnce({
          ok: true,
          content: {
            ...EMPTY_RESUME_CONTENT,
            summary: 'extracted summary',
            experience: [
              { company: 'ExtractedCo', role: 'Lead', period: '', bullets: ['Shipped Y'] },
            ],
          },
          tokensUsed: 7,
        })

        await service.ingestText(session(HR_USER), SENIOR_A.id, 'a'.repeat(200))
        await vi.waitFor(async () => {
          expect((await rowOf(SENIOR_A.id)).status).toBe('READY')
        })

        const row = await rowOf(SENIOR_A.id)
        expect((row.content as ResumeContent).summary).toBe('live summary')
        expect(row.facts?.experience[0]).toMatchObject({
          company: 'ExtractedCo',
          notes: ['Shipped Y'],
        })
        expect(row.verificationStatus).toBe('DRAFT')
        expect(row.version).toBe(before.version + 1)
        expect(row.stagedPdfS3Key).toBeNull()
        expect(s3.delete).toHaveBeenCalledWith(stagedKey)
      })

      it('upload while CHECKING returns 409 before storing anything', async () => {
        await setState(SENIOR_A.id, { verificationStatus: 'CHECKING', verificationRunId: RUN_ID })

        await expectBusy(
          service.uploadSource(session(HR_USER), SENIOR_A.id, {
            buffer: buildDocx(['Иван Петров', 'Синьор']),
            mimetype: RESUME_DOCX_MIME,
            originalname: 'cv.docx',
          }),
        )
        expect(s3.upload).not.toHaveBeenCalled()
      })

      it('a run starting during the upload still answers 409 when the cleanup delete fails', async () => {
        s3.upload.mockImplementationOnce(async () => {
          await setState(SENIOR_A.id, { verificationStatus: 'CHECKING', verificationRunId: RUN_ID })
        })
        s3.delete.mockRejectedValueOnce(new Error('storage down'))

        await expectBusy(
          service.uploadSource(session(HR_USER), SENIOR_A.id, {
            buffer: buildDocx(['Иван Петров', 'Синьор']),
            mimetype: RESUME_DOCX_MIME,
            originalname: 'cv.docx',
          }),
        )
        const uploadedKey = s3.upload.mock.calls.at(-1)?.[0] as string
        expect(s3.delete).toHaveBeenCalledWith(uploadedKey)
        expect((await rowOf(SENIOR_A.id)).sourceS3Key).not.toBe(uploadedKey)
      })

      it('a failed delete of the superseded source still answers with the new source in place', async () => {
        const previousKey = `senior-resumes/${SENIOR_A.id}/previous-source`
        await setState(SENIOR_A.id, { sourceS3Key: previousKey })
        s3.delete.mockRejectedValueOnce(new Error('storage down'))

        const queued = await service.uploadSource(session(HR_USER), SENIOR_A.id, {
          buffer: buildDocx(['Иван Петров', 'Синьор']),
          mimetype: RESUME_DOCX_MIME,
          originalname: 'cv.docx',
        })
        expect(queued.resume?.status).toBe('QUEUED')
        const uploadedKey = s3.upload.mock.calls.at(-1)?.[0] as string
        expect(s3.delete).toHaveBeenCalledWith(previousKey)
        expect((await rowOf(SENIOR_A.id)).sourceS3Key).toBe(uploadedKey)
        // The extraction of the new source still starts.
        await vi.waitFor(async () => {
          expect((await rowOf(SENIOR_A.id)).status).not.toMatch(/^(QUEUED|RUNNING)$/)
        })
      })

      it('extracted facts outside the schema range fail the run and store nothing', async () => {
        const before = await rowOf(SENIOR_A.id)
        ai.extractStructure.mockResolvedValueOnce({
          ok: true,
          content: {
            ...EMPTY_RESUME_CONTENT,
            experience: [
              { company: 'OldCo', role: 'Clerk', period: '1900-05 — 2005-01', bullets: [] },
            ],
          },
          tokensUsed: 7,
        })

        await service.ingestText(session(HR_USER), SENIOR_A.id, 'a'.repeat(200))
        await vi.waitFor(async () => {
          expect((await rowOf(SENIOR_A.id)).status).toBe('FAILED')
        })

        const row = await rowOf(SENIOR_A.id)
        expect(row.errorCode).toBe('MODEL_INVALID_JSON')
        expect(row.lastExtractionTokens).toBe(7)
        expect(row.facts).toEqual(before.facts)
        expect(row.version).toBe(before.version)
        expect(row.verificationStatus).toBe(before.verificationStatus)
      })

      it('pasted text while QUEUED returns 409 and starts no extraction', async () => {
        await setState(SENIOR_A.id, { verificationStatus: 'QUEUED', verificationRunId: RUN_ID })
        const before = await rowOf(SENIOR_A.id)

        await expectBusy(service.ingestText(session(HR_USER), SENIOR_A.id, 'a'.repeat(200)))

        expect(await rowOf(SENIOR_A.id)).toEqual(before)
        expect(ai.extractStructure).not.toHaveBeenCalled()
      })

      it('deleting a resume also deletes its staged PDF', async () => {
        await setState(SENIOR_A.id, awaiting())

        await service.deleteResume(session(HR_USER), SENIOR_A.id)

        expect(s3.delete).toHaveBeenCalledWith(stagedKey)
        expect(
          await dbSvc.db.select().from(seniorResumes).where(eq(seniorResumes.userId, SENIOR_A.id)),
        ).toEqual([])
      })

      it('new resume in a team using classic×2, modern×1 gets compact or technical deterministically', async () => {
        // sha256(...11) mod 4 = 3 -> the walk starts at `technical` (unit spec).
        const newcomer = makeRow({
          id: '7b3d91c4-2e5f-4a00-aa00-000000000011',
          email: 'resume-team-newcomer@test.spec',
          role: 'SENIOR',
        })
        const peers = ['12', '13', '14'].map((n) =>
          makeRow({
            id: `7b3d91c4-2e5f-4a00-aa00-0000000000${n}`,
            email: `resume-team-peer-${n}@test.spec`,
            role: 'SENIOR',
          }),
        )
        const all = [newcomer, ...peers]
        const [team] = await dbSvc.db
          .insert(teams)
          .values({ name: 'resume-template-pick-team' })
          .returning({ id: teams.id })
        if (!team) throw new Error('team not created')
        try {
          await dbSvc.db
            .insert(users)
            .values(all.map((u) => ({ ...u, googleId: `test-resume-rbac-${u.id}` })))
            .onConflictDoNothing()
          await dbSvc.db
            .insert(teamMembers)
            .values(all.map((u) => ({ teamId: team.id, userId: u.id })))
          await dbSvc.db.insert(seniorResumes).values(
            ['classic', 'classic', 'modern'].map((templateName, i) => ({
              userId: peers[i]!.id,
              templateName,
            })),
          )

          const saved = await service.saveFacts(session(HR_USER), newcomer.id, FACTS)

          expect(saved.resume?.templateName).toBe('technical')
        } finally {
          const ids = all.map((u) => u.id)
          await dbSvc.db.delete(seniorResumes).where(inArray(seniorResumes.userId, ids))
          await dbSvc.db.delete(teams).where(eq(teams.id, team.id))
          await dbSvc.db.delete(users).where(inArray(users.id, ids))
        }
      })
    })
  },
)
