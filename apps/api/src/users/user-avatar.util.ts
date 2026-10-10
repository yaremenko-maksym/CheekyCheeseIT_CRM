import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import { documents } from '../database/schema'
import type { DatabaseService } from '../database/database.service'

/**
 * Validate that the supplied `avatarDocumentId` references a document with
 * `category = 'AVATAR'` owned by `ownerId` (or any owner when invoker is
 * ADMIN). Throws `BadRequestException` otherwise so the caller surfaces a
 * 400 with a human-readable message.
 *
 * `null` is treated as a clear-avatar operation and short-circuits.
 *
 * Extracted verbatim from `UsersService.assertAvatarDocument`; the only
 * change is `this.db.db` -> the `db` parameter.
 */
export async function assertAvatarDocument(
  db: DatabaseService['db'],
  documentId: string | null | undefined,
  expectedOwnerId: string,
): Promise<void> {
  if (documentId === undefined || documentId === null) return
  const row = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  })
  if (!row) throw apiError('AVATAR_DOCUMENT_NOT_FOUND', HttpStatus.BAD_REQUEST)
  if (row.category !== 'AVATAR') {
    throw apiError('AVATAR_DOCUMENT_WRONG_CATEGORY', HttpStatus.BAD_REQUEST)
  }
  if (row.ownerId !== expectedOwnerId) {
    throw apiError('AVATAR_DOCUMENT_WRONG_OWNER', HttpStatus.BAD_REQUEST)
  }
  if (row.deletedAt !== null) {
    throw apiError('AVATAR_DOCUMENT_DELETED', HttpStatus.BAD_REQUEST)
  }
}
