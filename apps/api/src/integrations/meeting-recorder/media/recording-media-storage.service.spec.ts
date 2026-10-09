import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'

import { RecordingMediaStorageService } from './recording-media-storage.service'

function fixture() {
  const config = {
    get: (name: string) =>
      ({
        S3_BUCKET: 'test-bucket',
        S3_USE_SSE: false,
        S3_ENDPOINT: 'https://storage.example.test',
        S3_REGION: 'auto',
        S3_FORCE_PATH_STYLE: true,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      })[name as 'S3_BUCKET'],
  }
  const service = new RecordingMediaStorageService(config as never)
  const send = vi.fn()
  Object.assign(service, { client: { send } })
  return { service, send }
}

describe('media provider part verification', () => {
  it('falls back to the shared S3 configuration when media-specific settings are absent', async () => {
    const config = {
      get: (name: string) =>
        ({
          S3_BUCKET: 'shared-media',
          S3_USE_SSE: false,
          S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
          S3_REGION: 'auto',
          S3_FORCE_PATH_STYLE: false,
          AWS_ACCESS_KEY_ID: 'shared-key',
          AWS_SECRET_ACCESS_KEY: 'shared-secret',
        })[name as 'S3_BUCKET'],
    }
    const service = new RecordingMediaStorageService(config as never)

    const origin = await service.uploadOrigin()

    expect(origin).toBe('https://shared-media.abc123.r2.cloudflarestorage.com')
  })

  it('uses an isolated media S3 configuration when it is provided', async () => {
    const config = {
      get: (name: string) =>
        ({
          S3_BUCKET: 'documents',
          S3_USE_SSE: true,
          S3_ENDPOINT: 'https://documents.example.test',
          S3_REGION: 'eu-central-1',
          S3_FORCE_PATH_STYLE: true,
          AWS_ACCESS_KEY_ID: 'documents-key',
          AWS_SECRET_ACCESS_KEY: 'documents-secret',
          MEETING_RECORDER_MEDIA_S3_BUCKET: 'private-media',
          MEETING_RECORDER_MEDIA_S3_USE_SSE: false,
          MEETING_RECORDER_MEDIA_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
          MEETING_RECORDER_MEDIA_S3_REGION: 'auto',
          MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE: false,
          MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID: 'media-key',
          MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY: 'media-secret',
        })[name as 'S3_BUCKET'],
    }
    const service = new RecordingMediaStorageService(config as never)

    const origin = await service.uploadOrigin()

    expect(origin).toBe('https://private-media.abc123.r2.cloudflarestorage.com')
  })

  it('presigns R2 URLs on a hostname allowed by the production media CSP', async () => {
    const config = {
      get: (name: string) =>
        ({
          S3_BUCKET: 'private-media',
          S3_USE_SSE: false,
          S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
          S3_REGION: 'auto',
          S3_FORCE_PATH_STYLE: false,
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
        })[name as 'S3_BUCKET'],
    }
    const service = new RecordingMediaStorageService(config as never)

    const origin = await service.uploadOrigin()

    expect(origin).not.toBeNull()
    expect(new URL(origin!).protocol).toBe('https:')
    expect(new URL(origin!).hostname).toMatch(/\.r2\.cloudflarestorage\.com$/)
  })

  it('uses validated media URL lifetime overrides when configured', async () => {
    const config = {
      get: (name: string) =>
        ({
          S3_BUCKET: 'private-media',
          S3_USE_SSE: false,
          S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
          S3_REGION: 'auto',
          S3_FORCE_PATH_STYLE: false,
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          MEETING_RECORDER_MEDIA_PART_URL_TTL_SECONDS: 2,
          MEETING_RECORDER_MEDIA_PLAYBACK_URL_TTL_SECONDS: 3,
        })[name as 'S3_BUCKET'],
    }
    const service = new RecordingMediaStorageService(config as never)

    const part = await service.signPart('meeting-recordings/a', 'opaque-upload', 1)
    const playback = await service.playback('meeting-recordings/a', 'video/webm')

    expect(new URL(part.url).searchParams.get('X-Amz-Expires')).toBe('2')
    expect(new URL(playback.url).searchParams.get('X-Amz-Expires')).toBe('3')
  })

  it('retains provider-reported sizes across multipart ListParts pages', async () => {
    const { service, send } = fixture()
    send
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, ETag: 'etag-1', Size: 5 }],
        IsTruncated: true,
        NextPartNumberMarker: 1,
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, ETag: 'etag-2', Size: 7 }],
        IsTruncated: false,
      })
    await expect(service.listParts('opaque-key', 'opaque-upload')).resolves.toEqual([
      { partNumber: 1, etag: 'etag-1', bytes: 5 },
      { partNumber: 2, etag: 'etag-2', bytes: 7 },
    ])
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListPartsCommand)
    expect(send.mock.calls[1]?.[0].input.PartNumberMarker).toBe('1')
  })

  it('maps a missing provider multipart upload to an expirable client attempt', async () => {
    const { service, send } = fixture()
    send.mockRejectedValue({ name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } })
    await expect(service.listParts('opaque-key', 'missing-upload')).rejects.toMatchObject({
      status: 410,
      response: { code: 'MEDIA_UPLOAD_EXPIRED' },
    })
  })

  it('rejects provider manifests without trustworthy size metadata', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ Parts: [{ PartNumber: 1, ETag: 'etag-1' }], IsTruncated: false })
    await expect(service.listParts('opaque-key', 'opaque-upload')).rejects.toMatchObject({
      status: 503,
    })
  })

  it('enumerates only the dedicated meeting-recordings multipart prefix across pages', async () => {
    const { service, send } = fixture()
    const first = new Date('2026-10-01T00:00:00Z')
    const second = new Date('2026-10-02T00:00:00Z')
    send
      .mockResolvedValueOnce({
        Uploads: [
          { Key: 'meeting-recordings/a/one', UploadId: 'upload-1', Initiated: first },
          { Key: 'documents/resume.pdf', UploadId: 'document-upload', Initiated: first },
        ],
        IsTruncated: true,
        NextKeyMarker: 'meeting-recordings/a/one',
        NextUploadIdMarker: 'upload-1',
      })
      .mockResolvedValueOnce({
        Uploads: [{ Key: 'meeting-recordings/a/two', UploadId: 'upload-2', Initiated: second }],
        IsTruncated: false,
      })

    await expect(service.listOpenMediaUploads()).resolves.toEqual([
      { key: 'meeting-recordings/a/one', uploadId: 'upload-1', initiatedAt: first },
      { key: 'meeting-recordings/a/two', uploadId: 'upload-2', initiatedAt: second },
    ])
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListMultipartUploadsCommand)
    expect(send.mock.calls[0]?.[0].input.Prefix).toBe('meeting-recordings/')
    expect(send.mock.calls[1]?.[0].input.KeyMarker).toBe('meeting-recordings/a/one')
    expect(send.mock.calls[1]?.[0].input.UploadIdMarker).toBe('upload-1')
  })

  it('lists completed media objects across provider pages for read-only orphan reporting', async () => {
    const { service, send } = fixture()
    const first = new Date('2026-10-01T00:00:00Z')
    const second = new Date('2026-10-02T00:00:00Z')
    send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'meeting-recordings/a/one', Size: 5, LastModified: first },
          { Key: 'documents/not-media', Size: 9, LastModified: first },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'meeting-recordings/a/two', Size: 7, LastModified: second }],
        IsTruncated: false,
      })

    await expect(service.listMediaObjects()).resolves.toEqual([
      { key: 'meeting-recordings/a/one', bytes: 5, lastModified: first },
      { key: 'meeting-recordings/a/two', bytes: 7, lastModified: second },
    ])
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectsV2Command)
    expect(send.mock.calls[0]?.[0].input.Prefix).toBe('meeting-recordings/')
    expect(send.mock.calls[1]?.[0].input.ContinuationToken).toBe('page-2')
  })
})
