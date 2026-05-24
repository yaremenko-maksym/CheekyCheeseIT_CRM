/**
 * DocumentsService — application layer for PHASE 6 documents.
 *
 * Responsibilities:
 *  - Upload pipeline: validate MIME/size → compress → push to S3 → write DB row
 *    (with compensation: delete DB row if S3 upload throws after the insert)
 *  - Listing with RBAC filter per category (6 categories: RESUME, SCAN,
 *    CONTRACT, RECEIPT, AVATAR, LOGO). AVATAR + LOGO are "internal" — hidden
 *    from default list unless ADMIN explicitly opts in.
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
import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
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
import { documents, projects, teamMembers, users } from '../database/schema'
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
    const docId = randomUUID()
    const sanitizedName = this.sanitizeFilename(meta.name ?? file.originalname)
    const s3Key = `documents/${meta.category}/${ownerId}/${docId}-${sanitizedName}`

    // ---- 8. Insert DB row FIRST, then S3 (compensate on S3 failure) ----
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
        s3Key,
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
    } catch (err) {
      // Compensate: drop the DB row so we don't leak metadata for a file
      // that never made it to S3.
      this.logger.error(
        `S3 upload failed for docId=${docId}: ${(err as Error).message} — rolling back DB row`,
      )
      await this.db.db.delete(documents).where(eq(documents.id, docId))
      throw err
    }

    // ---- 9. Fire-and-forget thumbnail for images ----
    if (compressed.finalMimeType.startsWith('image/')) {
      // Don't await — failure shouldn't break the upload. UI falls back to
      // the full image if the thumb is missing.
      void this.tryUploadThumbnail(s3Key, compressed.buffer, compressed.finalMimeType)
    }

    return this.mapDocument(row)
  }

  /**
   * Generate + upload thumbnail. Detached from the main upload promise so
   * thumb generation failures never roll back the document insert.
   */
  private async tryUploadThumbnail(
    primaryKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    try {
      const thumb = await this.compression.makeThumbnail(buffer, mimeType)
      if (!thumb) return
      const thumbKey = this.thumbnailKeyFor(primaryKey)
      await this.s3.upload(thumbKey, thumb, 'image/jpeg')
    } catch (err) {
      this.logger.warn(
        `thumbnail upload failed for key="${primaryKey}": ${(err as Error).message}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async list(actor: SessionUser, filters: DocumentListFilters): Promise<DocumentDto[]> {
    const where = await this.buildListWhere(actor, filters)
    if (where === 'NONE') return []

    const rows = await this.db.db
      .select()
      .from(documents)
      .where(where)
      .orderBy(desc(documents.createdAt))
    return rows.map((row) => this.mapDocument(row))
  }

  // -------------------------------------------------------------------------
  // Presigned download URL
  // -------------------------------------------------------------------------

  async getDownloadUrl(actor: SessionUser, docId: string): Promise<PresignedDownload> {
    const doc = await this.findActiveOrThrow(docId, actor)
    return this.s3.getPresignedDownloadUrl(doc.s3Key)
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
    return this.mapDocument(restored)
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

    // S3 deletes are idempotent in S3Service (errors logged + swallowed)
    await this.s3.delete(doc.s3Key)
    await this.s3.delete(this.thumbnailKeyFor(doc.s3Key))

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
        throw new ForbiddenException(
          'CONTRACT может загрузить только ADMIN или SENIOR для себя',
        )
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
    // ADMIN explicitly requests them. UI never asks for them in /crm/documents.
    if (filters.category) {
      // Caller asked for a specific category — RBAC check below decides
      // whether they're allowed to see it.
      conditions.push(eq(documents.category, filters.category))
    } else {
      // No explicit category → exclude internals
      conditions.push(
        // not in (AVATAR, LOGO)
        // Drizzle: use `notInArray` would be cleaner, but `notInArray` exists
        // in newer drizzle versions; we use a NOT IN via SQL fallback below.
        // For consistency with the rest of the codebase, use inArray + NOT
        // via an explicit OR of equality with non-internal categories.
        inArray(documents.category, ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT']),
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
      visibleClauses.push(
        and(eq(documents.category, 'RESUME'), eq(documents.ownerId, actor.id))!,
      )
    }

    if (this.canSeeAll(actor.role, 'SCAN') && (!category || category === 'SCAN')) {
      visibleClauses.push(eq(documents.category, 'SCAN'))
    } else if (this.canSeeSelf(actor.role, 'SCAN') && (!category || category === 'SCAN')) {
      visibleClauses.push(
        and(eq(documents.category, 'SCAN'), eq(documents.ownerId, actor.id))!,
      )
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
            and(
              eq(documents.category, 'CONTRACT'),
              inArray(documents.ownerId, seniorIds),
            )!,
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
      visibleClauses.push(
        and(eq(documents.category, 'AVATAR'), eq(documents.ownerId, actor.id))!,
      )
    }

    if (!category || category === 'LOGO') {
      // LOGO is readable for ADMIN/HR/SENIOR (all). ADMIN handled above.
      if (actor.role === 'HR' || actor.role === 'SENIOR') {
        visibleClauses.push(eq(documents.category, 'LOGO'))
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
    if (
      (actor.role === 'HR' || actor.role === 'SENIOR') &&
      doc.category === 'LOGO'
    ) {
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

  private mapDocument(row: typeof documents.$inferSelect): DocumentDto {
    return {
      id: row.id,
      ownerId: row.ownerId,
      projectId: row.projectId ?? null,
      category: row.category as DocumentCategory,
      name: row.name,
      s3Key: row.s3Key,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
      uploadedBy: row.uploadedBy,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      deletedBy: row.deletedBy ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}

// Re-export INTERNAL_CATEGORIES from shared so tests that import this module
// don't need a second import path. (Pure convenience.)
export { INTERNAL_CATEGORIES }
