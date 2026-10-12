/**
 * Hard-delete execution for DocumentsService (L9 leaf extraction, behavior-preserving
 * MOVE). Free functions over explicit arguments — no DI edge. Bodies are verbatim from
 * DocumentsService; they encode PERMANENT-deletion ordering: S3 objects first (main, then
 * thumbnail), DB row last. The RBAC / soft-delete gates (`hardDelete` role + deletedAt
 * checks) stay on the facade and run BEFORE any of these.
 */
import { HttpStatus, type Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import { documents } from '../database/schema'
import { apiError } from '../common/api-error'
import type { S3Service } from './s3.service'

type HardDeletableDoc = Pick<typeof documents.$inferSelect, 'id' | 's3Key' | 'thumbnailS3Key'>

/**
 * Permanently remove S3 object(s) and the DB row for an already-resolved document.
 *
 * Order chosen for safety:
 *  1. S3 delete first (idempotent in S3Service — missing key swallowed). Main object
 *     first, then the thumbnail if present (NULL when no thumb exists, e.g. PDFs).
 *  2. DB row delete second — after S3, so a crash between the two leaves at most a
 *     dangling S3 object (cheap) rather than a missing S3 object with a DB row pointing
 *     at it (broken download). FK cascades (ON DELETE SET NULL) happen on the row delete.
 */
export async function executeHardDelete(
  db: DatabaseService,
  s3: S3Service,
  doc: HardDeletableDoc,
): Promise<void> {
  await s3.delete(doc.s3Key)
  if (doc.thumbnailS3Key) {
    await s3.delete(doc.thumbnailS3Key)
  }
  await db.db.delete(documents).where(eq(documents.id, doc.id))
}

/**
 * Internal hard-delete bypass — NO RBAC, trusted server code only (e.g. TransactionsService
 * replacing a SENIOR_INCOME receipt). Does NOT require the document to be soft-deleted.
 * Throws DOCUMENT_NOT_FOUND (404) when the row does not exist.
 */
export async function hardDeleteById(
  db: DatabaseService,
  s3: S3Service,
  docId: string,
): Promise<void> {
  const doc = await db.db.query.documents.findFirst({
    where: eq(documents.id, docId),
  })
  if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)
  await executeHardDelete(db, s3, doc)
}

/**
 * Best-effort S3-only cleanup (post-commit, DB row already deleted inside a transaction).
 * Errors are swallowed + warned — a dangling S3 object costs pennies; rolling back the DB
 * for an S3 hiccup would be worse. Main key and thumbnail key are attempted independently.
 */
export async function deleteS3Keys(
  s3: S3Service,
  logger: Logger,
  mainKey: string,
  thumbKey: string | null | undefined,
): Promise<void> {
  try {
    await s3.delete(mainKey)
  } catch (err) {
    logger.warn(`deleteS3Keys: failed to delete main key="${mainKey}": ${(err as Error).message}`)
  }
  if (thumbKey) {
    try {
      await s3.delete(thumbKey)
    } catch (err) {
      logger.warn(
        `deleteS3Keys: failed to delete thumb key="${thumbKey}": ${(err as Error).message}`,
      )
    }
  }
}
