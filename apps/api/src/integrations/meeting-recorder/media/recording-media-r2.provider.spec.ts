import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { RecordingMediaStorageService } from './recording-media-storage.service'

function env(primary: string, fallback: string): string | undefined {
  return process.env[primary] ?? process.env[fallback]
}

const endpoint = env('MEETING_RECORDER_MEDIA_S3_ENDPOINT', 'S3_ENDPOINT')
const bucket = env('MEETING_RECORDER_MEDIA_S3_BUCKET', 'S3_BUCKET')
const accessKeyId = env('MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID')
const secretAccessKey = env('MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY')
const hasR2Credentials = Boolean(endpoint && bucket && accessKeyId && secretAccessKey)

describe.skipIf(!hasR2Credentials)('Meeting Recorder media — real Cloudflare R2', () => {
  it('SR-M-1: signed Content-Length rejects an oversized UploadPart at the provider boundary', async () => {
    const values: Record<string, unknown> = {
      MEETING_RECORDER_MEDIA_S3_ENDPOINT: endpoint,
      MEETING_RECORDER_MEDIA_S3_BUCKET: bucket,
      MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID: accessKeyId,
      MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY: secretAccessKey,
      MEETING_RECORDER_MEDIA_S3_REGION: 'auto',
      MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE: false,
      MEETING_RECORDER_MEDIA_S3_USE_SSE: false,
      MEETING_RECORDER_MEDIA_PART_URL_TTL_SECONDS: 900,
    }
    const config = { get: (name: string) => values[name] }
    const storage = new RecordingMediaStorageService(config as never)
    const key = `meeting-recordings/r2-verification/${randomUUID()}/${randomUUID()}`
    const uploadId = await storage.begin(key, 'video/webm')

    try {
      const signed = await storage.signPart(key, uploadId, 1, 5)

      const oversized = await fetch(signed.url, {
        method: 'PUT',
        body: Buffer.from('123456'),
      })
      expect(oversized.status).toBe(403)

      const exact = await fetch(signed.url, {
        method: 'PUT',
        body: Buffer.from('12345'),
      })
      expect(exact.status).toBe(200)
    } finally {
      await storage.abort(key, uploadId)
    }
  }, 30_000)
})
