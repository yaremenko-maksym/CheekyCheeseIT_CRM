/**
 * DocumentsService — application layer for PHASE 6 documents.
 *
 * Responsibilities:
 *  - Upload pipeline: validate MIME/size → compress → push to S3 → write DB row
 *    (with compensation: delete DB row if S3 upload throws after the insert)
 *  - Listing with RBAC filter per category (7 categories: RESUME, SCAN,
 *    CONTRACT, RECEIPT, AVATAR, LOGO, INVOICE). AVATAR + LOGO + INVOICE are
 *    "internal" — hidden from default list unless ADMIN explicitly opts in.
 *    INVOICE rows are also blocked from the public upload endpoint (only
 *    InvoicesService creates them; see Invoice Signing Epic).
 *  - Presigned download URL (24h TTL via S3Service)
 *  - Two-stage delete: soft (owner/ADMIN) and hard (ADMIN-only, requires
 *    prior soft delete)
 *
 * Why RBAC lives in the service (not a guard):
 *   The rules are *content-aware* (each category has its own visibility +
 *   upload matrix and HR's contract scope depends on a join with teams).
 *   A generic role guard can't express any of that — keeping the rules here
 *   makes them testable in isolation.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_WHITELIST,
  INTERNAL_CATEGORIES,
  type CreateDocumentMetadata,
  type Document as DocumentDto,
  type DocumentCategory,
  type DocumentListFilters,
  type PresignedDownload,
  type SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
// security-review PR #456 round 2 (merged in via MED-4, round 3 of THIS
// task's review): `nonDeletedTransactions` (VIEW), never the raw
// `transactions` table — this module is outside `finance/**` and the
// ESLint no-restricted-imports rule bans the raw import here. Merging with
// the raw table instead (reverting this) would silently bring back
// signature/status badges for soft-deleted transactions — resolved
// keeping main's VIEW-based import, on top of this task's own additions
// (`documentAccessLog`/`projectMembers`/`projects`/`HrAccessService`/
// `isSensitiveCategory`) — no raw `transactions` reference remains
// anywhere in this file (confirmed: it was already unused here even
// before this merge, a leftover from the round-2 accountant-scoping
// revert).
import { documents, invoiceSignatures, nonDeletedTransactions, users } from '../database/schema'
import { HrAccessService } from '../common/hr-access.service'
import { getHrSeniorIds, getTeammateIds } from './document-scope.util'
import { buildListWhere } from './document-visibility.util'
import { S3Service } from './s3.service'
import {
  deleteS3Keys as deleteS3KeysUtil,
  executeHardDelete,
  hardDeleteById,
} from './document-hard-delete.util'
import { presignDocument, presignThumbnail } from './document-presign.util'
import { CompressionService, CompressionError, detectMimeFromBuffer } from './compression.service'
import type { DrizzleTx } from '../database/types'
import { apiError } from '../common/api-error'
import { sanitizeFilename, thumbnailKeyFor } from './document-key.util'
import { deriveStatusBadge, mapContractVirtualEntry, mapDocument } from './document-mapping.util'
import { assertCanUpload } from './document-upload-rbac.util'

/** What the controller hands us after parsing the multipart request. */
export interface UploadFileInput {
  buffer: Buffer
  mimetype: string
  originalname: string
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly compression: CompressionService,
    private readonly hrAccess: HrAccessService,
  ) {}

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  async upload(
    actor: SessionUser,
    file: UploadFileInput,
    meta: CreateDocumentMetadata,
  ): Promise<DocumentDto> {
    // ---- 1. Validate MIME — two-stage: client Content-Type whitelist + magic-byte confirmation ----
    if (!(DOCUMENT_MIME_WHITELIST as readonly string[]).includes(file.mimetype)) {
      throw apiError('DOCUMENT_MIME_NOT_ALLOWED', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }
    // Magic-byte check: detect real content type from buffer signatures.
    // Guards against clients sending a false Content-Type (e.g. "image/jpeg"
    // for a PDF or arbitrary binary). We reject if the detected type differs
    // from the declared type OR if we cannot identify the buffer at all.
    const detectedMime = detectMimeFromBuffer(file.buffer)
    if (!detectedMime) {
      throw apiError('DOCUMENT_CONTENT_UNRECOGNIZED', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }
    if (detectedMime !== file.mimetype) {
      throw apiError('DOCUMENT_CONTENT_TYPE_MISMATCH', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }

    // ---- 2. Validate size ----
    if (file.buffer.length > DOCUMENT_MAX_BYTES) {
      throw apiError('DOCUMENT_TOO_LARGE', HttpStatus.PAYLOAD_TOO_LARGE, {
        maxMb: Math.floor(DOCUMENT_MAX_BYTES / 1024 / 1024),
      })
    }

    // ---- 3. Resolve target owner (default = self) ----
    const ownerId = meta.ownerId ?? actor.id

    // ---- 4. RBAC: can `actor` upload `category` for `ownerId`? ----
    assertCanUpload(actor.role, actor.id, meta.category, ownerId)

    // ---- 5. CONTRACT requires projectId (Zod already enforced this; double-check defensively) ----
    if (meta.category === 'CONTRACT' && !meta.projectId) {
      throw apiError('DOCUMENT_PROJECT_ID_REQUIRED', HttpStatus.BAD_REQUEST)
    }

    // ---- 6. Compression (always — backend handles all formats) ----
    // CompressionError is thrown when sharp/pdf-lib rejects the buffer (corrupt
    // file, misidentified content). Surface as 415 — the client must provide a
    // valid, processable file rather than getting a silent raw-byte passthrough.
    //
    // SPEC-H-1 (PR #702 fix-round 1): this is the CRM-facing (authenticated)
    // catch site for `CompressionError` — task plan scope explicitly requires
    // migrating it, unlike the public/anonymous one in
    // `vacancies/applications.service.ts::compressResume` (kept as
    // `UnsupportedMediaTypeException`, see that file's own comment). The
    // `DOCUMENT_CONTENT_UNRECOGNIZED` code already covers "couldn't process
    // this file — it may be damaged" (same 415, same meaning as a
    // sharp/pdf-lib processing failure on a whitelisted MIME) — reused here
    // rather than minting a near-duplicate code. `err.message` (which used
    // to carry a Russian sentence plus the raw library error) is dropped
    // entirely from the response; it stays in the server log only, via
    // `CompressionService`'s own `this.logger.error(...)` call right before
    // this throw.
    let compressed: Awaited<ReturnType<CompressionService['compress']>>
    try {
      compressed = await this.compression.compress(file.buffer, file.mimetype)
    } catch (err) {
      if (err instanceof CompressionError) {
        throw apiError('DOCUMENT_CONTENT_UNRECOGNIZED', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
      }
      throw err
    }

    // ---- 7. Generate s3 key + sanitize filename ----
    // Variant 3 (hybrid): the original filename is kept intact in
    // `original_name` (UI display + download-as), while `name` and the S3
    // key are strictly ASCII so cyrillic / unicode never breaks an
    // S3 PutObject or a presigned URL signature.
    const docId = randomUUID()
    const originalName = (meta.name ?? file.originalname).slice(0, 255)
    const sanitizedName = sanitizeFilename(originalName)
    const s3Key = `documents/${meta.category}/${ownerId}/${docId}-${sanitizedName}`

    // ---- 8. Generate thumbnail (sync) BEFORE the DB insert so we can
    //         persist the thumbnail key in the same row. PDFs / non-images
    //         skip this; UI falls back to a category icon. Thumbnail
    //         failures (sharp errors) are non-fatal — they just leave the
    //         thumbnail column NULL, never block the upload.
    let thumbnailBuffer: Buffer | null = null
    if (compressed.finalMimeType.startsWith('image/')) {
      thumbnailBuffer = await this.compression.makeThumbnail(
        compressed.buffer,
        compressed.finalMimeType,
      )
    }
    const thumbnailS3Key = thumbnailBuffer ? thumbnailKeyFor(s3Key) : null

    // ---- 9. Insert DB row FIRST, then S3 (compensate on S3 failure) ----
    // This avoids orphan S3 objects (which cost money) at the price of
    // ephemeral orphan DB rows (free + cleaned in the compensation block).
    const [row] = await this.db.db
      .insert(documents)
      .values({
        id: docId,
        ownerId,
        projectId: meta.projectId ?? null,
        category: meta.category,
        name: sanitizedName,
        originalName,
        s3Key,
        thumbnailS3Key,
        sizeBytes: compressed.sizeBytes,
        mimeType: compressed.finalMimeType,
        uploadedBy: actor.id,
      })
      .returning()

    if (!row) {
      // Should never happen on a successful insert, but guard for type-narrowing.
      throw new Error('Failed to insert document row')
    }

    try {
      await this.s3.upload(s3Key, compressed.buffer, compressed.finalMimeType, meta.category)
      // Upload the thumbnail in the same try-block so a thumb-only failure
      // still compensates the DB row (the row already references the thumb
      // key, so it would be inconsistent without it).
      if (thumbnailBuffer && thumbnailS3Key) {
        try {
          // Same category as the main object — a thumbnail of a sensitive
          // scan/resume is still sensitive (task-file-storage-hardening §3).
          await this.s3.upload(thumbnailS3Key, thumbnailBuffer, 'image/jpeg', meta.category)
        } catch (thumbErr) {
          // Thumbnail upload failure is *non-fatal* but we clear the
          // thumbnail key from the row so the UI doesn't 404 trying to
          // fetch it. The main object is fine.
          this.logger.warn(
            `thumbnail S3 upload failed for docId=${docId}: ${(thumbErr as Error).message} — clearing thumbnail_s3_key`,
          )
          await this.db.db
            .update(documents)
            .set({ thumbnailS3Key: null })
            .where(eq(documents.id, docId))
          row.thumbnailS3Key = null
        }
      }
    } catch (err) {
      // Compensate: drop the DB row so we don't leak metadata for a file
      // that never made it to S3.
      this.logger.error(
        `S3 upload failed for docId=${docId}: ${(err as Error).message} — rolling back DB row`,
      )
      await this.db.db.delete(documents).where(eq(documents.id, docId))
      throw err
    }

    // Uploader === actor for fresh uploads — we already have the
    // display name in the session, no extra round-trip needed.
    return mapDocument(row, actor.displayName ?? null)
  }

  // -------------------------------------------------------------------------
  // System-facing upload (Invoice Signing Epic)
  // -------------------------------------------------------------------------

  /**
   * Internal upload bypass for system-generated documents (e.g. INVOICE PDFs
   * produced by InvoicesService). Differs from `upload()` in that:
   *   - No RBAC check (caller is trusted server code, not an HTTP actor)
   *   - No MIME whitelist enforcement (still recorded as-is in the row)
   *   - No size cap (system-generated PDFs are bounded by template)
   *   - No compression pass (input is already finalised by the producer)
   *   - Accepts an explicit Buffer + mime + filename + `uploadedById`
   *
   * Used by InvoicesService.autoCreate* and InvoicesService.signInvoice to
   * push the generated PDF into S3 + `documents` row in one shot. Thumbnail
   * generation is intentionally skipped (INVOICE category is hidden from the
   * default documents list and the verify page uses its own download flow).
   */
  async uploadInternal(params: {
    category: DocumentCategory
    ownerId: string
    file: Buffer
    mimeType: string
    name: string
    uploadedById: string
    projectId?: string | null
  }): Promise<DocumentDto> {
    const docId = randomUUID()
    const originalName = params.name.slice(0, 255)
    const sanitizedName = sanitizeFilename(originalName)
    const s3Key = `documents/${params.category}/${params.ownerId}/${docId}-${sanitizedName}`

    // Insert DB row first, then S3 (compensate on S3 failure) — mirrors
    // `upload()` so we never leak S3 objects without a corresponding row.
    const [row] = await this.db.db
      .insert(documents)
      .values({
        id: docId,
        ownerId: params.ownerId,
        projectId: params.projectId ?? null,
        category: params.category,
        name: sanitizedName,
        originalName,
        s3Key,
        thumbnailS3Key: null,
        sizeBytes: params.file.length,
        mimeType: params.mimeType,
        uploadedBy: params.uploadedById,
      })
      .returning()

    if (!row) {
      throw new Error('Failed to insert document row')
    }

    try {
      await this.s3.upload(s3Key, params.file, params.mimeType, params.category)
    } catch (err) {
      this.logger.error(
        `S3 upload failed for internal docId=${docId}: ${(err as Error).message} — rolling back DB row`,
      )
      await this.db.db.delete(documents).where(eq(documents.id, docId))
      throw err
    }

    return mapDocument(row, null)
  }

  /**
   * Internal soft-delete bypass — same effect as `softDelete()` but without
   * the owner/ADMIN RBAC check, since the caller is trusted server code
   * replacing one system-generated document with another (e.g. invoice PDF
   * re-generation after the counterparty signs).
   *
   * Idempotent: skips if already deleted. Throws NotFoundException if the
   * document does not exist at all (defensive — callers should know the id).
   *
   * security-review round 2 (PR #600, MED-2 on task-invoice-signature-
   * integrity): optional `tx` lets a caller run this write inside its OWN
   * `db.transaction`, alongside other writes that must commit or roll back
   * together (e.g. `InvoicesService.voidInvoiceForAmountEdit` — the
   * document soft-delete, the signature void-stamp, and the FK null-out are
   * three separate statements that used to have no atomicity: a failure
   * between them left "SIGNED" pointing at a document that no longer
   * existed). Defaults to the plain (non-transactional) db handle for every
   * other caller — behaviour unchanged for them.
   */
  async softDeleteInternal(docId: string, deletedById: string, tx?: DrizzleTx): Promise<void> {
    const db = tx ?? this.db.db
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (doc.deletedAt) return
    await db
      .update(documents)
      .set({ deletedAt: new Date(), deletedBy: deletedById })
      .where(eq(documents.id, docId))
  }

  /**
   * Lookup a document by id without any RBAC check. Used by trusted system
   * code (InvoicesService) that already established the relationship between
   * the document and a higher-level entity (e.g. transaction.invoiceDocumentId
   * FK guarantees the link). Returns null for missing rows.
   */
  async findByIdInternal(docId: string): Promise<typeof documents.$inferSelect | null> {
    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    return doc ?? null
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async list(actor: SessionUser, filters: DocumentListFilters): Promise<DocumentDto[]> {
    // Security: DROP must only see their own documents regardless of any ownerId
    // filter passed by the client. Force ownerId = self for DROP to prevent
    // cross-user document enumeration (OWASP IDOR / A01).
    const effectiveFilters: DocumentListFilters =
      actor.role === 'DROP' ? { ...filters, ownerId: actor.id } : filters
    const where = await buildListWhere(this.db, this.hrAccess, actor, effectiveFilters)
    if (where === 'NONE') return []

    // LEFT JOIN users so the response carries the uploader's display name
    // alongside `uploadedBy`. The UI renders this as a clickable
    // `<Link to="/crm/users/:id">`. We use LEFT (not INNER) because the
    // uploader row may be missing (hard-deleted user, legacy data) — the
    // schema treats `uploadedByDisplayName` as nullable for that case.
    //
    // LEFT JOIN transactions on `invoice_document_id = documents.id` so
    // INVOICE rows carry their parent transaction id. The UI uses it to
    // open `InvoiceDetailDialog` (which is keyed by transaction id) from
    // the /crm/documents INVOICE tab — replaces the standalone
    // `/crm/finance/invoices` page.
    //
    // `invoicePendingSignature` is computed at SELECT time via a SQL CASE
    // expression — it's `true` only when ALL of:
    //   - the document is an INVOICE
    //   - it has a parent transaction (LEFT JOIN matched)
    //   - no COUNTERPARTY signature exists yet in `invoice_signatures`
    //   - the viewer is the expected counterparty (SENIOR_INCOME ⇒ sender;
    //     SALARY ⇒ receiver)
    // The UI uses this to render an «Требует подписи» badge + a banner at
    // the top of /crm/documents.
    const viewerId = actor.id
    // security-review PR #456 round 2: every reference below is to
    // `nonDeletedTransactions` (a VIEW, see schema.ts) — NOT the raw
    // `transactions` table. A soft-deleted transaction cannot drive any of
    // these badges no matter what, because the LEFT JOIN below can only ever
    // match a non-deleted row (there is no `deleted_at` condition to forget —
    // this replaces the round-1 `AND TRANSACTION_NOT_DELETED` join condition,
    // which relied on remembering to write it every time).
    // task-invoice-signature-integrity: every EXISTS below is scoped to
    // voided_at IS NULL — a voided signature row belongs to a PRIOR,
    // superseded invoice generation (AC2) and must not drive either badge
    // for the transaction's CURRENT (possibly freshly-reissued) invoice.
    const pendingSig = sql<boolean>`(
      CASE
        WHEN ${documents.category} = 'INVOICE'
          AND ${nonDeletedTransactions.id} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${invoiceSignatures}
            WHERE ${invoiceSignatures.transactionId} = ${nonDeletedTransactions.id}
              AND ${invoiceSignatures.signerRole} = 'COUNTERPARTY'
              AND ${invoiceSignatures.voidedAt} IS NULL
          )
          AND (
            (${nonDeletedTransactions.type} = 'SENIOR_INCOME' AND ${nonDeletedTransactions.senderId} = ${viewerId})
            OR (${nonDeletedTransactions.type} = 'SALARY' AND ${nonDeletedTransactions.receiverId} = ${viewerId})
          )
        THEN TRUE
        ELSE FALSE
      END
    )`

    // PR-2: invoice completeness badge — both COMPANY + COUNTERPARTY present → signed
    // Computed via SQL EXISTS sub-queries so no N+1 per row.
    const invoiceSigned = sql<boolean>`(
      CASE
        WHEN ${documents.category} = 'INVOICE'
          AND ${nonDeletedTransactions.id} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${invoiceSignatures}
            WHERE ${invoiceSignatures.transactionId} = ${nonDeletedTransactions.id}
              AND ${invoiceSignatures.signerRole} = 'COMPANY'
              AND ${invoiceSignatures.voidedAt} IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM ${invoiceSignatures}
            WHERE ${invoiceSignatures.transactionId} = ${nonDeletedTransactions.id}
              AND ${invoiceSignatures.signerRole} = 'COUNTERPARTY'
              AND ${invoiceSignatures.voidedAt} IS NULL
          )
        THEN TRUE
        ELSE FALSE
      END
    )`

    // PR-2: receipt badge — derived from the linked transaction's status.
    // LEFT JOIN transactions on receipt_document_id = documents.id for RECEIPT rows.
    const receiptTxStatus = sql<string | null>`(
      CASE
        WHEN ${documents.category} = 'RECEIPT'
        THEN (
          SELECT t.status FROM ${nonDeletedTransactions} t
          WHERE t.receipt_document_id = ${documents.id}
          LIMIT 1
        )
        ELSE NULL
      END
    )`

    const rows = await this.db.db
      .select({
        doc: documents,
        uploaderName: users.displayName,
        invoiceTxId: nonDeletedTransactions.id,
        invoicePendingSignature: pendingSig,
        invoiceSigned,
        receiptTxStatus,
      })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.uploadedBy))
      .leftJoin(nonDeletedTransactions, eq(nonDeletedTransactions.invoiceDocumentId, documents.id))
      .where(where)
      .orderBy(desc(documents.createdAt))

    const fileEntries = rows.map((row) => {
      // Derive statusBadge from backend state (PR-2).
      const badge = deriveStatusBadge(
        row.doc.category as DocumentCategory,
        Boolean(row.invoiceSigned),
        row.receiptTxStatus,
      )
      return mapDocument(
        row.doc,
        row.uploaderName ?? null,
        row.invoiceTxId ?? null,
        Boolean(row.invoicePendingSignature),
        'file',
        badge,
      )
    })

    // PR-2: append employee_contracts as virtual entries.
    // RBAC: ADMIN sees all users' contracts; non-ADMIN sees only own.
    // CANCELLED contracts are hidden per spec.
    const contractEntries = await this.buildContractVirtualEntries(actor, filters)

    return [...fileEntries, ...contractEntries]
  }

  /**
   * Build virtual DocumentDto entries from employee_contracts (PR-2).
   *
   * These are NOT rows from the `documents` table — they represent the
   * canonical per-employee contract (from the A3 onboarding flow) as
   * a first-class entry in the unified list. The `source` discriminator
   * ('employee_contract') lets the frontend render a different affordance
   * (open contract editor / PDF viewer) vs. a plain uploaded file.
   *
   * RBAC mirrors A3 rules (ADMIN + owner):
   *   - ADMIN: sees all non-CANCELLED contracts (including DRAFT — ADMIN prepares them)
   *   - All other roles: own non-CANCELLED, non-DRAFT contract only
   *     (employee sees contract only once READY_TO_SIGN or later)
   * CANCELLED contracts are hidden from all viewers per spec.
   * DRAFT contracts are hidden from non-ADMIN per spec (A3-4 onboarding rule).
   *
   * No double-counting: uploaded CONTRACT files (category='CONTRACT' in
   * the `documents` table) are separate entries from these virtual ones.
   */
  private async buildContractVirtualEntries(
    actor: SessionUser,
    filters: DocumentListFilters,
  ): Promise<DocumentDto[]> {
    // If the caller asked for a specific category that is not 'CONTRACT' (or
    // if filtering by ownerId that would exclude contracts), honour that.
    // Contracts always appear in the 'CONTRACT' category slot or when no
    // category filter is active.
    const categoryFilter = filters.category
    if (categoryFilter && categoryFilter !== 'CONTRACT') {
      return []
    }

    const isAdmin = actor.role === 'ADMIN'

    // Fetch employee_contracts scoped by RBAC:
    //   ADMIN — all non-CANCELLED (DRAFT + READY_TO_SIGN + SIGNED)
    //   non-ADMIN — own non-CANCELLED AND non-DRAFT (READY_TO_SIGN + SIGNED only)
    // Include signedContract relation so we can surface the human-readable
    // contract_number (e.g. CHK-7F3A9C) in the list instead of the raw uuid.
    const contractRows = await this.db.db.query.employeeContracts.findMany({
      where: (tbl, { ne, eq: deq, and: dand }) => {
        const notCancelled = ne(tbl.status, 'CANCELLED')
        if (isAdmin) return notCancelled
        // Non-ADMIN: own contract + must be past DRAFT stage
        const notDraft = ne(tbl.status, 'DRAFT')
        return dand(notCancelled, notDraft, deq(tbl.userId, actor.id))
      },
      with: { signedContract: true },
    })

    // AC6: batch-fetch displayNames for all contract owners (no N+1).
    const ownerIds = [...new Set(contractRows.map((c) => c.userId))]
    const ownerRows = ownerIds.length
      ? await this.db.db.query.users.findMany({
          where: (tbl, { inArray }) => inArray(tbl.id, ownerIds),
          columns: { id: true, displayName: true },
        })
      : []
    const displayNameMap: Record<string, string> = Object.fromEntries(
      ownerRows.map((u) => [u.id, u.displayName]),
    )

    return contractRows.map((c) => mapContractVirtualEntry(c, displayNameMap))
  }

  // -------------------------------------------------------------------------
  // Presigned URLs — access gate (findActiveOrThrow) stays here; the presign
  // build + access logging live in document-presign.util.ts (L10 leaf).
  // -------------------------------------------------------------------------

  async getDownloadUrl(actor: SessionUser, docId: string): Promise<PresignedDownload> {
    const doc = await this.findActiveOrThrow(docId, actor)
    return presignDocument(this.s3, this.db, this.logger, actor, doc, 'DOWNLOAD')
  }

  /**
   * Like `getDownloadUrl` but forces `Content-Disposition: inline` so the
   * browser renders the PDF inside an iframe instead of triggering a Save
   * dialog. Same category-based TTL applies (sensitive categories get 30 min).
   */
  async getPreviewUrl(actor: SessionUser, docId: string): Promise<PresignedDownload> {
    const doc = await this.findActiveOrThrow(docId, actor)
    return presignDocument(this.s3, this.db, this.logger, actor, doc, 'PREVIEW')
  }

  // -------------------------------------------------------------------------
  // Soft delete / restore
  // -------------------------------------------------------------------------

  async softDelete(actor: SessionUser, docId: string): Promise<void> {
    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // RBAC: owner OR ADMIN
    if (actor.role !== 'ADMIN' && doc.ownerId !== actor.id) {
      throw apiError('DOCUMENT_DELETE_OWNER_OR_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    // Idempotent: skip if already soft-deleted
    if (doc.deletedAt) return

    await this.db.db
      .update(documents)
      .set({ deletedAt: new Date(), deletedBy: actor.id })
      .where(eq(documents.id, docId))
  }

  async restore(actor: SessionUser, docId: string): Promise<DocumentDto> {
    if (actor.role !== 'ADMIN') {
      throw apiError('DOCUMENT_RESTORE_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)

    const [restored] = await this.db.db
      .update(documents)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(documents.id, docId))
      .returning()

    if (!restored) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // Resolve uploader display name so the restored row matches what
    // `list()` would have returned (UI relies on this field).
    const uploader = await this.db.db.query.users.findFirst({
      where: eq(users.id, restored.uploadedBy),
      columns: { displayName: true },
    })
    return mapDocument(restored, uploader?.displayName ?? null)
  }

  // -------------------------------------------------------------------------
  // Hard delete — internal (no RBAC, trusted server code)
  // -------------------------------------------------------------------------

  /**
   * Internal hard-delete bypass — no RBAC, trusted server code only (e.g.
   * TransactionsService replacing a SENIOR_INCOME receipt). Execution lives in
   * document-hard-delete.util.
   */
  async hardDeleteInternal(docId: string): Promise<void> {
    await hardDeleteById(this.db, this.s3, docId)
  }

  /**
   * Best-effort S3-only cleanup for post-commit callers
   * (`TransactionsService.updateSeniorIncome`); errors swallowed + warned.
   */
  async deleteS3Keys(mainKey: string, thumbKey: string | null | undefined): Promise<void> {
    await deleteS3KeysUtil(this.s3, this.logger, mainKey, thumbKey)
  }

  // -------------------------------------------------------------------------
  // Hard delete (ADMIN-only, requires prior soft delete)
  // -------------------------------------------------------------------------

  async hardDelete(actor: SessionUser, docId: string): Promise<void> {
    if (actor.role !== 'ADMIN') {
      throw apiError('DOCUMENT_HARD_DELETE_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)

    if (!doc.deletedAt) {
      throw apiError('DOCUMENT_HARD_DELETE_REQUIRES_SOFT_DELETE', HttpStatus.BAD_REQUEST)
    }

    await executeHardDelete(this.db, this.s3, doc)
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Lookup an active document and assert the caller has GET visibility on it.
   * Throws 404 (not 403) on access denial — we don't leak existence.
   */
  private async findActiveOrThrow(docId: string, actor: SessionUser) {
    const doc = await this.db.db.query.documents.findFirst({
      where: and(eq(documents.id, docId), isNull(documents.deletedAt)),
    })
    if (!doc) throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)

    // Reuse the visibility builder by asking it for "show me only this
    // category" — if the actor has no clause that matches this owner, deny.
    if (actor.role === 'ADMIN') return doc

    // Cheap path: owner sees own.
    if (doc.ownerId === actor.id) return doc

    // task-file-storage-hardening §1: SENIOR/HR + RESUME/SCAN is
    // team-and-project-scoped, not "sees all" — this is the single gate
    // that guards BOTH the list (via buildVisibilityClause) and this
    // direct-by-id fetch (the audit's specific finding: a single gate used
    // to say "yes" unconditionally for these two categories).
    if (
      (actor.role === 'SENIOR' || actor.role === 'HR') &&
      (doc.category === 'RESUME' || doc.category === 'SCAN')
    ) {
      const teammateIds = await getTeammateIds(this.db, this.hrAccess, actor.id, actor.role)
      if (teammateIds.includes(doc.ownerId)) return doc
      throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

    // ACCOUNTANT reads any SCAN — owner decision 2026-08-03 (security-review
    // round 2), see the doc comment on the SCAN branch of
    // `buildVisibilityClause` for the full rationale (transaction-scoping
    // tried in round 1 was rejected as self-satisfying + onboarding-breaking).
    if (actor.role === 'ACCOUNTANT' && doc.category === 'SCAN') {
      return doc
    }

    // HR + CONTRACT: special team-scope check.
    if (actor.role === 'HR' && doc.category === 'CONTRACT') {
      const seniorIds = await getHrSeniorIds(this.db, actor.id)
      if (seniorIds.includes(doc.ownerId)) return doc
    }

    // ACCOUNTANT can read all receipts.
    if (actor.role === 'ACCOUNTANT' && doc.category === 'RECEIPT') {
      return doc
    }

    // LOGO read for HR/SENIOR.
    if ((actor.role === 'HR' || actor.role === 'SENIOR') && doc.category === 'LOGO') {
      return doc
    }

    // ACCOUNTANT reads any INVOICE (finance audit, same scope as RECEIPT).
    if (actor.role === 'ACCOUNTANT' && doc.category === 'INVOICE') {
      return doc
    }

    throw apiError('DOCUMENT_NOT_FOUND', HttpStatus.NOT_FOUND)
  }

  // -------------------------------------------------------------------------
  // Presigned thumbnail URL — returns null when no thumb exists.
  // -------------------------------------------------------------------------

  async getThumbnailUrl(actor: SessionUser, docId: string): Promise<PresignedDownload | null> {
    const doc = await this.findActiveOrThrow(docId, actor)
    return presignThumbnail(this.s3, this.db, this.logger, actor, doc)
  }
}

// Re-export INTERNAL_CATEGORIES from shared so tests that import this module
// don't need a second import path. (Pure convenience.)
export { INTERNAL_CATEGORIES }
