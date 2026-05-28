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
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_WHITELIST,
  INTERNAL_CATEGORIES,
  type CreateDocumentMetadata,
  type Document as DocumentDto,
  type DocumentCategory,
  type DocumentListFilters,
  type PresignedDownload,
  type Role,
  type SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { documents, invoiceSignatures, teamMembers, transactions, users } from '../database/schema'
import { S3Service } from './s3.service'
import { CompressionService } from './compression.service'

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
  ) {}

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  async upload(
    actor: SessionUser,
    file: UploadFileInput,
    meta: CreateDocumentMetadata,
  ): Promise<DocumentDto> {
    // ---- 1. Validate MIME ----
    if (!(DOCUMENT_MIME_WHITELIST as readonly string[]).includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `MIME type "${file.mimetype}" не разрешён. Разрешены: ${DOCUMENT_MIME_WHITELIST.join(', ')}`,
      )
    }

    // ---- 2. Validate size ----
    if (file.buffer.length > DOCUMENT_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Файл больше ${Math.floor(DOCUMENT_MAX_BYTES / 1024 / 1024)} MB`,
      )
    }

    // ---- 3. Resolve target owner (default = self) ----
    const ownerId = meta.ownerId ?? actor.id

    // ---- 4. RBAC: can `actor` upload `category` for `ownerId`? ----
    this.assertCanUpload(actor.role, actor.id, meta.category, ownerId)

    // ---- 5. CONTRACT requires projectId (Zod already enforced this; double-check defensively) ----
    if (meta.category === 'CONTRACT' && !meta.projectId) {
      throw new BadRequestException('projectId is required for CONTRACT documents')
    }

    // ---- 6. Compression (always — backend handles all formats) ----
    const compressed = await this.compression.compress(file.buffer, file.mimetype)

    // ---- 7. Generate s3 key + sanitize filename ----
    // Variant 3 (hybrid): the original filename is kept intact in
    // `original_name` (UI display + download-as), while `name` and the S3
    // key are strictly ASCII so cyrillic / unicode never breaks an
    // S3 PutObject or a presigned URL signature.
    const docId = randomUUID()
    const originalName = (meta.name ?? file.originalname).slice(0, 255)
    const sanitizedName = this.sanitizeFilename(originalName)
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
    const thumbnailS3Key = thumbnailBuffer ? this.thumbnailKeyFor(s3Key) : null

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
      await this.s3.upload(s3Key, compressed.buffer, compressed.finalMimeType)
      // Upload the thumbnail in the same try-block so a thumb-only failure
      // still compensates the DB row (the row already references the thumb
      // key, so it would be inconsistent without it).
      if (thumbnailBuffer && thumbnailS3Key) {
        try {
          await this.s3.upload(thumbnailS3Key, thumbnailBuffer, 'image/jpeg')
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
    return this.mapDocument(row, actor.displayName ?? null)
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
    const sanitizedName = this.sanitizeFilename(originalName)
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
      await this.s3.upload(s3Key, params.file, params.mimeType)
    } catch (err) {
      this.logger.error(
        `S3 upload failed for internal docId=${docId}: ${(err as Error).message} — rolling back DB row`,
      )
      await this.db.db.delete(documents).where(eq(documents.id, docId))
      throw err
    }

    return this.mapDocument(row, null)
  }

  /**
   * Internal soft-delete bypass — same effect as `softDelete()` but without
   * the owner/ADMIN RBAC check, since the caller is trusted server code
   * replacing one system-generated document with another (e.g. invoice PDF
   * re-generation after the counterparty signs).
   *
   * Idempotent: skips if already deleted. Throws NotFoundException if the
   * document does not exist at all (defensive — callers should know the id).
   */
  async softDeleteInternal(docId: string, deletedById: string): Promise<void> {
    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw new NotFoundException('Документ не найден')
    if (doc.deletedAt) return
    await this.db.db
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
    const where = await this.buildListWhere(actor, filters)
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
    const pendingSig = sql<boolean>`(
      CASE
        WHEN ${documents.category} = 'INVOICE'
          AND ${transactions.id} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${invoiceSignatures}
            WHERE ${invoiceSignatures.transactionId} = ${transactions.id}
              AND ${invoiceSignatures.signerRole} = 'COUNTERPARTY'
          )
          AND (
            (${transactions.type} = 'SENIOR_INCOME' AND ${transactions.senderId} = ${viewerId})
            OR (${transactions.type} = 'SALARY' AND ${transactions.receiverId} = ${viewerId})
          )
        THEN TRUE
        ELSE FALSE
      END
    )`
    const rows = await this.db.db
      .select({
        doc: documents,
        uploaderName: users.displayName,
        invoiceTxId: transactions.id,
        invoicePendingSignature: pendingSig,
      })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.uploadedBy))
      .leftJoin(transactions, eq(transactions.invoiceDocumentId, documents.id))
      .where(where)
      .orderBy(desc(documents.createdAt))
    return rows.map((row) =>
      this.mapDocument(
        row.doc,
        row.uploaderName ?? null,
        row.invoiceTxId ?? null,
        Boolean(row.invoicePendingSignature),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Presigned download URL
  // -------------------------------------------------------------------------

  async getDownloadUrl(actor: SessionUser, docId: string): Promise<PresignedDownload> {
    const doc = await this.findActiveOrThrow(docId, actor)
    // Variant 3 hybrid: download-as filename = original (unicode) when
    // available, falling back to the sanitized ASCII `name` for legacy rows
    // that pre-date migration 0011.
    const downloadAs = doc.originalName ?? doc.name
    return this.s3.getPresignedDownloadUrl(doc.s3Key, undefined, downloadAs)
  }

  // -------------------------------------------------------------------------
  // Soft delete / restore
  // -------------------------------------------------------------------------

  async softDelete(actor: SessionUser, docId: string): Promise<void> {
    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw new NotFoundException('Документ не найден')

    // RBAC: owner OR ADMIN
    if (actor.role !== 'ADMIN' && doc.ownerId !== actor.id) {
      throw new ForbiddenException('Только владелец или ADMIN может удалить документ')
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
      throw new ForbiddenException('Только ADMIN может восстановить документ')
    }

    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw new NotFoundException('Документ не найден')

    const [restored] = await this.db.db
      .update(documents)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(documents.id, docId))
      .returning()

    if (!restored) throw new NotFoundException('Документ не найден')

    // Resolve uploader display name so the restored row matches what
    // `list()` would have returned (UI relies on this field).
    const uploader = await this.db.db.query.users.findFirst({
      where: eq(users.id, restored.uploadedBy),
      columns: { displayName: true },
    })
    return this.mapDocument(restored, uploader?.displayName ?? null)
  }

  // -------------------------------------------------------------------------
  // Hard delete (ADMIN-only, requires prior soft delete)
  // -------------------------------------------------------------------------

  async hardDelete(actor: SessionUser, docId: string): Promise<void> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Только ADMIN может удалить документ окончательно')
    }

    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })
    if (!doc) throw new NotFoundException('Документ не найден')

    if (!doc.deletedAt) {
      throw new BadRequestException(
        'Сначала переместите документ в корзину (soft delete), затем удалите окончательно',
      )
    }

    // S3 deletes are idempotent in S3Service (errors logged + swallowed).
    // Thumbnail key is read from the row (NULL when no thumb exists, e.g. PDFs).
    await this.s3.delete(doc.s3Key)
    if (doc.thumbnailS3Key) {
      await this.s3.delete(doc.thumbnailS3Key)
    }

    // DB row + FK cascades (ON DELETE SET NULL on referencing tables)
    await this.db.db.delete(documents).where(eq(documents.id, docId))
  }

  // =========================================================================
  // RBAC helpers
  // =========================================================================

  /**
   * RBAC for UPLOAD. Throws ForbiddenException if `role` cannot upload
   * `category` for the target `ownerId`. Matrix from pm-brief.md:
   *
   *   RESUME / SCAN:
   *     ADMIN/HR/SENIOR — any ownerId
   *     JUNIOR — ownerId == self only
   *     ACCOUNTANT — forbidden
   *   CONTRACT:
   *     ADMIN — any ownerId
   *     SENIOR — ownerId == self only
   *     others — forbidden
   *   RECEIPT:
   *     ADMIN/ACCOUNTANT — any ownerId
   *     SENIOR — ownerId == self only
   *     HR / JUNIOR — forbidden
   *   AVATAR:
   *     ADMIN — any ownerId (impersonation)
   *     anyone else — ownerId == self only
   *   LOGO:
   *     ADMIN/HR/SENIOR — allowed (projectId scope is enforced elsewhere)
   *     JUNIOR/ACCOUNTANT — forbidden
   */
  private assertCanUpload(
    role: Role,
    actorId: string,
    category: DocumentCategory,
    ownerId: string,
  ): void {
    const isSelf = actorId === ownerId

    switch (category) {
      case 'RESUME':
      case 'SCAN':
        if (role === 'ACCOUNTANT') {
          throw new ForbiddenException(`Роль ${role} не может загружать ${category}`)
        }
        if (role === 'JUNIOR' && !isSelf) {
          throw new ForbiddenException('JUNIOR может загружать только свои документы')
        }
        return
      case 'CONTRACT':
        if (role === 'ADMIN') return
        if (role === 'SENIOR' && isSelf) return
        throw new ForbiddenException('CONTRACT может загрузить только ADMIN или SENIOR для себя')
      case 'RECEIPT':
        if (role === 'ADMIN' || role === 'ACCOUNTANT') return
        if (role === 'SENIOR' && isSelf) return
        throw new ForbiddenException(`Роль ${role} не может загружать чеки`)
      case 'AVATAR':
        if (role === 'ADMIN') return
        if (isSelf) return
        throw new ForbiddenException('Аватар можно загрузить только для своего профиля')
      case 'LOGO':
        if (role === 'ADMIN' || role === 'HR' || role === 'SENIOR') return
        throw new ForbiddenException(`Роль ${role} не может загружать логотипы`)
      case 'INVOICE':
        // INVOICE documents are produced by the system only (PDF generated
        // server-side by InvoicesService — see Invoice Signing Epic). They
        // must never be uploaded via the regular /api/documents endpoint
        // — InvoicesService bypasses this check by calling the internal
        // upload helper directly.
        throw new ForbiddenException(
          'INVOICE documents are generated by the system and cannot be uploaded via this endpoint',
        )
      default: {
        // Exhaustiveness check
        const _exhaustive: never = category
        throw new BadRequestException(`Unknown category: ${String(_exhaustive)}`)
      }
    }
  }

  /**
   * Build the WHERE clause for `list()`. Returns 'NONE' if the caller has
   * no access to anything matching the filters (so we can short-circuit to
   * `[]` without a query).
   *
   * Visibility (from pm-brief.md "RBAC матрица для GET"):
   *   ADMIN: any category, any ownerId
   *   SENIOR: resume/scan all; contract/receipt own; avatar own; logo all (read)
   *   JUNIOR: resume/scan own; avatar own; nothing else
   *   HR: resume/scan all; contract — for seniors in HR's teams; avatar own;
   *       logo all (read); receipt none
   *   ACCOUNTANT: scan all; receipt all (read); avatar own;
   *               resume/contract/logo none
   */
  private async buildListWhere(
    actor: SessionUser,
    filters: DocumentListFilters,
  ): Promise<SQL | 'NONE'> {
    const conditions: SQL[] = []

    // ---- Soft-delete filter ----
    if (filters.includeDeleted && actor.role === 'ADMIN') {
      // No filter — return both active and deleted
    } else {
      conditions.push(isNull(documents.deletedAt))
    }

    // ---- Project filter (caller can ask for one project) ----
    if (filters.projectId) {
      conditions.push(eq(documents.projectId, filters.projectId))
    }

    // ---- Category filter ----
    // Default behavior: hide internal categories (AVATAR, LOGO) unless an
    // ADMIN explicitly requests them. INVOICE is system-generated but is
    // now exposed as a regular tab in /crm/documents (read-only — uploads
    // still go through InvoicesService), so it's part of the default set.
    if (filters.category) {
      // Caller asked for a specific category — RBAC check below decides
      // whether they're allowed to see it.
      conditions.push(eq(documents.category, filters.category))
    } else {
      // No explicit category → exclude internals (AVATAR/LOGO)
      conditions.push(
        // not in (AVATAR, LOGO)
        // Drizzle: use `notInArray` would be cleaner, but `notInArray` exists
        // in newer drizzle versions; we use a NOT IN via SQL fallback below.
        // For consistency with the rest of the codebase, use inArray + NOT
        // via an explicit OR of equality with non-internal categories.
        inArray(documents.category, ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE']),
      )
    }

    // ---- Per-role visibility ----
    const visibility = await this.buildVisibilityClause(actor, filters)
    if (visibility === 'NONE') return 'NONE'
    if (visibility !== null) conditions.push(visibility)

    // ---- Owner filter from caller (further narrow) ----
    if (filters.ownerId) {
      conditions.push(eq(documents.ownerId, filters.ownerId))
    }

    if (conditions.length === 0) {
      // No conditions = match everything. Returning `undefined` would let
      // drizzle return all rows; explicit `isNotNull(id)` keeps types happy.
      return isNotNull(documents.id)
    }
    if (conditions.length === 1) return conditions[0]!
    return and(...conditions)!
  }

  /**
   * Returns a SQL clause for "what categories + ownerIds this user can see"
   * or 'NONE' if the user has zero visibility for the requested filter.
   */
  private async buildVisibilityClause(
    actor: SessionUser,
    filters: DocumentListFilters,
  ): Promise<SQL | null | 'NONE'> {
    const category = filters.category

    // ADMIN can see anything. internal-include toggle handled in buildListWhere.
    if (actor.role === 'ADMIN') {
      // ADMIN-only: includeInternal — currently controlled by `category`
      // filter (if ADMIN asks for AVATAR/LOGO they get them).
      return null
    }

    // Non-ADMIN trying to use the includeDeleted flag → silently ignored
    // (the soft-delete filter already added isNull above).

    // Build a set of (category, ownerScope) tuples the actor is allowed to see.
    const visibleClauses: SQL[] = []

    if (this.canSeeAll(actor.role, 'RESUME') && (!category || category === 'RESUME')) {
      visibleClauses.push(eq(documents.category, 'RESUME'))
    } else if (this.canSeeSelf(actor.role, 'RESUME') && (!category || category === 'RESUME')) {
      visibleClauses.push(and(eq(documents.category, 'RESUME'), eq(documents.ownerId, actor.id))!)
    }

    if (this.canSeeAll(actor.role, 'SCAN') && (!category || category === 'SCAN')) {
      visibleClauses.push(eq(documents.category, 'SCAN'))
    } else if (this.canSeeSelf(actor.role, 'SCAN') && (!category || category === 'SCAN')) {
      visibleClauses.push(and(eq(documents.category, 'SCAN'), eq(documents.ownerId, actor.id))!)
    }

    if (!category || category === 'CONTRACT') {
      if (actor.role === 'SENIOR') {
        visibleClauses.push(
          and(eq(documents.category, 'CONTRACT'), eq(documents.ownerId, actor.id))!,
        )
      } else if (actor.role === 'HR') {
        const seniorIds = await this.getHrSeniorIds(actor.id)
        if (seniorIds.length > 0) {
          visibleClauses.push(
            and(eq(documents.category, 'CONTRACT'), inArray(documents.ownerId, seniorIds))!,
          )
        }
      }
      // JUNIOR/ACCOUNTANT see no contracts
    }

    if (!category || category === 'RECEIPT') {
      if (actor.role === 'ACCOUNTANT') {
        visibleClauses.push(eq(documents.category, 'RECEIPT'))
      } else if (actor.role === 'SENIOR') {
        visibleClauses.push(
          and(eq(documents.category, 'RECEIPT'), eq(documents.ownerId, actor.id))!,
        )
      }
      // HR/JUNIOR see no receipts
    }

    if (!category || category === 'AVATAR') {
      // Every authenticated user can see their own avatar row (useful for
      // managing the override). ADMIN already returned above.
      visibleClauses.push(and(eq(documents.category, 'AVATAR'), eq(documents.ownerId, actor.id))!)
    }

    if (!category || category === 'LOGO') {
      // LOGO is readable for ADMIN/HR/SENIOR (all). ADMIN handled above.
      if (actor.role === 'HR' || actor.role === 'SENIOR') {
        visibleClauses.push(eq(documents.category, 'LOGO'))
      }
    }

    if (!category || category === 'INVOICE') {
      // INVOICE documents are produced by InvoicesService — the row's
      // `ownerId` is the counterparty (SENIOR / JUNIOR), so visibility is
      // scoped to `documents.ownerId == viewer.id` for non-admins.
      // ACCOUNTANT is allowed to see ALL invoices (finance audit role,
      // same scope as RECEIPT). ADMIN handled above. JUNIOR/HR/SENIOR
      // only see invoices they themselves are the counterparty for.
      if (actor.role === 'ACCOUNTANT') {
        visibleClauses.push(eq(documents.category, 'INVOICE'))
      } else {
        visibleClauses.push(
          and(eq(documents.category, 'INVOICE'), eq(documents.ownerId, actor.id))!,
        )
      }
    }

    if (visibleClauses.length === 0) return 'NONE'
    if (visibleClauses.length === 1) return visibleClauses[0]!
    return or(...visibleClauses)!
  }

  private canSeeAll(role: Role, category: DocumentCategory): boolean {
    if (category === 'RESUME') {
      return role === 'SENIOR' || role === 'HR'
    }
    if (category === 'SCAN') {
      return role === 'SENIOR' || role === 'HR' || role === 'ACCOUNTANT'
    }
    return false
  }

  private canSeeSelf(role: Role, category: DocumentCategory): boolean {
    if (category === 'RESUME' || category === 'SCAN') return role === 'JUNIOR'
    return false
  }

  private async getHrSeniorIds(hrId: string): Promise<string[]> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, hrId))
    if (!hrTeams.length) return []
    const teamIds = hrTeams.map((r) => r.teamId)
    const seniors = await this.db.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
    return seniors.map((r) => r.userId)
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
    if (!doc) throw new NotFoundException('Документ не найден')

    // Reuse the visibility builder by asking it for "show me only this
    // category" — if the actor has no clause that matches this owner, deny.
    if (actor.role === 'ADMIN') return doc

    // Cheap path: owner sees own.
    if (doc.ownerId === actor.id) return doc

    // Otherwise check category visibility.
    const seesAll = this.canSeeAll(actor.role, doc.category)
    if (seesAll) return doc

    // HR + CONTRACT: special team-scope check.
    if (actor.role === 'HR' && doc.category === 'CONTRACT') {
      const seniorIds = await this.getHrSeniorIds(actor.id)
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

    throw new NotFoundException('Документ не найден')
  }

  /**
   * Replace any character that's not alphanumeric / dot / dash / underscore,
   * cap the result at 200 chars. We collapse spaces to underscores so URLs
   * stay clean.
   */
  private sanitizeFilename(name: string): string {
    const cleaned = name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
    return cleaned.slice(0, 200) || 'file'
  }

  /** Thumbnail key: <key-without-ext>-thumb.jpg */
  private thumbnailKeyFor(key: string): string {
    return key.replace(/\.[^.]+$/, '') + '-thumb.jpg'
  }

  /**
   * Map a `documents` row into the API DTO.
   *
   * @param row                       the `documents` row as returned by Drizzle
   * @param uploaderName              display name resolved via a join (callers
   *                                  that already issued the join pass it in;
   *                                  callers that only have the row can pass
   *                                  `null` and the UI will fall back to a
   *                                  short id)
   * @param invoiceTransactionId      for INVOICE category only — the parent
   *                                  transaction id resolved via
   *                                  `transactions.invoice_document_id`. Null
   *                                  for non-INVOICE rows and for callers that
   *                                  did not issue the join.
   * @param invoicePendingSignature   computed by `list()` only: true when the
   *                                  viewer is the expected counterparty and
   *                                  no COUNTERPARTY signature exists yet.
   *                                  Other callers (`upload`, `restore`, etc.)
   *                                  pass `false` since the flag is purely a
   *                                  viewer-relative UI hint.
   */
  private mapDocument(
    row: typeof documents.$inferSelect,
    uploaderName: string | null = null,
    invoiceTransactionId: string | null = null,
    invoicePendingSignature: boolean = false,
  ): DocumentDto {
    return {
      id: row.id,
      ownerId: row.ownerId,
      projectId: row.projectId ?? null,
      category: row.category as DocumentCategory,
      name: row.name,
      originalName: row.originalName ?? null,
      s3Key: row.s3Key,
      thumbnailS3Key: row.thumbnailS3Key ?? null,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
      uploadedBy: row.uploadedBy,
      uploadedByDisplayName: uploaderName,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      deletedBy: row.deletedBy ?? null,
      createdAt: row.createdAt.toISOString(),
      invoiceTransactionId,
      invoicePendingSignature,
    }
  }

  // -------------------------------------------------------------------------
  // Presigned thumbnail URL — returns null when no thumb exists.
  // -------------------------------------------------------------------------

  async getThumbnailUrl(actor: SessionUser, docId: string): Promise<PresignedDownload | null> {
    const doc = await this.findActiveOrThrow(docId, actor)
    if (!doc.thumbnailS3Key) return null
    return this.s3.getPresignedDownloadUrl(doc.thumbnailS3Key)
  }
}

// Re-export INTERNAL_CATEGORIES from shared so tests that import this module
// don't need a second import path. (Pure convenience.)
export { INTERNAL_CATEGORIES }
