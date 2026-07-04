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
 * (AVATAR — Profile UI; LOGO — Project edit dialog; INVOICE —
 * `/crm/finance/invoices` UI). ADMIN may enable a "show internal" toggle
 * for audit/cleanup workflows.
 */
export const INTERNAL_CATEGORIES = ['AVATAR', 'LOGO', 'INVOICE'] as const

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
  'INVOICE',
])
export type DocumentCategory = z.infer<typeof documentCategorySchema>

// ---------------------------------------------------------------------------
// Status badge (PR-2 — unified list + badges)
// ---------------------------------------------------------------------------

/**
 * Semantic status badge attached by the backend to each document entry.
 *
 * `kind` — the type of source document:
 *   'contract' — from `employee_contracts` (virtual entry)
 *   'invoice'  — from `documents` (INVOICE category) + `invoice_signatures`
 *   'receipt'  — from `documents` (RECEIPT category) + linked `transactions.status`
 *
 * `state` — derived from the source's data:
 *   contract: 'draft' | 'ready' | 'signed'
 *   invoice:  'ready' (missing sig) | 'signed' (both sigs present)
 *   receipt:  'pending' (PENDING/REJECTED) | 'validated' (VALIDATED)
 *
 * Backend sends semantics only; Russian labels live in the frontend
 * (DocumentStatusBadge component). RESUME/SCAN/uploaded CONTRACT files
 * get `statusBadge: null` — no badge rendered.
 */
export const statusBadgeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('contract'),
    state: z.enum(['draft', 'ready', 'signed']),
  }),
  z.object({
    kind: z.literal('invoice'),
    state: z.enum(['ready', 'signed']),
  }),
  z.object({
    kind: z.literal('receipt'),
    state: z.enum(['pending', 'validated']),
  }),
])
export type StatusBadge = z.infer<typeof statusBadgeSchema>

/**
 * Discriminator that tells the frontend what kind of entry this is.
 *   'file'              — a row from the `documents` table (uploaded file)
 *   'employee_contract' — a virtual entry synthesised from `employee_contracts`
 *
 * The discriminator is used to avoid double-counting: an uploaded CONTRACT
 * file (category='CONTRACT') and the canonical employee_contract are two
 * distinct entries and affordances (edit contract body vs. download PDF).
 */
export const documentSourceSchema = z.enum(['file', 'employee_contract'])
export type DocumentSource = z.infer<typeof documentSourceSchema>

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
  // s3Key intentionally omitted from the public DTO — it is an internal storage
  // identifier that clients do not need and should not see (s3/documents hygiene).
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
  /**
   * For INVOICE category only: the parent transaction id this invoice
   * document belongs to (joined from `transactions.invoice_document_id`).
   * Lets the UI open `InvoiceDetailDialog` (keyed by transaction id) from
   * a `Document` row in `/crm/documents`. Null for non-INVOICE rows and
   * for INVOICE rows where the FK has been broken (defensive — should
   * not happen in practice since InvoicesService writes both together).
   */
  invoiceTransactionId: z.string().uuid().nullable().optional(),
  /**
   * For INVOICE category only: `true` when the *current viewer* is the
   * expected counterparty for the parent transaction AND no COUNTERPARTY
   * signature has been recorded yet. Computed at SELECT time by the API
   * (see DocumentsService.list — SQL CASE expression that LEFT JOINs the
   * transaction + NOT EXISTS the signature). Drives:
   *   - the «Требует подписи» badge on DocumentCard
   *   - the amber banner at the top of /crm/documents counting how many
   *     invoices wait for the viewer's signature
   * Optional (back-compat with older clients) + default false on the wire
   * for non-INVOICE rows.
   *
   * @deprecated Superseded by `statusBadge` for INVOICE rows (PR-2).
   * Kept for backward compatibility — existing clients relying on this field
   * continue to work. New code should read `statusBadge` instead.
   */
  invoicePendingSignature: z.boolean().optional(),
  /**
   * Semantic status badge from the backend (PR-2 — unified list + badges).
   * Null for RESUME / SCAN / plain CONTRACT uploads (no badge shown).
   * Present for INVOICE rows (derived from invoice_signatures),
   * RECEIPT rows (derived from linked transactions.status), and
   * employee_contract virtual entries (from employee_contracts.status).
   * Optional for backward compat with pre-PR-2 API responses.
   */
  statusBadge: statusBadgeSchema.nullable().optional(),
  /**
   * Discriminator: 'file' for rows from the `documents` table,
   * 'employee_contract' for virtual entries from `employee_contracts`.
   * Optional for backward compat.
   */
  source: documentSourceSchema.optional(),
  /**
   * For employee_contract virtual entries only: the typed name from the
   * signed_contracts record (i.e. what the employee typed when signing).
   * Null for unsigned contracts and all non-contract documents.
   * AC6 polish — shown in DocumentDetailDialog «Подписал» row.
   */
  signedByName: z.string().nullable().optional(),
  /**
   * For employee_contract virtual entries only: ISO timestamp of when the
   * employee signed the contract. Null for unsigned contracts and all
   * non-contract documents. AC6 polish — shown in DocumentDetailDialog.
   */
  signedAt: z.string().datetime().nullable().optional(),
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
  .refine((data) => data.category !== 'CONTRACT' || Boolean(data.projectId), {
    message: 'projectId is required for CONTRACT documents',
    path: ['projectId'],
  })
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

// ---------------------------------------------------------------------------
// Orphan reconciliation (POST /api/documents/reconcile-orphans, ADMIN only)
// ---------------------------------------------------------------------------

/**
 * Query / body params for the reconcile-orphans endpoint.
 * Both fields are optional — defaults are applied server-side:
 *   dryRun=true, graceHours=48.
 */
export const reconcileOrphansOptionsSchema = z.object({
  /** When true (default), nothing is deleted — only a report is returned. */
  dryRun: z.boolean().default(true),
  /**
   * Objects modified within this many hours are skipped (in-flight uploads).
   * Default: 48 hours. Minimum 1 hour — graceHours=0 would allow the
   * reconciler to delete objects whose DB row hasn't committed yet (race
   * condition between S3 upload and Postgres commit). Enforced here so the
   * controller can never pass 0 to the destructive deletion path.
   */
  graceHours: z.number().int().min(1).default(48),
})
export type ReconcileOrphansOptions = z.infer<typeof reconcileOrphansOptionsSchema>

/**
 * A single orphan S3 object entry in the reconciliation report.
 */
export const orphanEntrySchema = z.object({
  /** S3 object key. */
  key: z.string().min(1),
  /** Object size in bytes. */
  sizeBytes: z.number().int().nonnegative(),
  /** ISO timestamp of LastModified from S3. */
  lastModified: z.string().datetime(),
})
export type OrphanEntry = z.infer<typeof orphanEntrySchema>

/**
 * Report returned by POST /api/documents/reconcile-orphans.
 * When dryRun=true, deleted is always 0.
 */
export const reconcileReportSchema = z.object({
  /** Total number of S3 objects scanned (across all paginated pages). */
  scannedObjects: z.number().int().nonnegative(),
  /** Total number of DB keys loaded (s3Key + thumbnailS3Key). */
  dbKeys: z.number().int().nonnegative(),
  /** Orphan objects: in S3 but not in DB AND older than graceHours. */
  orphans: z.array(orphanEntrySchema),
  /** Sum of orphan object sizes in bytes. */
  orphanBytes: z.number().int().nonnegative(),
  /** Number of objects actually deleted (always 0 when dryRun=true). */
  deleted: z.number().int().nonnegative(),
  /** Whether this was a dry run. */
  dryRun: z.boolean(),
})
export type ReconcileReport = z.infer<typeof reconcileReportSchema>
