import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { and, eq, isNotNull, ne } from 'drizzle-orm'

import { apiError } from '../../../common/api-error'
import { DatabaseService } from '../../../database/database.service'
import {
  interviewRecordings,
  meetingRecorderAuditLog,
  meetingRecorderConnections,
  recordingMediaArtifacts,
  recordingMediaUploads,
} from '../../../database/schema'
import { RECORDING_MEDIA_COMPLETION_LEASE_MS } from './recording-media-constants'
import { RecordingMediaStorageService } from './recording-media-storage.service'

type PurgeArtifact = Pick<
  typeof recordingMediaArtifacts.$inferSelect,
  'id' | 'connectionId' | 'externalRecordingId' | 'storageKey'
>

@Injectable()
export class RecordingMediaPurgeService {
  private readonly logger = new Logger(RecordingMediaPurgeService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: RecordingMediaStorageService,
  ) {}

  async purgeRecording(
    recordingId: string,
    actorUserId: string,
  ): Promise<{ state: 'purged' | 'purging' }> {
    const now = new Date()
    const request = await this.db.db.transaction(async (tx) => {
      // Connection is immutable for a recording. Read it without locking, then
      // take the same connection lock as media create/complete before the row lock.
      const [locator] = await tx
        .select({ connectionId: interviewRecordings.connectionId })
        .from(interviewRecordings)
        .where(eq(interviewRecordings.id, recordingId))
        .limit(1)
      if (!locator) {
        throw apiError('MEETING_RECORDER_RECORDING_NOT_FOUND', HttpStatus.NOT_FOUND)
      }

      await tx
        .select({ id: meetingRecorderConnections.id })
        .from(meetingRecorderConnections)
        .where(eq(meetingRecorderConnections.id, locator.connectionId))
        .for('update')
        .limit(1)

      const [recording] = await tx
        .select({
          id: interviewRecordings.id,
          connectionId: interviewRecordings.connectionId,
          externalRecordingId: interviewRecordings.externalRecordingId,
          purgedAt: interviewRecordings.purgedAt,
        })
        .from(interviewRecordings)
        .where(eq(interviewRecordings.id, recordingId))
        .for('update')
        .limit(1)
      if (!recording) {
        throw apiError('MEETING_RECORDER_RECORDING_NOT_FOUND', HttpStatus.NOT_FOUND)
      }

      if (recording.purgedAt === null) {
        await tx
          .update(interviewRecordings)
          .set({ snapshot: {}, purgedAt: now, updatedAt: now })
          .where(eq(interviewRecordings.id, recording.id))
        await tx.insert(meetingRecorderAuditLog).values({
          action: 'recording-purged',
          actorUserId,
          connectionId: recording.connectionId,
          interviewRecordingId: recording.id,
        })
      }

      const artifacts = await tx
        .update(recordingMediaArtifacts)
        .set({ status: 'purging' })
        .where(
          and(
            eq(recordingMediaArtifacts.connectionId, recording.connectionId),
            eq(recordingMediaArtifacts.externalRecordingId, recording.externalRecordingId),
            ne(recordingMediaArtifacts.status, 'purged'),
          ),
        )
        .returning({
          id: recordingMediaArtifacts.id,
          connectionId: recordingMediaArtifacts.connectionId,
          externalRecordingId: recordingMediaArtifacts.externalRecordingId,
          storageKey: recordingMediaArtifacts.storageKey,
        })

      return { recording, artifacts }
    })

    let pending = false
    for (const artifact of request.artifacts) {
      try {
        if (!(await this.cleanupArtifact(artifact, request.recording.id, now))) pending = true
      } catch (error) {
        pending = true
        this.logger.error(
          `Meeting Recorder media purge failed for artifact ${artifact.id}; will retry`,
          error instanceof Error ? error.stack : String(error),
        )
      }
    }
    return { state: pending ? 'purging' : 'purged' }
  }

  /**
   * Cleanup is idempotent: provider work completes before the durable state moves
   * from `purging` to `purged`. A failure therefore leaves a retry marker behind.
   */
  async cleanupArtifact(
    artifact: PurgeArtifact,
    recordingId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const attempts = await this.db.db
      .select({
        id: recordingMediaUploads.id,
        storageKey: recordingMediaUploads.storageKey,
        storageUploadId: recordingMediaUploads.storageUploadId,
        status: recordingMediaUploads.status,
        updatedAt: recordingMediaUploads.updatedAt,
      })
      .from(recordingMediaUploads)
      .where(eq(recordingMediaUploads.artifactId, artifact.id))

    const completionCutoff = new Date(now.getTime() - RECORDING_MEDIA_COMPLETION_LEASE_MS)
    if (
      attempts.some(
        (attempt) => attempt.status === 'completing' && attempt.updatedAt > completionCutoff,
      )
    ) {
      return false
    }

    const keys = new Set([artifact.storageKey, ...attempts.map((attempt) => attempt.storageKey)])
    const ownedPrefix = `meeting-recordings/${artifact.connectionId}/${artifact.id}/`
    for (const key of keys) {
      if (!key.startsWith(ownedPrefix)) throw new Error('Unsafe media purge key')
    }

    for (const attempt of attempts) {
      if (attempt.status === 'ready') continue
      try {
        // UploadPart presigns are capabilities for one multipart UploadId. Abort
        // that session before deleting objects; a late/in-flight part can no
        // longer be completed after the provider has invalidated the UploadId.
        await this.storage.abort(attempt.storageKey, attempt.storageUploadId)
      } catch (error) {
        // GONE is equivalent evidence: the multipart capability is already dead.
        if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.GONE) throw error
      }
    }
    for (const key of keys) await this.storage.delete(key)

    await this.db.db.transaction(async (tx) => {
      await tx
        .update(recordingMediaUploads)
        .set({ status: 'aborted', updatedAt: now })
        .where(eq(recordingMediaUploads.artifactId, artifact.id))
      const transitioned = await tx
        .update(recordingMediaArtifacts)
        .set({ status: 'purged' })
        .where(
          and(
            eq(recordingMediaArtifacts.id, artifact.id),
            eq(recordingMediaArtifacts.status, 'purging'),
          ),
        )
        .returning({ id: recordingMediaArtifacts.id })
      if (transitioned.length === 0) return
      await tx.insert(meetingRecorderAuditLog).values({
        action: 'media-purged',
        actorUserId: null,
        connectionId: artifact.connectionId,
        interviewRecordingId: recordingId,
        metadata: { artifactId: artifact.id },
      })
    })
    return true
  }

  async retryPendingPurges(now: Date = new Date()): Promise<number> {
    const pending = await this.db.db
      .select({
        id: recordingMediaArtifacts.id,
        connectionId: recordingMediaArtifacts.connectionId,
        externalRecordingId: recordingMediaArtifacts.externalRecordingId,
        storageKey: recordingMediaArtifacts.storageKey,
      })
      .from(recordingMediaArtifacts)
      .where(eq(recordingMediaArtifacts.status, 'purging'))
      .limit(100)

    let completed = 0
    for (const artifact of pending) {
      const [recording] = await this.db.db
        .select({ id: interviewRecordings.id })
        .from(interviewRecordings)
        .where(
          and(
            eq(interviewRecordings.connectionId, artifact.connectionId),
            eq(interviewRecordings.externalRecordingId, artifact.externalRecordingId),
            isNotNull(interviewRecordings.purgedAt),
          ),
        )
        .limit(1)
      if (!recording) continue
      try {
        if (await this.cleanupArtifact(artifact, recording.id, now)) completed++
      } catch (error) {
        this.logger.error(
          `Meeting Recorder media purge retry failed for artifact ${artifact.id}`,
          error instanceof Error ? error.stack : String(error),
        )
      }
    }
    return completed
  }

  @Cron('*/5 * * * *')
  async retryPendingPurgesOnSchedule(): Promise<void> {
    try {
      const completed = await this.retryPendingPurges()
      if (completed > 0) {
        this.logger.log(`Meeting Recorder media purge retry: completed ${completed} artifact(s)`)
      }
    } catch (error) {
      this.logger.error(
        'Meeting Recorder media purge retry scan failed; will retry',
        error instanceof Error ? error.stack : String(error),
      )
    }
  }
}
