/**
 * bug-44 (backlog item 44) — unit-level double for `SeniorResumesService.runRender`'s
 * two failure branches (Typst render vs S3 upload).
 *
 * WHY A UNIT SPEC EXISTS ALONGSIDE THE INTEGRATION ONE (mandatory, not
 * duplication — see .claude/rules/common/mutation-gate-integration-specs.md):
 * `resumes-rbac.integration.spec.ts` already proves the real behaviour against
 * a real Postgres, including this exact scenario ("an upload failure after a
 * successful render fails the row instead of leaving it RUNNING"). But the
 * mutation gate drives Stryker through `apps/api/vitest.config.mts`'s
 * NON-integration run, which structurally excludes every `*.integration.spec.ts`
 * from test discovery — Stryker never even sees that file exists, so it cannot
 * credit it with killing anything. Without a unit double, all 14 mutants Stryker
 * generated in the changed lines of `runRender`'s upload-catch + the new shared
 * `failRender` helper reported `Survived` (0 covered), not because the code was
 * untested — the integration spec DOES test it — but because the gate cannot
 * run that file at all. This spec is what makes the gate able to see the line.
 *
 * A hand-rolled fluent mock stands in for `DatabaseService.db` (same pattern as
 * `projects.service.spec.ts`'s `buildHarness`): `.update(table).set(values)
 * .where(...)` records `values` and resolves; `.returning()` on the SAME chain
 * additionally resolves to a caller-controlled row. This is a test DOUBLE, not
 * a re-implementation of Drizzle — it exists only to observe exactly what
 * `runRender` writes on each branch.
 */
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { S3Service } from '../documents/s3.service'
import type { ResumeAiService } from './resume-ai.service'
import type { ResumeTextExtractionService } from './resume-text-extraction.service'
import type { ResumeTypstService } from './resume-typst.service'
import { SeniorResumesService } from './resumes.service'

const RESUME_ID = 'resume-1'
const USER_ID = 'user-1'

interface RecordedUpdate {
  table: unknown
  values: Record<string, unknown>
}

/**
 * Fluent double for `db.db`: `.update(table).set(values).where(...)` records
 * `values` and resolves to `undefined`; the SAME chain also exposes
 * `.returning()`, resolving to the CLAIMED row on the first update (the atomic
 * QUEUED->RUNNING claim `runRender` always does first) and to `[{ id }]` on
 * every later one (what the READY branch expects back).
 */
function buildDbDouble(claimedRow: Record<string, unknown>) {
  const updates: RecordedUpdate[] = []
  const db = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values })
        const isClaim = updates.length === 1
        const chain = Promise.resolve(undefined) as Promise<undefined> & {
          returning: (sel?: unknown) => Promise<unknown[]>
        }
        chain.returning = async () => (isClaim ? [claimedRow] : [{ id: claimedRow['id'] }])
        return { where: () => chain }
      },
    }),
  }
  return { db, updates }
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RESUME_ID,
    userId: USER_ID,
    content: EMPTY_RESUME_CONTENT,
    layout: DEFAULT_RESUME_LAYOUT,
    templateSource: null,
    pdfS3Key: null,
    pdfFingerprint: null,
    pdfRenderError: null,
    ...overrides,
  }
}

function buildService(
  db: unknown,
  s3: { upload: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> },
  typst: { fingerprint: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> },
) {
  return new SeniorResumesService(
    { db } as unknown as DatabaseService,
    s3 as unknown as S3Service,
    {} as unknown as ResumeAiService,
    {} as unknown as ResumeTextExtractionService,
    typst as unknown as ResumeTypstService,
  )
}

describe('SeniorResumesService.runRender — failure branches (bug-44)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    warnSpy?.mockRestore()
  })

  it('an S3 upload failure after a successful render fails the row — never READY, never silently swallowed', async () => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const row = makeRow()
    const { db, updates } = buildDbDouble(row)
    const s3 = {
      upload: vi.fn().mockRejectedValue(new Error('storage unreachable')),
      delete: vi.fn(),
    }
    const typst = {
      fingerprint: vi.fn().mockReturnValue('fingerprint-upload-fail-0123456789'),
      render: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
    }
    const service = buildService(db, s3, typst)

    await expect(service.runRender(RESUME_ID, 'Синьор Тест')).resolves.toBeUndefined()

    // The upload really happened, with the exact category args — a mutant that
    // blanks either literal must not survive.
    expect(s3.upload).toHaveBeenCalledTimes(1)
    expect(s3.upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      'application/pdf',
      'RESUME',
    )

    // Exactly ONE write after the claim. If the try/catch body (or `failRender`
    // itself) were emptied by a mutant, control falls through to the READY
    // write instead — same call count, wrong content — or `failRender`'s own
    // body being emptied means NO second write happens at all.
    expect(updates).toHaveLength(2)
    const failWrite = updates[1]?.values
    expect(failWrite?.['pdfRenderStatus']).toBe('FAILED')
    expect(failWrite?.['pdfRenderError']).toBe(
      'PDF собрался, но не сохранился в хранилище. Попробуйте позже.',
    )
    expect(failWrite?.['pdfRenderStartedAt']).toBeNull()
    expect(failWrite?.['pdfRenderRunId']).toBeNull()
    // bug-44 AC3: a storage failure says nothing about the INPUT the way a
    // Typst error does — the fingerprint of a render that actually SUCCEEDED
    // must not be recorded, or the row would look permanently "doomed" for
    // content that rendered fine.
    expect(failWrite).not.toHaveProperty('pdfFingerprint')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('storage unreachable'))
  })

  it('logs "unknown" (not the raw value) when the rejection is not an Error instance', async () => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const row = makeRow()
    const { db } = buildDbDouble(row)
    const s3 = {
      upload: vi.fn().mockRejectedValue('a plain string, not an Error'),
      delete: vi.fn(),
    }
    const typst = {
      fingerprint: vi.fn().mockReturnValue('fingerprint-nonerror-0123456789'),
      render: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
    }
    const service = buildService(db, s3, typst)

    await service.runRender(RESUME_ID, 'Синьор Тест')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PDF upload failed — unknown'))
  })

  it('a Typst render failure, unlike an upload failure, DOES record the fingerprint — retrying identical input is pointless', async () => {
    const row = makeRow()
    const { db, updates } = buildDbDouble(row)
    const s3 = { upload: vi.fn(), delete: vi.fn() }
    const typst = {
      fingerprint: vi.fn().mockReturnValue('fingerprint-render-fail-0123456789'),
      render: vi.fn().mockRejectedValue(new Error('typst blew up')),
    }
    const service = buildService(db, s3, typst)

    await service.runRender(RESUME_ID, 'Синьор Тест')

    // Never even reached the upload half.
    expect(s3.upload).not.toHaveBeenCalled()

    expect(updates).toHaveLength(2)
    const failWrite = updates[1]?.values
    expect(failWrite?.['pdfRenderStatus']).toBe('FAILED')
    expect(failWrite?.['pdfFingerprint']).toBe('fingerprint-render-fail-0123456789')
  })
})
