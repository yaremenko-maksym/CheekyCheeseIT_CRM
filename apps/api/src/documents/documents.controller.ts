/**
 * DocumentsController — HTTP surface for PHASE 6 documents.
 *
 * Upload uses Fastify's native multipart support (@fastify/multipart is
 * registered globally in main.ts with the 10 MB cap). The controller pulls
 * exactly one file field + arbitrary metadata fields, defers all business
 * logic to DocumentsService.
 *
 * Endpoints (all prefixed `/api/documents` by the global prefix):
 *   POST   /                upload (multipart)
 *   GET    /                list (RBAC-filtered)
 *   GET    /:id/download    presigned URL { url, expiresAt }
 *   DELETE /:id             soft delete (owner or ADMIN)
 *   POST   /:id/restore     restore from trash (ADMIN)
 *   DELETE /:id/hard        hard delete (ADMIN, requires prior soft delete)
 */
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import {
  createDocumentMetadataSchema,
  documentListFiltersSchema,
  type CreateDocumentMetadata,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { DocumentsService } from './documents.service'

/** Minimal shape of a multipart field as returned by @fastify/multipart. */
interface MultipartField {
  type: 'field' | 'file'
  fieldname: string
  value?: unknown
  toBuffer?: () => Promise<Buffer>
  mimetype?: string
  filename?: string
}

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // ---------------------------------------------------------------------------
  // POST /api/documents — upload (multipart)
  // ---------------------------------------------------------------------------

  @Post()
  async upload(@Req() req: FastifyRequest, @CurrentUser() user: SessionUser) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Content-Type must be multipart/form-data')
    }

    // Drain the multipart stream into in-memory parts. With @fastify/multipart
    // configured to attach fields to the body (attachFieldsToBody: 'keyValues'
    // mode), we can iterate via req.parts() and collect both file + fields.
    let file: { buffer: Buffer; mimetype: string; originalname: string } | null = null
    const fields: Record<string, string> = {}

    for await (const part of req.parts() as AsyncIterable<MultipartField>) {
      if (part.type === 'file' && part.fieldname === 'file') {
        // Only one file per upload — first one wins.
        if (file) continue
        const buffer = await (part.toBuffer
          ? part.toBuffer()
          : Promise.reject(new Error('Multipart file has no toBuffer()')))
        file = {
          buffer,
          mimetype: part.mimetype ?? 'application/octet-stream',
          originalname: part.filename ?? 'upload',
        }
      } else if (part.type === 'field') {
        // value is unknown — coerce to string for our Zod schema.
        if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value
        }
      }
    }

    if (!file) {
      throw new BadRequestException('Missing "file" field in multipart body')
    }

    const meta: CreateDocumentMetadata = createDocumentMetadataSchema.parse({
      category: fields['category'],
      projectId: fields['projectId'] || undefined,
      ownerId: fields['ownerId'] || undefined,
      name: fields['name'] || undefined,
    })

    return this.documentsService.upload(user, file, meta)
  }

  // ---------------------------------------------------------------------------
  // GET /api/documents — list
  // ---------------------------------------------------------------------------

  @Get()
  list(@Query() query: Record<string, string>, @CurrentUser() user: SessionUser) {
    // Coerce includeDeleted from string → boolean before zod parse.
    const filters = documentListFiltersSchema.parse({
      category: query['category'] || undefined,
      ownerId: query['ownerId'] || undefined,
      projectId: query['projectId'] || undefined,
      includeDeleted: query['includeDeleted'] === 'true',
    })
    return this.documentsService.list(user, filters)
  }

  // ---------------------------------------------------------------------------
  // GET /api/documents/:id/download — presigned URL
  // ---------------------------------------------------------------------------

  @Get(':id/download')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.documentsService.getDownloadUrl(user, id)
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/documents/:id — soft delete
  // ---------------------------------------------------------------------------

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documentsService.softDelete(user, id)
  }

  // ---------------------------------------------------------------------------
  // POST /api/documents/:id/restore — restore from trash (ADMIN)
  // ---------------------------------------------------------------------------

  @Post(':id/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.documentsService.restore(user, id)
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/documents/:id/hard — hard delete (ADMIN, after soft delete)
  // ---------------------------------------------------------------------------

  @Delete(':id/hard')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hardDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documentsService.hardDelete(user, id)
  }

}
