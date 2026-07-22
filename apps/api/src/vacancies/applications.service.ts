/**
 * ApplicationsService — task-vacancies-api.
 *
 * Owns two surfaces:
 *   1. `apply()` — the PUBLIC, unauthenticated vacancy-apply pipeline (fail-fast,
 *      strict order — see task §5): rate-limit is enforced at the controller
 *      (`@RelaxableThrottle`, not here) → honeypot → Zod field validation →
 *      Turnstile → vacancy lookup (PUBLISHED only) → duplicate check → size →
 *      MIME/magic-bytes → compress → persist (DB-first, S3 compensate) →
 *      notify ADMIN/HR.
 *   2. Admin application management (ADMIN | HR): list / update status /
 *      delete (row + R2 object) / presigned resume download URL.
 *
 * Reuse (no new upload pipeline invented): `S3Service.upload/delete/
 * getPresignedDownloadUrl` + `CompressionService.compress` + `detectMimeFromBuffer`
 * (all from the documents module) and `NotificationsService.create`.
 *
 * PII: candidate email/telegram are NEVER logged — only ids appear in
 * Logger calls. Notification title/body ARE allowed to carry the candidate's
 * name (that's the intended recipient-facing content, not a log).
 */
import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import {
  applyVacancyFieldsSchema,
  type SessionUser,
  type VacancyApplication,
  type VacancyApplicationResumeUrl,
  type VacancyApplicationStatus,
} from '@crm/shared'
import {
  CompressionError,
  CompressionService,
  detectMimeFromBuffer,
} from '../documents/compression.service'
import { S3Service } from '../documents/s3.service'
import { DatabaseService } from '../database/database.service'
import { users, vacancyApplications } from '../database/schema'
import { NotificationsService } from '../notifications/notifications.service'
import { TurnstileService } from './turnstile.service'
import { VacanciesService } from './vacancies.service'

/** Minimal shape of a multipart file part as handed over by the controller. */
export interface ApplyResumeFile {
  buffer: Buffer
  mimetype: string
  originalname: string
}

type ApplicationRow = typeof vacancyApplications.$inferSelect

/** Only PDF resumes are accepted (task §5.6). */
const RESUME_MIME = 'application/pdf'

/**
 * Buffer size hard cap — 5 MB (task: "PDF ≤ 5MB → R2"). Exported so
 * `PublicVacanciesController` can pass the SAME number as an explicit
 * per-route `req.parts({ limits: { fileSize: ... } })` cap (sec MED-2 / F3)
 * instead of letting the public apply endpoint inherit the more permissive
 * global multipart config from main.ts — single source of truth, no drift.
 */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024

/** Duplicate-submission window — same email + vacancy within 24h → 429. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Presigned resume-download TTL — 600s (task §Endpoints). */
const RESUME_PRESIGN_TTL_SEC = 600

/**
 * Strips characters that could break out of the ASCII-fallback
 * `filename="..."` parameter S3Service.getPresignedDownloadUrl() builds for
 * Content-Disposition (sec MED-5 / F5). `fullName` is candidate-controlled;
 * an unescaped `"` or `\` can confuse/spoof the quoted filename parameter.
 * CR/LF are stripped defensively too (S3Service's own asciiFallback already
 * drops all control chars, but this call site does not rely on that —
 * `s3.service.ts` is out of scope/blast-radius for this task). The
 * `filename*=UTF-8''...` companion parameter is unaffected (S3Service
 * percent-encodes it separately), so this only narrows the legacy ASCII
 * fallback, never the actual downloaded file content.
 */
function sanitizeDownloadFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '')
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly vacanciesService: VacanciesService,
    private readonly s3: S3Service,
    private readonly compression: CompressionService,
    private readonly turnstile: TurnstileService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public apply pipeline
  // ---------------------------------------------------------------------------

  async apply(
    slug: string,
    rawFields: Record<string, string>,
    file: ApplyResumeFile | null,
    remoteIp: string | undefined,
  ): Promise<{ ok: true }> {
    // ---- 1. Honeypot — raw check BEFORE schema validation ----
    // The `website` field is validated as max(0) in the schema too (defence
    // in depth), but the actual anti-bot mimicry MUST happen before we ever
    // touch Turnstile/DB/S3: a bot that fills the honeypot gets a fake 201
    // so it never learns which check tripped it.
    const honeypot = rawFields['website']
    if (honeypot && honeypot.length > 0) {
      this.logger.warn(
        'apply(): honeypot field non-empty — mimicking success (no further processing)',
      )
      return { ok: true }
    }

    // ---- 2. Validate the rest of the fields ----
    const fields = applyVacancyFieldsSchema.parse(rawFields)

    // ---- 3. Turnstile ----
    const turnstileOk = await this.turnstile.verify(fields.turnstileToken, remoteIp)
    if (!turnstileOk) {
      throw new BadRequestException('Проверка Turnstile не пройдена')
    }

    // ---- Vacancy lookup (PUBLISHED only — 404 otherwise, mirrors GET detail) ----
    const vacancy = await this.vacanciesService.getPublishedRowBySlug(slug)

    // ---- 4. Duplicate: same email + vacancy within 24h → 429 ----
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const duplicate = await this.db.db.query.vacancyApplications.findFirst({
      where: and(
        eq(vacancyApplications.vacancyId, vacancy.id),
        eq(vacancyApplications.email, fields.email),
        gte(vacancyApplications.createdAt, since),
      ),
    })
    if (duplicate) {
      throw new HttpException(
        'Вы уже откликались на эту вакансию за последние 24 часа',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    // ---- 5. Size ----
    if (!file) {
      throw new BadRequestException('Файл резюме обязателен')
    }
    if (file.buffer.length > RESUME_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Файл резюме больше ${Math.floor(RESUME_MAX_BYTES / 1024 / 1024)} MB`,
      )
    }

    // ---- 6. MIME + magic-bytes (PDF only) ----
    if (file.mimetype !== RESUME_MIME) {
      throw new UnsupportedMediaTypeException('Резюме должно быть в формате PDF')
    }
    const detectedMime = detectMimeFromBuffer(file.buffer)
    if (detectedMime !== RESUME_MIME) {
      throw new UnsupportedMediaTypeException(
        'Содержимое файла не соответствует формату PDF (magic-byte не распознан)',
      )
    }

    // ---- 7. Compress (strip PDF metadata) ----
    let compressed: Awaited<ReturnType<CompressionService['compress']>>
    try {
      compressed = await this.compression.compress(file.buffer, RESUME_MIME)
    } catch (err) {
      if (err instanceof CompressionError) {
        throw new UnsupportedMediaTypeException(err.message)
      }
      throw err
    }

    // ---- 8. Persist: DB row FIRST, then R2 upload (compensate on failure) ----
    const applicationId = randomUUID()
    const s3Key = `vacancy-applications/${vacancy.id}/${applicationId}.pdf`

    const [row] = await this.db.db
      .insert(vacancyApplications)
      .values({
        id: applicationId,
        vacancyId: vacancy.id,
        fullName: fields.fullName,
        email: fields.email,
        telegram: fields.telegram ?? null,
        linkedinUrl: fields.linkedinUrl ?? null,
        githubUrl: fields.githubUrl ?? null,
        coverLetter: fields.coverLetter ?? null,
        resumeS3Key: s3Key,
        resumeSizeBytes: compressed.sizeBytes,
      })
      .returning()

    if (!row) throw new Error('Failed to insert vacancy application')

    try {
      await this.s3.upload(s3Key, compressed.buffer, compressed.finalMimeType)
    } catch (err) {
      this.logger.error(
        `apply(): R2 upload failed for applicationId=${applicationId} — rolling back DB row: ${(err as Error).message}`,
      )
      await this.db.db.delete(vacancyApplications).where(eq(vacancyApplications.id, applicationId))
      throw err
    }

    // ---- 9. Notify every ADMIN/HR user ----
    await this.notifyAdminsAndHr(vacancy.id, vacancy.title, row.fullName)

    return { ok: true }
  }

  // ---------------------------------------------------------------------------
  // Admin application management (ADMIN | HR)
  // ---------------------------------------------------------------------------

  async list(actor: SessionUser, vacancyId: string): Promise<VacancyApplication[]> {
    this.assertAdminOrHr(actor)
    await this.vacanciesService.getRowOrThrow(vacancyId)

    const rows = await this.db.db
      .select()
      .from(vacancyApplications)
      .where(eq(vacancyApplications.vacancyId, vacancyId))
      .orderBy(desc(vacancyApplications.createdAt))
    return rows.map((r) => this.mapApplication(r))
  }

  async updateStatus(
    actor: SessionUser,
    vacancyId: string,
    applicationId: string,
    status: VacancyApplicationStatus,
  ): Promise<VacancyApplication> {
    this.assertAdminOrHr(actor)
    await this.getApplicationOrThrow(vacancyId, applicationId)

    const [updated] = await this.db.db
      .update(vacancyApplications)
      .set({ status })
      .where(eq(vacancyApplications.id, applicationId))
      .returning()
    if (!updated) throw new Error('Failed to update vacancy application')
    return this.mapApplication(updated)
  }

  /** Deletes the DB row AND the R2 object. S3Service.delete is idempotent/non-throwing. */
  async remove(actor: SessionUser, vacancyId: string, applicationId: string): Promise<void> {
    this.assertAdminOrHr(actor)
    const row = await this.getApplicationOrThrow(vacancyId, applicationId)

    await this.db.db.delete(vacancyApplications).where(eq(vacancyApplications.id, applicationId))
    await this.s3.delete(row.resumeS3Key)
  }

  async getResumeUrl(
    actor: SessionUser,
    vacancyId: string,
    applicationId: string,
  ): Promise<VacancyApplicationResumeUrl> {
    this.assertAdminOrHr(actor)
    const row = await this.getApplicationOrThrow(vacancyId, applicationId)

    return this.s3.getPresignedDownloadUrl(
      row.resumeS3Key,
      RESUME_PRESIGN_TTL_SEC,
      `${sanitizeDownloadFilename(row.fullName)}.pdf`,
      'attachment',
    )
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private assertAdminOrHr(actor: SessionUser): void {
    if (actor.role !== 'ADMIN' && actor.role !== 'HR') {
      throw new ForbiddenException('Доступно только ADMIN и HR')
    }
  }

  /** Application must exist AND belong to the given vacancyId (IDOR guard). */
  private async getApplicationOrThrow(
    vacancyId: string,
    applicationId: string,
  ): Promise<ApplicationRow> {
    await this.vacanciesService.getRowOrThrow(vacancyId)
    const row = await this.db.db.query.vacancyApplications.findFirst({
      where: eq(vacancyApplications.id, applicationId),
    })
    if (!row || row.vacancyId !== vacancyId) {
      throw new NotFoundException('Отклик не найден')
    }
    return row
  }

  private async notifyAdminsAndHr(
    vacancyId: string,
    vacancyTitle: string,
    candidateFullName: string,
  ): Promise<void> {
    const recipients = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.role, ['ADMIN', 'HR']))

    // Fan out in parallel (code MED / F6) — a sequential await-loop turned N
    // ADMIN/HR recipients into N sequential round-trips. `Promise.allSettled`
    // fires every notification concurrently and never rejects itself, so one
    // recipient's failure (e.g. a transient DB hiccup) cannot roll back
    // `apply()` — the candidate's submission already succeeded.
    const results = await Promise.allSettled(
      recipients.map((recipient) =>
        this.notifications.create({
          userId: recipient.id,
          type: 'VACANCY_APPLICATION',
          title: `Новый отклик: ${candidateFullName} — ${vacancyTitle}`,
          link: `/vacancies/${vacancyId}`,
        }),
      ),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `notifyAdminsAndHr(): one notification failed to create (apply() still succeeds): ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        )
      }
    }
  }

  private mapApplication(row: ApplicationRow): VacancyApplication {
    return {
      id: row.id,
      vacancyId: row.vacancyId,
      fullName: row.fullName,
      email: row.email,
      telegram: row.telegram ?? null,
      linkedinUrl: row.linkedinUrl ?? null,
      githubUrl: row.githubUrl ?? null,
      coverLetter: row.coverLetter ?? null,
      resumeSizeBytes: row.resumeSizeBytes,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
