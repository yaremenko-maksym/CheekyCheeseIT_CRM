/**
 * DocumentsController.reconcileOrphans — unit test.
 *
 * Verifies that the controller:
 *   1. Parses opts from body via reconcileOrphansOptionsSchema (defaults applied).
 *   2. Serialises Date orphan entries to ISO strings before schema validation.
 *   3. Returns a response that satisfies reconcileReportSchema (output guarantee).
 *   4. Propagates dryRun=false correctly to the service.
 */
import { describe, expect, it, vi } from 'vitest'
import { reconcileReportSchema } from '@crm/shared'
import { DocumentsController } from './documents.controller'
import type { DocumentsService } from './documents.service'
import type { DocumentsReconciliationService } from './documents-reconciliation.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock for DocumentsReconciliationService. */
function makeReconciliationMock(overrides?: Partial<{ deleted: number; orphanCount: number }>) {
  const orphanCount = overrides?.orphanCount ?? 1
  const deleted = overrides?.deleted ?? 0
  const lastModified = new Date('2024-01-01T10:00:00.000Z')

  return {
    reconcileOrphans: vi.fn().mockResolvedValue({
      scannedObjects: orphanCount + 1,
      dbKeys: 1,
      orphans: Array.from({ length: orphanCount }, (_, i) => ({
        key: `documents/RECEIPT/orphan-${i}.jpg`,
        sizeBytes: 1024,
        lastModified, // Date — as the service produces internally
      })),
      orphanBytes: orphanCount * 1024,
      deleted,
      dryRun: deleted === 0,
    }),
  }
}

/** Minimal stub for DocumentsService (unused methods in this test). */
const documentsServiceStub = {} as unknown as DocumentsService

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocumentsController.reconcileOrphans — response schema validation', () => {
  it('response passes reconcileReportSchema.parse() when orphans have Date lastModified', async () => {
    const reconciliationMock = makeReconciliationMock({ orphanCount: 2 })
    const controller = new DocumentsController(
      documentsServiceStub,
      reconciliationMock as unknown as DocumentsReconciliationService,
    )

    const result = await controller.reconcileOrphans({ dryRun: true, graceHours: 48 })

    // Must not throw — this is the core output-guarantee assertion
    expect(() => reconcileReportSchema.parse(result)).not.toThrow()

    const parsed = reconcileReportSchema.parse(result)
    expect(parsed.scannedObjects).toBe(3)
    expect(parsed.dbKeys).toBe(1)
    expect(parsed.orphans).toHaveLength(2)
    expect(parsed.orphanBytes).toBe(2048)
    expect(parsed.deleted).toBe(0)
    expect(parsed.dryRun).toBe(true)
  })

  it('orphan lastModified is serialised to ISO string (not a Date) in the response', async () => {
    const reconciliationMock = makeReconciliationMock({ orphanCount: 1 })
    const controller = new DocumentsController(
      documentsServiceStub,
      reconciliationMock as unknown as DocumentsReconciliationService,
    )

    const result = await controller.reconcileOrphans({})

    expect(result.orphans[0]!.lastModified).toBe('2024-01-01T10:00:00.000Z')
    expect(typeof result.orphans[0]!.lastModified).toBe('string')
  })

  it('applies schema defaults when body is empty — dryRun=true, graceHours=48', async () => {
    const reconciliationMock = makeReconciliationMock({ orphanCount: 0 })
    const controller = new DocumentsController(
      documentsServiceStub,
      reconciliationMock as unknown as DocumentsReconciliationService,
    )

    await controller.reconcileOrphans({})

    expect(reconciliationMock.reconcileOrphans).toHaveBeenCalledWith({
      dryRun: true,
      graceHours: 48,
    })
  })

  it('propagates dryRun=false and custom graceHours to the service', async () => {
    const reconciliationMock = makeReconciliationMock({ orphanCount: 0, deleted: 0 })
    const controller = new DocumentsController(
      documentsServiceStub,
      reconciliationMock as unknown as DocumentsReconciliationService,
    )

    await controller.reconcileOrphans({ dryRun: false, graceHours: 72 })

    expect(reconciliationMock.reconcileOrphans).toHaveBeenCalledWith({
      dryRun: false,
      graceHours: 72,
    })
  })

  it('empty orphans list also passes reconcileReportSchema', async () => {
    const reconciliationMock = makeReconciliationMock({ orphanCount: 0 })
    const controller = new DocumentsController(
      documentsServiceStub,
      reconciliationMock as unknown as DocumentsReconciliationService,
    )

    const result = await controller.reconcileOrphans({ dryRun: true })

    expect(() => reconcileReportSchema.parse(result)).not.toThrow()
    const parsed = reconcileReportSchema.parse(result)
    expect(parsed.orphans).toHaveLength(0)
    expect(parsed.orphanBytes).toBe(0)
  })
})
