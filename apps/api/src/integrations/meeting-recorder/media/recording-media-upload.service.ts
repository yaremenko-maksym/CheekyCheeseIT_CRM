import { createHash, randomUUID } from 'node:crypto'
import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { and, count, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'

import { DatabaseService } from '../../../database/database.service'
import {
  meetingRecorderConnections,
  recordingMediaArtifacts,
  recordingMediaUploads,
} from '../../../database/schema'
import {
  RecordingMediaStorageService,
  type UploadedMediaPart,
} from './recording-media-storage.service'

const PART_SIZE = 32 * 1024 * 1024
const MAX_PARTS = 10_000
const MAX_BYTES = 8 * 1024 * 1024 * 1024
const CONNECTION_QUOTA = 64 * 1024 * 1024 * 1024
const UPLOAD_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000
const COMPLETION_LEASE_MS = 2 * 60 * 1000
const MAX_ACTIVE = 4
const MAX_CONCURRENCY = 3

const uploadRequestSchema = z
  .object({
    clientTransferId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    recordingId: z.string().regex(/^recording_[0-9a-f-]{36}$/i),
    artifact: z
      .object({
        role: z.enum(['tab-recording', 'microphone-recording', 'self-video']),
        filename: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(200),
        bytes: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict()

type CreateRequest = z.infer<typeof uploadRequestSchema>
type Artifact = typeof recordingMediaArtifacts.$inferSelect
type Upload = typeof recordingMediaUploads.$inferSelect

function mediaError(code: string, status: HttpStatus): HttpException {
  return new HttpException({ code }, status)
}

function externalId(prefix: 'media' | 'upload', uuid: string): string {
  return `${prefix}_${uuid}`
}

function parseExternalId(value: string, prefix: 'media' | 'upload'): string {
  const id = value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : ''
  if (!z.uuid().safeParse(id).success) throw mediaError('MEDIA_NOT_FOUND', HttpStatus.NOT_FOUND)
  return id
}

/** Control plane for private multipart transfer attempts; media bytes flow directly to R2. */
@Injectable()
export class RecordingMediaUploadService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: RecordingMediaStorageService,
  ) {}

  async create(connectionId: string, body: unknown) {
    const parsed = uploadRequestSchema.safeParse(body)
    if (!parsed.success) throw mediaError('MEDIA_UPLOAD_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    const input = parsed.data
    const mimeType = input.artifact.mimeType.split(';', 1)[0]!.trim().toLowerCase()
    if (!['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4'].includes(mimeType)) {
      throw mediaError('MEDIA_UPLOAD_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    if (
      input.artifact.bytes > MAX_BYTES ||
      Math.ceil(input.artifact.bytes / PART_SIZE) > MAX_PARTS
    ) {
      throw mediaError('MEDIA_UPLOAD_TOO_LARGE', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    const filename = input.artifact.filename.replace(/[\x00-\x1f\x7f]/g, '')
    if (!filename) throw mediaError('MEDIA_UPLOAD_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    const requestFingerprint = fingerprint(input, mimeType)

    let pendingProviderUpload: { key: string; uploadId: string } | undefined
    try {
      const result = await this.db.db.transaction(async (tx) => {
        // A row lock serializes create, restart and quota checks for this connection.
        const [connection] = await tx
          .select({ enabled: meetingRecorderConnections.enabled })
          .from(meetingRecorderConnections)
          .where(eq(meetingRecorderConnections.id, connectionId))
          .for('update')
          .limit(1)
        if (!connection || !connection.enabled)
          throw mediaError('MEDIA_CONNECTION_DISABLED', HttpStatus.GONE)

        const [existing] = await tx
          .select()
          .from(recordingMediaArtifacts)
          .where(
            and(
              eq(recordingMediaArtifacts.connectionId, connectionId),
              eq(recordingMediaArtifacts.clientTransferId, input.clientTransferId),
            ),
          )
          .limit(1)
        if (existing && existing.requestFingerprint !== requestFingerprint) {
          throw mediaError('MEDIA_TRANSFER_CONFLICT', HttpStatus.CONFLICT)
        }
        if (existing?.status === 'ready') return this.ready(existing)

        if (existing) {
          const [latest] = await tx
            .select()
            .from(recordingMediaUploads)
            .where(eq(recordingMediaUploads.artifactId, existing.id))
            .orderBy(desc(recordingMediaUploads.createdAt), desc(recordingMediaUploads.id))
            .limit(1)

          if (latest?.status === 'completing') {
            if (await this.confirmObject(existing, latest)) {
              await tx
                .update(recordingMediaArtifacts)
                .set({ status: 'ready', storageKey: latest.storageKey, completedAt: new Date() })
                .where(eq(recordingMediaArtifacts.id, existing.id))
              await tx
                .update(recordingMediaUploads)
                .set({ status: 'ready' })
                .where(eq(recordingMediaUploads.id, latest.id))
              return this.ready(existing)
            }
            if (latest.updatedAt > new Date(Date.now() - COMPLETION_LEASE_MS)) {
              throw mediaError('MEDIA_UPLOAD_COMPLETING', HttpStatus.CONFLICT)
            }
          }
          if (latest?.status === 'uploading' && latest.expiresAt > new Date()) {
            return this.uploading(existing, latest)
          }
          if (latest?.status === 'uploading' || latest?.status === 'completing')
            await tx
              .update(recordingMediaUploads)
              .set({ status: 'expired', updatedAt: new Date() })
              .where(eq(recordingMediaUploads.id, latest.id))
        }

        const [activeCount] = await tx
          .select({ value: count() })
          .from(recordingMediaUploads)
          .innerJoin(
            recordingMediaArtifacts,
            eq(recordingMediaUploads.artifactId, recordingMediaArtifacts.id),
          )
          .where(
            and(
              eq(recordingMediaArtifacts.connectionId, connectionId),
              eq(recordingMediaUploads.status, 'uploading'),
              gt(recordingMediaUploads.expiresAt, new Date()),
            ),
          )
        if ((activeCount?.value ?? 0) >= MAX_ACTIVE)
          throw mediaError('MEDIA_UPLOAD_LIMIT', HttpStatus.TOO_MANY_REQUESTS)

        if (!existing) {
          const [quota] = await tx
            .select({ bytes: sql<string>`coalesce(sum(${recordingMediaArtifacts.bytes}),0)` })
            .from(recordingMediaArtifacts)
            .where(
              and(
                eq(recordingMediaArtifacts.connectionId, connectionId),
                sql`${recordingMediaArtifacts.status} != 'failed'`,
              ),
            )
          if (Number(quota?.bytes ?? 0) + input.artifact.bytes > CONNECTION_QUOTA) {
            throw mediaError('MEDIA_QUOTA_EXCEEDED', HttpStatus.PAYLOAD_TOO_LARGE)
          }
        }

        const artifactId = existing?.id ?? randomUUID()
        const attemptId = randomUUID()
        const key = `meeting-recordings/${connectionId}/${artifactId}/${attemptId}`
        if (!existing) {
          await tx.insert(recordingMediaArtifacts).values({
            id: artifactId,
            connectionId,
            clientTransferId: input.clientTransferId,
            externalRecordingId: input.recordingId,
            role: input.artifact.role,
            filename,
            requestFingerprint,
            mimeType,
            bytes: input.artifact.bytes,
            storageKey: key,
          })
        }

        const providerUploadId = await this.storage.begin(key, mimeType)
        pendingProviderUpload = { key, uploadId: providerUploadId }
        const expiresAt = new Date(Date.now() + UPLOAD_LIFETIME_MS)
        const [attempt] = await tx
          .insert(recordingMediaUploads)
          .values({
            id: attemptId,
            artifactId,
            storageKey: key,
            storageUploadId: providerUploadId,
            partSize: PART_SIZE,
            expiresAt,
          })
          .returning()
        if (!attempt) throw mediaError('MEDIA_UPLOAD_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
        if (existing)
          await tx
            .update(recordingMediaArtifacts)
            .set({ status: 'uploading' })
            .where(eq(recordingMediaArtifacts.id, artifactId))
        return this.uploading({ id: artifactId }, attempt)
      })
      pendingProviderUpload = undefined
      return result
    } catch (error) {
      if (pendingProviderUpload) {
        // Failed DB commits can leave an untracked provider upload; abort it best-effort.
        await this.storage
          .abort(pendingProviderUpload.key, pendingProviderUpload.uploadId)
          .catch(() => undefined)
      }
      throw error
    }
  }

  async status(connectionId: string, uploadId: string) {
    const { artifact, upload } = await this.findAttempt(connectionId, uploadId)
    this.assertUploadNotExpired(upload)
    if (artifact.status === 'ready') return this.ready(artifact)
    if (upload.status === 'completing') {
      if (await this.confirmObject(artifact, upload)) return await this.markReady(artifact, upload)
      throw mediaError('MEDIA_UPLOAD_COMPLETING', HttpStatus.CONFLICT)
    }
    this.assertUploadActive(upload)
    return {
      state: 'uploading' as const,
      artifactId: externalId('media', artifact.id),
      uploadedParts: await this.storage.listParts(upload.storageKey, upload.storageUploadId),
    }
  }

  async signPart(connectionId: string, uploadId: string, partNumber: number) {
    const { artifact, upload } = await this.findAttempt(connectionId, uploadId)
    this.assertUploadActive(upload)
    if (artifact.status !== 'uploading')
      throw mediaError('MEDIA_UPLOAD_COMPLETING', HttpStatus.CONFLICT)
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > Math.ceil(artifact.bytes / upload.partSize)
    ) {
      throw mediaError('MEDIA_PART_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    return this.storage.signPart(upload.storageKey, upload.storageUploadId, partNumber)
  }

  async complete(connectionId: string, uploadId: string, body: unknown) {
    const { artifact, upload } = await this.findAttempt(connectionId, uploadId)
    this.assertUploadNotExpired(upload)
    if (artifact.status === 'ready') return this.ready(artifact)
    if (await this.confirmObject(artifact, upload)) return await this.markReady(artifact, upload)

    const parsed = z
      .object({
        parts: z
          .array(
            z
              .object({
                partNumber: z.number().int().positive(),
                etag: z.string().min(1),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PARTS),
      })
      .strict()
      .safeParse(body)
    if (
      !parsed.success ||
      parsed.data.parts.length !== Math.ceil(artifact.bytes / upload.partSize)
    ) {
      throw mediaError('MEDIA_PARTS_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    for (const [index, part] of parsed.data.parts.entries()) {
      if (part.partNumber !== index + 1)
        throw mediaError('MEDIA_PARTS_INVALID', HttpStatus.UNPROCESSABLE_ENTITY)
    }

    // Claim a bounded completion lease atomically, protecting against concurrent completes.
    const now = new Date()
    const [claimed] = await this.db.db
      .update(recordingMediaUploads)
      .set({
        status: 'completing',
        updatedAt: now,
      })
      .where(
        and(
          eq(recordingMediaUploads.id, upload.id),
          sql`(${recordingMediaUploads.status} = 'uploading' AND ${recordingMediaUploads.expiresAt} > ${now}) OR (${recordingMediaUploads.status} = 'completing' AND ${recordingMediaUploads.updatedAt} < ${new Date(now.getTime() - COMPLETION_LEASE_MS)})`,
        ),
      )
      .returning({ id: recordingMediaUploads.id })
    if (!claimed) throw mediaError('MEDIA_UPLOAD_COMPLETING', HttpStatus.CONFLICT)
    await this.db.db
      .update(recordingMediaArtifacts)
      .set({ status: 'completing' })
      .where(eq(recordingMediaArtifacts.id, artifact.id))

    try {
      const actual = await this.storage.listParts(upload.storageKey, upload.storageUploadId)
      if (!equalParts(parsed.data.parts, actual))
        throw mediaError('MEDIA_PARTS_MISMATCH', HttpStatus.UNPROCESSABLE_ENTITY)
      await this.storage.complete(upload.storageKey, upload.storageUploadId, parsed.data.parts)
    } catch (error: unknown) {
      // A completion can succeed at R2 even if its HTTP response is lost.
      if (await this.confirmObject(artifact, upload)) return await this.markReady(artifact, upload)
      if (error instanceof HttpException && error.getStatus() === HttpStatus.UNPROCESSABLE_ENTITY) {
        // ListParts mismatch happens before CompleteMultipartUpload and is safe to retry.
        await this.db.db.transaction(async (tx) => {
          await tx
            .update(recordingMediaUploads)
            .set({ status: 'uploading', updatedAt: new Date() })
            .where(
              and(
                eq(recordingMediaUploads.id, upload.id),
                eq(recordingMediaUploads.status, 'completing'),
              ),
            )
          await tx
            .update(recordingMediaArtifacts)
            .set({ status: 'uploading' })
            .where(
              and(
                eq(recordingMediaArtifacts.id, artifact.id),
                eq(recordingMediaArtifacts.status, 'completing'),
              ),
            )
        })
      }
      throw error
    }
    if (!(await this.confirmObject(artifact, upload)))
      throw mediaError('MEDIA_OBJECT_MISMATCH', HttpStatus.CONFLICT)
    return this.markReady(artifact, upload)
  }

  async playback(connectionId: string, artifactId: string) {
    const id = parseExternalId(artifactId, 'media')
    const [artifact] = await this.db.db
      .select()
      .from(recordingMediaArtifacts)
      .where(eq(recordingMediaArtifacts.id, id))
      .limit(1)
    if (!artifact) throw mediaError('MEDIA_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (artifact.connectionId !== connectionId)
      throw mediaError('MEDIA_FORBIDDEN', HttpStatus.FORBIDDEN)
    if (artifact.status !== 'ready') throw mediaError('MEDIA_NOT_READY', HttpStatus.CONFLICT)
    return this.storage.playback(artifact.storageKey, artifact.mimeType)
  }

  async playbackForCrm(connectionId: string, externalRecordingId: string, artifactId: string) {
    // CRM session/RBAC access is checked by the recording-detail controller.
    // Disabling the external receiver revokes bearer access, not historical CRM playback.
    const id = parseExternalId(artifactId, 'media')
    const [artifact] = await this.db.db
      .select()
      .from(recordingMediaArtifacts)
      .where(
        and(
          eq(recordingMediaArtifacts.id, id),
          eq(recordingMediaArtifacts.connectionId, connectionId),
          eq(recordingMediaArtifacts.externalRecordingId, externalRecordingId),
          eq(recordingMediaArtifacts.status, 'ready'),
        ),
      )
      .limit(1)
    if (!artifact) throw mediaError('MEDIA_NOT_FOUND', HttpStatus.NOT_FOUND)
    return this.storage.playback(artifact.storageKey, artifact.mimeType)
  }

  private async findAttempt(
    connectionId: string,
    uploadId: string,
  ): Promise<{ artifact: Artifact; upload: Upload }> {
    const id = parseExternalId(uploadId, 'upload')
    const [row] = await this.db.db
      .select({ artifact: recordingMediaArtifacts, upload: recordingMediaUploads })
      .from(recordingMediaUploads)
      .innerJoin(
        recordingMediaArtifacts,
        eq(recordingMediaUploads.artifactId, recordingMediaArtifacts.id),
      )
      .where(eq(recordingMediaUploads.id, id))
      .limit(1)
    if (!row) throw mediaError('MEDIA_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (row.artifact.connectionId !== connectionId)
      throw mediaError('MEDIA_FORBIDDEN', HttpStatus.FORBIDDEN)
    return row
  }

  private assertUploadActive(upload: Upload): void {
    this.assertUploadNotExpired(upload)
    if (upload.status !== 'uploading')
      throw mediaError('MEDIA_UPLOAD_COMPLETING', HttpStatus.CONFLICT)
  }

  private assertUploadNotExpired(upload: Upload): void {
    if (
      upload.status === 'expired' ||
      upload.status === 'aborted' ||
      (upload.status === 'uploading' && upload.expiresAt <= new Date())
    ) {
      throw mediaError('MEDIA_UPLOAD_EXPIRED', HttpStatus.GONE)
    }
  }

  private async confirmObject(artifact: Artifact, upload: Upload): Promise<boolean> {
    const object = await this.storage.head(upload.storageKey)
    return (
      object?.bytes === artifact.bytes &&
      object.mimeType.split(';', 1)[0]?.toLowerCase() === artifact.mimeType
    )
  }

  private async markReady(artifact: Artifact, upload: Upload) {
    await this.db.db.transaction(async (tx) => {
      // Use the same connection lock as create, so a restarted attempt cannot win a late complete.
      await tx
        .select({ id: meetingRecorderConnections.id })
        .from(meetingRecorderConnections)
        .where(eq(meetingRecorderConnections.id, artifact.connectionId))
        .for('update')
        .limit(1)
      // A stale attempt may have finished after the client restarted with a new upload.
      const [latest] = await tx
        .select({ id: recordingMediaUploads.id, status: recordingMediaUploads.status })
        .from(recordingMediaUploads)
        .where(eq(recordingMediaUploads.artifactId, artifact.id))
        .orderBy(desc(recordingMediaUploads.createdAt), desc(recordingMediaUploads.id))
        .limit(1)
      if (latest?.id !== upload.id || latest.status === 'expired' || latest.status === 'aborted') {
        throw mediaError('MEDIA_UPLOAD_EXPIRED', HttpStatus.GONE)
      }
      await tx
        .update(recordingMediaArtifacts)
        .set({ status: 'ready', storageKey: upload.storageKey, completedAt: new Date() })
        .where(eq(recordingMediaArtifacts.id, artifact.id))
      await tx
        .update(recordingMediaUploads)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(eq(recordingMediaUploads.id, upload.id))
    })
    return this.ready(artifact)
  }

  private ready(artifact: Pick<Artifact, 'id'>) {
    return { artifactId: externalId('media', artifact.id), state: 'ready' as const }
  }

  private uploading(artifact: Pick<Artifact, 'id'>, upload: Upload) {
    return {
      artifactId: externalId('media', artifact.id),
      uploadId: externalId('upload', upload.id),
      state: 'uploading' as const,
      strategy: 'multipart-put-v1' as const,
      partSize: upload.partSize,
      maxConcurrency: MAX_CONCURRENCY,
    }
  }
}

function fingerprint(input: CreateRequest, mimeType: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.recordingId,
        input.artifact.role,
        input.artifact.filename,
        mimeType,
        input.artifact.bytes,
      ]),
    )
    .digest('hex')
}

function equalParts(expected: UploadedMediaPart[], actual: UploadedMediaPart[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (part, index) =>
        part.partNumber === actual[index]?.partNumber && part.etag === actual[index]?.etag,
    )
  )
}
