/**
 * SeniorResumesController — HTTP surface for the canonical senior resume.
 *
 * Paths (global prefix `api`):
 *   GET    /api/users/:userId/resume            current structure + state
 *   PUT    /api/users/:userId/resume            save the structure (version++)
 *   POST   /api/users/:userId/resume/source     upload PDF/DOCX (multipart) -> QUEUED
 *   POST   /api/users/:userId/resume/text       paste plain text -> QUEUED
 *   GET    /api/users/:userId/resume/source     presigned download of the original
 *   GET    /api/users/:userId/resume/pdf        rendered PDF on our template
 *   POST   /api/users/:userId/resume/confirm    promote the staged result (ADMIN/HR)
 *   PUT    /api/users/:userId/resume/staged     edit one staged text -> staged-edit run
 *   POST   /api/users/:userId/resume/staged/regenerate  one staged path -> item run
 *   GET    /api/users/:userId/resume/staged-pdf the staged PDF awaiting Confirm
 *   DELETE /api/users/:userId/resume            erase the row + the stored file
 *
 * Auth: the global JwtAuthGuard (AppModule APP_GUARD) authenticates. There is
 * deliberately NO `@Roles()` decorator here: the §4 table is per-TARGET
 * ("SENIOR may read their OWN resume"; [owner 2026-11-14] only ADMIN and HR
 * write), which a role-only guard cannot express — RolesGuard would happily
 * let SENIOR A read SENIOR B's resume.
 * The real check lives in SeniorResumesService.assertAccess and is a
 * comparison of ids.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  confirmResumeSchema,
  editStagedFieldSchema,
  ingestResumeTextSchema,
  regenerateStagedFieldSchema,
  updateResumeContentSchema,
  updateResumeFactsSchema,
  updateResumeLayoutSchema,
  updateResumeTemplateSchema,
  decodeResumeMessage,
  RESUME_SOURCE_MAX_BYTES,
  type Locale,
  type StoredResumeMessage,
  type SessionUser,
} from '@crm/shared'
import { apiError, interpolate } from '../common/api-error'
import { CurrentUser } from '../auth/current-user.decorator'
import { RequestLocale } from '../i18n/request-locale'
import { canAccessResume } from './resume-access'
import { noAccess, SeniorResumesService, sanitizeFileName } from './resumes.service'

/** Minimal shape of a multipart part as returned by @fastify/multipart. */
interface MultipartField {
  type: 'field' | 'file'
  fieldname: string
  value?: unknown
  toBuffer?: () => Promise<Buffer>
  /** The file part's stream; a skipped file must be drained or `req.parts()` never moves on. */
  file?: { resume: () => unknown }
  mimetype?: string
  filename?: string
}

@Controller('users/:userId/resume')
export class SeniorResumesController {
  constructor(private readonly service: SeniorResumesService) {}

  @Get()
  get(@Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() user: SessionUser) {
    return this.service.getForUser(user, userId)
  }

  @Put()
  update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { content } = updateResumeContentSchema.parse(body)
    return this.service.updateContent(user, userId, content)
  }

  /**
   * Upload the original resume file. Throttled harder than the default: each
   * accepted upload costs a paid model call, so this is the one endpoint where
   * a loop is directly expensive.
   */
  @Post('source')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async uploadSource(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionUser,
  ) {
    // SR-L-4: refuse before the body is read, so a caller without write rights cannot stream up to
    // the size limit for a 403. The service's assertAccess stays the authority (target role, 404).
    // Stryker disable next-line StringLiteral: equivalent — any mode but 'read' refuses a SENIOR, and ADMIN/HR ignore it
    if (!canAccessResume(user, userId, 'write')) throw noAccess()
    if (!req.isMultipart()) {
      throw apiError('RESUME_UPLOAD_NOT_MULTIPART', HttpStatus.BAD_REQUEST)
    }

    let file: { buffer: Buffer; mimetype: string; originalname: string } | null = null
    try {
      for await (const part of req.parts({
        limits: { fileSize: RESUME_SOURCE_MAX_BYTES, files: 1 },
      }) as AsyncIterable<MultipartField>) {
        if (part.type !== 'file' || part.fieldname !== 'file') {
          part.file?.resume() // a skipped file part must be drained; a field has no stream
          continue
        }
        // Guard only: `files: 1` already rejects a second file part, so this is a guard for a future change to `files`.
        if (file) {
          part.file?.resume()
          continue // first file wins
        }
        if (!part.toBuffer) throw apiError('RESUME_UPLOAD_UNREADABLE', HttpStatus.BAD_REQUEST)
        file = {
          buffer: await part.toBuffer(),
          mimetype: part.mimetype ?? 'application/octet-stream',
          originalname: part.filename ?? 'resume',
        }
      }
    } catch (err) {
      // The iterator and toBuffer both reject with the size error; one mapping covers both.
      throw uploadLimitError(err)
    }
    if (!file) throw apiError('RESUME_UPLOAD_NO_FILE', HttpStatus.BAD_REQUEST)

    return this.service.uploadSource(user, userId, file)
  }

  /** Paste-the-text fallback — same queue, same model, same validation. */
  @Post('text')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  ingestText(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { text } = ingestResumeTextSchema.parse(body)
    return this.service.ingestText(user, userId, text)
  }

  @Get('source')
  getSource(@Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() user: SessionUser) {
    return this.service.getSourceDownload(user, userId)
  }

  /**
   * Erase the resume — the row and the stored original alike.
   *
   * Personal data has to be removable, and blanking the fields is not removal:
   * the uploaded PDF/DOCX would stay in object storage. Guarded by the same
   * per-target write rule as every other mutation here (a SENIOR may erase
   * their own resume and nobody else's).
   */
  @Delete()
  remove(@Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() user: SessionUser) {
    return this.service.deleteResume(user, userId)
  }

  /**
   * The layout switches (§3): section order, hidden sections, density, font
   * scale. The ONLY typesetting a human may change.
   *
   * Note what this endpoint deliberately is NOT: there is no route anywhere in
   * this controller that accepts template source. A template is executable
   * typesetting code, and the guarantee that a resume's layout cannot be
   * steered by user- or model-supplied text is worth more than the flexibility
   * of letting HR paste one. Personal templates arrive through the designer's
   * task, not through the API.
   */
  @Put('layout')
  // On VERIFIED a look write starts a template run (model calls): throttled like submit.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  updateLayout(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { layout } = updateResumeLayoutSchema.parse(body)
    return this.service.updateLayout(user, userId, layout)
  }

  /** The facts HR enters (spec §3). Same write rule; 409 while a check runs. */
  @Put('facts')
  updateFacts(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { facts } = updateResumeFactsSchema.parse(body)
    return this.service.saveFacts(user, userId, facts)
  }

  /** Starts the check run (Task 14): 202, the run goes on off the request path; 409 while busy. */
  @Post('submit')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() user: SessionUser) {
    return this.service.submit(user, userId)
  }

  /** Confirm the staged result (Task 15): ADMIN/HR only; 409 when it changed since it was shown. */
  @Post('confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  confirm(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.confirm(user, userId, confirmResumeSchema.parse(body))
  }

  /** Rewrite one staged text by hand; a staged-edit run re-checks it (202). */
  @Put('staged')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  editStaged(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.editStagedField(user, userId, editStagedFieldSchema.parse(body))
  }

  /** Regenerate one staged path with the model; an item run (202). */
  @Post('staged/regenerate')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  regenerateStaged(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.regenerateStagedField(user, userId, regenerateStagedFieldSchema.parse(body))
  }

  /** The staged PDF awaiting Confirm; 404 like the live PDF when absent or not readable. */
  @Get('staged-pdf')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async getStagedPdf(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
    @Res() reply: FastifyReply,
    @RequestLocale() locale: Locale,
  ): Promise<void> {
    const result = await this.service.getStagedPdf(user, userId)
    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', resumeContentDisposition(result.displayName, locale))
      .send(result.pdfBuffer)
  }

  /** A catalog template (spec §6) — a name from the enum, never template source. */
  @Put('template')
  // On VERIFIED a look write starts a template run (model calls): throttled like submit.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  updateTemplate(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { templateName } = updateResumeTemplateSchema.parse(body)
    return this.service.setTemplate(user, userId, templateName)
  }

  /**
   * The rendered PDF, SERVED from storage — never typeset inside this request.
   *
   * Answers 200 with the bytes when the stored render matches the current
   * content+layout+template, and 202 with a state to poll when it does not
   * (the request enqueues the render on its way out). That split is the whole
   * reason the render is a job: typesetting untrusted content is unbounded CPU,
   * and a request handler is the one place it must never happen.
   *
   * `no-store` because the body is personal data and changes on every save — a
   * cached copy would show a stale resume from the browser's disk cache, which
   * is what the sensitive-documents policy avoids elsewhere.
   */
  @Get('pdf')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async getPdf(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
    @Res() reply: FastifyReply,
    @RequestLocale() locale: Locale,
  ): Promise<void> {
    const result = await this.service.getRenderedPdf(user, userId)

    if (!result.ready) {
      await reply.code(202).send(pendingPdfBody(result.status, result.message))
      return
    }

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', resumeContentDisposition(result.displayName, locale))
      .send(result.pdfBuffer)
  }
}

/**
 * Build a `Content-Disposition` value for the rendered PDF.
 *
 * The display name is user data, so it goes through the SAME `sanitizeFileName`
 * the upload path uses. There used to be two different reductions here — the
 * service one dropped path separators and capped the length, this one only
 * removed quotes and newlines — so a display name of `../../etc/passwd.pdf`
 * arrived intact in the header while the identical string was defused on the
 * way in. One definition, one behaviour, whichever direction the name travels.
 *
 * On top of that: the ASCII slot cannot contain anything that would break out
 * of the quoted parameter, and the UTF-8 slot carries the real Cyrillic name.
 * Mirrors `safeContractFilename` in the contracts module.
 *
 * Backlog 451: the word before the name follows the viewer's locale (`@RequestLocale()`).
 */
export function resumeContentDisposition(displayName: string, locale: Locale): string {
  // Sanitise FIRST, then strip the quoting characters. The other order removed
  // the backslash before `sanitizeFileName` could treat it as a separator, so
  // `..\..\etc\passwd.pdf` collapsed to `......etcpasswd.pdf` instead of
  // reducing to its bare filename the way the upload path does.
  const safe = sanitizeFileName(displayName).replace(/["\\]/g, '').trim() || 'resume'
  const ascii = `${safe.replace(/[^\x20-\x7E]/g, '_')}.pdf`
  const utf8 = encodeURIComponent(`${RESUME_FILE_WORD[locale]} — ${safe}.pdf`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

const RESUME_FILE_WORD: Record<Locale, string> = { uk: 'Резюме', en: 'Resume' }

/**
 * QA-LOW-4. Past the per-route `fileSize` limit passed to `req.parts` (see `uploadSource`), the
 * multipart plugin throws `FST_REQ_FILE_TOO_LARGE`, a 413 with no code; the resume upload answers
 * it with its own coded 413. Backlog 450: a second file part (`FST_FILES_LIMIT`) or too many parts
 * (`FST_PARTS_LIMIT`) is the plugin's uncoded 413 too and gets one coded 413. Any other failure goes on as it is.
 */
function uploadLimitError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return apiError('RESUME_UPLOAD_TOO_MANY_PARTS', HttpStatus.PAYLOAD_TOO_LARGE)
  }
  if (code !== 'FST_REQ_FILE_TOO_LARGE') return err
  return apiError('RESUME_FILE_TOO_LARGE', HttpStatus.PAYLOAD_TOO_LARGE, {
    mb: Math.floor(RESUME_SOURCE_MAX_BYTES / 1024 / 1024),
  })
}

/**
 * The 202 body of `GET resume/pdf` while no current PDF exists (backlog 443).
 * `stored` is the row's `pdf_render_error` (FAILED) or null (still building).
 * It carries the code and params for a client with a catalog and the English
 * line in `message` for one without. A row written before codes existed holds
 * Russian text; that text goes out as it is, with no code.
 */
export function pendingPdfBody(
  status: 'QUEUED' | 'RUNNING' | 'FAILED',
  stored: string | null,
): {
  status: string
  code?: StoredResumeMessage['code']
  params?: Record<string, string | number> | undefined
  message: string
} {
  const decoded =
    stored === null
      ? { code: 'RESUME_PDF_PREPARING' as const }
      : decodeResumeMessage(stored, 'RESUME_ERROR_DETAILS_UNAVAILABLE')
  if (decoded === null) return { status, message: String(stored) }
  return { status, ...decoded, message: interpolate(decoded.code, decoded.params) }
}
