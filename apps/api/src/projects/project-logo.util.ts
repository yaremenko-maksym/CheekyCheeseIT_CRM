import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import { documents } from '../database/schema'
import type { DatabaseService } from '../database/database.service'

/**
 * Validate that the supplied `logoDocumentId` references a document with
 * `category = 'LOGO'`. ProjectId match is enforced when present — protects
 * against using the logo of another project. Throws `BadRequestException`.
 * Null is treated as a clear-logo operation and short-circuits.
 *
 * Extracted verbatim from `ProjectsService.assertLogoDocument` (leaf P-L6);
 * the only change is `this.db.db` -> the `db` parameter.
 */
export async function assertLogoDocument(
  db: DatabaseService['db'],
  documentId: string | null | undefined,
  projectId: string | null,
): Promise<void> {
  if (documentId === undefined || documentId === null) return
  const row = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  })
  if (!row) throw apiError('LOGO_DOCUMENT_NOT_FOUND', HttpStatus.BAD_REQUEST)
  if (row.category !== 'LOGO') {
    throw apiError('LOGO_DOCUMENT_WRONG_CATEGORY', HttpStatus.BAD_REQUEST)
  }
  if (row.deletedAt !== null) {
    throw apiError('LOGO_DOCUMENT_DELETED', HttpStatus.BAD_REQUEST)
  }
  if (projectId !== null && row.projectId !== null && row.projectId !== projectId) {
    throw apiError('LOGO_DOCUMENT_WRONG_PROJECT', HttpStatus.BAD_REQUEST)
  }
}
