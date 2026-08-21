/**
 * SeniorResumesService — canonical resume data for a SENIOR (task-resume-base).
 *
 * Pipeline: file (or pasted text) -> extracted text -> ONE model call ->
 * structured `ResumeContent` -> editable form -> PDF. After the single
 * extraction the system works with the STRUCTURE; the uploaded file survives
 * only as a downloadable original.
 *
 * Async by design (AC3): the upload endpoint stores the source, marks the row
 * QUEUED and returns IMMEDIATELY; the extraction runs detached and the client
 * polls. Two independent things then guarantee the row cannot get stuck:
 *   - the detached run always writes a terminal state (READY or FAILED), and
 *   - `ResumeExtractionCronService` sweeps rows left RUNNING past a deadline
 *     (container restarted mid-extraction) and re-queues abandoned QUEUED rows.
 *
 * RBAC lives in `resume-access.ts` (one pure, comparison-based rule) and is
 * applied by `assertAccess` at the top of EVERY method — read, write, source
 * download and PDF alike.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  RESUME_LIMITS,
  RESUME_SOURCE_MAX_BYTES,
  normalizeResumeLayout,
  resumeContentSchema,
  type ResumeContent,
  type ResumeFailureCode,
  type ResumeLayoutOptions,
  type SeniorResumeDto,
  type SeniorResumeResponse,
  type SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { seniorResumes, type SeniorResume, type User } from '../database/schema'
import { S3Service, presignTtlForCategory } from '../documents/s3.service'
import { ResumeAiService } from './resume-ai.service'
import { canAccessResume, type ResumeAccessMode } from './resume-access'
import {
  ResumeRenderError,
  ResumeTypstService,
  type ResumeRenderInput,
} from './resume-typst.service'
import {
  ResumeFileUnreadableError,
  ResumeTextExtractionService,
} from './resume-text-extraction.service'
import { detectResumeSourceMime } from './resume-source.util'

/**
 * How many times `deleteResume` will re-read and re-erase when an upload keeps
 * replacing the stored file underneath it. Three is plenty: each round erases
 * whatever the row points at, so losing three in a row means a genuine storm,
 * not a race.
 */
const DELETE_RACE_ATTEMPTS = 3

/** A RUNNING row older than this was abandoned (process died) — AC3 sweep. */
export const STUCK_EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * A render left RUNNING longer than this was abandoned.
 *
 * Far shorter than the extraction timeout because the work is bounded by a
 * 20-second SIGKILL: a render still marked RUNNING after two minutes means the
 * PROCESS that owned it is gone, not that it is slow.
 */
export const STUCK_RENDER_TIMEOUT_MS = 2 * 60 * 1000

export interface ResumeSourceFile {
  buffer: Buffer
  /** Client-declared type. Advisory ONLY — the real check is on the bytes. */
  mimetype: string
  originalname: string
}

export interface ResumeSourceDownload {
  url: string
  expiresAt: string
  fileName: string
}

@Injectable()
export class SeniorResumesService {
  private readonly logger = new Logger(SeniorResumesService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly ai: ResumeAiService,
    private readonly extraction: ResumeTextExtractionService,
    private readonly typst: ResumeTypstService,
  ) {}

  // ==========================================================================
  // Access
  // ==========================================================================

  /**
   * Enforce the §4 table, then confirm the target is a real SENIOR.
   *
   * Order matters: the ROLE decision happens first and never touches the DB,
   * so a JUNIOR/DROP probing arbitrary ids gets a flat 403 and learns nothing
   * about which ids exist. Only once the viewer is allowed do we look the
   * target up (404 for "no such user" / "not a senior" — a resume is a senior
   * artefact and does not exist for other roles).
   */
  private async assertAccess(
    viewer: SessionUser,
    targetUserId: string,
    mode: ResumeAccessMode,
  ): Promise<User> {
    if (!canAccessResume(viewer, targetUserId, mode)) {
      throw new ForbiddenException('Нет доступа к резюме этого пользователя')
    }
    const target = await this.db.db.query.users.findFirst({
      where: (tbl, { eq: equals }) => equals(tbl.id, targetUserId),
    })
    if (!target) throw new NotFoundException('Пользователь не найден')
    if (target.role !== 'SENIOR') throw new NotFoundException('Резюме ведётся только для синьоров')
    return target as User
  }

  // ==========================================================================
  // Read
  // ==========================================================================

  /**
   * GET. `resume` is `null` when the senior has no row yet — but `canEdit` is
   * still answered, because it describes the VIEWER's rights, not the row's
   * existence. Without that, the empty state could not know whether to offer
   * the upload button (see the response schema's doc).
   */
  async getForUser(viewer: SessionUser, targetUserId: string): Promise<SeniorResumeResponse> {
    await this.assertAccess(viewer, targetUserId, 'read')
    const row = await this.findRow(targetUserId)
    if (!row) {
      return { resume: null, canEdit: canAccessResume(viewer, targetUserId, 'write') }
    }
    return this.toResponse(row, viewer)
  }

  /** Presigned download of the ORIGINAL uploaded file (never public). */
  async getSourceDownload(
    viewer: SessionUser,
    targetUserId: string,
  ): Promise<ResumeSourceDownload> {
    await this.assertAccess(viewer, targetUserId, 'read')
    const row = await this.findRow(targetUserId)
    if (!row?.sourceS3Key) throw new NotFoundException('Исходный файл резюме не загружен')

    const fileName = row.sourceFileName ?? 'resume'
    const { url, expiresAt } = await this.s3.getPresignedDownloadUrl(
      row.sourceS3Key,
      // RESUME is one of the sensitive categories -> short TTL + no-store,
      // reusing the documents module's single classification instead of
      // inventing a second policy here.
      presignTtlForCategory('RESUME'),
      fileName,
      'attachment',
      'RESUME',
    )
    return { url, expiresAt, fileName }
  }

  /**
   * The rendered PDF — SERVED, not produced, here.
   *
   * This is the whole point of the render being a job. The handler does three
   * cheap things: check access, compare the stored fingerprint with the current
   * one, and stream bytes out of object storage. Typesetting is unbounded CPU
   * on untrusted content and has no business inside a request; when the stored
   * copy is stale the caller gets `pending` and a render is enqueued, exactly
   * as the extraction pipeline behaves.
   *
   * Returning a discriminated result rather than throwing on "not ready": the
   * controller answers 202 with a state the UI already knows how to poll, and a
   * pending render is a normal moment in the life of a resume, not an error.
   */
  async getRenderedPdf(
    viewer: SessionUser,
    targetUserId: string,
  ): Promise<
    | { ready: true; pdfBuffer: Buffer; displayName: string }
    | { ready: false; status: 'QUEUED' | 'RUNNING' | 'FAILED'; message: string | null }
  > {
    const target = await this.assertAccess(viewer, targetUserId, 'read')
    const row = await this.findRow(targetUserId)
    if (!row) throw new NotFoundException('Резюме ещё не создано')

    const wanted = this.typst.fingerprint(this.renderInputFor(row, target.displayName))
    if (row.pdfS3Key && row.pdfFingerprint === wanted) {
      return {
        ready: true,
        pdfBuffer: await this.s3.getObject(row.pdfS3Key),
        displayName: target.displayName,
      }
    }

    if (row.pdfRenderStatus === 'FAILED' && row.pdfFingerprint === wanted) {
      return { ready: false, status: 'FAILED', message: row.pdfRenderError }
    }

    // Stale or never built — make sure something is working on it.
    await this.enqueueRender(row.id, target.displayName)
    return { ready: false, status: 'QUEUED', message: null }
  }

  // ==========================================================================
  // Write
  // ==========================================================================

  /**
   * Manual save of the whole structure. Bumps `version` and clears any FAILED
   * banner — a hand-filled resume is a perfectly valid resume, so an earlier
   * extraction failure must not keep shouting at the user afterwards.
   */
  async updateContent(
    viewer: SessionUser,
    targetUserId: string,
    content: ResumeContent,
  ): Promise<SeniorResumeResponse> {
    const target = await this.assertAccess(viewer, targetUserId, 'write')
    // Re-validate server-side: never persist client-shaped JSON unchecked.
    const validated = resumeContentSchema.parse(content)
    const existing = await this.ensureRow(targetUserId)

    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        content: validated,
        // Incremented IN SQL, not read-modify-write. `existing.version` was
        // read in a separate statement, so two concurrent saves both computed
        // the same next value and one increment vanished — and `version` is
        // exactly the signal task-resume-tailoring reads to notice a stale
        // base, so a lost increment silently marks a stale variant as current.
        version: sql`${seniorResumes.version} + 1`,
        status: 'READY',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        // Disown any extraction in flight: the human just decided what this
        // resume says, and a model that started earlier must not land on top
        // of that decision a few seconds later.
        extractionRunId: null,
        updatedByUserId: viewer.id,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, existing.id))
      .returning()

    if (!updated) throw new NotFoundException('Резюме не найдено')
    // The data changed, so the PDF is stale. Queued, never rendered here: the
    // save must not wait on a typesetter (task §2, "рендер вне пути запроса").
    await this.enqueueRender(updated.id, target.displayName)
    return this.toResponse(updated, viewer)
  }

  /**
   * Accept an uploaded PDF/DOCX: validate the BYTES, store the original, mark
   * QUEUED and return at once. Extraction happens detached (AC3).
   */
  async uploadSource(
    viewer: SessionUser,
    targetUserId: string,
    file: ResumeSourceFile,
  ): Promise<SeniorResumeResponse> {
    await this.assertAccess(viewer, targetUserId, 'write')

    if (file.buffer.length === 0) throw new UnsupportedMediaTypeException('Файл пустой')
    if (file.buffer.length > RESUME_SOURCE_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Файл больше ${Math.floor(RESUME_SOURCE_MAX_BYTES / 1024 / 1024)} MB`,
      )
    }

    // AC2 — the ONLY thing that decides the type is the content. The
    // filename extension and the client's Content-Type are both attacker
    // controlled and are deliberately not consulted.
    const detected = detectResumeSourceMime(file.buffer)
    if (detected === null) {
      throw new UnsupportedMediaTypeException(
        'Поддерживаются только PDF и DOCX. Содержимое файла не соответствует ни одному из этих форматов.',
      )
    }

    const row = await this.ensureRow(targetUserId)
    const key = `senior-resumes/${targetUserId}/${row.id}-${Date.now()}`
    await this.s3.upload(key, file.buffer, detected, 'RESUME')

    const previousKey = row.sourceS3Key
    const [queued] = await this.db.db
      .update(seniorResumes)
      .set({
        sourceS3Key: key,
        sourceFileName: sanitizeFileName(file.originalname),
        sourceFileSizeBytes: file.buffer.length,
        sourceMimeType: detected,
        status: 'QUEUED',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        // Re-arming the queue from ANY state (including RUNNING) is deliberate
        // — the newest upload is what the user wants — but it must also DISOWN
        // whatever is still running, or the older run finishes second and wins,
        // writing the contents of the file we are about to delete.
        extractionRunId: null,
        updatedByUserId: viewer.id,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, row.id))
      .returning()
    if (!queued) throw new NotFoundException('Резюме не найдено')

    // Replacing the source must not leave the previous object orphaned in R2.
    if (previousKey && previousKey !== key) {
      await this.s3.delete(previousKey)
    }

    this.startExtraction(row.id, () => this.extraction.extract(file.buffer, detected))
    return this.toResponse(queued, viewer)
  }

  /**
   * Fallback path (§2): the user pastes the resume as text. Goes through the
   * SAME queue + model + validation as a file, so an image-only PDF is never a
   * dead end.
   */
  async ingestText(
    viewer: SessionUser,
    targetUserId: string,
    text: string,
  ): Promise<SeniorResumeResponse> {
    await this.assertAccess(viewer, targetUserId, 'write')
    const row = await this.ensureRow(targetUserId)

    const [queued] = await this.db.db
      .update(seniorResumes)
      .set({
        status: 'QUEUED',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        // Same reason as in `uploadSource`: supersede, and disown what ran.
        extractionRunId: null,
        updatedByUserId: viewer.id,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, row.id))
      .returning()
    if (!queued) throw new NotFoundException('Резюме не найдено')

    this.startExtraction(row.id, () => Promise.resolve(text))
    return this.toResponse(queued, viewer)
  }

  /**
   * Erase the resume: the row AND the stored original file.
   *
   * A resume is personal data — employment history, education, contacts — held
   * on behalf of a person who can ask for it to be removed. Until now there was
   * no way to do that at all: content could be blanked field by field, but the
   * row survived and, more to the point, so did the uploaded PDF/DOCX in
   * object storage, which is the copy that actually holds the raw document.
   *
   * Order is deliberate. The storage object goes first: if that fails we abort
   * with the row still present and the operation can be retried honestly.
   * Deleting the row first and then failing on storage would leave an orphaned
   * file no code path can ever reach again — undeletable personal data.
   *
   * That order alone is not enough, though, because the key can CHANGE while we
   * are using it. Read key, delete object, delete row — and an upload landing in
   * that window replaces `source_s3_key`, so we erase the old object and then
   * drop the row that pointed at the NEW one. The user is told "deleted" while
   * their raw resume stays in the bucket, unreferenced and unreachable: nothing
   * sweeps the `senior-resumes/` prefix, so it would sit there for good.
   *
   * So the row is only removed while its key still matches the object we just
   * erased (`source_s3_key IS NOT DISTINCT FROM <what we deleted>` — NULL-safe,
   * because "no file" is a legitimate value). If the row moved under us, the
   * loop runs again and erases the newer object too, and only a genuinely
   * pathological upload storm exhausts the attempts.
   *
   * Returns the same envelope every other endpoint answers with, so the client
   * lands straight back on the empty state.
   */
  async deleteResume(viewer: SessionUser, targetUserId: string): Promise<SeniorResumeResponse> {
    await this.assertAccess(viewer, targetUserId, 'write')

    for (let attempt = 0; attempt < DELETE_RACE_ATTEMPTS; attempt += 1) {
      const row = await this.findRow(targetUserId)
      if (!row) {
        if (attempt === 0) throw new NotFoundException('Резюме ещё не создано')
        break // a racing writer removed it first — the end state is the same
      }

      const key = row.sourceS3Key
      // BOTH stored objects go: the uploaded original AND the rendered PDF.
      // The render was added by this task and is a second copy of the same
      // personal data — a delete that erased only the source would leave a
      // full CV in the bucket while telling the user it was gone.
      const pdfKey = row.pdfS3Key
      if (key) await this.s3.delete(key)
      if (pdfKey) await this.s3.delete(pdfKey)

      const removed = await this.db.db
        .delete(seniorResumes)
        .where(
          and(
            eq(seniorResumes.id, row.id),
            // NULL-safe equality: `= NULL` is never true, so a resume without a
            // stored file would never match and could never be deleted.
            sql`${seniorResumes.sourceS3Key} IS NOT DISTINCT FROM ${key}`,
            // The render key moves independently of the source key (a layout
            // change rewrites one and not the other), so the guard has to cover
            // it too — otherwise a render landing mid-delete orphans its PDF.
            sql`${seniorResumes.pdfS3Key} IS NOT DISTINCT FROM ${pdfKey}`,
          ),
        )
        .returning({ id: seniorResumes.id })

      if (removed.length > 0) {
        this.logger.log(`Resume of ${targetUserId} deleted by ${viewer.id}`)
        return { resume: null, canEdit: canAccessResume(viewer, targetUserId, 'write') }
      }

      // The row changed between the read and the delete — almost certainly a
      // new upload. Go round again and erase whatever it points at now.
      this.logger.warn(
        `Resume of ${targetUserId}: source changed mid-delete, retrying (attempt ${attempt + 1})`,
      )
    }

    throw new ConflictException(
      'Резюме изменяется прямо сейчас — повторите удаление через несколько секунд.',
    )
  }

  // ==========================================================================
  // Extraction pipeline
  // ==========================================================================

  /**
   * Detached kick-off. Deliberately NOT awaited by the HTTP handler — that is
   * what makes the endpoint answer immediately. Every rejection is caught here
   * so a failure can never become an unhandled rejection (which, per the
   * SalaryCron precedent, would take the scheduler/process down).
   */
  private startExtraction(resumeId: string, loadText: () => Promise<string>): void {
    void this.runExtraction(resumeId, loadText).catch((err: unknown) => {
      this.logger.error(
        `Detached resume extraction crashed for ${resumeId}: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    })
  }

  /**
   * QUEUED -> RUNNING -> READY | FAILED. Public so the cron can re-drive an
   * abandoned QUEUED row through exactly the same code path.
   *
   * Every write below carries the run token from `claimForExtraction`. That is
   * what makes a slow run harmless: if anything superseded it while the model
   * was thinking — a newer upload, a pasted text, a manual save by HR — the
   * token no longer matches, the UPDATE touches zero rows, and this run drops
   * its result instead of overwriting fresher data (or resurrecting the
   * contents of a file that has since been deleted from storage).
   *
   * The token is also checked BEFORE the model is called, which is the
   * difference between discarding a result and never buying it. Two uploads in
   * a row used to mean two paid Workers AI calls even though only one answer
   * could ever be kept — the loser's tokens were spent purely to be thrown
   * away. Now the superseded run notices at the last cheap moment and stops.
   */
  async runExtraction(resumeId: string, loadText: () => Promise<string>): Promise<void> {
    const runId = await this.claimForExtraction(resumeId)
    if (runId === null) return // someone else is already running it

    let text: string
    try {
      text = await loadText()
    } catch (err: unknown) {
      // Detail stays in the server log; the user gets our own wording.
      this.logger.warn(
        `Resume ${resumeId}: could not load text — ${err instanceof Error ? err.message : 'unknown'}`,
      )
      await this.failExtraction(resumeId, runId, ...describeLoadFailure(err))
      return
    }

    if (text.trim().length < RESUME_LIMITS.minExtractableChars) {
      await this.failExtraction(
        resumeId,
        runId,
        'NO_TEXT',
        'Из файла не удалось извлечь текст (вероятно, это скан или картинка). Вставьте текст резюме вручную.',
      )
      return
    }

    // Last checkpoint before the only step that costs money. Reading the file
    // and extracting its text are cheap and local; the model call is neither.
    if (!(await this.stillOwnsRun(resumeId, runId))) {
      this.logger.log(
        `Resume ${resumeId}: superseded before the model call — skipping it (no tokens spent)`,
      )
      return
    }

    const result = await this.ai.extractStructure(text)
    if (!result.ok) {
      await this.failExtraction(
        resumeId,
        runId,
        result.code,
        result.message,
        result.quotaResetsAt,
        result.tokensUsed,
      )
      return
    }

    const written = await this.db.db
      .update(seniorResumes)
      .set({
        content: result.content,
        status: 'READY',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        extractionRunId: null,
        lastExtractionTokens: result.tokensUsed,
        // The extraction REPLACES the content, so it is a content change like
        // any other and must move `version` — that field is what
        // task-resume-tailoring reads to notice a stale base, and a silent
        // content swap underneath a stable version is exactly the case it
        // would miss.
        version: sql`${seniorResumes.version} + 1`,
        updatedAt: new Date(),
      })
      .where(this.ownedByRun(resumeId, runId))
      .returning({ id: seniorResumes.id })

    if (written.length === 0) {
      this.logger.log(
        `Resume ${resumeId}: extraction result discarded — the row was superseded while the model ran`,
      )
      return
    }

    // Extraction REPLACED the content, so the PDF that matched the old content
    // is stale. Same detached queue as a manual save.
    await this.enqueueRender(resumeId)
  }

  /**
   * Atomically move QUEUED -> RUNNING and stamp a fresh run token.
   *
   * The `status = 'QUEUED'` predicate is the lock: a second worker (cron
   * re-drive racing the detached run) updates zero rows and backs off, so the
   * model is never paid twice. Returns the token the run must present on its
   * terminal write, or `null` when the claim was lost.
   */
  private async claimForExtraction(resumeId: string): Promise<string | null> {
    const runId = randomUUID()
    const claimed = await this.db.db
      .update(seniorResumes)
      .set({ status: 'RUNNING', extractionStartedAt: new Date(), extractionRunId: runId })
      .where(and(eq(seniorResumes.id, resumeId), eq(seniorResumes.status, 'QUEUED')))
      .returning({ id: seniorResumes.id })
    return claimed.length > 0 ? runId : null
  }

  /**
   * "This row, still RUNNING, still owned by MY attempt." Every terminal write
   * of an extraction is gated on it — see `runExtraction`.
   */
  private ownedByRun(resumeId: string, runId: string) {
    return and(
      eq(seniorResumes.id, resumeId),
      eq(seniorResumes.status, 'RUNNING'),
      eq(seniorResumes.extractionRunId, runId),
    )
  }

  /**
   * Cheap read of the same condition, for bailing out BEFORE spending money.
   *
   * There is still a window between this check and the model call — a second
   * upload landing in those microseconds is paid for. Closing it completely
   * would need a lock held across a multi-second HTTP request to Cloudflare,
   * which trades a rare wasted call for a common stuck row. This turns "always
   * pays twice" into "pays twice only if the second upload lands inside the
   * same tick", and the ownership predicate still guarantees the RESULT is
   * correct either way.
   */
  private async stillOwnsRun(resumeId: string, runId: string): Promise<boolean> {
    const [row] = await this.db.db
      .select({ id: seniorResumes.id })
      .from(seniorResumes)
      .where(this.ownedByRun(resumeId, runId))
      .limit(1)
    return row !== undefined
  }

  private async failExtraction(
    resumeId: string,
    runId: string,
    code: ResumeFailureCode,
    message: string,
    quotaResetsAt: string | null = null,
    tokensUsed: number | null = null,
  ): Promise<void> {
    await this.db.db
      .update(seniorResumes)
      .set({
        status: 'FAILED',
        errorCode: code,
        errorMessage: message,
        quotaResetsAt: quotaResetsAt ? new Date(quotaResetsAt) : null,
        extractionStartedAt: null,
        extractionRunId: null,
        lastExtractionTokens: tokensUsed,
        updatedAt: new Date(),
      })
      .where(this.ownedByRun(resumeId, runId))
  }

  /**
   * Fail a row the sweep found abandoned in QUEUED.
   *
   * There is no run token to present — nothing ever claimed the row — so the
   * guard has to be the STATE THE SWEEP SAW. `updatedAt` is that snapshot: the
   * sweep selected rows whose `updatedAt` was older than the cutoff, and any
   * write since (a new upload, a pasted text, a manual save, another worker
   * claiming it) moves that column.
   *
   * Without it this UPDATE was unconditional, so between the sweep's SELECT and
   * this write it could stamp FAILED over a row that had just been re-queued —
   * showing the user a failure for work that is running, and orphaning the run
   * that had already taken the row (its terminal write then finds no match).
   */
  private async failUnclaimed(
    resumeId: string,
    expectedUpdatedAt: Date,
    code: ResumeFailureCode,
    message: string,
  ): Promise<void> {
    await this.db.db
      .update(seniorResumes)
      .set({
        status: 'FAILED',
        errorCode: code,
        errorMessage: message,
        extractionStartedAt: null,
        extractionRunId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(seniorResumes.id, resumeId),
          eq(seniorResumes.status, 'QUEUED'),
          eq(seniorResumes.updatedAt, expectedUpdatedAt),
        ),
      )
  }

  /**
   * Sweep rows abandoned in RUNNING (the container died mid-extraction). Called
   * by the cron; returns how many were swept so the job can log honestly.
   */
  async sweepStuckExtractions(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_EXTRACTION_TIMEOUT_MS)
    const swept = await this.db.db
      .update(seniorResumes)
      .set({
        status: 'FAILED',
        errorCode: 'STALLED',
        errorMessage:
          'Распознавание прервалось (перезапуск сервиса). Загрузите файл ещё раз или заполните резюме вручную.',
        extractionStartedAt: null,
        extractionRunId: null,
        updatedAt: now,
      })
      .where(
        and(eq(seniorResumes.status, 'RUNNING'), lt(seniorResumes.extractionStartedAt, cutoff)),
      )
      .returning({ id: seniorResumes.id })
    return swept.length
  }

  /**
   * Rows left QUEUED with no worker (process restarted between the INSERT and
   * the detached run). Without the stored source there is nothing to re-read,
   * so a file-less QUEUED row is failed rather than silently spinning forever.
   */
  async requeueAbandoned(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_EXTRACTION_TIMEOUT_MS)
    const abandoned = await this.db.db
      .select()
      .from(seniorResumes)
      .where(and(eq(seniorResumes.status, 'QUEUED'), lt(seniorResumes.updatedAt, cutoff)))
      // Oldest first: the row that has been stuck longest is the one a user is
      // most likely staring at, and a deterministic order makes the batch's
      // behaviour reproducible instead of dependent on physical row layout.
      .orderBy(asc(seniorResumes.updatedAt))
      .limit(20)

    let handled = 0
    for (const row of abandoned) {
      const key = row.sourceS3Key
      const mime = row.sourceMimeType
      if (!key || !mime) {
        // This row is still QUEUED — nothing ever claimed it, so there is no
        // run token to present; fail it directly.
        await this.failUnclaimed(
          row.id,
          row.updatedAt,
          'STALLED',
          'Распознавание прервалось (перезапуск сервиса). Вставьте текст резюме ещё раз или заполните форму вручную.',
        )
        handled += 1
        continue
      }
      await this.runExtraction(row.id, async () => {
        const buffer = await this.s3.getObject(key)
        const detected = detectResumeSourceMime(buffer)
        if (detected === null) throw new ResumeFileUnreadableError('Исходный файл повреждён')
        return this.extraction.extract(buffer, detected)
      })
      handled += 1
    }
    return handled
  }

  // ==========================================================================
  // Render pipeline (template + data -> PDF), out of the request path
  // ==========================================================================

  /**
   * Everything the template is allowed to see, assembled in one place.
   *
   * ONE function builds this, and both the freshness check and the render call
   * it. If the read path and the write path assembled the input separately they
   * would eventually disagree about some field, and the fingerprint would stop
   * meaning "these bytes are current" without anything failing loudly.
   */
  private renderInputFor(row: SeniorResume, displayName: string): ResumeRenderInput {
    return {
      displayName,
      content: this.safeContent(row.content),
      layout: this.safeLayout(row.layout),
      templateSource: row.templateSource,
    }
  }

  /**
   * Mark the row QUEUED and kick a detached render.
   *
   * Deliberately not awaited by any caller: a save returns as soon as the data
   * is saved, and the PDF catches up. Re-queuing from RUNNING is allowed and
   * clears the run token, so a render already in flight is disowned rather than
   * cancelled — it finishes, finds the token gone, and drops its bytes.
   */
  private async enqueueRender(resumeId: string, displayName?: string): Promise<void> {
    await this.db.db
      .update(seniorResumes)
      .set({
        pdfRenderStatus: 'QUEUED',
        pdfRenderError: null,
        pdfRenderStartedAt: null,
        pdfRenderRunId: null,
      })
      .where(eq(seniorResumes.id, resumeId))

    void this.runRender(resumeId, displayName).catch((err: unknown) => {
      this.logger.error(
        `Detached resume render crashed for ${resumeId}: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    })
  }

  /**
   * QUEUED -> RUNNING -> READY | FAILED.
   *
   * Public so the sweep can re-drive an abandoned row through the identical
   * path. Every terminal write carries the run token, for the same reason
   * extraction does: by the time a render finishes, the content it rendered may
   * already be two saves old, and writing its key would advertise a stale PDF
   * as the current one.
   */
  async runRender(resumeId: string, displayName?: string): Promise<void> {
    const runId = randomUUID()
    const claimed = await this.db.db
      .update(seniorResumes)
      .set({
        pdfRenderStatus: 'RUNNING',
        // NULL until a SLOT IS HELD — see `markRenderStarted`. The claim is
        // still taken here, atomically, because that is what stops two workers
        // rendering the same row; but the clock the stuck-sweep reads must not
        // start while this render is merely waiting its turn.
        pdfRenderStartedAt: null,
        pdfRenderRunId: runId,
      })
      .where(and(eq(seniorResumes.id, resumeId), eq(seniorResumes.pdfRenderStatus, 'QUEUED')))
      .returning()
    const row = claimed[0]
    if (!row) return // someone else owns this render

    const name = displayName ?? (await this.displayNameFor(row.userId))
    const input = this.renderInputFor(row, name)
    const fingerprint = this.typst.fingerprint(input)

    let pdf: Buffer
    try {
      pdf = await this.typst.render(input, () => {
        // Fire-and-forget: advisory timestamp, and the render is already
        // underway by the time it lands. A failure here can only make the
        // sweep more conservative, never less.
        void this.markRenderStarted(resumeId, runId)
      })
    } catch (err: unknown) {
      const message =
        err instanceof ResumeRenderError
          ? err.message
          : 'Не удалось собрать PDF резюме. Попробуйте позже.'
      this.logger.warn(`Resume ${resumeId}: render failed — ${message}`)
      // Recorded so a repeated request for the SAME input reports the
      // failure instead of queuing a render that will fail identically — a
      // Typst error is a pure function of the input, so retrying it changes
      // nothing.
      await this.failRender(resumeId, runId, message, fingerprint)
      return
    }

    const key = `senior-resumes/${row.userId}/pdf/${row.id}-${fingerprint.slice(0, 16)}.pdf`
    try {
      await this.s3.upload(key, pdf, 'application/pdf', 'RESUME')
    } catch (err: unknown) {
      // bug-44: this used to sit OUTSIDE any try/catch, so a rejected upload
      // propagated out of `runRender` uncaught and the row stayed RUNNING —
      // exactly as it had just been claimed — until the stuck-render sweep
      // reclaimed it two minutes later. The document itself is fine, Typst
      // already produced it; the bytes simply never reached the bucket.
      //
      // Deliberately NOT retried here and NOT persisted anywhere for manual
      // recovery: a PutObject either lands whole or not at all, so there is
      // no partial object at `key` to finish or clean up, and the S3 client
      // already retries transient errors internally before rejecting — a
      // second attempt in-process would mostly repeat a failure that just
      // repeated itself. The in-memory `pdf` buffer is simply dropped.
      //
      // `pdfFingerprint`/`pdfS3Key` are deliberately left UNTOUCHED (unlike
      // the render-failure path above): a storage failure says nothing
      // about the INPUT the way a Typst error does, so the row keeps citing
      // its last successfully uploaded PDF, if any, rather than being
      // marked "this content is doomed". Recovery is the same motion as a
      // render failure — the next explicit save re-renders and re-uploads
      // from scratch.
      const message = 'PDF собрался, но не сохранился в хранилище. Попробуйте позже.'
      this.logger.warn(
        `Resume ${resumeId}: PDF upload failed — ${err instanceof Error ? err.message : 'unknown'}`,
      )
      await this.failRender(resumeId, runId, message)
      return
    }

    const written = await this.db.db
      .update(seniorResumes)
      .set({
        pdfS3Key: key,
        pdfFingerprint: fingerprint,
        pdfRenderStatus: 'READY',
        pdfRenderError: null,
        pdfRenderStartedAt: null,
        pdfRenderRunId: null,
      })
      .where(this.ownedByRenderRun(resumeId, runId))
      .returning({ id: seniorResumes.id })

    if (written.length === 0) {
      // Superseded mid-render. The row now points elsewhere, so this object is
      // unreferenced the moment it is written — erase it rather than leave a
      // PDF of someone's CV in the bucket that no code path can reach.
      this.logger.log(`Resume ${resumeId}: render superseded — discarding ${key}`)
      await this.s3.delete(key)
      return
    }

    // Only now is the previous PDF genuinely unreferenced.
    if (row.pdfS3Key && row.pdfS3Key !== key) await this.s3.delete(row.pdfS3Key)
  }

  /**
   * Start the stuck-clock, at the moment work actually begins.
   *
   * Separate from the claim because the two answer different questions. The
   * claim asks "is this row mine to render" and must happen before anything
   * else. This asks "since when has the renderer been busy with it", and the
   * gap between them is queue time — up to `MAX_CONCURRENT_RENDERS` slots'
   * worth, unbounded in principle. Aging a render from the claim would let the
   * sweep restart healthy work that was simply waiting its turn, which is
   * strictly worse than not sweeping at all: it multiplies the queue it was
   * meant to clear.
   */
  private async markRenderStarted(resumeId: string, runId: string): Promise<void> {
    await this.db.db
      .update(seniorResumes)
      .set({ pdfRenderStartedAt: new Date() })
      .where(this.ownedByRenderRun(resumeId, runId))
  }

  private ownedByRenderRun(resumeId: string, runId: string) {
    return and(
      eq(seniorResumes.id, resumeId),
      eq(seniorResumes.pdfRenderStatus, 'RUNNING'),
      eq(seniorResumes.pdfRenderRunId, runId),
    )
  }

  /**
   * The one place `runRender` writes a terminal FAILURE — shared by BOTH
   * halves of the pipeline (Typst render, S3 upload) so a storage failure
   * cannot invent a second way of telling the user "this attempt did not
   * work" (bug-44 AC2). Scoped by `ownedByRenderRun`, same as the READY
   * write: a run superseded mid-flight must not stamp failure over a newer
   * attempt's state.
   *
   * `fingerprint` is optional and caller-decided: pass it when the failure is
   * a pure function of the render INPUT (Typst error — retrying changes
   * nothing, so recording it stops an identical request from re-queuing);
   * omit it when the failure says nothing about the input (a storage
   * hiccup), so the row keeps citing whatever it pointed at before this
   * attempt instead of being marked "this content is doomed".
   */
  private async failRender(
    resumeId: string,
    runId: string,
    message: string,
    fingerprint?: string,
  ): Promise<void> {
    await this.db.db
      .update(seniorResumes)
      .set({
        pdfRenderStatus: 'FAILED',
        pdfRenderError: message,
        pdfRenderStartedAt: null,
        pdfRenderRunId: null,
        ...(fingerprint === undefined ? {} : { pdfFingerprint: fingerprint }),
      })
      .where(this.ownedByRenderRun(resumeId, runId))
  }

  /**
   * Renders abandoned mid-flight (the container died) — swept back to QUEUED.
   *
   * QUEUED rather than FAILED, unlike the extraction sweep: a render needs no
   * uploaded file and no paid model call to retry, so the honest recovery is to
   * simply do it again. Also re-drives rows left QUEUED with nobody working on
   * them.
   */
  async sweepStuckRenders(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_RENDER_TIMEOUT_MS)
    const stuck = await this.db.db
      .update(seniorResumes)
      .set({ pdfRenderStatus: 'QUEUED', pdfRenderStartedAt: null, pdfRenderRunId: null })
      .where(
        and(
          eq(seniorResumes.pdfRenderStatus, 'RUNNING'),
          lt(seniorResumes.pdfRenderStartedAt, cutoff),
        ),
      )
      .returning({ id: seniorResumes.id })

    const abandoned = await this.db.db
      .select({ id: seniorResumes.id, userId: seniorResumes.userId })
      .from(seniorResumes)
      .where(and(eq(seniorResumes.pdfRenderStatus, 'QUEUED'), lt(seniorResumes.updatedAt, cutoff)))
      .orderBy(asc(seniorResumes.updatedAt))
      .limit(20)

    for (const candidate of abandoned) {
      await this.runRender(candidate.id)
    }
    return stuck.length + abandoned.length
  }

  /**
   * Save the layout switches (§3) and rebuild the PDF.
   *
   * The switches are the ONLY typesetting a human may change. There is no
   * endpoint that writes `template_source`, and this method does not become
   * one: it takes a validated `ResumeLayoutOptions` and nothing else. Bumping
   * `version` is deliberate — the rendered artefact changed, and `version` is
   * what the tailoring task reads to notice a stale derivative.
   */
  async updateLayout(
    viewer: SessionUser,
    targetUserId: string,
    layout: ResumeLayoutOptions,
  ): Promise<SeniorResumeResponse> {
    const target = await this.assertAccess(viewer, targetUserId, 'write')
    const existing = await this.ensureRow(targetUserId)

    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        layout: normalizeResumeLayout(layout),
        // In SQL, for the same reason as `updateContent` — a layout change and
        // a content save racing each other must produce two increments, not one.
        version: sql`${seniorResumes.version} + 1`,
        updatedByUserId: viewer.id,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, existing.id))
      .returning()
    if (!updated) throw new NotFoundException('Резюме не найдено')

    await this.enqueueRender(updated.id, target.displayName)
    return this.toResponse(updated, viewer)
  }

  private async displayNameFor(userId: string): Promise<string> {
    const user = await this.db.db.query.users.findFirst({
      where: (tbl, { eq: equals }) => equals(tbl.id, userId),
      columns: { displayName: true },
    })
    return user?.displayName ?? 'Резюме'
  }

  // ==========================================================================
  // Row helpers
  // ==========================================================================

  private findRow(targetUserId: string): Promise<SeniorResume | undefined> {
    return this.db.db.query.seniorResumes.findFirst({
      where: (tbl, { eq: equals }) => equals(tbl.userId, targetUserId),
    })
  }

  /**
   * Get-or-create. `senior_resumes.user_id` is UNIQUE, so if two requests race
   * the loser's INSERT is skipped by `onConflictDoNothing` and it simply re-reads
   * the winner's row — no duplicate, no 500.
   */
  private async ensureRow(targetUserId: string): Promise<SeniorResume> {
    const existing = await this.findRow(targetUserId)
    if (existing) return existing

    await this.db.db
      .insert(seniorResumes)
      .values({ userId: targetUserId, content: EMPTY_RESUME_CONTENT })
      .onConflictDoNothing({ target: seniorResumes.userId })

    const created = await this.findRow(targetUserId)
    if (!created) throw new NotFoundException('Не удалось создать резюме')
    return created
  }

  private async toResponse(row: SeniorResume, viewer: SessionUser): Promise<SeniorResumeResponse> {
    const editor = row.updatedByUserId
      ? await this.db.db.query.users.findFirst({
          where: (tbl, { eq: equals }) => equals(tbl.id, row.updatedByUserId as string),
          columns: { displayName: true },
        })
      : undefined

    const layout = this.safeLayout(row.layout)

    return {
      resume: {
        id: row.id,
        userId: row.userId,
        content: this.safeContent(row.content),
        status: row.status,
        errorCode: (row.errorCode as SeniorResumeDto['errorCode']) ?? null,
        errorMessage: row.errorMessage,
        quotaResetsAt: row.quotaResetsAt?.toISOString() ?? null,
        sourceFileName: row.sourceFileName,
        sourceFileSizeBytes: row.sourceFileSizeBytes,
        hasSourceFile: Boolean(row.sourceS3Key),
        version: row.version,
        updatedByUserId: row.updatedByUserId,
        updatedByName: editor?.displayName ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),

        layout,
        // A LABEL. `template_source` is never serialised: the template is code,
        // it stays server-side, and keeping it out of the DTO is what makes
        // "the template is not part of the data" true rather than intended.
        templateName: row.templateName ?? 'Стандартный шаблон',
        hasCustomTemplate: row.templateSource !== null,

        renderStatus: row.pdfRenderStatus,
        renderError: row.pdfRenderError,
        // Freshness is a COMPARISON of fingerprints, not a status check: a
        // READY render of yesterday's content is not an up-to-date PDF.
        // The name is the resume OWNER's — it is printed at the top of the
        // document, so it is part of the render input like any other field.
        pdfUpToDate:
          Boolean(row.pdfS3Key) &&
          row.pdfFingerprint ===
            this.typst.fingerprint(this.renderInputFor(row, await this.displayNameFor(row.userId))),
      },
      // Server-computed, never echoed from the client.
      canEdit: canAccessResume(viewer, row.userId, 'write'),
    }
  }

  /**
   * Validate the layout on the way out, exactly as `safeContent` does.
   *
   * A stored layout can be stale (a section added to the enum after it was
   * written) or hand-edited, and the renderer must never receive a list it has
   * to defend itself against. `normalizeResumeLayout` makes it total.
   */
  private safeLayout(raw: unknown): ResumeLayoutOptions {
    return normalizeResumeLayout(raw ?? DEFAULT_RESUME_LAYOUT)
  }

  /**
   * Validate on the way OUT too. The column is JSONB written by this service,
   * but a hand-edited row, a restored backup or a future migration could put
   * something else there — and this content is rendered in a browser and drawn
   * into a PDF. Falling back to empty content beats shipping unvalidated JSON.
   */
  private safeContent(raw: unknown): ResumeContent {
    const parsed = resumeContentSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    this.logger.warn('Stored resume content failed validation — serving empty content')
    return EMPTY_RESUME_CONTENT
  }
}

/**
 * Turn a "could not get the text" throw into (code, message) SAFE TO DISPLAY.
 *
 * `errorMessage` is rendered verbatim in the resume panel, so only messages
 * this codebase wrote may reach it. `ResumeFileUnreadableError` carries exactly
 * those — Russian, user-facing, deliberately phrased ("в PDF больше 30
 * страниц"). Everything else is a storage client or a parser talking to itself:
 * bucket names, key paths, endpoint hosts, stack-shaped internals. Those are
 * logged, never shown.
 */
function describeLoadFailure(err: unknown): [ResumeFailureCode, string] {
  if (err instanceof ResumeFileUnreadableError) return ['UNREADABLE_FILE', err.message]
  return [
    'MODEL_ERROR',
    'Не удалось прочитать исходный файл резюме. Загрузите его ещё раз или вставьте текст.',
  ]
}

/**
 * Keep a display filename safe and bounded: no path separators (so it can
 * never be read as a path), no control characters, capped length. This is what
 * ends up in `Content-Disposition` via `S3Service` (which does its own quoting
 * on top).
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'resume'
  const cleaned = Array.from(base)
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
  return (cleaned === '' ? 'resume' : cleaned).slice(0, 180)
}
