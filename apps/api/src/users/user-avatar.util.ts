import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import { documents } from '../database/schema'
import type { DatabaseService } from '../database/database.service'

/**
 * Validate that the supplied `avatarDocumentId` references a document with
 * `category = 'AVATAR'`, is not soft-deleted, and is owned by
 * `expectedOwnerId`. The owner check is unconditional: it takes no role or
 * invoker input, so there is no ADMIN bypass. Throws via `apiError(...,
 * HttpStatus.BAD_REQUEST)` (HTTP 400 with an error code) otherwise.
 *
 * `null` / `undefined` is treated as a clear-avatar operation and
 * short-circuits without querying.
 *
 * Extracted from `UsersService.assertAvatarDocument`; the only code change
 * is `this.db.db` -> the `db` parameter.
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
