/**
 * ApplicationsService.apply() — unit tests for the public apply pipeline.
 *
 * Every dependency (VacanciesService, S3Service, CompressionService,
 * TurnstileService, NotificationsService, DatabaseService) is mocked so each
 * failure branch (task §5 + AC7) can be exercised in isolation, deterministically,
 * without a real Postgres/R2. The happy path + RBAC on the admin endpoints +
 * the real 24h-duplicate SQL are additionally covered against a real DB in
 * vacancies.integration.spec.ts (AC6/AC4).
 */
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import {
  ApplicationsService,
  MIMIC_DELAY_JITTER_MS,
  MIMIC_DELAY_TARGET_MS,
  type ApplyResumeFile,
} from './applications.service'
import type { VacanciesService } from './vacancies.service'
import type { TurnstileService } from './turnstile.service'
import type { S3Service } from '../documents/s3.service'
import type { CompressionService } from '../documents/compression.service'
import { CompressionError } from '../documents/compression.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { DatabaseService } from '../database/database.service'

/** Minimal PDF magic bytes (%PDF header) — matches 'application/pdf'. */
const PDF_MAGIC_BUF = Buffer.from('%PDF-1.4 stub-content-for-testing')
/** PNG magic bytes — used to simulate a mismatched-content upload. */
const PNG_MAGIC_BUF = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

const VALID_FIELDS = {
  fullName: 'Ivan Petrenko',
  email: 'ivan@example.com',
  turnstileToken: 'tok-123',
}

const VACANCY_ROW = {
  id: 'vac-1',
  slug: 'senior-frontend-engineer',
  title: 'Senior Frontend Engineer',
  status: 'PUBLISHED' as const,
}

function pdfFile(overrides: Partial<ApplyResumeFile> = {}): ApplyResumeFile {
  return {
    buffer: PDF_MAGIC_BUF,
    mimetype: 'application/pdf',
    originalname: 'resume.pdf',
    ...overrides,
  }
}

/**
 * Default shape for a "duplicate" fixture row — a realistic existing
 * application (owner decision 2026-08-03: the duplicate branch now reads
 * `duplicate.id`/`duplicate.resumeS3Key` to update the row and delete the
 * old file, so the fixture needs both, not just an `id`).
 */
function existingApplicationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'existing-app',
    vacancyId: 'vac-1',
    email: VALID_FIELDS.email,
    resumeS3Key: 'vacancy-applications/vac-1/existing-app.pdf',
    resumeSizeBytes: 999,
    coverLetter: 'old cover letter',
    ...overrides,
  }
}

interface Harness {
  svc: ApplicationsService
  vacanciesService: { getPublishedRowBySlug: ReturnType<typeof vi.fn> }
  turnstile: { verify: ReturnType<typeof vi.fn> }
  s3: {
    upload: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    deleteOrThrow: ReturnType<typeof vi.fn>
  }
  compression: { compress: ReturnType<typeof vi.fn> }
  notifications: { create: ReturnType<typeof vi.fn> }
  deletedApplicationIds: string[]
  updateCalls: Record<string, unknown>[]
}

function makeHarness(
  opts: {
    duplicateRow?: unknown
    recipients?: { id: string }[]
    turnstileValid?: boolean
    deleteOrThrowError?: Error
  } = {},
): Harness {
  const deletedApplicationIds: string[] = []
  const updateCalls: Record<string, unknown>[] = []

  const vacanciesService = {
    getPublishedRowBySlug: vi.fn().mockResolvedValue(VACANCY_ROW),
  }
  const turnstile = {
    verify: vi.fn().mockResolvedValue(opts.turnstileValid ?? true),
  }
  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteOrThrow: opts.deleteOrThrowError
      ? vi.fn().mockRejectedValue(opts.deleteOrThrowError)
      : vi.fn().mockResolvedValue(undefined),
  }
  const compression = {
    compress: vi.fn().mockResolvedValue({
      buffer: PDF_MAGIC_BUF,
      finalMimeType: 'application/pdf',
      sizeBytes: PDF_MAGIC_BUF.length,
    }),
  }
  const notifications = {
    create: vi.fn().mockResolvedValue(undefined),
  }

  const db = {
    db: {
      query: {
        vacancyApplications: {
          findFirst: async () => opts.duplicateRow,
        },
      },
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => [{ ...vals, createdAt: new Date('2026-07-22T00:00:00Z') }],
        }),
      }),
      update: (_table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: async (_pred: unknown) => {
            updateCalls.push(vals)
            return undefined
          },
        }),
      }),
      delete: (_table: unknown) => ({
        where: async (_pred: unknown) => {
          deletedApplicationIds.push('deleted')
          return undefined
        },
      }),
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: async (_pred: unknown) => opts.recipients ?? [{ id: 'admin-1' }, { id: 'hr-1' }],
        }),
      }),
    },
  }

  const svc = new ApplicationsService(
    db as unknown as DatabaseService,
    vacanciesService as unknown as VacanciesService,
    s3 as unknown as S3Service,
    compression as unknown as CompressionService,
    turnstile as unknown as TurnstileService,
    notifications as unknown as NotificationsService,
  )

  return {
    svc,
    vacanciesService,
    turnstile,
    s3,
    compression,
    notifications,
    deletedApplicationIds,
    updateCalls,
  }
}

describe('ApplicationsService.apply()', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('honeypot: non-empty website field mimics success WITHOUT touching turnstile/DB/S3', async () => {
    const result = await h.svc.apply(
      'senior-frontend-engineer',
      { ...VALID_FIELDS, website: 'http://spam.example' },
      pdfFile(),
      '1.2.3.4',
    )
    expect(result).toEqual({ ok: true })
    expect(h.turnstile.verify).not.toHaveBeenCalled()
    expect(h.vacanciesService.getPublishedRowBySlug).not.toHaveBeenCalled()
    expect(h.s3.upload).not.toHaveBeenCalled()
  })

  it('honeypot: empty website field proceeds normally', async () => {
    const result = await h.svc.apply(
      'senior-frontend-engineer',
      { ...VALID_FIELDS, website: '' },
      pdfFile(),
      '1.2.3.4',
    )
    expect(result).toEqual({ ok: true })
    expect(h.turnstile.verify).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid field shape (missing turnstileToken) via Zod', async () => {
    await expect(
      h.svc.apply(
        'senior-frontend-engineer',
        { fullName: 'Ivan', email: 'ivan@x.com' },
        pdfFile(),
        '1.2.3.4',
      ),
    ).rejects.toThrow()
    expect(h.turnstile.verify).not.toHaveBeenCalled()
  })

  it('turnstile invalid → 400, vacancy is never looked up', async () => {
    h = makeHarness({ turnstileValid: false })
    await expect(
      h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4'),
    ).rejects.toThrow(BadRequestException)
    expect(h.vacanciesService.getPublishedRowBySlug).not.toHaveBeenCalled()
  })

  it('vacancy not found/published → propagates 404 from VacanciesService', async () => {
    h.vacanciesService.getPublishedRowBySlug.mockRejectedValue(
      new NotFoundException('Вакансия не найдена'),
    )
    await expect(h.svc.apply('missing-slug', VALID_FIELDS, pdfFile(), '1.2.3.4')).rejects.toThrow(
      NotFoundException,
    )
  })

  // OWNER DECISION 2026-08-03 (security-review round 2 — overturns round-1
  // MED-4's "silent no-op"): a duplicate now UPDATES the existing row in
  // place — new resume file, new size, new cover letter, reset submission
  // time — instead of discarding the resubmission. The RESPONSE stays
  // `{ ok: true }` either way, which is what actually keeps the
  // enumeration oracle closed (see the describe block further down).
  describe('duplicate within 24h → updates the existing application in place (owner decision 2026-08-03)', () => {
    it('uploads the NEW file under a fresh key, deletes the OLD key, updates the row (size/cover-letter/time), notifies nobody', async () => {
      h = makeHarness({ duplicateRow: existingApplicationRow() })
      const result = await h.svc.apply(
        'senior-frontend-engineer',
        { ...VALID_FIELDS, email: existingApplicationRow().email },
        pdfFile(),
        '1.2.3.4',
      )
      expect(result).toEqual({ ok: true })

      // New file uploaded under a DIFFERENT key than the old one.
      expect(h.s3.upload).toHaveBeenCalledTimes(1)
      const [newKey, , , category] = h.s3.upload.mock.calls[0] as [string, Buffer, string, string]
      expect(newKey).toMatch(/^vacancy-applications\/vac-1\/.+\.pdf$/)
      expect(newKey).not.toBe(existingApplicationRow().resumeS3Key)
      expect(category).toBe('RESUME')

      // OLD file actually deleted from storage — via the throwing helper,
      // same one `remove()` already uses (`deleteOrThrow`, not the
      // best-effort `delete()`).
      expect(h.s3.deleteOrThrow).toHaveBeenCalledTimes(1)
      expect(h.s3.deleteOrThrow).toHaveBeenCalledWith(existingApplicationRow().resumeS3Key)
      expect(h.s3.delete).not.toHaveBeenCalled() // no compensation needed on the happy path

      // Row updated: new key, new size, new cover letter, reset time —
      // exactly the 4 fields the owner named ("резюме, размер,
      // сопроводительное, время"). Contact fields untouched (not part of
      // this update — dedup key `email` cannot change anyway).
      expect(h.updateCalls).toHaveLength(1)
      const update = h.updateCalls[0] as {
        resumeS3Key: string
        resumeSizeBytes: number
        coverLetter: string | null
        createdAt: Date
      }
      expect(update.resumeS3Key).toBe(newKey)
      expect(update.resumeSizeBytes).toBe(PDF_MAGIC_BUF.length)
      expect(update.coverLetter).toBeNull() // VALID_FIELDS carries no coverLetter
      expect(update.createdAt).toBeInstanceOf(Date)
      expect('fullName' in update).toBe(false)
      expect('email' in update).toBe(false)

      // No fresh-insert path taken, no admin/HR re-notification — a
      // resubmission is not a brand-new application from the ops side.
      expect(h.notifications.create).not.toHaveBeenCalled()
    })

    it('when the old-file delete fails: compensates by deleting the just-uploaded new file, does NOT update the row, and rethrows', async () => {
      h = makeHarness({
        duplicateRow: existingApplicationRow(),
        deleteOrThrowError: new Error('R2 unreachable'),
      })
      await expect(
        h.svc.apply(
          'senior-frontend-engineer',
          { ...VALID_FIELDS, email: existingApplicationRow().email },
          pdfFile(),
          '1.2.3.4',
        ),
      ).rejects.toThrow('R2 unreachable')

      // The new file WAS uploaded, then compensated (deleted) — never left
      // dangling as an orphan alongside the still-alive old file.
      expect(h.s3.upload).toHaveBeenCalledTimes(1)
      const [newKey] = h.s3.upload.mock.calls[0] as [string]
      expect(h.s3.delete).toHaveBeenCalledTimes(1)
      expect(h.s3.delete).toHaveBeenCalledWith(newKey)

      // The forbidden end-state this test exists to rule out: "record
      // updated AND both files present". Assert the record update never
      // ran at all.
      expect(h.updateCalls).toHaveLength(0)
    })
  })

  // security-review round 3, MED-2: the round-2 flat per-branch delay was
  // REJECTED (it padded the short-circuit branches by a fixed amount that
  // turned out to be systematically SLOWER than a genuine submission with
  // an attacker-chosen minimal file — the leak inverted, it didn't close).
  // The fix is a SHARED deadline applied identically to all 3 branches,
  // measured from request-start — these tests assert that convergence
  // property directly: whichever branch runs, the total response time
  // floors at the same `MIMIC_DELAY_TARGET_MS`(+jitter) window.
  //
  // `toFake: ['setTimeout', 'clearTimeout']` deliberately leaves
  // `performance.now()` REAL — the mocked DB/S3/compression calls all
  // resolve in native microtask time (no real I/O), so real elapsed time
  // between request-start and the padding call stays a few ms at most for
  // EVERY branch here, letting `padToSharedDeadline` compute close to the
  // full target for all three — exactly the scenario the fix targets
  // (near-zero real work, needs the floor to avoid leaking that).
  describe('shared timing-deadline — all 3 branches converge (security-review round 3, MED-2)', () => {
    async function assertResolvesWithinSharedDeadline(startApply: () => Promise<unknown>) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const promise = startApply()
        let resolved = false
        void promise.then(() => {
          resolved = true
        })

        // Flush mocked-call microtasks so the padding setTimeout is
        // actually scheduled before advancing fake time.
        await vi.advanceTimersByTimeAsync(0)
        expect(resolved).toBe(false)

        // Comfortably short of even the un-jittered floor — still pending
        // (generous margin below MIMIC_DELAY_TARGET_MS for real-elapsed
        // microtask overhead in the test harness itself).
        await vi.advanceTimersByTimeAsync(MIMIC_DELAY_TARGET_MS - 50)
        expect(resolved).toBe(false)

        // Comfortably past even the maximum jitter — must have resolved.
        await vi.advanceTimersByTimeAsync(MIMIC_DELAY_JITTER_MS + 100)
        expect(resolved).toBe(true)
        await expect(promise).resolves.toEqual({ ok: true })
      } finally {
        vi.useRealTimers()
      }
    }

    it('honeypot branch pads to the shared deadline', async () => {
      await assertResolvesWithinSharedDeadline(() =>
        h.svc.apply(
          'senior-frontend-engineer',
          { ...VALID_FIELDS, website: 'http://spam.example' },
          pdfFile(),
          '1.2.3.4',
        ),
      )
    })

    it('duplicate-update branch pads to the SAME shared deadline', async () => {
      h = makeHarness({ duplicateRow: existingApplicationRow() })
      await assertResolvesWithinSharedDeadline(() =>
        h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4'),
      )
    })

    it('genuine-new-application branch pads to the SAME shared deadline', async () => {
      await assertResolvesWithinSharedDeadline(() =>
        h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4'),
      )
    })
  })

  it('missing file → 400', async () => {
    await expect(
      h.svc.apply('senior-frontend-engineer', VALID_FIELDS, null, '1.2.3.4'),
    ).rejects.toThrow(BadRequestException)
  })

  it('file larger than 5MB → 413', async () => {
    const bigBuf = Buffer.alloc(6 * 1024 * 1024, 0)
    PDF_MAGIC_BUF.copy(bigBuf)
    await expect(
      h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile({ buffer: bigBuf }), '1.2.3.4'),
    ).rejects.toThrow(PayloadTooLargeException)
  })

  it('declared mimetype not application/pdf → 415', async () => {
    await expect(
      h.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile({ mimetype: 'image/png' }),
        '1.2.3.4',
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException)
  })

  it('magic-bytes mismatch (declared pdf, actual PNG content) → 415', async () => {
    await expect(
      h.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile({ buffer: PNG_MAGIC_BUF }),
        '1.2.3.4',
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException)
  })

  it('compression failure (CompressionError) → 415 with the service message', async () => {
    h.compression.compress.mockRejectedValue(new CompressionError('corrupt PDF'))
    await expect(
      h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4'),
    ).rejects.toThrow(UnsupportedMediaTypeException)
  })

  it('R2 upload failure compensates by deleting the DB row, then rethrows', async () => {
    h.s3.upload.mockRejectedValue(new Error('R2 unreachable'))
    await expect(
      h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4'),
    ).rejects.toThrow('R2 unreachable')
    expect(h.deletedApplicationIds).toHaveLength(1)
    expect(h.notifications.create).not.toHaveBeenCalled()
  })

  it('happy path: 201-equivalent {ok:true}, uploads to the expected key, notifies every recipient', async () => {
    const result = await h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.s3.upload).toHaveBeenCalledTimes(1)
    const [key, , , category] = h.s3.upload.mock.calls[0] as [string, Buffer, string, string]
    expect(key).toMatch(/^vacancy-applications\/vac-1\/.+\.pdf$/)
    // task-file-storage-hardening §3 — category is always passed so
    // S3Service can set the private/no-store cache header.
    expect(category).toBe('RESUME')
    expect(h.notifications.create).toHaveBeenCalledTimes(2)
    expect(h.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        type: 'VACANCY_APPLICATION',
        link: '/vacancies/vac-1',
      }),
    )
  })

  // task-file-storage-hardening §5 — the anti-bloat fallback must never
  // silently undo the pass-1 PDF metadata strip for this ONE public/
  // anonymous call site.
  it('compresses with neverFallbackToOriginal: true (never stores the unsanitized original)', async () => {
    await h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    expect(h.compression.compress).toHaveBeenCalledWith(PDF_MAGIC_BUF, 'application/pdf', {
      neverFallbackToOriginal: true,
    })
  })

  // task-file-storage-hardening §6 + MED-4 (security-review round 1) +
  // owner decision 2026-08-03 (security-review round 2): the duplicate
  // check runs AFTER file-shape validation, and — regardless of whether it
  // now UPDATES the row instead of no-op'ing — the RESPONSE for a fully
  // valid resubmission carries zero signal about whether that email
  // already applied. EVERY probe shape (no file, wrong MIME, or a fully
  // valid PDF) gets a response indistinguishable from a genuine
  // first-time submission.
  describe('enumeration-oracle ordering — fully closed (§6 + MED-4, still closed after owner decision 2026-08-03)', () => {
    it('missing file still 400s even when the email already applied (duplicate row exists) — NOT a fake success', async () => {
      h = makeHarness({ duplicateRow: existingApplicationRow() })
      await expect(
        h.svc.apply('senior-frontend-engineer', VALID_FIELDS, null, '1.2.3.4'),
      ).rejects.toThrow(BadRequestException)
    })

    it('wrong MIME still 415s even when the email already applied — NOT a fake success', async () => {
      h = makeHarness({ duplicateRow: existingApplicationRow() })
      await expect(
        h.svc.apply(
          'senior-frontend-engineer',
          VALID_FIELDS,
          pdfFile({ mimetype: 'image/png' }),
          '1.2.3.4',
        ),
      ).rejects.toThrow(UnsupportedMediaTypeException)
    })

    it('a fully valid resubmission (real PDF, matching MIME) ALSO mimics success — no residual 429 signal', async () => {
      h = makeHarness({ duplicateRow: existingApplicationRow() })
      const result = await h.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile(),
        '1.2.3.4',
      )
      expect(result).toEqual({ ok: true })
    })

    // Explicit three-way comparison, requested by the owner: the response
    // for (a) a duplicate that gets a real in-place update, (b) a genuine
    // brand-new submission, and (c) the honeypot bait must be byte-for-byte
    // identical — not just "happen to both be 2xx".
    it('duplicate-update / genuine-new / honeypot all resolve to the exact same response shape', async () => {
      const genuineHarness = makeHarness()
      const genuineResult = await genuineHarness.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile(),
        '1.2.3.4',
      )

      const duplicateHarness = makeHarness({ duplicateRow: existingApplicationRow() })
      const duplicateResult = await duplicateHarness.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile(),
        '1.2.3.4',
      )

      const honeypotHarness = makeHarness()
      const honeypotResult = await honeypotHarness.svc.apply(
        'senior-frontend-engineer',
        { ...VALID_FIELDS, website: 'http://spam.example' },
        pdfFile(),
        '1.2.3.4',
      )

      expect(genuineResult).toEqual({ ok: true })
      expect(duplicateResult).toEqual({ ok: true })
      expect(honeypotResult).toEqual({ ok: true })
      expect(genuineResult).toEqual(duplicateResult)
      expect(duplicateResult).toEqual(honeypotResult)
    })
  })

  it('happy path: notification title includes candidate name and vacancy title, never the raw email', async () => {
    await h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    const [call] = h.notifications.create.mock.calls as [{ title: string }][]
    expect(call[0].title).toContain('Ivan Petrenko')
    expect(call[0].title).toContain('Senior Frontend Engineer')
    expect(call[0].title).not.toContain(VALID_FIELDS.email)
  })

  // F6 (code MED) — notifyAdminsAndHr fans out via Promise.allSettled: one
  // recipient's notification failing must NOT fail apply() (the candidate's
  // submission already succeeded), and every recipient is still attempted.
  it('one recipient notification failing does not fail apply(); every recipient is still attempted', async () => {
    h = makeHarness({ recipients: [{ id: 'admin-1' }, { id: 'hr-1' }] })
    let callCount = 0
    h.notifications.create.mockImplementation(() => {
      callCount += 1
      return callCount === 1
        ? Promise.reject(new Error('notif service down'))
        : Promise.resolve(undefined)
    })

    const result = await h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.notifications.create).toHaveBeenCalledTimes(2)
  })
})

// F5 (sec MED-5) — Content-Disposition filename sanitization on the
// admin/HR resume-download endpoint.
describe('ApplicationsService.getResumeUrl()', () => {
  const ADMIN_ACTOR = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser

  function makeResumeHarness(
    fullName: string,
    opts: { resumeS3Key?: string | null; insertShouldThrow?: boolean } = {},
  ) {
    const s3 = {
      getPresignedDownloadUrl: vi
        .fn()
        .mockResolvedValue({ url: 'https://stub/x', expiresAt: '2026-01-01T00:10:00.000Z' }),
    }
    const vacanciesService = {
      getRowOrThrow: vi.fn().mockResolvedValue({ id: 'vac-1' }),
    }
    const row = {
      id: 'app-1',
      vacancyId: 'vac-1',
      fullName,
      resumeS3Key:
        opts.resumeS3Key === undefined ? 'vacancy-applications/vac-1/app-1.pdf' : opts.resumeS3Key,
    }
    const insertedRows: Record<string, unknown>[] = []
    const db = {
      db: {
        query: {
          vacancyApplications: {
            findFirst: vi.fn().mockResolvedValue(row),
          },
        },
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (opts.insertShouldThrow) return Promise.reject(new Error('DB down'))
            insertedRows.push(vals)
            return Promise.resolve(undefined)
          },
        }),
      },
    }
    const svc = new ApplicationsService(
      db as unknown as DatabaseService,
      vacanciesService as unknown as VacanciesService,
      s3 as unknown as S3Service,
      {} as unknown as CompressionService,
      {} as unknown as TurnstileService,
      {} as unknown as NotificationsService,
    )
    return { svc, s3, insertedRows }
  }

  it('strips ", backslash, CR and LF from the candidate fullName before building the download filename', async () => {
    const { svc, s3 } = makeResumeHarness('Ev"il\\Name\r\n')
    await svc.getResumeUrl(ADMIN_ACTOR, 'vac-1', 'app-1')
    const [, , downloadAs] = s3.getPresignedDownloadUrl.mock.calls[0] as [
      string,
      number,
      string,
      string,
    ]
    expect(downloadAs).toBe('EvilName.pdf')
  })

  it('leaves an ordinary fullName untouched (no over-stripping of legitimate characters)', async () => {
    const { svc, s3 } = makeResumeHarness("O'Brien-Petrenko Jr.")
    await svc.getResumeUrl(ADMIN_ACTOR, 'vac-1', 'app-1')
    const [, , downloadAs] = s3.getPresignedDownloadUrl.mock.calls[0] as [
      string,
      number,
      string,
      string,
    ]
    expect(downloadAs).toBe("O'Brien-Petrenko Jr..pdf")
  })

  // task-file-storage-hardening §2 — resumeS3Key is null once the 180-day
  // file-only retention purge has run: the application row survives, only
  // the file is gone. 404, and the presigned-URL call is never made.
  it('resumeS3Key=null (already retention-purged) → 404, no presign attempted', async () => {
    const { svc, s3 } = makeResumeHarness('Ivan Petrenko', { resumeS3Key: null })
    await expect(svc.getResumeUrl(ADMIN_ACTOR, 'vac-1', 'app-1')).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled()
  })

  // task-file-storage-hardening §7 — access-log entry on every successful
  // resume download; the URL itself must never be recorded.
  describe('access-log (§7)', () => {
    it('writes an access-log row with actor/application/category, WITHOUT the URL', async () => {
      const { svc, insertedRows } = makeResumeHarness('Ivan Petrenko')
      await svc.getResumeUrl(ADMIN_ACTOR, 'vac-1', 'app-1')

      expect(insertedRows).toHaveLength(1)
      const row = insertedRows[0]!
      expect(row['actorId']).toBe('admin-1')
      expect(row['targetId']).toBe('app-1')
      expect(row['action']).toBe('DOWNLOAD')
      expect(row['metadata']).toEqual({ category: 'RESUME', source: 'vacancy_application' })
      // Never carries the URL / anything URL-shaped.
      expect(JSON.stringify(row)).not.toContain('https://stub/x')
    })

    it('a failing access-log write does not block the download (best-effort)', async () => {
      const { svc, s3 } = makeResumeHarness('Ivan Petrenko', { insertShouldThrow: true })
      const result = await svc.getResumeUrl(ADMIN_ACTOR, 'vac-1', 'app-1')
      expect(result.url).toBe('https://stub/x')
      expect(s3.getPresignedDownloadUrl).toHaveBeenCalledTimes(1)
    })
  })
})

// task-candidate-card-resume (AC2/AC3) — preview URL (attachment
// disposition, same as download — see the method's doc comment for why),
// with its own 404-not-403 RBAC denial.
describe('ApplicationsService.getResumePreviewUrl()', () => {
  const ADMIN_ACTOR = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser
  const HR_ACTOR = { id: 'hr-1', role: 'HR' } as unknown as SessionUser
  const SENIOR_ACTOR = { id: 'senior-1', role: 'SENIOR' } as unknown as SessionUser

  function makeResumeHarness(
    fullName: string,
    opts: { resumeS3Key?: string | null; insertShouldThrow?: boolean } = {},
  ) {
    const s3 = {
      getPresignedDownloadUrl: vi
        .fn()
        .mockResolvedValue({ url: 'https://stub/preview', expiresAt: '2026-01-01T00:10:00.000Z' }),
    }
    const vacanciesService = {
      getRowOrThrow: vi.fn().mockResolvedValue({ id: 'vac-1' }),
    }
    const row = {
      id: 'app-1',
      vacancyId: 'vac-1',
      fullName,
      resumeS3Key:
        opts.resumeS3Key === undefined ? 'vacancy-applications/vac-1/app-1.pdf' : opts.resumeS3Key,
    }
    const insertedRows: Record<string, unknown>[] = []
    const db = {
      db: {
        query: {
          vacancyApplications: {
            findFirst: vi.fn().mockResolvedValue(row),
          },
        },
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (opts.insertShouldThrow) return Promise.reject(new Error('DB down'))
            insertedRows.push(vals)
            return Promise.resolve(undefined)
          },
        }),
      },
    }
    const svc = new ApplicationsService(
      db as unknown as DatabaseService,
      vacanciesService as unknown as VacanciesService,
      s3 as unknown as S3Service,
      {} as unknown as CompressionService,
      {} as unknown as TurnstileService,
      {} as unknown as NotificationsService,
    )
    return { svc, s3, insertedRows, vacanciesService }
  }

  it.each([ADMIN_ACTOR, HR_ACTOR])(
    '$role gets a 200-shaped presigned URL (attachment disposition, category RESUME)',
    async (actor) => {
      const { svc, s3 } = makeResumeHarness('Ivan Petrenko')
      const result = await svc.getResumePreviewUrl(actor, 'vac-1', 'app-1')
      expect(result.url).toBe('https://stub/preview')
      const [, , , disposition, category] = s3.getPresignedDownloadUrl.mock.calls[0] as [
        string,
        number,
        string,
        string,
        string,
      ]
      expect(disposition).toBe('attachment')
      expect(category).toBe('RESUME')
    },
  )

  // AC3 — a role outside ADMIN/HR is denied with 404 (NOT 403, unlike the
  // sibling getResumeUrl/download endpoint) — the vacancy/application lookup
  // is never even reached.
  it('SENIOR (role outside the team) → NotFoundException (404), no lookup attempted', async () => {
    const { svc, vacanciesService } = makeResumeHarness('Ivan Petrenko')
    await expect(svc.getResumePreviewUrl(SENIOR_ACTOR, 'vac-1', 'app-1')).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(vacanciesService.getRowOrThrow).not.toHaveBeenCalled()
  })

  it('resumeS3Key=null (retention-purged) → 404, no presign attempted', async () => {
    const { svc, s3 } = makeResumeHarness('Ivan Petrenko', { resumeS3Key: null })
    await expect(svc.getResumePreviewUrl(ADMIN_ACTOR, 'vac-1', 'app-1')).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled()
  })

  it('writes an access-log row with action=PREVIEW (distinct from DOWNLOAD)', async () => {
    const { svc, insertedRows } = makeResumeHarness('Ivan Petrenko')
    await svc.getResumePreviewUrl(ADMIN_ACTOR, 'vac-1', 'app-1')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]!['action']).toBe('PREVIEW')
  })

  it('a failing access-log write does not block the preview (best-effort)', async () => {
    const { svc, s3 } = makeResumeHarness('Ivan Petrenko', { insertShouldThrow: true })
    const result = await svc.getResumePreviewUrl(ADMIN_ACTOR, 'vac-1', 'app-1')
    expect(result.url).toBe('https://stub/preview')
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledTimes(1)
  })
})

// task-file-storage-hardening §4 — orphan-safe delete ordering: R2 object
// FIRST (throwing deleteOrThrow), DB row only after it succeeds. Mirrors
// VacanciesRetentionCronService's own ordering rationale.
describe('ApplicationsService.remove()', () => {
  const ADMIN_ACTOR = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser

  function makeRemoveHarness(opts: { resumeS3Key?: string | null; deleteShouldThrow?: boolean }) {
    const deletedKeys: string[] = []
    const deletedApplicationIds: string[] = []
    const s3 = {
      deleteOrThrow: vi.fn().mockImplementation((key: string) => {
        if (opts.deleteShouldThrow) return Promise.reject(new Error('R2 unreachable'))
        deletedKeys.push(key)
        return Promise.resolve(undefined)
      }),
    }
    const vacanciesService = {
      getRowOrThrow: vi.fn().mockResolvedValue({ id: 'vac-1' }),
    }
    const row = {
      id: 'app-1',
      vacancyId: 'vac-1',
      resumeS3Key:
        opts.resumeS3Key === undefined ? 'vacancy-applications/vac-1/app-1.pdf' : opts.resumeS3Key,
    }
    const db = {
      db: {
        query: {
          vacancyApplications: {
            findFirst: vi.fn().mockResolvedValue(row),
          },
        },
        delete: (_table: unknown) => ({
          where: async (_pred: unknown) => {
            deletedApplicationIds.push(row.id)
            return undefined
          },
        }),
      },
    }
    const svc = new ApplicationsService(
      db as unknown as DatabaseService,
      vacanciesService as unknown as VacanciesService,
      s3 as unknown as S3Service,
      {} as unknown as CompressionService,
      {} as unknown as TurnstileService,
      {} as unknown as NotificationsService,
    )
    return { svc, s3, deletedKeys, deletedApplicationIds }
  }

  it('deletes R2 object then the DB row, in that order', async () => {
    const { svc, deletedKeys, deletedApplicationIds } = makeRemoveHarness({})
    await svc.remove(ADMIN_ACTOR, 'vac-1', 'app-1')
    expect(deletedKeys).toEqual(['vacancy-applications/vac-1/app-1.pdf'])
    expect(deletedApplicationIds).toEqual(['app-1'])
  })

  it('a failed R2 delete leaves the DB row untouched (no orphan-inducing swallow)', async () => {
    const { svc, deletedApplicationIds } = makeRemoveHarness({ deleteShouldThrow: true })
    await expect(svc.remove(ADMIN_ACTOR, 'vac-1', 'app-1')).rejects.toThrow('R2 unreachable')
    expect(deletedApplicationIds).toHaveLength(0)
  })

  it('resumeS3Key already null (retention-purged) → skips S3 entirely, still deletes the row', async () => {
    const { svc, s3, deletedApplicationIds } = makeRemoveHarness({ resumeS3Key: null })
    await svc.remove(ADMIN_ACTOR, 'vac-1', 'app-1')
    expect(s3.deleteOrThrow).not.toHaveBeenCalled()
    expect(deletedApplicationIds).toEqual(['app-1'])
  })
})
