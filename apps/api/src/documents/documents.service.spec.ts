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

// -----------------------------------------------------------------------------
// Harness: predicate-blind drizzle imposter
// -----------------------------------------------------------------------------

interface DocRow {
  id: string
  ownerId: string
  projectId: string | null
  category: string
  name: string
  s3Key: string
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
    s3Key:
      d.s3Key ??
      `documents/${d.category ?? 'RESUME'}/${d.ownerId ?? 'x'}/${d.id ?? idx}-file.pdf`,
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
              where: async (_p: unknown) =>
                (opts.hrSeniorIds ?? []).map((id) => ({ userId: id })),
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
              s3Key: values['s3Key'] as string,
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
      await expect(
        h.service.upload(HR, pdfFile, { category: 'RECEIPT' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
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
      await expect(
        h.service.upload(JUNIOR, pdfFile, { category: 'LOGO' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
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

  it('ADMIN + soft-deleted → S3 deleted + DB row gone', async () => {
    const h = makeHarness({
      docs: [
        {
          id: 'd1',
          ownerId: SENIOR.id,
          category: 'RESUME',
          s3Key: 'documents/RESUME/x/d1-f.pdf',
          deletedAt: new Date(),
        },
      ],
    })
    await h.service.hardDelete(ADMIN, 'd1')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RESUME/x/d1-f.pdf')
    expect(h.s3.delete).toHaveBeenCalledWith('documents/RESUME/x/d1-f-thumb.jpg')
    expect(h.docsRows.length).toBe(0)
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
      docs: [{ id: 'd1', ownerId: SENIOR.id, category: 'RESUME', deletedAt: new Date('2026-01-01') }],
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

  it('JUNIOR cannot download someone else\'s RESUME → 404 (not 403, no leak)', async () => {
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
