import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  MEETING_RECORDER_TEST_EVENT_TYPE,
  meetingRecorderConnectionSchema,
  meetingRecorderRecordingDetailSchema,
  meetingRecorderRecordingSummarySchema,
  meetingRecorderUnmatchedRecordingSchema,
  sanitizeMeetingRecorderRecording,
  type CreateMeetingRecorderConnectionDto,
  type LinkMeetingRecorderRecordingDto,
  type MeetingRecorderConnectionDto,
  type MeetingRecorderRecordingDetailDto,
  type MeetingRecorderRecordingSummaryDto,
  type MeetingRecorderSnapshotEvent,
  type MeetingRecorderUnmatchedRecordingDto,
  type MeetingRecorderWebhookEvent,
  type SessionUser,
  type SetMeetingRecorderSecretDto,
  type UpdateMeetingRecorderConnectionDto,
} from '@crm/shared'

import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import {
  interviewRecordings,
  interviews,
  meetingRecorderAuditLog,
  meetingRecorderConnections,
  meetingRecorderWebhookReceipts,
  type MeetingRecorderAuditAction,
} from '../../database/schema'
import type { DrizzleTx } from '../../database/types'
import { InterviewAccessPolicyService } from '../../interviews/interview-access-policy.service'
import { meetingRecorderWebhookError } from './meeting-recorder-errors'
import { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'

const recordingSummaryColumns = {
  id: interviewRecordings.id,
  interviewId: interviewRecordings.interviewId,
  connectionId: interviewRecordings.connectionId,
  externalRecordingId: interviewRecordings.externalRecordingId,
  revision: interviewRecordings.revision,
  title: interviewRecordings.title,
  startedAt: interviewRecordings.startedAt,
  endedAt: interviewRecordings.endedAt,
  durationMs: interviewRecordings.durationMs,
  provider: interviewRecordings.provider,
  meetingId: interviewRecordings.meetingId,
  meetingUrl: interviewRecordings.meetingUrl,
  stageAtLink: interviewRecordings.stageAtLink,
  matchedBy: interviewRecordings.matchedBy,
  readiness: interviewRecordings.readiness,
  linkedByUserId: interviewRecordings.linkedByUserId,
  linkedAt: interviewRecordings.linkedAt,
  lastEventAt: interviewRecordings.lastEventAt,
  createdAt: interviewRecordings.createdAt,
  updatedAt: interviewRecordings.updatedAt,
} as const

type RecordingRow = typeof interviewRecordings.$inferSelect
type RecordingSummaryRow = Pick<
  RecordingRow,
  | 'id'
  | 'interviewId'
  | 'connectionId'
  | 'externalRecordingId'
  | 'revision'
  | 'title'
  | 'startedAt'
  | 'endedAt'
  | 'durationMs'
  | 'provider'
  | 'meetingId'
  | 'meetingUrl'
  | 'stageAtLink'
  | 'matchedBy'
  | 'readiness'
  | 'linkedByUserId'
  | 'linkedAt'
  | 'lastEventAt'
  | 'createdAt'
  | 'updatedAt'
>

@Injectable()
export class MeetingRecorderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly secretCrypto: MeetingRecorderSecretCryptoService,
    private readonly matcher: MeetingRecorderMatcher,
    private readonly interviewAccess: InterviewAccessPolicyService,
  ) {}

  async listConnections(): Promise<MeetingRecorderConnectionDto[]> {
    const rows = await this.db.db
      .select()
      .from(meetingRecorderConnections)
      .orderBy(desc(meetingRecorderConnections.createdAt))
    return rows.map((row) => this.mapConnection(row))
  }

  async createConnection(
    dto: CreateMeetingRecorderConnectionDto,
    actorUserId: string,
  ): Promise<MeetingRecorderConnectionDto> {
    return this.db.db.transaction(async (tx) => {
      const now = new Date()
      const [row] = await tx
        .insert(meetingRecorderConnections)
        .values({
          name: dto.name,
          createdBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      if (!row) throw new Error('Failed to create Meeting Recorder connection')

      await this.audit(tx, {
        action: 'connection-created',
        actorUserId,
        connectionId: row.id,
      })
      return this.mapConnection(row)
    })
  }

  async updateConnection(
    id: string,
    dto: UpdateMeetingRecorderConnectionDto,
    actorUserId: string,
  ): Promise<MeetingRecorderConnectionDto> {
    return this.db.db.transaction(async (tx) => {
      const existing = await this.lockConnectionOrThrow(tx, id)
      const changes: Partial<typeof meetingRecorderConnections.$inferInsert> = {}
      const actions: MeetingRecorderAuditAction[] = []

      if (dto.name !== undefined && dto.name !== existing.name) {
        changes.name = dto.name
        actions.push('connection-renamed')
      }
      if (dto.enabled !== undefined && dto.enabled !== existing.enabled) {
        changes.enabled = dto.enabled
        actions.push(dto.enabled ? 'connection-enabled' : 'connection-disabled')
      }

      if (actions.length === 0) return this.mapConnection(existing)
      changes.updatedAt = new Date()

      const [updated] = await tx
        .update(meetingRecorderConnections)
        .set(changes)
        .where(eq(meetingRecorderConnections.id, id))
        .returning()
      if (!updated) throw new Error('Failed to update Meeting Recorder connection')

      await tx.insert(meetingRecorderAuditLog).values(
        actions.map((action) => ({
          action,
          actorUserId,
          connectionId: id,
        })),
      )
      return this.mapConnection(updated)
    })
  }

  async setConnectionSecret(
    id: string,
    dto: SetMeetingRecorderSecretDto,
    actorUserId: string,
  ): Promise<MeetingRecorderConnectionDto> {
    return this.db.db.transaction(async (tx) => {
      await this.lockConnectionOrThrow(tx, id)
      const now = new Date()
      const ciphertext = this.secretCrypto.encrypt(dto.secret, id)
      const [updated] = await tx
        .update(meetingRecorderConnections)
        .set({
          signingSecretCiphertext: ciphertext,
          signingSecretUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(meetingRecorderConnections.id, id))
        .returning()
      if (!updated) throw new Error('Failed to store Meeting Recorder secret')

      await this.audit(tx, {
        action: 'secret-replaced',
        actorUserId,
        connectionId: id,
      })
      return this.mapConnection(updated)
    })
  }

  async resetPairing(id: string, actorUserId: string): Promise<MeetingRecorderConnectionDto> {
    return this.db.db.transaction(async (tx) => {
      await this.lockConnectionOrThrow(tx, id)
      const now = new Date()
      const [updated] = await tx
        .update(meetingRecorderConnections)
        .set({
          expectedSource: null,
          signingSecretCiphertext: null,
          signingSecretUpdatedAt: null,
          lastVerifiedAt: null,
          updatedAt: now,
        })
        .where(eq(meetingRecorderConnections.id, id))
        .returning()
      if (!updated) throw new Error('Failed to reset Meeting Recorder pairing')

      await this.audit(tx, {
        action: 'pairing-reset',
        actorUserId,
        connectionId: id,
      })
      return this.mapConnection(updated)
    })
  }

  async getWebhookAuthentication(
    connectionId: string,
  ): Promise<{ secret: string; signingSecretCiphertext: string }> {
    const [row] = await this.db.db
      .select({
        signingSecretCiphertext: meetingRecorderConnections.signingSecretCiphertext,
      })
      .from(meetingRecorderConnections)
      .where(eq(meetingRecorderConnections.id, connectionId))
      .limit(1)

    if (!row?.signingSecretCiphertext) {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
        HttpStatus.UNAUTHORIZED,
      )
    }

    try {
      return {
        secret: this.secretCrypto.decrypt(row.signingSecretCiphertext, connectionId),
        signingSecretCiphertext: row.signingSecretCiphertext,
      }
    } catch {
      throw meetingRecorderWebhookError(
        'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
        HttpStatus.UNAUTHORIZED,
      )
    }
  }

  async ingestWebhookEvent(
    connectionId: string,
    event: MeetingRecorderWebhookEvent,
    authenticatedSigningSecretCiphertext: string,
  ): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      const receipt = await tx
        .insert(meetingRecorderWebhookReceipts)
        .values({
          connectionId,
          webhookId: event.id,
          eventType: event.type,
          receivedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [
            meetingRecorderWebhookReceipts.connectionId,
            meetingRecorderWebhookReceipts.webhookId,
          ],
        })
        .returning({ id: meetingRecorderWebhookReceipts.id })

      if (receipt.length === 0) return

      const connection = await this.lockWebhookConnection(tx, connectionId)
      if (!connection) {
        throw meetingRecorderWebhookError(
          'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
          HttpStatus.UNAUTHORIZED,
        )
      }
      if (connection.signingSecretCiphertext !== authenticatedSigningSecretCiphertext) {
        throw meetingRecorderWebhookError(
          'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
          HttpStatus.UNAUTHORIZED,
        )
      }
      if (!connection.enabled) {
        throw meetingRecorderWebhookError('MEETING_RECORDER_CONNECTION_DISABLED', HttpStatus.GONE)
      }

      if (connection.expectedSource !== null && connection.expectedSource !== event.source) {
        throw meetingRecorderWebhookError('MEETING_RECORDER_SOURCE_MISMATCH', HttpStatus.FORBIDDEN)
      }
      if (connection.expectedSource === null) {
        await tx
          .update(meetingRecorderConnections)
          .set({ expectedSource: event.source, updatedAt: new Date() })
          .where(eq(meetingRecorderConnections.id, connectionId))
      }

      if (event.type === MEETING_RECORDER_TEST_EVENT_TYPE) {
        const now = new Date()
        await tx
          .update(meetingRecorderConnections)
          .set({ lastVerifiedAt: now, updatedAt: now })
          .where(eq(meetingRecorderConnections.id, connectionId))
        return
      }

      await this.ingestSnapshot(tx, connectionId, event)
    })
  }

  async listInterviewRecordings(
    interviewId: string,
    currentUser: SessionUser,
  ): Promise<MeetingRecorderRecordingSummaryDto[]> {
    const [interview] = await this.db.db
      .select({ seniorId: interviews.seniorId })
      .from(interviews)
      .where(eq(interviews.id, interviewId))
      .limit(1)
    if (!interview) throw apiError('INTERVIEW_NOT_FOUND', HttpStatus.NOT_FOUND)
    await this.interviewAccess.assertUpdateAccess(interview, currentUser)

    const rows = await this.db.db
      .select(recordingSummaryColumns)
      .from(interviewRecordings)
      .where(eq(interviewRecordings.interviewId, interviewId))
      .orderBy(desc(interviewRecordings.startedAt))
    return rows.map((row) => this.mapSummary(row))
  }

  async getRecordingDetail(
    recordingId: string,
    currentUser: SessionUser,
  ): Promise<MeetingRecorderRecordingDetailDto> {
    const [row] = await this.db.db
      .select()
      .from(interviewRecordings)
      .where(eq(interviewRecordings.id, recordingId))
      .limit(1)
    if (!row) {
      throw apiError('MEETING_RECORDER_RECORDING_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    await this.assertRecordingReadAccess(row, currentUser)
    return this.mapDetail(row)
  }

  async listUnmatchedRecordings(): Promise<MeetingRecorderUnmatchedRecordingDto[]> {
    const rows = await this.db.db
      .select(recordingSummaryColumns)
      .from(interviewRecordings)
      .where(isNull(interviewRecordings.interviewId))
      .orderBy(desc(interviewRecordings.createdAt))
    return rows.map((row) => meetingRecorderUnmatchedRecordingSchema.parse(this.mapSummary(row)))
  }

  async linkRecording(
    recordingId: string,
    dto: LinkMeetingRecorderRecordingDto,
    actor: SessionUser,
  ): Promise<MeetingRecorderRecordingDetailDto> {
    return this.db.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(interviewRecordings)
        .where(eq(interviewRecordings.id, recordingId))
        .for('update')
        .limit(1)
      const row = rows[0]
      if (!row) {
        throw apiError('MEETING_RECORDER_RECORDING_NOT_FOUND', HttpStatus.NOT_FOUND)
      }

      const now = new Date()
      let action: MeetingRecorderAuditAction
      let update: Partial<typeof interviewRecordings.$inferInsert>

      if (dto.interviewId === null) {
        action = 'recording-unlinked'
        update = {
          interviewId: null,
          stageAtLink: null,
          matchedBy: 'unmatched',
          linkedByUserId: null,
          linkedAt: null,
          updatedAt: now,
        }
      } else {
        const targetRows = await tx
          .select({
            id: interviews.id,
            seniorId: interviews.seniorId,
            stage: interviews.stage,
          })
          .from(interviews)
          .where(eq(interviews.id, dto.interviewId))
          .for('update')
          .limit(1)
        const target = targetRows[0]
        if (!target) throw apiError('INTERVIEW_NOT_FOUND', HttpStatus.NOT_FOUND)
        await this.interviewAccess.assertUpdateAccess(target, actor)

        action = 'recording-linked'
        update = {
          interviewId: target.id,
          stageAtLink: target.stage,
          matchedBy: 'manual',
          linkedByUserId: actor.id,
          linkedAt: now,
          updatedAt: now,
        }
      }

      const [updated] = await tx
        .update(interviewRecordings)
        .set(update)
        .where(eq(interviewRecordings.id, recordingId))
        .returning()
      if (!updated) throw new Error('Failed to link Meeting Recorder recording')

      await this.audit(tx, {
        action,
        actorUserId: actor.id,
        connectionId: updated.connectionId,
        interviewRecordingId: updated.id,
      })
      return this.mapDetail(updated)
    })
  }

  private async ingestSnapshot(
    tx: DrizzleTx,
    connectionId: string,
    event: MeetingRecorderSnapshotEvent,
  ): Promise<void> {
    const recording = event.data.recording
    const existingRows = await tx
      .select()
      .from(interviewRecordings)
      .where(
        and(
          eq(interviewRecordings.connectionId, connectionId),
          eq(interviewRecordings.externalRecordingId, recording.id),
        ),
      )
      .for('update')
      .limit(1)
    const existing = existingRows[0]
    if (existing && existing.revision >= event.data.revision) return

    let interviewId = existing?.interviewId ?? null
    let stageAtLink = existing?.stageAtLink ?? null
    let matchedBy = existing?.matchedBy ?? ('unmatched' as const)
    let linkedByUserId = existing?.linkedByUserId ?? null
    let linkedAt = existing?.linkedAt ?? null

    if (!existing || existing.interviewId === null) {
      const match = await this.matcher.findExactMatch(tx, recording)
      interviewId = match?.interviewId ?? null
      stageAtLink = match?.stageAtLink ?? null
      matchedBy = match?.matchedBy ?? 'unmatched'
      linkedByUserId = null
      linkedAt = null
    }

    const snapshot = sanitizeMeetingRecorderRecording(recording)
    const eventTime = new Date(event.time)
    const now = new Date()
    const values = {
      interviewId,
      connectionId,
      externalRecordingId: recording.id,
      revision: event.data.revision,
      source: event.source,
      title: recording.title,
      startedAt: new Date(recording.startedAt),
      endedAt: recording.endedAt ? new Date(recording.endedAt) : null,
      durationMs: recording.durationMs ?? null,
      provider: recording.source.provider ?? null,
      meetingId: recording.source.meetingId ?? null,
      meetingUrl: recording.source.meetingUrl ?? null,
      stageAtLink,
      matchedBy,
      readiness: event.data.readiness,
      snapshot,
      linkedByUserId,
      linkedAt,
      lastEventAt: eventTime,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof interviewRecordings.$inferInsert

    const written = await tx
      .insert(interviewRecordings)
      .values(values)
      .onConflictDoUpdate({
        target: [interviewRecordings.connectionId, interviewRecordings.externalRecordingId],
        set: {
          interviewId,
          revision: event.data.revision,
          source: event.source,
          title: recording.title,
          startedAt: values.startedAt,
          endedAt: values.endedAt,
          durationMs: values.durationMs,
          provider: values.provider,
          meetingId: values.meetingId,
          meetingUrl: values.meetingUrl,
          stageAtLink,
          matchedBy,
          readiness: event.data.readiness,
          snapshot,
          linkedByUserId,
          linkedAt,
          lastEventAt: eventTime,
          updatedAt: now,
        },
        setWhere: sql`${interviewRecordings.revision} < ${event.data.revision}`,
      })
      .returning({ id: interviewRecordings.id })

    if (written.length === 0) return
    await tx
      .update(meetingRecorderConnections)
      .set({ lastEventAt: eventTime, updatedAt: now })
      .where(eq(meetingRecorderConnections.id, connectionId))
  }

  private async assertRecordingReadAccess(
    row: RecordingRow,
    currentUser: SessionUser,
  ): Promise<void> {
    if (row.interviewId === null) {
      if (currentUser.role !== 'ADMIN') {
        throw apiError('MEETING_RECORDER_RECORDING_ACCESS_DENIED', HttpStatus.FORBIDDEN)
      }
      return
    }

    const [interview] = await this.db.db
      .select({ seniorId: interviews.seniorId })
      .from(interviews)
      .where(eq(interviews.id, row.interviewId))
      .limit(1)
    if (!interview) {
      throw apiError('MEETING_RECORDER_RECORDING_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

    try {
      await this.interviewAccess.assertUpdateAccess(interview, currentUser)
    } catch (error: unknown) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.FORBIDDEN) {
        throw apiError('MEETING_RECORDER_RECORDING_ACCESS_DENIED', HttpStatus.FORBIDDEN)
      }
      throw error
    }
  }

  private async lockConnectionOrThrow(tx: DrizzleTx, id: string) {
    const rows = await tx
      .select()
      .from(meetingRecorderConnections)
      .where(eq(meetingRecorderConnections.id, id))
      .for('update')
      .limit(1)
    const row = rows[0]
    if (!row) {
      throw apiError('MEETING_RECORDER_CONNECTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    return row
  }

  private async lockWebhookConnection(tx: DrizzleTx, id: string) {
    const rows = await tx
      .select()
      .from(meetingRecorderConnections)
      .where(eq(meetingRecorderConnections.id, id))
      .for('update')
      .limit(1)
    return rows[0] ?? null
  }

  private async audit(
    tx: DrizzleTx,
    value: {
      action: MeetingRecorderAuditAction
      actorUserId: string | null
      connectionId?: string | null
      interviewRecordingId?: string | null
    },
  ): Promise<void> {
    await tx.insert(meetingRecorderAuditLog).values({
      action: value.action,
      actorUserId: value.actorUserId,
      connectionId: value.connectionId ?? null,
      interviewRecordingId: value.interviewRecordingId ?? null,
    })
  }

  private mapConnection(
    row: typeof meetingRecorderConnections.$inferSelect,
  ): MeetingRecorderConnectionDto {
    return meetingRecorderConnectionSchema.parse({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      secretSet: row.signingSecretCiphertext !== null,
      expectedSource: row.expectedSource,
      signingSecretUpdatedAt: row.signingSecretUpdatedAt?.toISOString() ?? null,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      webhookPath: `/api/integrations/meeting-recorder/${row.id}/webhook`,
    })
  }

  private mapSummary(row: RecordingSummaryRow): MeetingRecorderRecordingSummaryDto {
    return meetingRecorderRecordingSummarySchema.parse({
      ...row,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      linkedAt: row.linkedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  private mapDetail(row: RecordingRow): MeetingRecorderRecordingDetailDto {
    const summary = this.mapSummary(row)
    return meetingRecorderRecordingDetailSchema.parse({
      ...summary,
      snapshot: row.snapshot,
    })
  }
}
