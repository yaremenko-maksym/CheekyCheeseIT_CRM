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
import { ApplicationsService, type ApplyResumeFile } from './applications.service'
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

interface Harness {
  svc: ApplicationsService
  vacanciesService: { getPublishedRowBySlug: ReturnType<typeof vi.fn> }
  turnstile: { verify: ReturnType<typeof vi.fn> }
  s3: { upload: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
  compression: { compress: ReturnType<typeof vi.fn> }
  notifications: { create: ReturnType<typeof vi.fn> }
  deletedApplicationIds: string[]
}

function makeHarness(
  opts: {
    duplicateRow?: unknown
    recipients?: { id: string }[]
    turnstileValid?: boolean
  } = {},
): Harness {
  const deletedApplicationIds: string[] = []

  const vacanciesService = {
    getPublishedRowBySlug: vi.fn().mockResolvedValue(VACANCY_ROW),
  }
  const turnstile = {
    verify: vi.fn().mockResolvedValue(opts.turnstileValid ?? true),
  }
  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
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

  return { svc, vacanciesService, turnstile, s3, compression, notifications, deletedApplicationIds }
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

  // task-file-storage-hardening MED-4 (security-review round 1, full oracle
  // closure): a duplicate now mimics success exactly like the honeypot
  // branch — no 429, no compress/persist/notify — so the response is
  // structurally indistinguishable from a genuine first-time submission.
  it('duplicate email+vacancy within 24h → mimics success {ok:true}, no compress/upload/notify', async () => {
    h = makeHarness({ duplicateRow: { id: 'existing-app' } })
    const result = await h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    expect(result).toEqual({ ok: true })
    expect(h.compression.compress).not.toHaveBeenCalled()
    expect(h.s3.upload).not.toHaveBeenCalled()
    expect(h.notifications.create).not.toHaveBeenCalled()
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

  // task-file-storage-hardening §6 + MED-4 (security-review round 1, full
  // closure) — enumeration oracle: the duplicate check runs AFTER file-shape
  // validation AND now mimics success instead of an honest 429 — so EVERY
  // probe shape (no file, wrong MIME, or a fully valid PDF) gets a response
  // that carries zero signal about whether that email already applied.
  describe('enumeration-oracle ordering — fully closed (§6 + MED-4)', () => {
    it('missing file still 400s even when the email already applied (duplicate row exists) — NOT a fake success', async () => {
      h = makeHarness({ duplicateRow: { id: 'existing-app' } })
      await expect(
        h.svc.apply('senior-frontend-engineer', VALID_FIELDS, null, '1.2.3.4'),
      ).rejects.toThrow(BadRequestException)
    })

    it('wrong MIME still 415s even when the email already applied — NOT a fake success', async () => {
      h = makeHarness({ duplicateRow: { id: 'existing-app' } })
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
      h = makeHarness({ duplicateRow: { id: 'existing-app' } })
      const result = await h.svc.apply(
        'senior-frontend-engineer',
        VALID_FIELDS,
        pdfFile(),
        '1.2.3.4',
      )
      expect(result).toEqual({ ok: true })
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
