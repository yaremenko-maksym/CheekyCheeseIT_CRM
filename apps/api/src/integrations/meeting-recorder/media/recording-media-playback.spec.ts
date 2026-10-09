import { HttpException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import type { DatabaseService } from '../../../database/database.service'
import { recordingMediaArtifacts } from '../../../database/schema'
import type { RecordingMediaStorageService } from './recording-media-storage.service'
import { RecordingMediaUploadService } from './recording-media-upload.service'

const artifact = {
  id: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalRecordingId: 'recording_33333333-3333-4333-8333-333333333333',
  status: 'ready',
  storageKey: 'recording-media/opaque-key',
  mimeType: 'video/webm',
}

function setup(status = 'ready') {
  const row = { ...artifact, status }
  const playback = vi.fn().mockResolvedValue({ url: 'https://example.test/signed-read' })
  const from = vi.fn((table) => {
    // The CRM playback path must remain available when the integration is disabled;
    // reading the connection.enabled flag here would make the test fail.
    expect(table).toBe(recordingMediaArtifacts)
    return {
      where(predicate: Parameters<PgDialect['sqlToQuery']>[0]) {
        const { sql, params } = new PgDialect().sqlToQuery(predicate)
        for (const field of ['id', 'connection_id', 'external_recording_id', 'status']) {
          expect(sql).toContain(field)
        }
        const matching = [row.id, row.connectionId, row.externalRecordingId, 'ready'].every(
          (value) => params.includes(value),
        )
        return { limit: vi.fn().mockResolvedValue(matching && status === 'ready' ? [row] : []) }
      },
    }
  })
  const db = { db: { select: vi.fn(() => ({ from })) } } as unknown as DatabaseService
  const storage = { playback } as unknown as RecordingMediaStorageService
  return { service: new RecordingMediaUploadService(db, storage), from, playback }
}

describe('CRM-user recording media playback', () => {
  it('plays a ready artifact through scoped CRM access even after receiver disable', async () => {
    const { service, from, playback } = setup()
    await expect(
      service.playbackForCrm(
        artifact.connectionId,
        artifact.externalRecordingId,
        `media_${artifact.id}`,
      ),
    ).resolves.toEqual({ url: 'https://example.test/signed-read' })
    expect(from).toHaveBeenCalledOnce()
    expect(playback).toHaveBeenCalledWith(artifact.storageKey, artifact.mimeType)
  })

  it('rejects artifacts outside the recording/connection scope and artifacts that are not ready', async () => {
    const { service, playback } = setup()
    for (const [connection, recording] of [
      ['44444444-4444-4444-8444-444444444444', artifact.externalRecordingId],
      [artifact.connectionId, 'recording_different'],
    ]) {
      await expect(
        service.playbackForCrm(connection!, recording!, `media_${artifact.id}`),
      ).rejects.toMatchObject({
        status: 404,
      })
    }
    expect(playback).not.toHaveBeenCalled()

    const pending = setup('uploading')
    await expect(
      pending.service.playbackForCrm(
        artifact.connectionId,
        artifact.externalRecordingId,
        `media_${artifact.id}`,
      ),
    ).rejects.toBeInstanceOf(HttpException)
    expect(pending.playback).not.toHaveBeenCalled()
  })
})
