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
import { and, eq, lt } from 'drizzle-orm'
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
        updatedByUserId: viewer.id,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, row.id))
      .returning()
    if (!queued) throw new NotFoundException('Резюме не найдено')

    this.startExtraction(row.id, () => Promise.resolve(text))
    return this.toResponse(queued, viewer)
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
   */
  async runExtraction(resumeId: string, loadText: () => Promise<string>): Promise<void> {
    const claimed = await this.claimForExtraction(resumeId)
    if (!claimed) return // someone else is already running it

    let text: string
    try {
      text = await loadText()
    } catch (err: unknown) {
      await this.failExtraction(
        resumeId,
        err instanceof ResumeFileUnreadableError ? 'UNREADABLE_FILE' : 'MODEL_ERROR',
        err instanceof Error ? err.message : 'Не удалось прочитать файл',
      )
      return
    }

    if (text.trim().length < RESUME_LIMITS.minExtractableChars) {
      await this.failExtraction(
        resumeId,
        'NO_TEXT',
        'Из файла не удалось извлечь текст (вероятно, это скан или картинка). Вставьте текст резюме вручную.',
      )
      return
    }

    const result = await this.ai.extractStructure(text)
    if (!result.ok) {
      await this.failExtraction(
        resumeId,
        result.code,
        result.message,
        result.quotaResetsAt,
        result.tokensUsed,
      )
      return
    }

    await this.db.db
      .update(seniorResumes)
      .set({
        content: result.content,
        status: 'READY',
        errorCode: null,
        errorMessage: null,
        quotaResetsAt: null,
        extractionStartedAt: null,
        lastExtractionTokens: result.tokensUsed,
        updatedAt: new Date(),
      })
      .where(eq(seniorResumes.id, resumeId))
  }

  /**
   * Atomically move QUEUED -> RUNNING. The `status = 'QUEUED'` predicate in the
   * UPDATE is the lock: a second worker (cron re-drive racing the detached
   * run) updates zero rows and backs off, so the model is never paid twice.
   */
  private async claimForExtraction(resumeId: string): Promise<boolean> {
    const claimed = await this.db.db
      .update(seniorResumes)
      .set({ status: 'RUNNING', extractionStartedAt: new Date() })
      .where(and(eq(seniorResumes.id, resumeId), eq(seniorResumes.status, 'QUEUED')))
      .returning({ id: seniorResumes.id })
    return claimed.length > 0
  }

  private async failExtraction(
    resumeId: string,
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
        lastExtractionTokens: tokensUsed,
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
        await this.failExtraction(
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
