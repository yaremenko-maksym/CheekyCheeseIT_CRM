/**
 * DocumentsReconciliationService — unit tests.
 *
 * All tests run offline: S3 is fully mocked (listObjects + delete).
 * The DatabaseService is mocked to return a controlled set of s3Key values.
 *
 * Coverage:
 *  1. dry-run: returns orphans, S3.delete is NOT called
 *  2. active (dryRun=false): S3.delete called EXACTLY for orphan keys, not for DB keys
 *  3. grace filter: objects newer than graceHours are NOT flagged as orphans
 *  4. object present in documents.s3Key is NEVER flagged
 *  5. pagination: listObjects fetches multiple pages via continuation token
 *  6. task-file-storage-hardening §4: vacancy-applications/ prefix is scanned
 *     too, and resumeS3Key values from vacancy_applications protect their keys
 */
import { describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { DocumentsReconciliationService } from './documents-reconciliation.service'
import type { S3ObjectInfo } from './documents-reconciliation.service'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Build an S3ObjectInfo with last-modified in the past by `hoursAgo`. */
function makeS3Object(key: string, hoursAgo: number, sizeBytes = 1024): S3ObjectInfo {
  const lastModified = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
  return { key, sizeBytes, lastModified }
}

// ---------------------------------------------------------------------------
// Minimal S3Service mock
//
// task-file-storage-hardening §4: `reconcileOrphans` now scans TWO prefixes
// (`documents/` + `vacancy-applications/`) in separate pagination loops.
// `vacancyPages` defaults to `[]` (a single empty page, matching "nothing
// under this prefix") so every EXISTING call site that only cares about
// `documents/` keeps working unchanged — it just costs one extra
// `listObjects` call for the empty vacancy-applications/ prefix, accounted
// for in the call-count assertions below.
// ---------------------------------------------------------------------------

function makeS3Mock(
  documentsPages: S3ObjectInfo[][],
  vacancyPages: S3ObjectInfo[][] = [],
): {
  listObjects: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  const pagesByPrefix: Record<string, S3ObjectInfo[][]> = {
    'documents/': documentsPages,
    'vacancy-applications/': vacancyPages,
  }
  const pageIndexByPrefix: Record<string, number> = {}
  return {
    listObjects: vi
      .fn()
      .mockImplementation((_continuationToken: string | undefined, prefix = 'documents/') => {
        const pages = pagesByPrefix[prefix] ?? []
        const idx = pageIndexByPrefix[prefix] ?? 0
        const page = pages[idx] ?? []
        pageIndexByPrefix[prefix] = idx + 1
        const hasMore = idx + 1 < pages.length
        return Promise.resolve({
          objects: page,
          nextContinuationToken: hasMore ? `token-${prefix}-page-${idx + 1}` : undefined,
        })
      }),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Minimal DatabaseService mock
//
// `reconcileOrphans` now issues TWO sequential `db.select().from()` queries
// (task-file-storage-hardening §4): 1st = `documents` (awaited directly off
// `.from()`, no `.where()`), 2nd = `vacancy_applications` (chains
// `.where(isNotNull(...))`). The mock below branches on call order so both
// shapes resolve correctly regardless of which helper a given test uses.
// ---------------------------------------------------------------------------

function makeDbMockFromRows(
  docRows: { s3Key: string; thumbnailS3Key: string | null }[],
  resumeKeys: string[] = [],
) {
  let callCount = 0
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        callCount += 1
        if (callCount === 1) {
          // documents query: select({...}).from(documents)
          return { from: vi.fn().mockResolvedValue(docRows) }
        }
        // vacancy_applications query: select({...}).from(vacancyApplications).where(isNotNull(...))
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(resumeKeys.map((resumeS3Key) => ({ resumeS3Key }))),
          }),
        }
      }),
    },
  }
}

function makeDbMock(s3Keys: string[], resumeKeys: string[] = []) {
  return makeDbMockFromRows(
    s3Keys.map((s3Key) => ({ s3Key, thumbnailS3Key: null })),
    resumeKeys,
  )
}

// Suppress logger output in tests
vi.spyOn(Logger.prototype, 'log').mockReturnValue(undefined)
vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined)

// ---------------------------------------------------------------------------
// 1. Dry-run: returns orphans, S3.delete NOT called
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — dry-run', () => {
  it('returns orphan list and does NOT call S3.delete when dryRun=true', async () => {
    const orphanKey = 'documents/RECEIPT/orphan-file.jpg'
    const dbKey = 'documents/RESUME/known-file.pdf'

    const s3Mock = makeS3Mock([[makeS3Object(orphanKey, 72), makeS3Object(dbKey, 72)]])
    const dbMock = makeDbMock([dbKey])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(report.scannedObjects).toBe(2)
    expect(report.dbKeys).toBe(1)
    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0]!.key).toBe(orphanKey)
    expect(report.deleted).toBe(0)
    expect(report.dryRun).toBe(true)
    expect(s3Mock.delete).not.toHaveBeenCalled()
  })

  it('returns empty orphans when all S3 keys are in DB', async () => {
    const key1 = 'documents/RESUME/a.pdf'
    const key2 = 'documents/SCAN/b.pdf'

    const s3Mock = makeS3Mock([[makeS3Object(key1, 72), makeS3Object(key2, 72)]])
    const dbMock = makeDbMock([key1, key2])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(report.orphans).toHaveLength(0)
    expect(report.orphanBytes).toBe(0)
    expect(report.deleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Active (dryRun=false): deletes orphans, skips DB-known keys
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — active deletion', () => {
  it('calls S3.delete ONLY for orphan keys, skips keys present in DB', async () => {
    const orphanKey = 'documents/RECEIPT/orphan.jpg'
    const dbKey = 'documents/RESUME/known.pdf'

    const s3Mock = makeS3Mock([[makeS3Object(orphanKey, 72), makeS3Object(dbKey, 72)]])
    const dbMock = makeDbMock([dbKey])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 48 })

    expect(s3Mock.delete).toHaveBeenCalledTimes(1)
    expect(s3Mock.delete).toHaveBeenCalledWith(orphanKey)
    expect(s3Mock.delete).not.toHaveBeenCalledWith(dbKey)
    expect(report.deleted).toBe(1)
    expect(report.dryRun).toBe(false)
  })

  it('deletes multiple orphans and counts them all in report.deleted', async () => {
    const orphan1 = 'documents/RECEIPT/orphan1.jpg'
    const orphan2 = 'documents/SCAN/orphan2.pdf'
    const orphan3 = 'documents/CONTRACT/orphan3.pdf'

    const s3Mock = makeS3Mock([
      [makeS3Object(orphan1, 72), makeS3Object(orphan2, 72), makeS3Object(orphan3, 72)],
    ])
    const dbMock = makeDbMock([]) // empty DB → all are orphans

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 48 })

    expect(report.deleted).toBe(3)
    expect(s3Mock.delete).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// 3. Grace filter: objects newer than graceHours are NOT orphans
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — grace period filter', () => {
  it('does NOT flag an object newer than graceHours even if absent from DB', async () => {
    const freshKey = 'documents/RECEIPT/in-flight.jpg'
    // 10 hours old, grace = 48 → should be excluded
    const s3Mock = makeS3Mock([[makeS3Object(freshKey, 10)]])
    const dbMock = makeDbMock([]) // not in DB

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(report.orphans).toHaveLength(0)
    expect(report.scannedObjects).toBe(1)
  })

  it('flags an object OLDER than graceHours that is absent from DB', async () => {
    const oldKey = 'documents/RECEIPT/stale.jpg'
    // 100 hours old, grace = 48 → should be flagged
    const s3Mock = makeS3Mock([[makeS3Object(oldKey, 100)]])
    const dbMock = makeDbMock([])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0]!.key).toBe(oldKey)
  })

  it('uses default graceHours=48 when option is omitted', async () => {
    // 36 hours old: within 48h default grace → should NOT be flagged
    const freshKey = 'documents/RECEIPT/recent.jpg'
    const s3Mock = makeS3Mock([[makeS3Object(freshKey, 36)]])
    const dbMock = makeDbMock([])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true }) // no graceHours

    expect(report.orphans).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. DB key NEVER flagged
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — DB key protection', () => {
  it('a key present in documents table is never flagged regardless of age', async () => {
    const protectedKey = 'documents/RESUME/legit.pdf'
    // Very old but in DB — must never appear in orphans
    const s3Mock = makeS3Mock([[makeS3Object(protectedKey, 999)]])
    const dbMock = makeDbMock([protectedKey])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 0 })

    expect(report.orphans).toHaveLength(0)
    expect(s3Mock.delete).not.toHaveBeenCalled()
  })

  it('thumbnailS3Key values present in DB are also protected', async () => {
    const thumbKey = 'documents/RECEIPT/thumb_orphan.jpg'
    // thumbnail key in DB → must not be deleted
    const s3Mock = makeS3Mock([[makeS3Object(thumbKey, 999)]])
    const dbMock = makeDbMockWithThumbnails([], [thumbKey])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 0 })

    expect(report.orphans).toHaveLength(0)
    expect(s3Mock.delete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. Pagination: continuation token across multiple pages
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — S3 pagination', () => {
  it('fetches all pages using continuation token and aggregates results', async () => {
    const orphanPage1 = 'documents/RECEIPT/p1-orphan.jpg'
    const dbKeyPage2 = 'documents/RESUME/p2-known.pdf'
    const orphanPage2 = 'documents/SCAN/p2-orphan.pdf'

    // Two pages of results
    const s3Mock = makeS3Mock([
      [makeS3Object(orphanPage1, 72)],
      [makeS3Object(dbKeyPage2, 72), makeS3Object(orphanPage2, 72)],
    ])
    const dbMock = makeDbMock([dbKeyPage2])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    // listObjects called twice for documents/ (once per page) + once more
    // for the (empty, in this test) vacancy-applications/ prefix, §4.
    expect(s3Mock.listObjects).toHaveBeenCalledTimes(3)
    expect(report.scannedObjects).toBe(3)
    expect(report.orphans).toHaveLength(2)
    const orphanKeys = report.orphans.map((o) => o.key).sort()
    expect(orphanKeys).toEqual([orphanPage1, orphanPage2].sort())
  })

  it('stops pagination when no nextContinuationToken is returned', async () => {
    // Single page — no continuation token
    const s3Mock = makeS3Mock([[makeS3Object('documents/RESUME/x.pdf', 72)]])
    const dbMock = makeDbMock(['documents/RESUME/x.pdf'])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    // 1 call for documents/, 1 more for the (empty) vacancy-applications/ prefix.
    expect(s3Mock.listObjects).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// task-file-storage-hardening §4: vacancy-applications/ prefix coverage
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — vacancy-applications/ prefix (§4)', () => {
  it('scans the vacancy-applications/ prefix and flags an orphan resume there', async () => {
    const orphanResume = 'vacancy-applications/vac-1/orphan-app.pdf'
    const s3Mock = makeS3Mock([], [[makeS3Object(orphanResume, 72)]])
    const dbMock = makeDbMock([]) // no documents rows, no resumeS3Key rows either

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0]!.key).toBe(orphanResume)
  })

  it('a resumeS3Key present in vacancy_applications is never flagged, regardless of age', async () => {
    const protectedResume = 'vacancy-applications/vac-1/legit-app.pdf'
    const s3Mock = makeS3Mock([], [[makeS3Object(protectedResume, 999)]])
    const dbMock = makeDbMock([], [protectedResume])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 0 })

    expect(report.orphans).toHaveLength(0)
    expect(s3Mock.delete).not.toHaveBeenCalled()
  })

  it('a resumeS3Key that is NULL (180-day file-only purge already ran) does not protect a stale key', async () => {
    // The purge already cleared resumeS3Key to null for this application —
    // makeDbMock's resumeKeys list (mirroring `isNotNull()` in the real
    // query) simply does not include it, exactly like the real DB row.
    const staleResume = 'vacancy-applications/vac-1/purged-app.pdf'
    const s3Mock = makeS3Mock([], [[makeS3Object(staleResume, 999)]])
    const dbMock = makeDbMock([], []) // resumeS3Key is null → not "known"

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 0 })

    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0]!.key).toBe(staleResume)
  })

  it('deletes orphans found under BOTH prefixes in a single active run', async () => {
    const docOrphan = 'documents/RECEIPT/orphan.jpg'
    const resumeOrphan = 'vacancy-applications/vac-1/orphan.pdf'
    const s3Mock = makeS3Mock([[makeS3Object(docOrphan, 72)]], [[makeS3Object(resumeOrphan, 72)]])
    const dbMock = makeDbMock([])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: false, graceHours: 48 })

    expect(report.deleted).toBe(2)
    expect(s3Mock.delete).toHaveBeenCalledWith(docOrphan)
    expect(s3Mock.delete).toHaveBeenCalledWith(resumeOrphan)
  })
})

// ---------------------------------------------------------------------------
// 6. Report shape validation
// ---------------------------------------------------------------------------

describe('DocumentsReconciliationService — report shape', () => {
  it('report contains all required fields with correct types', async () => {
    const orphanKey = 'documents/RECEIPT/test.jpg'
    const s3Mock = makeS3Mock([[makeS3Object(orphanKey, 72, 2048)]])
    const dbMock = makeDbMock([])

    const service = new DocumentsReconciliationService(
      s3Mock as unknown as import('./s3.service').S3Service,
      dbMock as unknown as import('../database/database.service').DatabaseService,
    )

    const report = await service.reconcileOrphans({ dryRun: true, graceHours: 48 })

    expect(typeof report.scannedObjects).toBe('number')
    expect(typeof report.dbKeys).toBe('number')
    expect(Array.isArray(report.orphans)).toBe(true)
    expect(typeof report.orphanBytes).toBe('number')
    expect(typeof report.deleted).toBe('number')
    expect(typeof report.dryRun).toBe('boolean')
    expect(report.orphanBytes).toBe(2048)

    const orphan = report.orphans[0]!
    expect(typeof orphan.key).toBe('string')
    expect(typeof orphan.sizeBytes).toBe('number')
    expect(orphan.lastModified).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// Helper: DB mock that includes thumbnail keys
// ---------------------------------------------------------------------------

function makeDbMockWithThumbnails(s3Keys: string[], thumbnailKeys: string[]) {
  // Return rows with both s3Key and thumbnailS3Key
  const rows = [
    ...s3Keys.map((s3Key) => ({ s3Key, thumbnailS3Key: null })),
    ...thumbnailKeys.map((thumbKey) => ({
      s3Key: 'documents/MAIN/placeholder.pdf',
      thumbnailS3Key: thumbKey,
    })),
  ]
  return makeDbMockFromRows(rows)
}
