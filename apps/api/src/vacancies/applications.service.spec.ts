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
  HttpException,
  HttpStatus,
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

  it('duplicate email+vacancy within 24h → 429', async () => {
    h = makeHarness({ duplicateRow: { id: 'existing-app' } })
    const call = h.svc.apply('senior-frontend-engineer', VALID_FIELDS, pdfFile(), '1.2.3.4')
    await expect(call).rejects.toBeInstanceOf(HttpException)
    await expect(call).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS })
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
    const [key] = h.s3.upload.mock.calls[0] as [string, Buffer, string]
    expect(key).toMatch(/^vacancy-applications\/vac-1\/.+\.pdf$/)
    expect(h.notifications.create).toHaveBeenCalledTimes(2)
    expect(h.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        type: 'VACANCY_APPLICATION',
        link: '/vacancies/vac-1',
      }),
    )
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
  const ADMIN_ACTOR = { role: 'ADMIN' } as unknown as SessionUser

  function makeResumeHarness(fullName: string) {
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
      resumeS3Key: 'vacancy-applications/vac-1/app-1.pdf',
    }
    const db = {
      db: {
        query: {
          vacancyApplications: {
            findFirst: vi.fn().mockResolvedValue(row),
          },
        },
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
    return { svc, s3 }
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
})
