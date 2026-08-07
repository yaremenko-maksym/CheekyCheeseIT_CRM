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
 *
 * Auth: the global JwtAuthGuard (AppModule APP_GUARD) authenticates. There is
 * deliberately NO `@Roles()` decorator here: the §4 table is per-TARGET
 * ("SENIOR may write their OWN resume"), which a role-only guard cannot
 * express — RolesGuard would happily let SENIOR A write SENIOR B's resume.
 * The real check lives in SeniorResumesService.assertAccess and is a
 * comparison of ids.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ingestResumeTextSchema, updateResumeContentSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { SeniorResumesService } from './resumes.service'

/** Minimal shape of a multipart part as returned by @fastify/multipart. */
interface MultipartField {
  type: 'field' | 'file'
  fieldname: string
  value?: unknown
  toBuffer?: () => Promise<Buffer>
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
    if (!req.isMultipart()) {
      throw new BadRequestException('Ожидается multipart/form-data')
    }

    let file: { buffer: Buffer; mimetype: string; originalname: string } | null = null
    for await (const part of req.parts() as AsyncIterable<MultipartField>) {
      if (part.type !== 'file' || part.fieldname !== 'file') continue
      if (file) continue // first file wins
      if (!part.toBuffer) throw new BadRequestException('Файл не удалось прочитать')
      file = {
        buffer: await part.toBuffer(),
        mimetype: part.mimetype ?? 'application/octet-stream',
        originalname: part.filename ?? 'resume',
      }
    }
    if (!file) throw new BadRequestException('В запросе нет поля "file"')

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
   * Rendered PDF. `no-store` because the body is personal data and the content
   * changes on every save — a cached copy would show a stale resume and would
   * sit in the browser's disk cache, which is exactly what the sensitive
   * documents policy avoids elsewhere.
   */
  @Get('pdf')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async getPdf(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { pdfBuffer, displayName } = await this.service.generatePdf(user, userId)
    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', resumeContentDisposition(displayName))
      .send(pdfBuffer)
  }
}

/**
 * Build a `Content-Disposition` value for the rendered PDF. The display name
 * is user data, so the ASCII slot is stripped of anything that could break out
 * of the quoted parameter and the UTF-8 slot carries the real (Cyrillic) name.
 * Mirrors `safeContractFilename` in the contracts module.
 */
export function resumeContentDisposition(displayName: string): string {
  const safe = displayName.replace(/["\\\r\n]/g, '').trim() || 'resume'
  const ascii = `${safe.replace(/[^\x20-\x7E]/g, '_')}.pdf`
  const utf8 = encodeURIComponent(`Резюме — ${safe}.pdf`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}
