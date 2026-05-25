import { z } from 'zod'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum file size accepted by upload endpoints / clientside picker.
 * 10 MB hard cap. Files larger than this are rejected before reaching S3.
 */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/**
 * Allowed MIME types for upload. Compression / re-encode is applied on the
 * backend after validation (HEIC → JPEG, PNG-no-alpha → JPEG, etc.), so the
 * final stored `mime_type` may differ from the uploaded value.
 */
export const DOCUMENT_MIME_WHITELIST = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const satisfies readonly string[]

/**
 * Internal categories — stored in `documents` table but NOT shown in
 * `/crm/documents` UI. They are managed only from their native places
 * (AVATAR — Profile UI; LOGO — Project edit dialog). ADMIN may enable a
 * "show internal" toggle for audit/cleanup workflows.
 */
export const INTERNAL_CATEGORIES = ['AVATAR', 'LOGO'] as const

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const documentCategorySchema = z.enum([
  'RESUME',
  'SCAN',
  'CONTRACT',
  'RECEIPT',
  'AVATAR',
  'LOGO',
])
export type DocumentCategory = z.infer<typeof documentCategorySchema>

// ---------------------------------------------------------------------------
// Document DTO (full row as returned from API)
// ---------------------------------------------------------------------------

export const documentSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  category: documentCategorySchema,
  /**
   * Sanitized (ASCII-only) filename used inside the S3 key and as the
   * download-as filename. Variant 3 "hybrid": s3 strict, original preserved,
   * UI shows `originalName`, download uses this.
   */
  name: z.string().min(1).max(255),
  /**
   * Original filename as uploaded by the user (cyrillic / unicode preserved).
   * Nullable for backwards compatibility with rows created before migration
   * 0011 — the UI falls back to `name` when this is null.
   */
  originalName: z.string().min(1).max(255).nullable(),
  s3Key: z.string().min(1).max(512),
  /**
   * S3 key of the 256x256 JPEG thumbnail (generated synchronously for image
   * MIME types). NULL for non-image documents (UI shows a category icon).
   */
  thumbnailS3Key: z.string().min(1).max(512).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(64),
  uploadedBy: z.string().uuid(),
  /**
   * Display name of the user who uploaded the document. Embedded by the API
   * via a LEFT JOIN on `users` so the UI does not need a second `/api/users`
   * round-trip (and works for JUNIOR / SENIOR / ACCOUNTANT roles which do
   * not have access to that endpoint). Nullable for safety:
   *   - legacy rows where the uploader was hard-deleted from `users`
   *   - the field is computed at SELECT time; a missing user row leaves it
   *     null so the UI can fall back to `shortId(uploadedBy)`.
   */
  uploadedByDisplayName: z.string().min(1).max(255).nullable(),
  deletedAt: z.string().datetime().nullable(),
  deletedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
})
export type Document = z.infer<typeof documentSchema>

// ---------------------------------------------------------------------------
// Create metadata (multipart upload body, excluding the file itself)
// ---------------------------------------------------------------------------

/**
 * Metadata accepted on `POST /api/documents` (the file is sent as multipart
 * field `file`; everything else lives in this object).
 *
 * Refinement: `CONTRACT` requires `projectId`. Other categories may omit it
 * (or set it to null — both are accepted).
 */
export const createDocumentMetadataSchema = z
  .object({
    category: documentCategorySchema,
    projectId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(255).optional(),
    /**
     * For uploads on behalf of another user (ADMIN/HR/SENIOR uploading
     * RESUME/SCAN for someone else). When omitted the API uses
     * `req.user.id` as the owner.
     */
    ownerId: z.string().uuid().optional(),
  })
  .refine(
    (data) => data.category !== 'CONTRACT' || Boolean(data.projectId),
    {
      message: 'projectId is required for CONTRACT documents',
      path: ['projectId'],
    },
  )
export type CreateDocumentMetadata = z.infer<typeof createDocumentMetadataSchema>

// ---------------------------------------------------------------------------
// List filters (query string)
// ---------------------------------------------------------------------------

export const documentListFiltersSchema = z.object({
  category: documentCategorySchema.optional(),
  ownerId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  /**
   * Include soft-deleted documents in the result. ADMIN only — the API
   * rejects the flag from non-ADMIN callers.
   */
  includeDeleted: z.boolean().optional().default(false),
})
export type DocumentListFilters = z.infer<typeof documentListFiltersSchema>

// ---------------------------------------------------------------------------
// Pre-signed download response
// ---------------------------------------------------------------------------

export const presignedDownloadSchema = z.object({
  url: z.string().url(),
  /** ISO timestamp; aligns with the pre-signed URL TTL (default 24h). */
  expiresAt: z.string().datetime(),
})
export type PresignedDownload = z.infer<typeof presignedDownloadSchema>
