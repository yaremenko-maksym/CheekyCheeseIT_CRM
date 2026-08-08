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
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import {
  EMPTY_RESUME_CONTENT,
  RESUME_LIMITS,
  RESUME_SOURCE_MAX_BYTES,
  resumeContentSchema,
  type ResumeContent,
  type ResumeFailureCode,
  type SeniorResumeDto,
  type SeniorResumeResponse,
  type SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { seniorResumes, type SeniorResume, type User } from '../database/schema'
import { S3Service, presignTtlForCategory } from '../documents/s3.service'
import { ResumeAiService } from './resume-ai.service'
import { canAccessResume, type ResumeAccessMode } from './resume-access'
import { ResumePdfService } from './resume-pdf.service'
import {
  ResumeFileUnreadableError,
  ResumeTextExtractionService,
} from './resume-text-extraction.service'
import { detectResumeSourceMime } from './resume-source.util'

/** A RUNNING row older than this was abandoned (process died) — AC3 sweep. */
export const STUCK_EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000

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
    private readonly pdf: ResumePdfService,
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

  /** Render the canonical content onto our PDF template (AC8). */
  async generatePdf(
    viewer: SessionUser,
    targetUserId: string,
  ): Promise<{ pdfBuffer: Buffer; displayName: string }> {
    const target = await this.assertAccess(viewer, targetUserId, 'read')
    const row = await this.findRow(targetUserId)
    if (!row) throw new NotFoundException('Резюме ещё не создано')

    const pdfBuffer = await this.pdf.generateResumePdf({
      displayName: target.displayName,
      content: this.safeContent(row.content),
      // Pinned to the row's own updatedAt so the same resume renders to the
      // same bytes on every download (matches the invoice determinism rule).
      generatedAt: row.updatedAt,
    })
    return { pdfBuffer, displayName: target.displayName }
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
    await this.assertAccess(viewer, targetUserId, 'write')
    // Re-validate server-side: never persist client-shaped JSON unchecked.
    const validated = resumeContentSchema.parse(content)
    const existing = await this.ensureRow(targetUserId)

    const [updated] = await this.db.db
      .update(seniorResumes)
      .set({
        content: validated,
        version: existing.version + 1,
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
   * Returns the same envelope every other endpoint answers with, so the client
   * lands straight back on the empty state.
   */
  async deleteResume(viewer: SessionUser, targetUserId: string): Promise<SeniorResumeResponse> {
    await this.assertAccess(viewer, targetUserId, 'write')
    const row = await this.findRow(targetUserId)
    if (!row) throw new NotFoundException('Резюме ещё не создано')

    if (row.sourceS3Key) await this.s3.delete(row.sourceS3Key)
    await this.db.db.delete(seniorResumes).where(eq(seniorResumes.id, row.id))

    this.logger.log(`Resume of ${targetUserId} deleted by ${viewer.id}`)
    return { resume: null, canEdit: canAccessResume(viewer, targetUserId, 'write') }
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
    }
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

  /** Mark a row FAILED regardless of ownership (used by the sweeps). */
  private async failUnclaimed(
    resumeId: string,
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
      .where(eq(seniorResumes.id, resumeId))
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
      },
      // Server-computed, never echoed from the client.
      canEdit: canAccessResume(viewer, row.userId, 'write'),
    }
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
