/**
 * ApplicationsService — task-vacancies-api.
 *
 * Owns two surfaces:
 *   1. `apply()` — the PUBLIC, unauthenticated vacancy-apply pipeline (fail-fast,
 *      strict order — see task §5): rate-limit is enforced at the controller
 *      (`@RelaxableThrottle`, not here) → honeypot → Zod field validation →
 *      Turnstile → vacancy lookup (PUBLISHED only) → size → MIME/magic-bytes
 *      → duplicate check (same email+vacancy within 24h → UPDATE the
 *      existing row in place instead of a fresh insert, see
 *      `updateDuplicateApplication` — owner decision 2026-08-03) → compress
 *      → persist (DB-first, S3 compensate) → notify ADMIN/HR.
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
  sanitizeDownloadFilename,
  type ApplyVacancyFields,
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
 * as a repeat. OWNER DECISION 2026-08-03 (overturns the round-1 MED-4
 * "silent no-op" — see the duplicate-check comment further down for the
 * full history): a repeat submission UPDATES the existing application row
 * in place (new resume/size/cover-letter/time) instead of being silently
 * discarded — a candidate resubmitting a corrected resume gets what they
 * expect. The RESPONSE stays `{ ok: true }` either way (that part of MED-4
 * is unchanged — the enumeration-oracle closure doesn't depend on whether
 * anything was actually written, only on the response being identical).
 */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Timing-side-channel mitigation — REWORKED (security-review round 3,
 * MED-2). History matters here, so keeping it:
 *
 * Round 2 attempt (REJECTED, kept as a cautionary note): added a flat
 * 150–350ms delay ONLY to the honeypot/duplicate short-circuit branches,
 * reasoning that the genuine-new path was "slower" so padding the fast
 * branches would close the gap. Round 3 review measured it properly: an
 * attacker controls the uploaded file, so the genuine path on a MINIMAL
 * PDF actually runs in ~60–150ms — BELOW the round-2 floor, not above it.
 * The two ranges (60–150 vs 150–350) don't even overlap. The channel
 * didn't close, it INVERTED: duplicates became reliably SLOWER instead of
 * reliably faster — same amplitude of leak, opposite sign. Padding only
 * the short-circuit branches can never work in general, because "how much
 * slower is genuine than short-circuit" depends on attacker-chosen input
 * (file size), which this service doesn't control.
 *
 * Round 3 fix: a SINGLE shared deadline, applied identically to ALL THREE
 * branches (honeypot / duplicate-update / genuine-new), measured from the
 * top of `apply()`. Whichever branch runs, the TOTAL wall-clock time from
 * request-start to response is floored at `MIMIC_DELAY_TARGET_MS` (plus a
 * small random jitter, picked once per request) — a branch that already
 * took longer than the target is NOT cut short (this only pads up, never
 * down), a branch that finished early waits out the remainder. This is
 * genuinely branch-agnostic: the padding amount for a given request
 * depends only on how much real work THAT request's own branch already
 * did, not on which branch it was.
 *
 * MIMIC_DELAY_TARGET_MS chosen with real margin above the round-3 review's
 * own genuine-minimal-PDF measurement (~60–150ms) — this repo's prod
 * backend is Cloudflare R2 over a real network, not loopback MinIO, so
 * production latency for even a minimal upload sits meaningfully higher
 * than that local number, and a realistic multi-page resume higher still.
 * 500ms leaves headroom for both without being a noticeably slow UX for a
 * one-off form submission.
 *
 * A large, attacker-chosen upload CAN still exceed the floor and run
 * longer than 500ms+jitter — that is expected and NOT a re-opened channel:
 * it reveals "this specific upload was large/slow", which is equally true
 * whether the email was new or a duplicate, so it carries no signal about
 * the thing an attacker actually wants to learn (did THIS email already
 * apply). The floor's job is only to remove the CHEAP, near-zero-effort
 * signal a naive single request used to leak.
 *
 * Honest limits (documented, not swept under the rug — same discipline as
 * round 2's note, corrected for what round 3 found): this is still not a
 * complete defense by itself. What actually makes large-scale probing
 * impractical is the COMBINATION of: rate limiting (`@RelaxableThrottle`
 * at the controller), mandatory Turnstile on every request, and the
 * NOISE every probe against a clean (never-applied) email creates — it
 * always creates a real application row and sends a real ADMIN/HR
 * notification, which is expensive/visible at scale regardless of this
 * delay. This floor exists so RESPONSE TIME ALONE doesn't hand an
 * attacker a free, silent side-channel on top of those — it is a
 * supporting measure, not the primary one.
 */
// Exported (not just internal) so the unit spec can assert the ACTUAL
// behaviour (all three branches converge on the same floor) via fake
// timers, instead of only asserting the constants exist.
export const MIMIC_DELAY_TARGET_MS = 500
export const MIMIC_DELAY_JITTER_MS = 150

/** Presigned resume-download TTL — 600s (task §Endpoints). */
const RESUME_PRESIGN_TTL_SEC = 600

/**
 * Picks THIS request's target deadline once, at the top of `apply()` —
 * `MIMIC_DELAY_TARGET_MS` plus a random jitter in `[0, MIMIC_DELAY_JITTER_MS)`.
 * The SAME value is reused at whichever of the 3 return points this
 * request actually hits (see `padToSharedDeadline`) — picking it once per
 * request (not once per branch) is what makes the padding branch-agnostic.
 */
function pickDeadlineTargetMs(): number {
  return MIMIC_DELAY_TARGET_MS + Math.random() * MIMIC_DELAY_JITTER_MS
}

/**
 * `await`ed at all 3 of `apply()`'s return points (honeypot / duplicate-
 * update / genuine-new) — see the `MIMIC_DELAY_TARGET_MS` doc comment for
 * the full round-3 rationale. `startedAt` is a `performance.now()`
 * timestamp captured at the very top of `apply()`; `targetMs` is this
 * request's own deadline from `pickDeadlineTargetMs()`. Only pads UP
 * (never returns early) — a branch that already took longer than the
 * target is left alone.
 */
function padToSharedDeadline(startedAt: number, targetMs: number): Promise<void> {
  const remaining = targetMs - (performance.now() - startedAt)
  if (remaining <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, remaining))
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
    // security-review round 3, MED-2: captured ONCE per request, at the
    // very top — see `MIMIC_DELAY_TARGET_MS`'s doc comment. Every return
    // point below pads to the SAME deadline via `padToSharedDeadline`.
    const requestStartedAt = performance.now()
    const deadlineTargetMs = pickDeadlineTargetMs()

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
      await padToSharedDeadline(requestStartedAt, deadlineTargetMs)
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

    // ---- 6. Duplicate: same email + vacancy within 24h → UPDATE in place ----
    // task-file-storage-hardening §6 (enumeration oracle) + MED-4
    // (security-review round 1): this check used to run BEFORE the
    // file-presence/size/MIME checks above, so a request sent with NO file
    // at all still reached it — an anonymous caller could send `email` + a
    // valid Turnstile token with no file and read off the status code
    // (429 = "this email already applied" vs 400 = "file required") to
    // establish whether a specific person had applied to a specific
    // vacancy, without ever needing a real resume. Moving the check after
    // file-shape validation closed the FREE, file-less version — but a
    // probe supplying a syntactically valid throwaway PDF could still
    // observe the honest 429 and learn the same fact (MED-4: "запрос с
    // любым валидным PDF по-прежнему различает «откликался» и «нет»").
    // Round-1 fix: mimic the honeypot branch's contract exactly — the
    // RESPONSE for a duplicate is `{ ok: true }`, identical in status code
    // and shape to a genuine first-time submission, no matter what the
    // request actually did server-side. That part is UNCHANGED below.
    //
    // OWNER DECISION 2026-08-03 (overturns round-1's "no further
    // processing" — flagged in the PR body as MY product call, not the
    // owner's, and the owner corrected it): a genuine repeat submission —
    // e.g. a candidate resending a corrected resume — used to be silently
    // discarded, which is a worse UX than the enumeration-oracle fix
    // needed to buy. A duplicate now UPDATES the EXISTING row in place
    // (`updateDuplicateApplication`: new resume file, new size, new cover
    // letter, reset submission time) instead of a no-op — the candidate
    // gets what they expect. The RESPONSE staying `{ ok: true }` either
    // way is what keeps the oracle closed; whether anything was actually
    // written server-side was never observable from the response, so this
    // doesn't reopen MED-4 — see `updateDuplicateApplication`'s own doc
    // comment for how the OLD file is guaranteed not to survive as an
    // orphan (the exact class of bug §4 of this same task fixed).
    //
    // TIMING (security-review round 2 MED item 3, REWORKED round 3 MED-2):
    // status/shape alone aren't enough — see `MIMIC_DELAY_TARGET_MS`'s doc
    // comment for the full history of why a flat per-branch delay failed
    // and what replaced it (a shared, request-wide deadline).
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const duplicate = await this.db.db.query.vacancyApplications.findFirst({
      where: and(
        eq(vacancyApplications.vacancyId, vacancy.id),
        eq(vacancyApplications.email, fields.email),
        gte(vacancyApplications.createdAt, since),
      ),
    })
    if (duplicate) {
      await this.updateDuplicateApplication(duplicate, vacancy.id, fields, file)
      await padToSharedDeadline(requestStartedAt, deadlineTargetMs)
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
    // Extracted to `compressResume` (security-review round 2 follow-up,
    // owner decision 2026-08-03) — `updateDuplicateApplication` below needs
    // the exact same compress-with-error-mapping behaviour.
    const compressed = await this.compressResume(file.buffer)

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

    // Same shared deadline as the other 2 branches (security-review round
    // 3, MED-2) — usually a no-op here since the genuine path's real work
    // (compress/insert/upload/notify) is normally the slowest of the
    // three, but included for a REAL reason, not just symmetry: a tiny
    // file + fast local storage (dev/test) can finish under the floor too,
    // and the floor is what removes the "how fast can genuine possibly be"
    // question from the attacker's toolkit entirely.
    await padToSharedDeadline(requestStartedAt, deadlineTargetMs)

    return { ok: true }
  }

  /**
   * Compress + strip metadata for an applicant-uploaded resume PDF, mapping
   * a `CompressionError` to the same 415 both `apply()` call sites already
   * threw before this was extracted (security-review round 2 follow-up,
   * owner decision 2026-08-03 — `updateDuplicateApplication` below needs
   * the identical behaviour, not a second copy of the try/catch).
   */
  private async compressResume(
    buffer: Buffer,
  ): Promise<Awaited<ReturnType<CompressionService['compress']>>> {
    try {
      return await this.compression.compress(buffer, RESUME_MIME, {
        neverFallbackToOriginal: true,
      })
    } catch (err) {
      if (err instanceof CompressionError) {
        throw new UnsupportedMediaTypeException(err.message)
      }
      throw err
    }
  }

  /**
   * OWNER DECISION 2026-08-03 (security-review round 2 — overturns round
   * 1's MED-4 "silent no-op" for a genuine repeat submission): update the
   * EXISTING application row in place instead of discarding the corrected
   * resume. Called from the duplicate branch of `apply()`; the RESPONSE
   * stays `{ ok: true }` regardless of what happens in here — see the
   * caller's doc comment for why that keeps the enumeration oracle closed.
   *
   * Ordering deliberately mirrors `remove()`'s established "storage first,
   * throwing" discipline (same helper, `S3Service.deleteOrThrow`), adapted
   * for an UPDATE instead of a full delete:
   *
   *   1. Upload the NEW file under a FRESH key. If this throws, nothing
   *      else has been touched yet — the existing row and its old file are
   *      exactly as they were (the safest possible failure: "as if the
   *      resubmission never happened").
   *   2. `deleteOrThrow` the OLD key BEFORE the row is touched. If this
   *      throws, best-effort delete the just-uploaded new file (so this
   *      doesn't depend on the orphan reconciler for a fully avoidable
   *      case) and rethrow WITHOUT updating the row. Because the row is
   *      never reached in this failure path, the forbidden end-state —
   *      "record updated AND both the old and new file present in
   *      storage" — cannot happen by construction: the row can only ever
   *      become "updated" once the old file is confirmed gone.
   *   3. Update the row (new key / size / cover letter / reset submission
   *      time). By the time this runs there is only ever ONE resume file
   *      for this application in storage — reproducing the exact "orphan
   *      file with personal data" class of bug that task-file-storage-
   *      hardening §4 (this same PR) fixed would defeat the point of that
   *      fix.
   *
   * `fullName`/`email`/`telegram`/`linkedinUrl`/`githubUrl` are
   * deliberately NOT touched — the owner's instruction scoped the update to
   * "резюме, размер, сопроводительное, время" (resume, size, cover letter,
   * time); email is the dedup key so it cannot change, and re-scoping the
   * other contact fields was never asked for.
   */
  private async updateDuplicateApplication(
    duplicate: ApplicationRow,
    vacancyId: string,
    fields: ApplyVacancyFields,
    file: ApplyResumeFile,
  ): Promise<void> {
    const compressed = await this.compressResume(file.buffer)
    const newS3Key = `vacancy-applications/${vacancyId}/${randomUUID()}.pdf`

    await this.s3.upload(newS3Key, compressed.buffer, compressed.finalMimeType, 'RESUME')

    if (duplicate.resumeS3Key) {
      try {
        await this.s3.deleteOrThrow(duplicate.resumeS3Key)
      } catch (err) {
        this.logger.error(
          `apply(): resubmission old-file delete failed for applicationId=${duplicate.id} — ` +
            `compensating by deleting the just-uploaded new file; application row NOT updated: ${(err as Error).message}`,
        )
        await this.s3.delete(newS3Key)
        throw err
      }
    }

    await this.db.db
      .update(vacancyApplications)
      .set({
        resumeS3Key: newS3Key,
        resumeSizeBytes: compressed.sizeBytes,
        coverLetter: fields.coverLetter ?? null,
        createdAt: new Date(),
      })
      .where(eq(vacancyApplications.id, duplicate.id))

    this.logger.warn(
      `apply(): duplicate email+vacancy within 24h — updated existing application in place (applicationId=${duplicate.id})`,
    )
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
    return this.presignResume(actor, vacancyId, applicationId, 'attachment', 'DOWNLOAD')
  }

  /**
   * task-candidate-card-resume (AC2/AC3) — presigned URL for the in-CRM
   * resume preview (CandidateCard "Просмотр"). Deliberately NOT gated by
   * `@Roles('ADMIN','HR')` at the controller (`vacancies.controller.ts` —
   * RolesGuard is a no-op without that decorator, see roles.guard.ts) —
   * RBAC lives here instead, and denial is a 404, not `getResumeUrl`'s 403.
   * This mirrors the established `DocumentsService.findActiveOrThrow`
   * convention for the general RESUME/SCAN document categories
   * (task-file-storage-hardening §1): "don't confirm this resource exists
   * to a viewer who isn't allowed to see it". Preview and download allow
   * the EXACT same role set (ADMIN | HR) — `getResumeUrl`'s existing 403
   * (defence-in-depth `@Roles` decorator + `assertAdminOrHr`, pinned by
   * `vacancies.integration.spec.ts`'s RBAC matrix) is intentionally left
   * untouched; only this NEW endpoint adopts the 404 convention.
   *
   * Disposition is `'attachment'`, same as `getResumeUrl` — code-review
   * round 2: the CRM's preview UI (`useApplicationResumeBlob`) always
   * fetches the URL programmatically and builds a Blob, which never looks
   * at `Content-Disposition` at all, so `'inline'` bought nothing
   * functionally here. What it DID buy is a real footgun: this URL is
   * candidate-controlled bytes (an anonymous public form's resume upload)
   * on a shared R2 origin — `'inline'` means anyone who ends up with the
   * raw URL within its 600s window (a copied link, a devtools inspection,
   * a shared machine) gets those bytes rendered in-browser at that origin
   * instead of prompted to save. `'attachment'` closes that off with zero
   * loss to the actual feature.
   */
  async getResumePreviewUrl(
    actor: SessionUser,
    vacancyId: string,
    applicationId: string,
  ): Promise<VacancyApplicationResumeUrl> {
    if (actor.role !== 'ADMIN' && actor.role !== 'HR') {
      throw new NotFoundException('Отклик не найден')
    }
    return this.presignResume(actor, vacancyId, applicationId, 'attachment', 'PREVIEW')
  }

  /**
   * Shared tail for `getResumeUrl`/`getResumePreviewUrl` — both callers have
   * already asserted RBAC (with their own status code) before reaching here.
   * Fetches the application row (IDOR-safe, 404 on cross-vacancy access),
   * 404s on a retention-purged resume, best-effort access-logs the read, and
   * returns the presigned URL with the caller's chosen disposition.
   */
  private async presignResume(
    actor: SessionUser,
    vacancyId: string,
    applicationId: string,
    disposition: 'inline' | 'attachment',
    action: 'DOWNLOAD' | 'PREVIEW',
  ): Promise<VacancyApplicationResumeUrl> {
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
    // downloaded/previewed this resume and when" was previously unanswerable.
    // Never records the presigned URL itself, only the actor/application/
    // category. A logging failure must not block the actual download/preview.
    try {
      await this.db.db.insert(documentAccessLog).values({
        actorId: actor.id,
        targetId: row.id,
        action,
        metadata: { category: 'RESUME', source: 'vacancy_application' },
      })
    } catch (err) {
      this.logger.warn(
        `presignResume: failed to write access-log row (action=${action}) for applicationId=${row.id}: ${(err as Error).message}`,
      )
    }

    return this.s3.getPresignedDownloadUrl(
      row.resumeS3Key,
      RESUME_PRESIGN_TTL_SEC,
      `${sanitizeDownloadFilename(row.fullName)}.pdf`,
      disposition,
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
