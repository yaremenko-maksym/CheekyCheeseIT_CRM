/**
 * DocumentsService — unit tests.
 *
 * Harness rationale: drizzle predicate objects are circular (PgUUID ↔
 * PgTable), so we cannot inspect them via JSON.stringify. Instead we mock
 * findFirst / select / update / insert / delete with semantics-only stubs:
 * they assume "find by predicate → return the single seeded doc that
 * matches the caller's intent" (every test seeds at most one doc and
 * passes its id explicitly when needed). That gives us full coverage of
 * the RBAC and lifecycle logic without parsing drizzle's AST.
 *
 * Coverage:
 *  - upload RBAC matrix (6 categories × 5 roles)
 *  - upload validation (MIME, size, CONTRACT+projectId)
 *  - upload S3 compensation on failure
 *  - upload S3 contract (sanitized key + correct mime)
 *  - soft + restore + hard delete RBAC
 *  - getDownloadUrl visibility (incl. HR team scope + ACCOUNTANT receipts)
 *  - soft-deleted docs invisible to getDownloadUrl
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { DocumentsService } from './documents.service'

// -----------------------------------------------------------------------------
// User fixtures
// -----------------------------------------------------------------------------

const u = (id: string, role: SessionUser['role'], name = id): SessionUser => ({
  id,
  role,
  displayName: name,
  email: `${id}@x.com`,
  avatar: null,
  seniorSharePercent: 26,
})

const ADMIN = u('admin-1', 'ADMIN')
const SENIOR = u('senior-1', 'SENIOR')
const SENIOR2 = u('senior-2', 'SENIOR')
const JUNIOR = u('junior-1', 'JUNIOR')
const HR = u('hr-1', 'HR')
const ACCOUNTANT = u('acc-1', 'ACCOUNTANT')
const DROP = u('drop-1', 'DROP')
const DROP2 = u('drop-2', 'DROP')

// -----------------------------------------------------------------------------
// Harness: predicate-blind drizzle imposter
// -----------------------------------------------------------------------------

interface DocRow {
  id: string
  ownerId: string
  projectId: string | null
  category: string
  name: string
  originalName: string | null
  s3Key: string
  thumbnailS3Key: string | null
  sizeBytes: number
  mimeType: string
  uploadedBy: string
  deletedAt: Date | null
  deletedBy: string | null
  createdAt: Date
}

interface HarnessOptions {
  /** Seed rows for findFirst/select. Each test uses 0 or 1 row. */
  docs?: Partial<DocRow>[]
  /** Senior IDs returned for HR's team scope query (innerJoin path). */
  hrSeniorIds?: string[]
  /** If true, findFirst pretends the looked-up doc does not exist. */
  pretendDocMissing?: boolean
  /** If true, findFirst only returns the doc when it is NOT soft-deleted
   *  (mirrors the "WHERE id=? AND deletedAt IS NULL" path). Used to test
   *  the soft-delete invisibility for getDownloadUrl. */
  honorSoftDeleteFilter?: boolean
}

function makeHarness(opts: HarnessOptions = {}) {
  const docsRows: DocRow[] = (opts.docs ?? []).map((d, idx) => ({
    id: d.id ?? `doc-${idx}`,
    ownerId: d.ownerId ?? 'owner-x',
    projectId: d.projectId ?? null,
    category: d.category ?? 'RESUME',
    name: d.name ?? 'file.pdf',
    originalName: d.originalName ?? d.name ?? 'file.pdf',
    s3Key:
      d.s3Key ?? `documents/${d.category ?? 'RESUME'}/${d.ownerId ?? 'x'}/${d.id ?? idx}-file.pdf`,
    thumbnailS3Key: d.thumbnailS3Key ?? null,
    sizeBytes: d.sizeBytes ?? 1024,
    mimeType: d.mimeType ?? 'application/pdf',
    uploadedBy: d.uploadedBy ?? d.ownerId ?? 'owner-x',
    deletedAt: d.deletedAt ?? null,
    deletedBy: d.deletedBy ?? null,
    createdAt: d.createdAt ?? new Date('2026-05-24'),
  }))

  // findFirst counter — first call from getDownloadUrl is the "active-only"
  // query, subsequent calls (softDelete/restore/hardDelete) ignore the
  // soft-delete filter.
  let findFirstCallCount = 0

  const db = {
    db: {
      query: {
        documents: {
          findFirst: async (_args: unknown) => {
            findFirstCallCount += 1
            if (opts.pretendDocMissing) return undefined
            const row = docsRows[0]
            if (!row) return undefined
            if (opts.honorSoftDeleteFilter && row.deletedAt) return undefined
            return row
          },
        },
        users: {
          // Used by `restore()` to re-attach the uploader's display name
          // to the restored row. The test harness has no users seeded —
          // returning `undefined` produces `uploadedByDisplayName: null`,
          // which mirrors a hard-deleted uploader and is a valid DTO shape.
          findFirst: async (_args: unknown) => undefined,
        },
      },

      select: (_arg?: unknown) => ({
        from: (_table: unknown) => {
          const builder = {
            where: (_pred: unknown) => builder,
            innerJoin: (_t: unknown, _on: unknown) => builder,
            orderBy: async (_o: unknown) => docsRows.map((r) => ({ ...r })),
            then: (resolve: (v: unknown) => void) => {
              // unused — we always chain through where().orderBy()
              resolve(undefined)
            },
          }
          // `select({fields}).from(teamMembers).where(...)` returns a Promise
          // directly when not followed by orderBy. We model that path with
          // an extra .where() that already resolves with the seniors list.
          const teamMembersBuilder = {
            where: async (_p: unknown) =>
              (opts.hrSeniorIds ?? []).map((id) => ({ teamId: 't1', userId: id })),
            innerJoin: (_t: unknown, _on: unknown) => ({
              where: async (_p: unknown) => (opts.hrSeniorIds ?? []).map((id) => ({ userId: id })),
            }),
          }
          // Detect which path by inspecting the table identity — we use a
          // proxy so the service can call either one.
          return new Proxy(builder, {
            get(target: typeof builder, prop: string | symbol) {
              if (prop === 'where' || prop === 'innerJoin') {
                // For team_members queries the next chained .where() returns
                // a list of userIds directly (no orderBy). The two callers
                // we have are:
                //   1) list(): .from(documents).where(...).orderBy(...)
                //   2) getHrSeniorIds(): two consecutive .from(teamMembers)
                //      flows. The proxy directs both to teamMembersBuilder.
                if (_table && (_table as { _ }) && '_' in (_table as object)) {
                  // We can't reliably distinguish without inspecting drizzle
                  // internals — instead we expose both behaviors via a union
                  // proxy: each method returns a builder that also works as
                  // teamMembersBuilder when awaited directly. Tests only
                  // exercise getDownloadUrl which uses getHrSeniorIds().
                }
              }
              return (
                (teamMembersBuilder as Record<string, unknown>)[prop as string] ??
                (target as unknown as Record<string, unknown>)[prop as string]
              )
            },
          })
        },
      }),

      insert: (_table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const row: DocRow = {
              id: (values['id'] as string) ?? `new-${docsRows.length}`,
              ownerId: values['ownerId'] as string,
              projectId: (values['projectId'] as string) ?? null,
              category: values['category'] as string,
              name: values['name'] as string,
              originalName: (values['originalName'] as string) ?? null,
              s3Key: values['s3Key'] as string,
              thumbnailS3Key: (values['thumbnailS3Key'] as string) ?? null,
              sizeBytes: values['sizeBytes'] as number,
              mimeType: values['mimeType'] as string,
              uploadedBy: values['uploadedBy'] as string,
              deletedAt: null,
              deletedBy: null,
              createdAt: new Date(),
            }
            docsRows.push(row)
            return [row]
          },
        }),
      }),

      update: (_table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (_pred: unknown) => {
            const apply = () => {
              docsRows.forEach((r) => {
                if ('deletedAt' in values) {
                  r.deletedAt = (values['deletedAt'] as Date | null) ?? null
                  r.deletedBy = (values['deletedBy'] as string | null) ?? null
                }
                if ('thumbnailS3Key' in values) {
                  r.thumbnailS3Key = (values['thumbnailS3Key'] as string | null) ?? null
                }
              })
            }
            return {
              // Promise interface (await update().set().where())
              then: (resolve: (v: unknown) => void) => {
                apply()
                resolve(undefined)
              },
              returning: async () => {
                apply()
                return docsRows.map((r) => ({ ...r }))
              },
            }
          },
        }),
      }),

      delete: (_table: unknown) => ({
        where: async (_pred: unknown) => {
          docsRows.length = 0
        },
      }),
    },
  }

  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue({
      url: 'https://signed.example/abc',
      expiresAt: new Date(Date.now() + 86_400 * 1000).toISOString(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  }

  const compression = {
    compress: vi.fn(async (buffer: Buffer, mime: string) => ({
      buffer,
      finalMimeType: mime === 'image/png' ? 'image/jpeg' : mime,
      sizeBytes: buffer.length,
    })),
    makeThumbnail: vi.fn().mockResolvedValue(null),
  }

  const service = new DocumentsService(db as never, s3 as never, compression as never)
  return {
    service,
    s3,
    compression,
    db,
    docsRows,
    getFindFirstCount: () => findFirstCallCount,
  }
}

// =============================================================================
// Upload — MIME / size validation
// =============================================================================

describe('DocumentsService.upload — MIME / size validation', () => {
  it('rejects MIME outside the whitelist (415)', async () => {
    const h = makeHarness()
    await expect(
      h.service.upload(
        ADMIN,
        { buffer: Buffer.from('x'), mimetype: 'text/csv', originalname: 'a.csv' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('rejects payload > 10 MB (413)', async () => {
    const h = makeHarness()
    const big = Buffer.alloc(11 * 1024 * 1024, 0)
    await expect(
      h.service.upload(
        ADMIN,
        { buffer: big, mimetype: 'application/pdf', originalname: 'big.pdf' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException)
  })

  it('rejects CONTRACT without projectId (400)', async () => {
    const h = makeHarness()
    await expect(
      h.service.upload(
        ADMIN,
        { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'c.pdf' },
        { category: 'CONTRACT' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

// =============================================================================
// Upload — RBAC matrix
// =============================================================================

describe('DocumentsService.upload — RBAC by category', () => {
  const pdfFile = {
    buffer: Buffer.from('pdf-bytes'),
    mimetype: 'application/pdf',
    originalname: 'a.pdf',
  }

  describe('RESUME / SCAN', () => {
    it('JUNIOR upload for someone else → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(JUNIOR, pdfFile, { category: 'RESUME', ownerId: SENIOR.id }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('JUNIOR upload for self → ok', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(JUNIOR, pdfFile, { category: 'RESUME' })
      expect(doc.category).toBe('RESUME')
      expect(doc.ownerId).toBe(JUNIOR.id)
    })
    it('ACCOUNTANT upload RESUME → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(ACCOUNTANT, pdfFile, { category: 'RESUME' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('ADMIN/HR/SENIOR upload SCAN for any ownerId → ok', async () => {
      for (const actor of [ADMIN, HR, SENIOR]) {
        const h = makeHarness()
        const doc = await h.service.upload(actor, pdfFile, {
          category: 'SCAN',
          ownerId: JUNIOR.id,
        })
        expect(doc.ownerId).toBe(JUNIOR.id)
      }
    })
  })

  describe('CONTRACT', () => {
    const projId = '00000000-0000-0000-0000-00000000aaaa'
    it('ADMIN → ok (any ownerId, with projectId)', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(ADMIN, pdfFile, {
        category: 'CONTRACT',
        ownerId: SENIOR.id,
        projectId: projId,
      })
      expect(doc.category).toBe('CONTRACT')
    })
    it('SENIOR for self with projectId → ok', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(SENIOR, pdfFile, {
        category: 'CONTRACT',
        projectId: projId,
      })
      expect(doc.ownerId).toBe(SENIOR.id)
    })
    it('SENIOR for another SENIOR → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(SENIOR, pdfFile, {
          category: 'CONTRACT',
          ownerId: SENIOR2.id,
          projectId: projId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('HR → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(HR, pdfFile, {
          category: 'CONTRACT',
          ownerId: SENIOR.id,
          projectId: projId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe('RECEIPT', () => {
    it('HR upload RECEIPT → 403', async () => {
      const h = makeHarness()
      await expect(h.service.upload(HR, pdfFile, { category: 'RECEIPT' })).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
    it('JUNIOR upload RECEIPT → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(JUNIOR, pdfFile, { category: 'RECEIPT' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('SENIOR for self → ok', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(SENIOR, pdfFile, { category: 'RECEIPT' })
      expect(doc.ownerId).toBe(SENIOR.id)
    })
    it('SENIOR for someone else → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(SENIOR, pdfFile, { category: 'RECEIPT', ownerId: SENIOR2.id }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('ACCOUNTANT for any owner → ok', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(ACCOUNTANT, pdfFile, {
        category: 'RECEIPT',
        ownerId: SENIOR.id,
      })
      expect(doc.ownerId).toBe(SENIOR.id)
    })
  })

  describe('AVATAR', () => {
    it('any role for self → ok', async () => {
      for (const actor of [JUNIOR, HR, SENIOR, ACCOUNTANT, ADMIN]) {
        const h = makeHarness()
        const doc = await h.service.upload(actor, pdfFile, { category: 'AVATAR' })
        expect(doc.ownerId).toBe(actor.id)
      }
    })
    it('non-ADMIN for other → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(SENIOR, pdfFile, { category: 'AVATAR', ownerId: JUNIOR.id }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
    it('ADMIN for other → ok (impersonation)', async () => {
      const h = makeHarness()
      const doc = await h.service.upload(ADMIN, pdfFile, {
        category: 'AVATAR',
        ownerId: JUNIOR.id,
      })
      expect(doc.ownerId).toBe(JUNIOR.id)
    })
  })

  describe('LOGO', () => {
    it('ADMIN / HR / SENIOR → ok', async () => {
      for (const actor of [ADMIN, HR, SENIOR]) {
        const h = makeHarness()
        const doc = await h.service.upload(actor, pdfFile, { category: 'LOGO' })
        expect(doc.category).toBe('LOGO')
      }
    })
    it('JUNIOR → 403', async () => {
      const h = makeHarness()
      await expect(h.service.upload(JUNIOR, pdfFile, { category: 'LOGO' })).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
    it('ACCOUNTANT → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(ACCOUNTANT, pdfFile, { category: 'LOGO' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })
})

// =============================================================================
// Upload — S3 compensation + key contract
// =============================================================================

describe('DocumentsService.upload — compensation on S3 failure', () => {
  it('deletes the DB row when S3.upload throws', async () => {
    const h = makeHarness()
    h.s3.upload.mockRejectedValueOnce(new Error('S3 down'))
    await expect(
      h.service.upload(
        ADMIN,
        { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'a.pdf' },
        { category: 'RESUME' },
      ),
    ).rejects.toThrow('S3 down')
    expect(h.docsRows.length).toBe(0)
  })
})

describe('DocumentsService.upload — S3 contract', () => {
  it('calls compression then S3.upload with sanitized key + compressed mime', async () => {
    const h = makeHarness()
    await h.service.upload(
      ADMIN,
      { buffer: Buffer.from('png'), mimetype: 'image/png', originalname: 'My file.png' },
      { category: 'RESUME' },
    )
    expect(h.compression.compress).toHaveBeenCalledTimes(1)
    expect(h.s3.upload).toHaveBeenCalledTimes(1)
    const [s3Key, , finalMime] = h.s3.upload.mock.calls[0]!
    expect(finalMime).toBe('image/jpeg') // PNG → JPEG via mock
    expect(s3Key).toMatch(/^documents\/RESUME\/admin-1\/[0-9a-f-]+-My_file\.png$/)
  })
})

// =============================================================================
// Hard delete
// =============================================================================

describe('DocumentsService.hardDelete', () => {
  it('non-ADMIN → 403', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date() }],
    })
    await expect(h.service.hardDelete(SENIOR, 'd1')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('ADMIN + NOT soft-deleted → 400', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: null }],
    })
    await expect(h.service.hardDelete(ADMIN, 'd1')).rejects.toBeInstanceOf(BadRequestException)
    expect(h.docsRows.length).toBe(1)
  })

  it('ADMIN + soft-deleted → S3 deleted (incl. thumbnail) + DB row gone', async () => {
    const h = makeHarness({
      docs: [
        {
          id: 'd1',
          ownerId: SENIOR.id,
          category: 'RESUME',
          s3Key: 'documents/RESUME/x/d1-f.pdf',
          thumbnailS3Key: 'documents/RESUME/x/d1-f-thumb.jpg',
          deletedAt: new Date(),
        },
      ],
    })
    await h.service.hardDelete(ADMIN, 'd1')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RESUME/x/d1-f.pdf')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RESUME/x/d1-f-thumb.jpg')
    expect(h.docsRows.length).toBe(0)
  })

  it('ADMIN + soft-deleted PDF (no thumb) → skips thumbnail delete', async () => {
    const h = makeHarness({
      docs: [
        {
          id: 'd1',
          ownerId: SENIOR.id,
          category: 'RESUME',
          s3Key: 'documents/RESUME/x/d1-f.pdf',
          thumbnailS3Key: null,
          deletedAt: new Date(),
        },
      ],
    })
    await h.service.hardDelete(ADMIN, 'd1')
    expect(h.s3.delete).toHaveBeenCalledTimes(1)
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RESUME/x/d1-f.pdf')
  })

  it('ADMIN + missing doc → 404', async () => {
    const h = makeHarness({ pretendDocMissing: true })
    await expect(h.service.hardDelete(ADMIN, 'd-missing')).rejects.toBeInstanceOf(NotFoundException)
  })
})

// =============================================================================
// Soft delete + restore
// =============================================================================

describe('DocumentsService.softDelete', () => {
  it('owner can soft-delete own doc', async () => {
    const h = makeHarness({ docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }] })
    await h.service.softDelete(SENIOR, 'd1')
    expect(h.docsRows[0]?.deletedAt).not.toBeNull()
    expect(h.docsRows[0]?.deletedBy).toBe(SENIOR.id)
  })

  it('ADMIN can soft-delete any doc', async () => {
    const h = makeHarness({ docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }] })
    await h.service.softDelete(ADMIN, 'd1')
    expect(h.docsRows[0]?.deletedAt).not.toBeNull()
  })

  it('non-owner non-ADMIN → 403', async () => {
    const h = makeHarness({ docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }] })
    await expect(h.service.softDelete(JUNIOR, 'd1')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('idempotent: already-deleted is a no-op (no error)', async () => {
    const h = makeHarness({
      docs: [
        { id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date('2026-01-01') },
      ],
    })
    await expect(h.service.softDelete(SENIOR, 'd1')).resolves.toBeUndefined()
  })
})

describe('DocumentsService.restore', () => {
  it('non-ADMIN → 403', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date() }],
    })
    await expect(h.service.restore(SENIOR, 'd1')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('ADMIN → clears deletedAt', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date() }],
    })
    await h.service.restore(ADMIN, 'd1')
    expect(h.docsRows[0]?.deletedAt).toBeNull()
  })

  it('restored DTO carries uploadedByDisplayName as null when uploader not in users table', async () => {
    // Mock users.findFirst returns undefined for this harness — restored
    // doc should still include the field, just null.
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date() }],
    })
    const restored = await h.service.restore(ADMIN, 'd1')
    expect(restored.uploadedByDisplayName).toBeNull()
  })
})

// =============================================================================
// DTO shape — uploadedByDisplayName on upload
// =============================================================================

describe('DocumentsService.upload — DTO shape', () => {
  it('returns uploadedByDisplayName from actor.displayName', async () => {
    const h = makeHarness()
    const doc = await h.service.upload(
      ADMIN,
      { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', originalname: 'cv.pdf' },
      { category: 'RESUME' },
    )
    expect(doc.uploadedByDisplayName).toBe(ADMIN.displayName)
  })
})

// =============================================================================
// Presigned download URL
// =============================================================================

describe('DocumentsService.getDownloadUrl', () => {
  it('ADMIN can download any doc', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'CONTRACT' }],
      honorSoftDeleteFilter: true,
    })
    const result = await h.service.getDownloadUrl(ADMIN, 'd1')
    expect(result.url).toContain('signed.example')
    expect(h.s3.getPresignedDownloadUrl).toHaveBeenCalledTimes(1)
  })

  it('owner can download own doc', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }],
      honorSoftDeleteFilter: true,
    })
    const result = await h.service.getDownloadUrl(SENIOR, 'd1')
    expect(result.url).toBeTruthy()
  })

  it("JUNIOR cannot download someone else's RESUME → 404 (not 403, no leak)", async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }],
      honorSoftDeleteFilter: true,
    })
    await expect(h.service.getDownloadUrl(JUNIOR, 'd1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('HR can download contracts of seniors from own teams', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'CONTRACT' }],
      hrSeniorIds: [SENIOR.id],
      honorSoftDeleteFilter: true,
    })
    const result = await h.service.getDownloadUrl(HR, 'd1')
    expect(result.url).toBeTruthy()
  })

  it('HR cannot download contracts of seniors NOT in own teams → 404', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'CONTRACT' }],
      hrSeniorIds: [],
      honorSoftDeleteFilter: true,
    })
    await expect(h.service.getDownloadUrl(HR, 'd1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('ACCOUNTANT can download any RECEIPT', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RECEIPT' }],
      honorSoftDeleteFilter: true,
    })
    const result = await h.service.getDownloadUrl(ACCOUNTANT, 'd1')
    expect(result.url).toBeTruthy()
  })

  it('owner cannot fetch URL for own soft-deleted doc → 404', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date() }],
      honorSoftDeleteFilter: true,
    })
    await expect(h.service.getDownloadUrl(SENIOR, 'd1')).rejects.toBeInstanceOf(NotFoundException)
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})

// =============================================================================
// PR-2 — status badges + employee_contracts virtual entries
// =============================================================================
//
// These tests extend the mock harness with:
//  - `invoiceSigs`: simulated invoice_signatures rows for a given tx id
//  - `txRows`: simulated transactions rows (for receipt badge derivation)
//  - `contractRows`: simulated employee_contracts rows (for virtual entries)
//
// The service is extended (Task 2 implementation) to:
//  (a) attach statusBadge to INVOICE rows (from invoice_signatures completeness)
//  (b) attach statusBadge to RECEIPT rows (from linked transaction.status)
//  (c) append employee_contracts (non-CANCELLED) as virtual source:'employee_contract' entries
//  (d) leave RESUME/SCAN with statusBadge: null

interface ExtendedHarnessOptions extends HarnessOptions {
  /** invoice_signatures rows for lookup by transactionId */
  invoiceSigs?: Array<{ transactionId: string; signerRole: 'COMPANY' | 'COUNTERPARTY' }>
  /** transactions rows for receipt badge derivation */
  txRows?: Array<{
    id: string
    status: 'PENDING' | 'VALIDATED' | 'REJECTED'
    receiptDocumentId?: string | null
    invoiceDocumentId?: string | null
    type?: string
    senderId?: string | null
    receiverId?: string | null
  }>
  /** employee_contracts rows for virtual entries */
  contractRows?: Array<{
    id: string
    userId: string
    status: 'DRAFT' | 'READY_TO_SIGN' | 'SIGNED' | 'CANCELLED'
    createdAt?: Date
  }>
}

function makeExtendedHarness(opts: ExtendedHarnessOptions = {}) {
  const { invoiceSigs = [], txRows = [], contractRows = [], ...baseOpts } = opts

  const docsRows: DocRow[] = (baseOpts.docs ?? []).map((d, idx) => ({
    id: d.id ?? `doc-${idx}`,
    ownerId: d.ownerId ?? 'owner-x',
    projectId: d.projectId ?? null,
    category: d.category ?? 'RESUME',
    name: d.name ?? 'file.pdf',
    originalName: d.originalName ?? d.name ?? 'file.pdf',
    s3Key:
      d.s3Key ?? `documents/${d.category ?? 'RESUME'}/${d.ownerId ?? 'x'}/${d.id ?? idx}-file.pdf`,
    thumbnailS3Key: d.thumbnailS3Key ?? null,
    sizeBytes: d.sizeBytes ?? 1024,
    mimeType: d.mimeType ?? 'application/pdf',
    uploadedBy: d.uploadedBy ?? d.ownerId ?? 'owner-x',
    deletedAt: d.deletedAt ?? null,
    deletedBy: d.deletedBy ?? null,
    createdAt: d.createdAt ?? new Date('2026-05-24'),
  }))

  // Build a mock db that the extended service can query. The service's list()
  // method uses db.select().from().leftJoin().where().orderBy() for the main
  // query, then separate db.select().from().where() calls for badge sub-queries
  // and db.query.employeeContracts.findMany() for virtual entries.
  const db = {
    db: {
      query: {
        documents: {
          findFirst: async (_args: unknown) => {
            if (baseOpts.pretendDocMissing) return undefined
            const row = docsRows[0]
            if (!row) return undefined
            if (baseOpts.honorSoftDeleteFilter && row.deletedAt) return undefined
            return row
          },
        },
        users: {
          findFirst: async (_args: unknown) => undefined,
          findMany: async (args?: {
            where?: (
              tbl: { id: string },
              ops: { inArray: (col: string, ids: string[]) => boolean },
            ) => boolean
            columns?: Record<string, boolean>
          }) => {
            // Return id+displayName for all contract row owners
            const ownerMap: Record<string, string> = {}
            for (const c of contractRows) {
              ownerMap[c.userId] = `User-${c.userId.slice(-4)}`
            }
            const all = Object.entries(ownerMap).map(([id, displayName]) => ({ id, displayName }))
            if (!args?.where) return all
            return all.filter((u) =>
              args.where!(
                { id: u.id },
                { inArray: (col, ids) => ids.includes(col === 'id' ? u.id : u.id) },
              ),
            )
          },
        },
        employeeContracts: {
          // Simulate Drizzle's findMany with a where callback.
          // The service passes `where: (tbl, { ne, eq, and }) => ...`.
          // We interpret it by building minimal Drizzle-like operator mocks
          // that return plain boolean predicates, then apply them to each row.
          findMany: async (args?: {
            where?: (
              tbl: { userId: string; status: string },
              ops: {
                ne: (a: string, b: string) => boolean
                eq: (a: string, b: string) => boolean
                and: (...bools: boolean[]) => boolean
              },
            ) => boolean
          }) => {
            if (!args?.where) return contractRows.filter((c) => c.status !== 'CANCELLED')
            return contractRows.filter((c) =>
              args.where!(
                { userId: c.userId, status: c.status },
                {
                  ne: (a, b) => a !== b,
                  eq: (a, b) => a === b,
                  and: (...bools) => bools.every(Boolean),
                },
              ),
            )
          },
        },
      },

      select: (_arg?: unknown) => ({
        from: (_table: unknown) => {
          // Return builder that chains where/leftJoin/orderBy
          const rows = docsRows
          const builder = {
            where: (_pred: unknown) => builder,
            leftJoin: (_t: unknown, _on: unknown) => builder,
            orderBy: async (_o: unknown) =>
              rows.map((r) => ({
                doc: r,
                uploaderName: null,
                invoiceTxId: txRows.find((tx) => tx.invoiceDocumentId === r.id)?.id ?? null,
                invoicePendingSignature: false,
                // new fields populated by extended service
                receiptTxStatus: txRows.find((tx) => tx.receiptDocumentId === r.id)?.status ?? null,
                invoiceSigned:
                  invoiceSigs.filter(
                    (s) =>
                      s.transactionId === txRows.find((tx) => tx.invoiceDocumentId === r.id)?.id,
                  ).length >= 2,
              })),
          }
          // For team_members queries (HR scope)
          const teamMembersBuilder = {
            where: async (_p: unknown) =>
              (baseOpts.hrSeniorIds ?? []).map((id) => ({ teamId: 't1', userId: id })),
            innerJoin: (_t: unknown, _on: unknown) => ({
              where: async (_p: unknown) =>
                (baseOpts.hrSeniorIds ?? []).map((id) => ({ userId: id })),
            }),
          }
          return new Proxy(builder, {
            get(target, prop: string | symbol) {
              return (
                (teamMembersBuilder as Record<string, unknown>)[prop as string] ??
                (target as unknown as Record<string, unknown>)[prop as string]
              )
            },
          })
        },
      }),

      insert: (_table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const row: DocRow = {
              id: (values['id'] as string) ?? `new-${docsRows.length}`,
              ownerId: values['ownerId'] as string,
              projectId: (values['projectId'] as string) ?? null,
              category: values['category'] as string,
              name: values['name'] as string,
              originalName: (values['originalName'] as string) ?? null,
              s3Key: values['s3Key'] as string,
              thumbnailS3Key: (values['thumbnailS3Key'] as string) ?? null,
              sizeBytes: values['sizeBytes'] as number,
              mimeType: values['mimeType'] as string,
              uploadedBy: values['uploadedBy'] as string,
              deletedAt: null,
              deletedBy: null,
              createdAt: new Date(),
            }
            docsRows.push(row)
            return [row]
          },
        }),
      }),

      update: (_table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (_pred: unknown) => {
            const apply = () => {
              docsRows.forEach((r) => {
                if ('deletedAt' in values) {
                  r.deletedAt = (values['deletedAt'] as Date | null) ?? null
                  r.deletedBy = (values['deletedBy'] as string | null) ?? null
                }
              })
            }
            return {
              then: (resolve: (v: unknown) => void) => {
                apply()
                resolve(undefined)
              },
              returning: async () => {
                apply()
                return docsRows.map((r) => ({ ...r }))
              },
            }
          },
        }),
      }),

      delete: (_table: unknown) => ({
        where: async (_pred: unknown) => {
          docsRows.length = 0
        },
      }),
    },
  }

  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue({
      url: 'https://signed.example/abc',
      expiresAt: new Date(Date.now() + 86_400 * 1000).toISOString(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  }

  const compression = {
    compress: vi.fn(async (buffer: Buffer, mime: string) => ({
      buffer,
      finalMimeType: mime === 'image/png' ? 'image/jpeg' : mime,
      sizeBytes: buffer.length,
    })),
    makeThumbnail: vi.fn().mockResolvedValue(null),
  }

  const service = new DocumentsService(db as never, s3 as never, compression as never)
  return { service, docsRows, db, s3 }
}

describe('DocumentsService.list — PR-2 statusBadge (Task 2)', () => {
  it('RESUME rows have statusBadge: null (no badge for plain uploads)', async () => {
    const h = makeExtendedHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === 'd1')
    expect(row).toBeDefined()
    expect(row?.statusBadge ?? null).toBeNull()
  })

  it('SCAN rows have statusBadge: null', async () => {
    const h = makeExtendedHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'SCAN' }],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === 'd1')
    expect(row?.statusBadge ?? null).toBeNull()
  })

  it('INVOICE with both COMPANY + COUNTERPARTY sigs → statusBadge {kind:invoice, state:signed}', async () => {
    const TX_ID = 'tx-001'
    const DOC_ID = 'inv-doc-001'
    const h = makeExtendedHarness({
      docs: [{ id: DOC_ID, ownerId: SENIOR.id, category: 'INVOICE' }],
      txRows: [
        {
          id: TX_ID,
          status: 'VALIDATED',
          invoiceDocumentId: DOC_ID,
          type: 'SENIOR_INCOME',
          senderId: SENIOR.id,
          receiverId: null,
        },
      ],
      invoiceSigs: [
        { transactionId: TX_ID, signerRole: 'COMPANY' },
        { transactionId: TX_ID, signerRole: 'COUNTERPARTY' },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === DOC_ID)
    expect(row?.statusBadge).toEqual({ kind: 'invoice', state: 'signed' })
  })

  it('INVOICE missing COUNTERPARTY sig → statusBadge {kind:invoice, state:ready}', async () => {
    const TX_ID = 'tx-002'
    const DOC_ID = 'inv-doc-002'
    const h = makeExtendedHarness({
      docs: [{ id: DOC_ID, ownerId: SENIOR.id, category: 'INVOICE' }],
      txRows: [
        {
          id: TX_ID,
          status: 'PENDING',
          invoiceDocumentId: DOC_ID,
          type: 'SENIOR_INCOME',
          senderId: SENIOR.id,
          receiverId: null,
        },
      ],
      invoiceSigs: [{ transactionId: TX_ID, signerRole: 'COMPANY' }],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === DOC_ID)
    expect(row?.statusBadge).toEqual({ kind: 'invoice', state: 'ready' })
  })

  it('RECEIPT with VALIDATED tx → statusBadge {kind:receipt, state:validated}', async () => {
    const TX_ID = 'tx-003'
    const DOC_ID = 'rcpt-doc-001'
    const h = makeExtendedHarness({
      docs: [{ id: DOC_ID, ownerId: SENIOR.id, category: 'RECEIPT' }],
      txRows: [
        {
          id: TX_ID,
          status: 'VALIDATED',
          receiptDocumentId: DOC_ID,
          type: 'SENIOR_INCOME',
          senderId: SENIOR.id,
          receiverId: null,
        },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === DOC_ID)
    expect(row?.statusBadge).toEqual({ kind: 'receipt', state: 'validated' })
  })

  it('RECEIPT with PENDING tx → statusBadge {kind:receipt, state:pending}', async () => {
    const TX_ID = 'tx-004'
    const DOC_ID = 'rcpt-doc-002'
    const h = makeExtendedHarness({
      docs: [{ id: DOC_ID, ownerId: SENIOR.id, category: 'RECEIPT' }],
      txRows: [
        {
          id: TX_ID,
          status: 'PENDING',
          receiptDocumentId: DOC_ID,
          type: 'SENIOR_INCOME',
          senderId: SENIOR.id,
          receiverId: null,
        },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === DOC_ID)
    expect(row?.statusBadge).toEqual({ kind: 'receipt', state: 'pending' })
  })

  it('RECEIPT with REJECTED tx → statusBadge {kind:receipt, state:pending} (rejection = re-confirm needed)', async () => {
    const TX_ID = 'tx-005'
    const DOC_ID = 'rcpt-doc-003'
    const h = makeExtendedHarness({
      docs: [{ id: DOC_ID, ownerId: SENIOR.id, category: 'RECEIPT' }],
      txRows: [
        {
          id: TX_ID,
          status: 'REJECTED',
          receiptDocumentId: DOC_ID,
          type: 'SENIOR_INCOME',
          senderId: SENIOR.id,
          receiverId: null,
        },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const row = result.find((r) => r.id === DOC_ID)
    expect(row?.statusBadge).toEqual({ kind: 'receipt', state: 'pending' })
  })
})

describe('DocumentsService.list — PR-2 employee_contract virtual entries (Task 2)', () => {
  it('SENIOR gets their non-CANCELLED employee_contract as virtual entry', async () => {
    const CONTRACT_ID = 'contract-001'
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [
        {
          id: CONTRACT_ID,
          userId: SENIOR.id,
          status: 'READY_TO_SIGN',
          createdAt: new Date('2026-01-01'),
        },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const virtual = result.find((r) => r.source === 'employee_contract')
    expect(virtual).toBeDefined()
    expect(virtual?.id).toBe(CONTRACT_ID)
    expect(virtual?.statusBadge).toEqual({ kind: 'contract', state: 'ready' })
  })

  it('DRAFT contract → statusBadge {kind:contract, state:draft} — visible to ADMIN only', async () => {
    // Non-ADMIN (SENIOR) must NOT see DRAFT contracts (A3-4 onboarding rule).
    // The badge derivation is still correct — we verify it via ADMIN actor.
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'c1', userId: SENIOR.id, status: 'DRAFT' }],
    })
    const resultAdmin = await h.service.list(ADMIN, {})
    const virtualAdmin = resultAdmin.find((r) => r.source === 'employee_contract')
    // ADMIN sees DRAFT with correct badge
    expect(virtualAdmin?.statusBadge).toEqual({ kind: 'contract', state: 'draft' })

    // SENIOR (non-ADMIN) does NOT see DRAFT contract at all
    const resultSenior = await h.service.list(SENIOR, {})
    const virtualSenior = resultSenior.find((r) => r.source === 'employee_contract')
    expect(virtualSenior).toBeUndefined()
  })

  it('SIGNED contract → statusBadge {kind:contract, state:signed}', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'c1', userId: SENIOR.id, status: 'SIGNED' }],
    })
    const result = await h.service.list(SENIOR, {})
    const virtual = result.find((r) => r.source === 'employee_contract')
    expect(virtual?.statusBadge).toEqual({ kind: 'contract', state: 'signed' })
  })

  it('CANCELLED contract is hidden (not in results)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'c1', userId: SENIOR.id, status: 'CANCELLED' }],
    })
    const result = await h.service.list(SENIOR, {})
    const virtual = result.filter((r) => r.source === 'employee_contract')
    expect(virtual).toHaveLength(0)
  })

  it('virtual employee_contract entry has source: employee_contract (no double-count with uploaded CONTRACT files)', async () => {
    // Both an uploaded CONTRACT file AND a virtual entry should coexist
    const CONTRACT_FILE_ID = 'uploaded-contract-doc'
    const CONTRACT_ROW_ID = 'employee-contract-row'
    const h = makeExtendedHarness({
      docs: [{ id: CONTRACT_FILE_ID, ownerId: SENIOR.id, category: 'CONTRACT' }],
      contractRows: [{ id: CONTRACT_ROW_ID, userId: SENIOR.id, status: 'SIGNED' }],
    })
    const result = await h.service.list(SENIOR, {})
    const fileEntry = result.find((r) => r.id === CONTRACT_FILE_ID)
    const virtualEntry = result.find((r) => r.source === 'employee_contract')
    // Both present — no merging or deduplication
    expect(fileEntry).toBeDefined()
    expect(virtualEntry).toBeDefined()
    expect(fileEntry?.source).not.toBe('employee_contract')
    expect(virtualEntry?.id).toBe(CONTRACT_ROW_ID)
  })

  it('ADMIN sees employee_contracts of all users (not filtered by own id)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [
        { id: 'c1', userId: SENIOR.id, status: 'SIGNED' },
        { id: 'c2', userId: JUNIOR.id, status: 'DRAFT' },
      ],
    })
    const result = await h.service.list(ADMIN, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(2)
  })

  it('SENIOR only sees own employee_contract (not others)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [
        { id: 'c1', userId: SENIOR.id, status: 'SIGNED' },
        { id: 'c2', userId: SENIOR2.id, status: 'DRAFT' },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.id).toBe('c1')
  })
})

// =============================================================================
// PR-2 — Role-based DRAFT visibility for employee_contracts
// =============================================================================

describe('DocumentsService.list — DRAFT contract visibility per role', () => {
  it('ADMIN sees own-user DRAFT contract (DRAFT is admin-only stage)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'draft-1', userId: SENIOR.id, status: 'DRAFT' }],
    })
    const result = await h.service.list(ADMIN, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.id).toBe('draft-1')
    expect(virtuals[0]?.statusBadge).toEqual({ kind: 'contract', state: 'draft' })
  })

  it('SENIOR does NOT see own DRAFT contract (visible only from READY_TO_SIGN)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'draft-1', userId: SENIOR.id, status: 'DRAFT' }],
    })
    const result = await h.service.list(SENIOR, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(0)
  })

  it('SENIOR sees own READY_TO_SIGN contract (visible to non-ADMIN)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'ready-1', userId: SENIOR.id, status: 'READY_TO_SIGN' }],
    })
    const result = await h.service.list(SENIOR, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.statusBadge).toEqual({ kind: 'contract', state: 'ready' })
  })

  it('SENIOR sees own SIGNED contract (visible to non-ADMIN)', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [{ id: 'signed-1', userId: SENIOR.id, status: 'SIGNED' }],
    })
    const result = await h.service.list(SENIOR, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.statusBadge).toEqual({ kind: 'contract', state: 'signed' })
  })

  it('ADMIN sees all contract statuses (DRAFT + READY_TO_SIGN + SIGNED) across users', async () => {
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [
        { id: 'draft-2', userId: SENIOR.id, status: 'DRAFT' },
        { id: 'ready-2', userId: SENIOR2.id, status: 'READY_TO_SIGN' },
        { id: 'signed-2', userId: JUNIOR.id, status: 'SIGNED' },
      ],
    })
    const result = await h.service.list(ADMIN, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    expect(virtuals).toHaveLength(3)
    const states = virtuals.map((v) => v.statusBadge?.state).sort()
    expect(states).toEqual(['draft', 'ready', 'signed'])
  })

  it('SENIOR with both DRAFT and READY_TO_SIGN contracts: only READY_TO_SIGN visible', async () => {
    // Unusual but defensive: user has two contracts — draft + ready
    const h = makeExtendedHarness({
      docs: [],
      contractRows: [
        { id: 'draft-3', userId: SENIOR.id, status: 'DRAFT' },
        { id: 'ready-3', userId: SENIOR.id, status: 'READY_TO_SIGN' },
      ],
    })
    const result = await h.service.list(SENIOR, {})
    const virtuals = result.filter((r) => r.source === 'employee_contract')
    // Only READY_TO_SIGN is visible; DRAFT is hidden from non-ADMIN
    expect(virtuals).toHaveLength(1)
    expect(virtuals[0]?.id).toBe('ready-3')
  })
})

// =============================================================================
// Task 1 — DocumentsService.hardDeleteInternal (PR-3)
// =============================================================================

describe('DocumentsService.hardDeleteInternal', () => {
  it('deletes S3 object then removes DB row — no RBAC check', async () => {
    const h = makeHarness({
      docs: [
        {
          id: 'd1',
          ownerId: SENIOR.id,
          category: 'RECEIPT',
          s3Key: 'documents/RECEIPT/senior-1/d1-receipt.pdf',
        },
      ],
    })
    await h.service.hardDeleteInternal('d1')
    // S3 delete called with the row's s3Key
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RECEIPT/senior-1/d1-receipt.pdf')
    // DB row removed
    expect(h.docsRows).toHaveLength(0)
  })

  it('also deletes thumbnailS3Key when present', async () => {
    const h = makeHarness({
      docs: [
        {
          id: 'd2',
          ownerId: SENIOR.id,
          category: 'RECEIPT',
          s3Key: 'documents/RECEIPT/senior-1/d2-receipt.pdf',
          thumbnailS3Key: 'documents/RECEIPT/senior-1/d2-receipt_thumb.jpg',
        },
      ],
    })
    await h.service.hardDeleteInternal('d2')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RECEIPT/senior-1/d2-receipt.pdf')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RECEIPT/senior-1/d2-receipt_thumb.jpg')
    expect(h.docsRows).toHaveLength(0)
  })

  it('throws NotFoundException when doc row does not exist', async () => {
    const h = makeHarness({ pretendDocMissing: true })
    await expect(h.service.hardDeleteInternal('no-such-doc')).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('no RBAC — any caller identity is irrelevant (internal use)', async () => {
    // hardDeleteInternal takes no actor — calling it should work regardless
    // of who triggered it upstream. Test with a doc owned by JUNIOR to show
    // ownership is not checked.
    const h = makeHarness({
      docs: [
        {
          id: 'd3',
          ownerId: JUNIOR.id,
          category: 'RECEIPT',
          s3Key: 'docs/RECEIPT/junior-1/d3.pdf',
        },
      ],
    })
    await expect(h.service.hardDeleteInternal('d3')).resolves.toBeUndefined()
    expect(h.docsRows).toHaveLength(0)
  })
})

// =============================================================================
// Task 3 — 1:1 receipt invariant + RECEIPT soft-delete rule (PR-3)
// =============================================================================

describe('DocumentsService — RECEIPT soft-delete rule (Task 3)', () => {
  // The RECEIPT user-soft-delete rule: an owner CAN soft-delete their receipt
  // via the regular softDelete() path — the 1:1 invariant is maintained by the
  // replace-with-delete path in TransactionsService, not by blocking softDelete.
  // This test documents current behaviour and ensures it stays unchanged.
  it('owner can soft-delete a RECEIPT document (softDelete is NOT blocked for RECEIPT)', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RECEIPT' }],
    })
    await expect(h.service.softDelete(SENIOR, 'd1')).resolves.toBeUndefined()
    expect(h.docsRows[0]?.deletedAt).not.toBeNull()
  })

  // hardDeleteInternal IS permitted on RECEIPT (internal, no RBAC) — this is
  // the controlled replace-delete path called by TransactionsService.
  it('hardDeleteInternal succeeds on RECEIPT doc (internal replace-delete allowed)', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RECEIPT', s3Key: 'docs/r/d1.pdf' }],
    })
    await expect(h.service.hardDeleteInternal('d1')).resolves.toBeUndefined()
    expect(h.docsRows).toHaveLength(0)
  })

  // The public hardDelete (ADMIN two-stage) still requires prior soft-delete
  // regardless of category — RECEIPT is no exception.
  it('hardDelete (ADMIN public) still requires prior soft-delete even for RECEIPT', async () => {
    const h = makeHarness({
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RECEIPT', deletedAt: null }],
    })
    await expect(h.service.hardDelete(ADMIN, 'd1')).rejects.toBeInstanceOf(BadRequestException)
  })
})

// -----------------------------------------------------------------------------
// DROP RBAC — IDOR self-scope enforcement (security: no cross-user access)
// task: drop-docs-contract UT finding 1
// -----------------------------------------------------------------------------
describe('DocumentsService — DROP IDOR self-scope', () => {
  // UPLOAD: DROP can upload RESUME/SCAN/CONTRACT for self, not for others.
  describe('upload RBAC for DROP', () => {
    it('DROP can upload RESUME for self → ok', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'cv.pdf' },
          { category: 'RESUME', ownerId: DROP.id },
        ),
      ).resolves.toBeDefined()
    })

    it('DROP cannot upload RESUME for another user → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'cv.pdf' },
          { category: 'RESUME', ownerId: DROP2.id },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('DROP can upload SCAN for self → ok', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'scan.pdf' },
          { category: 'SCAN', ownerId: DROP.id },
        ),
      ).resolves.toBeDefined()
    })

    it('DROP cannot upload SCAN for another user → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'scan.pdf' },
          { category: 'SCAN', ownerId: DROP2.id },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('DROP can upload CONTRACT for self with projectId → ok', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'contract.pdf' },
          { category: 'CONTRACT', ownerId: DROP.id, projectId: 'proj-uuid' },
        ),
      ).resolves.toBeDefined()
    })

    it('DROP cannot upload CONTRACT for another user → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'contract.pdf' },
          { category: 'CONTRACT', ownerId: DROP2.id, projectId: 'proj-uuid' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('DROP cannot upload RECEIPT → 403', async () => {
      const h = makeHarness()
      await expect(
        h.service.upload(
          DROP,
          { buffer: Buffer.alloc(10), mimetype: 'application/pdf', originalname: 'receipt.pdf' },
          { category: 'RECEIPT', ownerId: DROP.id },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  // LIST: DROP is forced to ownerId=self — passing a foreign ownerId must be ignored.
  // The service enforces this via effectiveFilters (ownerId override for DROP).
  //
  // NOTE: The unit harness does not support .leftJoin() in the drizzle select chain
  // (the harness builder models .where().orderBy() only). Full list() SQL correctness
  // is verified against a real PostgreSQL in documents-unified.integration.spec.ts.
  //
  // Here we test the IDOR invariant through the public softDelete path: if DROP
  // could access another user's document, softDelete would succeed; if access is
  // properly scoped (owner check), it throws ForbiddenException.
  describe('list() IDOR — DROP cannot access foreign docs via softDelete proxy', () => {
    it("softDelete: DROP cannot delete SENIOR's doc → 403 (ownership check holds)", async () => {
      const h = makeHarness({
        docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }],
      })
      // DROP is not the owner and not ADMIN → ForbiddenException
      await expect(h.service.softDelete(DROP, 'd1')).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('softDelete: DROP can delete own doc → ok (self-ownership check holds)', async () => {
      const h = makeHarness({
        docs: [{ id: 'd2', ownerId: DROP.id, category: 'RESUME' }],
      })
      await expect(h.service.softDelete(DROP, 'd2')).resolves.toBeUndefined()
    })
  })

  // DOWNLOAD: DROP can download their own doc (ownerId === DROP.id).
  describe('getDownloadUrl — DROP self-doc visibility', () => {
    it('DROP can download their own document', async () => {
      const h = makeHarness({
        docs: [{ id: 'd1', ownerId: DROP.id, category: 'RESUME' }],
        honorSoftDeleteFilter: true,
      })
      await expect(h.service.getDownloadUrl(DROP, 'd1')).resolves.toBeDefined()
    })

    it("DROP cannot download another user's document → 404", async () => {
      const h = makeHarness({
        docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME' }],
        honorSoftDeleteFilter: true,
      })
      await expect(h.service.getDownloadUrl(DROP, 'd1')).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})
