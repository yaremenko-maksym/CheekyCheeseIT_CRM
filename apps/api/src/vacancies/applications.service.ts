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
import { documentAccessLog, users, vacancyApplications } from '../database/schema'
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

/**
 * Duplicate-submission window — same email + vacancy within 24h is treated
 * as a repeat and mimics success with no further processing (see the
 * MED-4 comment on the duplicate check itself, further down, for why this
 * is `{ ok: true }` and not a 429 anymore).
 */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Timing-side-channel mitigation (security-review round 2, MED item 3):
 * the honeypot and duplicate branches both short-circuit BEFORE the
 * genuinely expensive work (compress → DB insert → R2 upload → notify
 * ADMIN/HR), so even with an identical status code and body, an attacker
 * measuring response latency could still tell "mimicked success" (fast)
 * apart from "genuine new submission" (slower) — the same oracle MED-4
 * closed for status/shape, left open for timing.
 *
 * This is NOT a perfect fix: real genuine-path latency varies with the
 * attacker's OWN uploaded file size (bigger PDF → slower compress/upload)
 * and with real R2 network conditions in prod, neither of which this
 * service can predict or replicate exactly server-side without doing the
 * same amount of real work (which would defeat the point of mimicking).
 * What IS cheap and worth doing: pad the mimicked-success branches with a
 * randomized delay in the same ballpark as a typical genuine submission,
 * so a timing probe needs many more samples (and a stable network) to
 * extract a signal, instead of a single request.
 *
 * Range grounded in a real (if small-scale) measurement: compressing a
 * synthetic 3-page/~5KB resume PDF via CompressionService + a real
 * PutObjectCommand round-trip to local MinIO averaged ~11ms combined
 * (loopback, tiny file) — production R2 network latency and a realistic
 * multi-page/multi-MB uploaded resume both push the real number well
 * above that floor, plus the notify-admins DB round-trip is not included
 * in that measurement at all. 150–350ms is a deliberately generous,
 * still-cheap floor (a few hundred ms is invisible to a legitimate
 * applicant, submitting once) rather than an attempt at an exact match —
 * the residual gap (variance from file size / real network jitter) is an
 * accepted, documented risk, not something this delay claims to close
 * completely.
 */
// Exported (not just internal) so the unit spec can assert the ACTUAL
// mimicked-success branches respect this documented range via fake timers,
// instead of only asserting the constant exists.
export const MIMIC_DELAY_MIN_MS = 150
export const MIMIC_DELAY_MAX_MS = 350

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

/**
 * `await`ed by the honeypot/duplicate "mimicked success" branches — see the
 * `MIMIC_DELAY_MIN_MS`/`MIMIC_DELAY_MAX_MS` doc comment for the full
 * rationale. Randomized (not fixed) so the delay itself doesn't become a
 * new, perfectly-constant tell.
 */
function mimicRealisticProcessingDelay(): Promise<void> {
  const ms = MIMIC_DELAY_MIN_MS + Math.random() * (MIMIC_DELAY_MAX_MS - MIMIC_DELAY_MIN_MS)
  return new Promise((resolve) => setTimeout(resolve, ms))
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
      await mimicRealisticProcessingDelay()
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

    // ---- 4. Size ----
    if (!file) {
      throw new BadRequestException('Файл резюме обязателен')
    }
    if (file.buffer.length > RESUME_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Файл резюме больше ${Math.floor(RESUME_MAX_BYTES / 1024 / 1024)} MB`,
      )
    }

    // ---- 5. MIME + magic-bytes (PDF only) ----
    if (file.mimetype !== RESUME_MIME) {
      throw new UnsupportedMediaTypeException('Резюме должно быть в формате PDF')
    }
    const detectedMime = detectMimeFromBuffer(file.buffer)
    if (detectedMime !== RESUME_MIME) {
      throw new UnsupportedMediaTypeException(
        'Содержимое файла не соответствует формату PDF (magic-byte не распознан)',
      )
    }

    // ---- 6. Duplicate: same email + vacancy within 24h → mimic success ----
    // task-file-storage-hardening §6 (enumeration oracle) + MED-4
    // (security-review round 1, full closure): this check used to run
    // BEFORE the file-presence/size/MIME checks above, so a request sent
    // with NO file at all still reached it — an anonymous caller could send
    // `email` + a valid Turnstile token with no file and read off the status
    // code (429 = "this email already applied" vs 400 = "file required") to
    // establish whether a specific person had applied to a specific vacancy,
    // without ever needing a real resume. Moving the check after file-shape
    // validation closed the FREE, file-less version — but a probe supplying
    // a syntactically valid throwaway PDF could still observe the honest 429
    // and learn the same fact (MED-4: "запрос с любым валидным PDF
    // по-прежнему различает «откликался» и «нет»"). Full closure: mimic the
    // honeypot branch's contract exactly — a duplicate resolves as
    // `{ ok: true }` with NO further processing (no compress/persist/notify),
    // indistinguishable in status code and response shape from a genuine
    // first-time submission. The cost is UX (a real accidental resubmission
    // gets a silent no-op instead of an explicit "you already applied"
    // message) — the SAME trade-off the honeypot branch already makes, and
    // the only way to make the response carry zero signal either way.
    //
    // TIMING (security-review round 2, MED item 3): status/shape alone
    // aren't enough — this branch is still measurably FASTER than the
    // genuine path below (no compress/upload/notify), so `await
    // mimicRealisticProcessingDelay()` pads it before returning. See that
    // helper's doc comment for the full rationale and its honestly-stated
    // limits (this narrows, not eliminates, the timing gap).
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const duplicate = await this.db.db.query.vacancyApplications.findFirst({
      where: and(
        eq(vacancyApplications.vacancyId, vacancy.id),
        eq(vacancyApplications.email, fields.email),
        gte(vacancyApplications.createdAt, since),
      ),
    })
    if (duplicate) {
      this.logger.warn(
        'apply(): duplicate email+vacancy within 24h — mimicking success (no further processing)',
      )
      await mimicRealisticProcessingDelay()
      return { ok: true }
    }

    // ---- 7. Compress (strip PDF metadata) ----
    // `neverFallbackToOriginal: true` (task-file-storage-hardening §5): this
    // is the ONE call site in the codebase that stores an anonymous public
    // submission verbatim on the default anti-bloat fallback path. Without
    // this flag, CompressionService's anti-bloat guard would silently return
    // the applicant's ORIGINAL bytes whenever pdf-lib's object-stream re-save
    // happens to be >= the input size — undoing the pass-1 metadata strip
    // above and storing the exact unsanitized file the applicant uploaded.
    let compressed: Awaited<ReturnType<CompressionService['compress']>>
    try {
      compressed = await this.compression.compress(file.buffer, RESUME_MIME, {
        neverFallbackToOriginal: true,
      })
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
      await this.s3.upload(s3Key, compressed.buffer, compressed.finalMimeType, 'RESUME')
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

  /**
   * Deletes the R2 object FIRST, then the DB row — mirrors
   * `VacanciesRetentionCronService.purgeExpiredApplications()`'s ordering
   * (task-file-storage-hardening §4). This used to delete the DB row first
   * and call the SWALLOWING `S3Service.delete()` second: a transient R2
   * failure then left the row gone but the PII resume orphaned in storage —
   * nothing left referenced that key any more, so it would sit there
   * forever (the reconciler treats anything past its grace window and
   * absent from the DB as an orphan to DELETE, not as "retry me"; see
   * DocumentsReconciliationService). Deleting R2 FIRST with the throwing
   * `deleteOrThrow` means a failed object delete leaves the row (and its
   * file) untouched — the caller sees the request fail and can retry from
   * the UI, exactly the same recovery path the cron gets automatically on
   * its next run. `resumeS3Key` may already be `null` here (the application
   * survived past the 180-day file-only retention purge, §2) — skip the S3
   * call entirely in that case, there is nothing left to delete.
   */
  async remove(actor: SessionUser, vacancyId: string, applicationId: string): Promise<void> {
    this.assertAdminOrHr(actor)
    const row = await this.getApplicationOrThrow(vacancyId, applicationId)

    if (row.resumeS3Key) {
      await this.s3.deleteOrThrow(row.resumeS3Key)
    }
    await this.db.db.delete(vacancyApplications).where(eq(vacancyApplications.id, applicationId))
  }

  async getResumeUrl(
    actor: SessionUser,
    vacancyId: string,
    applicationId: string,
  ): Promise<VacancyApplicationResumeUrl> {
    this.assertAdminOrHr(actor)
    const row = await this.getApplicationOrThrow(vacancyId, applicationId)

    // task-file-storage-hardening §2: `resumeS3Key` is null once the 180-day
    // file-only retention purge has already run for this application — the
    // application row itself survives (contact info stays for hiring
    // history), only the resume file is gone. 404 is the natural status: the
    // resource this endpoint serves genuinely no longer exists.
    if (!row.resumeS3Key) {
      throw new NotFoundException('Резюме удалено по истечении срока хранения')
    }

    // task-file-storage-hardening §7: best-effort access-log entry — "who
    // downloaded this resume and when" was previously unanswerable. Never
    // records the presigned URL itself, only the actor/application/category.
    // A logging failure must not block the actual download.
    try {
      await this.db.db.insert(documentAccessLog).values({
        actorId: actor.id,
        targetId: row.id,
        action: 'DOWNLOAD',
        metadata: { category: 'RESUME', source: 'vacancy_application' },
      })
    } catch (err) {
      this.logger.warn(
        `getResumeUrl: failed to write access-log row for applicationId=${row.id}: ${(err as Error).message}`,
      )
    }

    return this.s3.getPresignedDownloadUrl(
      row.resumeS3Key,
      RESUME_PRESIGN_TTL_SEC,
      `${sanitizeDownloadFilename(row.fullName)}.pdf`,
      'attachment',
      'RESUME',
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
