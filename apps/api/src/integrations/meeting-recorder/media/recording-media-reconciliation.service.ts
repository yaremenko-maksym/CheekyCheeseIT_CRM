import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { inArray } from 'drizzle-orm'

import { DatabaseService } from '../../../database/database.service'
import { recordingMediaUploads } from '../../../database/schema'
import { RecordingMediaStorageService } from './recording-media-storage.service'

/**
 * Separate from document reconciliation: expired multipart sessions are not documents.
 * A 48-hour grace period protects provider uploads created before the DB row commits.
 */
@Injectable()
export class RecordingMediaReconciliationService {
  private readonly logger = new Logger(RecordingMediaReconciliationService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: RecordingMediaStorageService,
  ) {}

  @Cron('30 4 * * *')
  async reconcileOnSchedule(): Promise<void> {
    try {
      const result = await this.reconcile()
      this.logger.log(
        `Meeting Recorder multipart reconciliation: ${result.aborted} stale of ${result.scanned} open uploads`,
      )
    } catch (error) {
      this.logger.error(
        'Meeting Recorder multipart reconciliation failed; will retry',
        error instanceof Error ? error.stack : String(error),
      )
    }
  }

  async reconcile(
    now: Date = new Date(),
    dryRun = false,
  ): Promise<{ scanned: number; stale: number; aborted: number }> {
    const graceCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000)
    const open = await this.storage.listOpenMediaUploads()
    let stale = 0
    let aborted = 0
    // Bound query parameter count for large buckets; do not scan unrelated document tables.
    for (let offset = 0; offset < open.length; offset += 400) {
      const batch = open.slice(offset, offset + 400)
      const attempts = await this.db.db
        .select({
          storageKey: recordingMediaUploads.storageKey,
          storageUploadId: recordingMediaUploads.storageUploadId,
          status: recordingMediaUploads.status,
          expiresAt: recordingMediaUploads.expiresAt,
          updatedAt: recordingMediaUploads.updatedAt,
        })
        .from(recordingMediaUploads)
        .where(
          inArray(
            recordingMediaUploads.storageUploadId,
            batch.map((x) => x.uploadId),
          ),
        )
      const known = new Map(attempts.map((a) => [`${a.storageKey}\u0000${a.storageUploadId}`, a]))
      for (const upload of batch) {
        if (upload.initiatedAt >= graceCutoff) continue
        const attempt = known.get(`${upload.key}\u0000${upload.uploadId}`)
        // Preserve live 6-day transfers even when the provider created them >48h ago.
        if (attempt?.status === 'uploading' && attempt.expiresAt > now) continue
        if (attempt?.status === 'completing' && attempt.updatedAt > graceCutoff) continue
        stale++
        if (!dryRun) {
          await this.storage.abort(upload.key, upload.uploadId)
          aborted++
        }
      }
    }
    return { scanned: open.length, stale, aborted }
  }
}
