import { describe, expect, it, vi } from 'vitest'

import { RecordingMediaReconciliationService } from './recording-media-reconciliation.service'

const now = new Date('2026-10-08T20:00:00Z')
const old = new Date('2026-09-29T20:00:00Z')
const fresh = new Date('2026-10-08T19:00:00Z')

function fixture(rows: Record<string, unknown>[] = []) {
  const uploads = [
    { key: 'meeting-recordings/a/live', uploadId: 'live', initiatedAt: old },
    { key: 'meeting-recordings/a/completing', uploadId: 'completing', initiatedAt: old },
    { key: 'meeting-recordings/a/expired', uploadId: 'expired', initiatedAt: old },
    { key: 'meeting-recordings/a/orphan', uploadId: 'orphan', initiatedAt: old },
    { key: 'meeting-recordings/a/new', uploadId: 'new', initiatedAt: fresh },
  ]
  const abort = vi.fn().mockResolvedValue(undefined)
  const storage = { listOpenMediaUploads: vi.fn().mockResolvedValue(uploads), abort }
  const where = vi.fn().mockResolvedValue(rows)
  const db = { db: { select: vi.fn().mockReturnValue({ from: () => ({ where }) }) } }
  const service = new RecordingMediaReconciliationService(db as never, storage as never)
  return { service, abort, storage, where }
}

describe('dedicated media multipart reconciliation', () => {
  it('preserves live uploads, recently completing uploads and new uncommitted uploads', async () => {
    const { service, abort } = fixture([
      {
        storageKey: 'meeting-recordings/a/live',
        storageUploadId: 'live',
        status: 'uploading',
        expiresAt: new Date('2026-10-09T20:00:00Z'),
        updatedAt: old,
      },
      {
        storageKey: 'meeting-recordings/a/completing',
        storageUploadId: 'completing',
        status: 'completing',
        expiresAt: old,
        updatedAt: fresh,
      },
      {
        storageKey: 'meeting-recordings/a/expired',
        storageUploadId: 'expired',
        status: 'uploading',
        expiresAt: old,
        updatedAt: old,
      },
    ])
    expect(await service.reconcile(now)).toEqual({ scanned: 5, stale: 2, aborted: 2 })
    expect(abort.mock.calls).toEqual([
      ['meeting-recordings/a/expired', 'expired'],
      ['meeting-recordings/a/orphan', 'orphan'],
    ])
  })

  it('supports safe dry run, retaining stale uploads for later cleanup', async () => {
    const { service, abort } = fixture()
    expect(await service.reconcile(now, true)).toEqual({ scanned: 5, stale: 4, aborted: 0 })
    expect(abort).not.toHaveBeenCalled()
  })

  it('propagates provider abort failures so the cron can retry next cycle', async () => {
    const { service, abort } = fixture()
    abort.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(service.reconcile(now)).rejects.toThrow('provider unavailable')
  })
})
