import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { and, eq, inArray, lte, or } from 'drizzle-orm'

import { DatabaseService } from '../../../database/database.service'
import { recordingMediaArtifacts, recordingMediaUploads } from '../../../database/schema'
import { RecordingMediaStorageService } from './recording-media-storage.service'

const RECONCILIATION_GRACE_MS = 48 * 60 * 60 * 1000
const REPORT_BATCH_SIZE = 400
const ORPHAN_SAMPLE_LIMIT = 20

type OrphanObjectSample = {
  ref: string
  bytes: number
  lastModified: string
}

type ReconciliationResult = {
  scanned: number
  stale: number
  aborted: number
  databaseAborted: number
  objectsScanned: number
  orphanObjects: number
  orphanSample: OrphanObjectSample[]
}

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
        `Meeting Recorder multipart reconciliation: ${result.aborted} stale of ${result.scanned} open uploads; ${result.databaseAborted} DB attempts converged; ${result.orphanObjects} completed orphan candidates of ${result.objectsScanned} objects`,
      )
      if (result.orphanSample.length > 0) {
        this.logger.warn(
          `Meeting Recorder orphan object report (redacted): ${result.orphanSample.map((object) => object.ref).join(', ')}`,
        )
      }
    } catch (error) {
      this.logger.error(
        'Meeting Recorder multipart reconciliation failed; will retry',
        error instanceof Error ? error.stack : String(error),
      )
    }
  }

  async reconcile(now: Date = new Date(), dryRun = false): Promise<ReconciliationResult> {
    const graceCutoff = new Date(now.getTime() - RECONCILIATION_GRACE_MS)
    const open = await this.storage.listOpenMediaUploads()
    let stale = 0
    let aborted = 0
    let databaseAborted = 0
    // Bound query parameter count for large buckets; do not scan unrelated document tables.
    for (let offset = 0; offset < open.length; offset += REPORT_BATCH_SIZE) {
      const batch = open.slice(offset, offset + REPORT_BATCH_SIZE)
      const attempts = await this.db.db
        .select({
          id: recordingMediaUploads.id,
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
        // A ready row is durable evidence that this provider state should not be mutated by cleanup.
        if (attempt?.status === 'ready') continue
        stale++
        if (!dryRun) {
          if (attempt) {
            const claimed = await this.db.db
              .update(recordingMediaUploads)
              .set({ status: 'aborted', updatedAt: now })
              .where(
                and(
                  eq(recordingMediaUploads.id, attempt.id),
                  or(
                    and(
                      eq(recordingMediaUploads.status, 'uploading'),
                      lte(recordingMediaUploads.expiresAt, now),
                    ),
                    and(
                      eq(recordingMediaUploads.status, 'completing'),
                      lte(recordingMediaUploads.updatedAt, graceCutoff),
                    ),
                    eq(recordingMediaUploads.status, 'expired'),
                    eq(recordingMediaUploads.status, 'aborted'),
                  ),
                ),
              )
              .returning({ id: recordingMediaUploads.id })
            // A live completion/restart may have won since the scan. Do not abort its provider session.
            if (!claimed.length) continue
            databaseAborted++
          }
          await this.storage.abort(upload.key, upload.uploadId)
          aborted++
        }
      }
    }
    const orphanReport = await this.reportCompletedOrphans(graceCutoff)
    return {
      scanned: open.length,
      stale,
      aborted,
      databaseAborted,
      ...orphanReport,
    }
  }

  private async reportCompletedOrphans(
    graceCutoff: Date,
  ): Promise<Pick<ReconciliationResult, 'objectsScanned' | 'orphanObjects' | 'orphanSample'>> {
    const objects = await this.storage.listMediaObjects()
    const candidates = objects.filter((object) => object.lastModified < graceCutoff)
    const orphanSample: OrphanObjectSample[] = []
    let orphanObjects = 0

    for (let offset = 0; offset < candidates.length; offset += REPORT_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + REPORT_BATCH_SIZE)
      const keys = batch.map((object) => object.key)
      const [artifacts, liveAttempts] = await Promise.all([
        this.db.db
          .select({ storageKey: recordingMediaArtifacts.storageKey })
          .from(recordingMediaArtifacts)
          .where(inArray(recordingMediaArtifacts.storageKey, keys)),
        this.db.db
          .select({ storageKey: recordingMediaUploads.storageKey })
          .from(recordingMediaUploads)
          .where(
            and(
              inArray(recordingMediaUploads.storageKey, keys),
              inArray(recordingMediaUploads.status, ['uploading', 'completing', 'ready']),
            ),
          ),
      ])
      const referenced = new Set([
        ...artifacts.map((row) => row.storageKey),
        ...liveAttempts.map((row) => row.storageKey),
      ])
      for (const object of batch) {
        if (referenced.has(object.key)) continue
        orphanObjects++
        if (orphanSample.length < ORPHAN_SAMPLE_LIMIT) {
          orphanSample.push({
            ref: `sha256:${createHash('sha256').update(object.key).digest('hex').slice(0, 16)}`,
            bytes: object.bytes,
            lastModified: object.lastModified.toISOString(),
          })
        }
      }
    }

    return { objectsScanned: objects.length, orphanObjects, orphanSample }
  }
}
