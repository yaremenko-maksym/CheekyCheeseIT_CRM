/**
 * Presigned-URL building + access logging for DocumentsService (L10 leaf extraction,
 * behavior-preserving MOVE). Free functions over explicit arguments — no DI edge.
 * Bodies are verbatim from DocumentsService; they encode credential/TTL/sensitivity
 * decisions: category-based TTL, sensitive-category access logging, and the rule that a
 * thumbnail inherits the MAIN document's category. The access gate (`findActiveOrThrow`)
 * stays on the facade and runs BEFORE any of these.
 */
import type { Logger } from '@nestjs/common'
import type { DocumentCategory, PresignedDownload, SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { documentAccessLog, type documents } from '../database/schema'
import { isSensitiveCategory, presignTtlForCategory, type S3Service } from './s3.service'

type PresignableDoc = Pick<
  typeof documents.$inferSelect,
  'id' | 'name' | 'originalName' | 'category' | 's3Key' | 'thumbnailS3Key'
>

/**
 * task-file-storage-hardening §7: best-effort access-log entry. Only sensitive
 * categories are logged (CONTRACT/RECEIPT/INVOICE/RESUME/SCAN). Never records the
 * presigned URL itself, only actor/document/category. A logging failure must not
 * block the actual download/preview/thumbnail fetch (error swallowed + warned).
 *
 * MED-1 (security-review round 3): `actorId` is the REAL human behind the request,
 * `actor.impersonatorId ?? actor.id`.
 */
export async function logDocumentAccess(
  db: DatabaseService,
  logger: Logger,
  actor: SessionUser,
  docId: string,
  category: DocumentCategory,
  action: 'DOWNLOAD' | 'PREVIEW' | 'THUMBNAIL',
): Promise<void> {
  if (!isSensitiveCategory(category)) return
  try {
    await db.db.insert(documentAccessLog).values({
      actorId: actor.impersonatorId ?? actor.id,
      targetId: docId,
      action,
      metadata: { category },
    })
  } catch (err) {
    logger.warn(
      `logAccess: failed to write access-log row for docId=${docId}: ${(err as Error).message}`,
    )
  }
}

/**
 * Presign the main file. DOWNLOAD forces `Content-Disposition: attachment` (Save
 * dialog); PREVIEW forces `inline` (iframe render). Same category-based TTL for both:
 * sensitive categories get 30 min; AVATAR/LOGO keep the 24h default.
 */
export async function presignDocument(
  s3: S3Service,
  db: DatabaseService,
  logger: Logger,
  actor: SessionUser,
  doc: PresignableDoc,
  action: 'DOWNLOAD' | 'PREVIEW',
): Promise<PresignedDownload> {
  // Variant 3 hybrid: download-as filename = original (unicode) when available,
  // falling back to the sanitized ASCII `name` for legacy rows (pre-migration 0011).
  const downloadAs = doc.originalName ?? doc.name
  const ttl = presignTtlForCategory(doc.category as DocumentCategory)
  await logDocumentAccess(db, logger, actor, doc.id, doc.category as DocumentCategory, action)
  return s3.getPresignedDownloadUrl(
    doc.s3Key,
    ttl,
    downloadAs,
    action === 'DOWNLOAD' ? 'attachment' : 'inline',
    doc.category as DocumentCategory,
  )
}

/**
 * Presign the thumbnail (null when none exists). Thumbnails inherit the MAIN
 * document's category and therefore its TTL/sensitivity: a leaked thumbnail URL
 * expires at the same time as the full file.
 */
export async function presignThumbnail(
  s3: S3Service,
  db: DatabaseService,
  logger: Logger,
  actor: SessionUser,
  doc: PresignableDoc,
): Promise<PresignedDownload | null> {
  if (!doc.thumbnailS3Key) return null
  const category = doc.category as DocumentCategory
  const ttl = presignTtlForCategory(category)
  await logDocumentAccess(db, logger, actor, doc.id, category, 'THUMBNAIL')
  return s3.getPresignedDownloadUrl(doc.thumbnailS3Key, ttl, undefined, 'inline', category)
}
