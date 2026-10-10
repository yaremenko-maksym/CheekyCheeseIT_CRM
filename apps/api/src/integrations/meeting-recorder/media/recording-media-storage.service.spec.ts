import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
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
  it('fails when the provider does not return a multipart upload id', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({})

    await expect(service.begin('meeting-recordings/a', 'video/webm')).rejects.toMatchObject({
      status: 503,
      message: 'MEDIA_STORAGE_UNAVAILABLE',
    })
  })

  it('reads media-specific storage configuration with the exact inferred keys', () => {
    const values: Record<string, unknown> = {
      MEETING_RECORDER_MEDIA_S3_BUCKET: 'private-media',
      MEETING_RECORDER_MEDIA_S3_USE_SSE: true,
      MEETING_RECORDER_MEDIA_PART_URL_TTL_SECONDS: 901,
      MEETING_RECORDER_MEDIA_PLAYBACK_URL_TTL_SECONDS: 1801,
      MEETING_RECORDER_MEDIA_S3_ENDPOINT: 'https://media.example.test',
      MEETING_RECORDER_MEDIA_S3_REGION: 'auto',
      MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE: true,
      MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID: 'media-key',
      MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY: 'media-secret',
    }
    const get = vi.fn((name: string) => values[name])

    new RecordingMediaStorageService({ get } as never)

    expect(get.mock.calls).toEqual(
      [
        'MEETING_RECORDER_MEDIA_S3_BUCKET',
        'MEETING_RECORDER_MEDIA_S3_USE_SSE',
        'MEETING_RECORDER_MEDIA_PART_URL_TTL_SECONDS',
        'MEETING_RECORDER_MEDIA_PLAYBACK_URL_TTL_SECONDS',
        'MEETING_RECORDER_MEDIA_S3_ENDPOINT',
        'MEETING_RECORDER_MEDIA_S3_REGION',
        'MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE',
        'MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID',
        'MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY',
      ].map((key) => [key, { infer: true }]),
    )
  })

  it('reads the exact shared storage fallback keys when media-specific settings are absent', () => {
    const values: Record<string, unknown> = {
      S3_BUCKET: 'shared-media',
      S3_USE_SSE: true,
      S3_ENDPOINT: 'https://storage.example.test',
      S3_REGION: 'eu-central-1',
      S3_FORCE_PATH_STYLE: false,
      AWS_ACCESS_KEY_ID: 'shared-key',
      AWS_SECRET_ACCESS_KEY: 'shared-secret',
    }
    const get = vi.fn((name: string) => values[name])

    new RecordingMediaStorageService({ get } as never)

    expect(get.mock.calls).toEqual(
      [
        'MEETING_RECORDER_MEDIA_S3_BUCKET',
        'S3_BUCKET',
        'MEETING_RECORDER_MEDIA_S3_USE_SSE',
        'S3_USE_SSE',
        'MEETING_RECORDER_MEDIA_PART_URL_TTL_SECONDS',
        'MEETING_RECORDER_MEDIA_PLAYBACK_URL_TTL_SECONDS',
        'MEETING_RECORDER_MEDIA_S3_ENDPOINT',
        'S3_ENDPOINT',
        'MEETING_RECORDER_MEDIA_S3_REGION',
        'S3_REGION',
        'MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE',
        'S3_FORCE_PATH_STYLE',
        'MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID',
        'AWS_ACCESS_KEY_ID',
        'MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY',
        'AWS_SECRET_ACCESS_KEY',
      ].map((key) => [key, { infer: true }]),
    )
  })

  it('uses the exact default URL lifetimes and returned expiry timestamps', async () => {
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
    const before = Date.now()
    const part = await service.signPart('meeting-recordings/a', 'upload-a', 1)
    const playback = await service.playback('meeting-recordings/a', 'video/webm')
    const after = Date.now()

    expect(new URL(part.url).searchParams.get('X-Amz-Expires')).toBe('900')
    expect(Date.parse(part.expiresAt)).toBeGreaterThanOrEqual(before + 900_000)
    expect(Date.parse(part.expiresAt)).toBeLessThanOrEqual(after + 900_000)
    expect(new URL(playback.url).searchParams.get('X-Amz-Expires')).toBe('1800')
    expect(Date.parse(playback.expiresAt)).toBeGreaterThanOrEqual(before + 1_800_000)
    expect(Date.parse(playback.expiresAt)).toBeLessThanOrEqual(after + 1_800_000)
  })

  it('adds SSE only when storage configuration enables it', async () => {
    const get = vi.fn(
      (name: string) =>
        ({
          S3_BUCKET: 'test-bucket',
          S3_USE_SSE: true,
          S3_ENDPOINT: 'https://storage.example.test',
          S3_REGION: 'auto',
          S3_FORCE_PATH_STYLE: true,
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
        })[name as 'S3_BUCKET'],
    )
    const service = new RecordingMediaStorageService({ get } as never)
    const send = vi.fn().mockResolvedValue({ UploadId: 'provider-upload' })
    Object.assign(service, { client: { send } })

    await service.begin('meeting-recordings/a', 'video/webm')

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CreateMultipartUploadCommand)
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'meeting-recordings/a',
      ContentType: 'video/webm',
      CacheControl: 'private, no-store',
      ServerSideEncryption: 'AES256',
    })
  })

  it('bounds every provider network request, including calls made under lifecycle locks', async () => {
    const { service, send } = fixture()
    send
      .mockResolvedValueOnce({ UploadId: 'provider-upload' })
      .mockResolvedValueOnce({ Parts: [], IsTruncated: false })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 5, ContentType: 'video/webm' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Uploads: [], IsTruncated: false })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false })

    await expect(service.begin('meeting-recordings/a', 'video/webm')).resolves.toBe(
      'provider-upload',
    )
    await expect(service.listParts('meeting-recordings/a', 'provider-upload')).resolves.toEqual([])
    await expect(
      service.complete('meeting-recordings/a', 'provider-upload', [
        { partNumber: 1, etag: 'etag-1' },
      ]),
    ).resolves.toBeUndefined()
    await expect(service.head('meeting-recordings/a')).resolves.toEqual({
      bytes: 5,
      mimeType: 'video/webm',
    })
    await expect(service.abort('meeting-recordings/a', 'provider-upload')).resolves.toBeUndefined()
    await expect(service.listOpenMediaUploads()).resolves.toEqual([])
    await expect(service.listMediaObjects()).resolves.toEqual([])

    expect(send.mock.calls.map((call) => call[0]?.constructor)).toEqual([
      CreateMultipartUploadCommand,
      ListPartsCommand,
      CompleteMultipartUploadCommand,
      HeadObjectCommand,
      AbortMultipartUploadCommand,
      ListMultipartUploadsCommand,
      ListObjectsV2Command,
    ])
    for (const call of send.mock.calls) {
      const options = call[1] as { abortSignal?: AbortSignal } | undefined
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
      expect(options?.abortSignal?.aborted).toBe(false)
    }
  })

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

  it('probes upload origin with the fixed discovery transfer coordinates', async () => {
    const { service } = fixture()
    const signPart = vi.spyOn(service, 'signPart').mockResolvedValue({
      method: 'PUT',
      url: 'https://bucket.example.test/upload',
      headers: {},
      expiresAt: '2026-10-10T10:15:00.000Z',
    })

    await expect(service.uploadOrigin()).resolves.toBe('https://bucket.example.test')
    expect(signPart).toHaveBeenCalledWith('meeting-recordings/discovery', 'discovery', 1)
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

  it.each([
    'http://bucket.example.test/upload',
    'https://user@bucket.example.test/upload',
    'https://user:secret@bucket.example.test/upload',
  ])('refuses an unsafe upload origin from %s', async (url) => {
    const { service } = fixture()
    vi.spyOn(service, 'signPart').mockResolvedValue({
      method: 'PUT',
      url,
      headers: {},
      expiresAt: '2026-10-10T10:15:00.000Z',
    })

    await expect(service.uploadOrigin()).resolves.toBeNull()
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

  it('treats an omitted provider part list as an empty page', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ IsTruncated: false })
    await expect(service.listParts('opaque-key', 'opaque-upload')).resolves.toEqual([])
  })

  it('sorts provider parts by part number instead of trusting provider order', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({
      Parts: [
        { PartNumber: 2, ETag: 'etag-2', Size: 7 },
        { PartNumber: 1, ETag: 'etag-1', Size: 5 },
      ],
      IsTruncated: false,
    })

    await expect(service.listParts('opaque-key', 'opaque-upload')).resolves.toEqual([
      { partNumber: 1, etag: 'etag-1', bytes: 5 },
      { partNumber: 2, etag: 'etag-2', bytes: 7 },
    ])
  })

  it.each([
    [{ PartNumber: 0, ETag: 'etag-1', Size: 5 }, 'zero part number'],
    [{ PartNumber: 1, ETag: '', Size: 5 }, 'empty etag'],
    [{ PartNumber: 1, ETag: 'etag-1', Size: 0 }, 'zero size'],
    [{ PartNumber: 1, ETag: 'etag-1', Size: 1.5 }, 'fractional size'],
  ])('rejects a provider part with %s (%s)', async (part) => {
    const { service, send } = fixture()
    send.mockResolvedValue({ Parts: [part], IsTruncated: false })
    await expect(service.listParts('opaque-key', 'opaque-upload')).rejects.toMatchObject({
      status: 503,
    })
  })

  it('rejects a truncated ListParts page without a next marker immediately', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ Parts: [], IsTruncated: true })
    await expect(service.listParts('opaque-key', 'opaque-upload')).rejects.toMatchObject({
      status: 503,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects a repeated ListParts marker before requesting a third page', async () => {
    const { service, send } = fixture()
    send
      .mockResolvedValueOnce({ Parts: [], IsTruncated: true, NextPartNumberMarker: 1 })
      .mockResolvedValueOnce({ Parts: [], IsTruncated: true, NextPartNumberMarker: 1 })
    await expect(service.listParts('opaque-key', 'opaque-upload')).rejects.toMatchObject({
      status: 503,
    })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends the exact provider multipart-completion manifest', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({})
    await service.complete('meeting-recordings/a', 'provider-upload', [
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 1, etag: 'etag-1' },
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand)
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'meeting-recordings/a',
      UploadId: 'provider-upload',
      MultipartUpload: {
        Parts: [
          { PartNumber: 2, ETag: 'etag-2' },
          { PartNumber: 1, ETag: 'etag-1' },
        ],
      },
    })
  })

  it('sends the exact HEAD request and validates both required metadata fields', async () => {
    const { service, send } = fixture()
    send.mockResolvedValueOnce({ ContentLength: 5, ContentType: 'video/webm' })
    await expect(service.head('meeting-recordings/a')).resolves.toEqual({
      bytes: 5,
      mimeType: 'video/webm',
    })
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand)
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'meeting-recordings/a',
    })

    send.mockResolvedValueOnce({ ContentType: 'video/webm' })
    await expect(service.head('meeting-recordings/a')).rejects.toMatchObject({ status: 503 })
    send.mockResolvedValueOnce({ ContentLength: 5, ContentType: '' })
    await expect(service.head('meeting-recordings/a')).rejects.toMatchObject({ status: 503 })
  })

  it.each([
    { name: 'NotFound' },
    { name: 'NoSuchKey' },
    { name: 'Other', $metadata: { httpStatusCode: 404 } },
  ])('maps object-not-found provider errors to null (%j)', async (error) => {
    const { service, send } = fixture()
    send.mockRejectedValue(error)
    await expect(service.head('meeting-recordings/a')).resolves.toBeNull()
  })

  it('sanitizes non-not-found HEAD errors', async () => {
    const { service, send } = fixture()
    send.mockRejectedValue(new Error('provider details'))
    await expect(service.head('meeting-recordings/a')).rejects.toMatchObject({
      status: 503,
      message: 'MEDIA_STORAGE_UNAVAILABLE',
    })
  })

  it.each([undefined, null])('sanitizes primitive HEAD failures (%j)', async (error) => {
    const { service, send } = fixture()
    send.mockRejectedValue(error)
    await expect(service.head('meeting-recordings/a')).rejects.toMatchObject({
      status: 503,
      message: 'MEDIA_STORAGE_UNAVAILABLE',
    })
  })

  it('pins playback response headers in the presigned request', async () => {
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
    const playback = await service.playback('meeting-recordings/a', 'video/webm')
    const url = new URL(playback.url)
    expect(url.searchParams.get('response-content-type')).toBe('video/webm')
    expect(url.searchParams.get('response-content-disposition')).toBe('inline')
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store')
  })

  it('sends the exact provider multipart-abort request', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({})
    await service.abort('meeting-recordings/a', 'provider-upload')
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(AbortMultipartUploadCommand)
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'meeting-recordings/a',
      UploadId: 'provider-upload',
    })
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

  it('treats an omitted multipart upload list as empty', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ IsTruncated: false })
    await expect(service.listOpenMediaUploads()).resolves.toEqual([])
  })

  it('skips malformed multipart-upload rows instead of treating them as abortable work', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({
      Uploads: [
        { UploadId: 'missing-key', Initiated: new Date() },
        { Key: 'meeting-recordings/a/no-id', Initiated: new Date() },
        { Key: 'meeting-recordings/a/no-date', UploadId: 'no-date' },
        { Key: 'meeting-recordings/a/bad-date', UploadId: 'bad-date', Initiated: new Date(NaN) },
      ],
      IsTruncated: false,
    })
    await expect(service.listOpenMediaUploads()).resolves.toEqual([])
  })

  it('rejects multipart pagination without a next key immediately', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ Uploads: [], IsTruncated: true })
    await expect(service.listOpenMediaUploads()).rejects.toMatchObject({ status: 503 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects an unchanged multipart pagination pair before a third request', async () => {
    const { service, send } = fixture()
    send
      .mockResolvedValueOnce({
        Uploads: [],
        IsTruncated: true,
        NextKeyMarker: 'same',
        NextUploadIdMarker: 'same-upload',
      })
      .mockResolvedValueOnce({
        Uploads: [],
        IsTruncated: true,
        NextKeyMarker: 'same',
        NextUploadIdMarker: 'same-upload',
      })
    await expect(service.listOpenMediaUploads()).rejects.toMatchObject({ status: 503 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['same', 'upload-1', 'same', 'upload-2'],
    ['key-1', 'same-upload', 'key-2', 'same-upload'],
  ])(
    'accepts multipart pagination when at least one marker advances',
    async (firstKey, firstUpload, secondKey, secondUpload) => {
      const { service, send } = fixture()
      send
        .mockResolvedValueOnce({
          Uploads: [],
          IsTruncated: true,
          NextKeyMarker: firstKey,
          NextUploadIdMarker: firstUpload,
        })
        .mockResolvedValueOnce({
          Uploads: [],
          IsTruncated: true,
          NextKeyMarker: secondKey,
          NextUploadIdMarker: secondUpload,
        })
        .mockResolvedValueOnce({ Uploads: [], IsTruncated: false })
      await expect(service.listOpenMediaUploads()).resolves.toEqual([])
      expect(send).toHaveBeenCalledTimes(3)
    },
  )

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

  it('treats an omitted completed-object list as empty', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ IsTruncated: false })
    await expect(service.listMediaObjects()).resolves.toEqual([])
  })

  it('skips malformed completed-object rows during orphan inventory', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({
      Contents: [
        { Size: 1, LastModified: new Date() },
        { Key: 'meeting-recordings/a/no-date', Size: 1 },
        { Key: 'meeting-recordings/a/bad-date', Size: 1, LastModified: new Date(NaN) },
        { Key: 'meeting-recordings/a/fraction', Size: 1.5, LastModified: new Date() },
        { Key: 'meeting-recordings/a/negative', Size: -1, LastModified: new Date() },
      ],
      IsTruncated: false,
    })
    await expect(service.listMediaObjects()).resolves.toEqual([])
  })

  it('preserves a zero-byte completed object in inventory', async () => {
    const { service, send } = fixture()
    const lastModified = new Date('2026-10-01T00:00:00Z')
    send.mockResolvedValue({
      Contents: [{ Key: 'meeting-recordings/a/empty', Size: 0, LastModified: lastModified }],
      IsTruncated: false,
    })
    await expect(service.listMediaObjects()).resolves.toEqual([
      { key: 'meeting-recordings/a/empty', bytes: 0, lastModified },
    ])
  })

  it('rejects completed-object pagination without a next token immediately', async () => {
    const { service, send } = fixture()
    send.mockResolvedValue({ Contents: [], IsTruncated: true })
    await expect(service.listMediaObjects()).rejects.toMatchObject({ status: 503 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects a repeated completed-object token before requesting a third page', async () => {
    const { service, send } = fixture()
    send
      .mockResolvedValueOnce({ Contents: [], IsTruncated: true, NextContinuationToken: 'same' })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: true, NextContinuationToken: 'same' })
    await expect(service.listMediaObjects()).rejects.toMatchObject({ status: 503 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, null, 'provider failed', { name: 'OtherError' }])(
    'sanitizes non-NoSuchUpload provider failures (%j)',
    async (error) => {
      const { service, send } = fixture()
      send.mockRejectedValue(error)
      await expect(service.listParts('opaque-key', 'opaque-upload')).rejects.toMatchObject({
        status: 503,
        message: 'MEDIA_STORAGE_UNAVAILABLE',
      })
    },
  )

  it('uses a fresh 30-second abort deadline for provider calls', async () => {
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const { service } = fixture()
    const options = (
      service as unknown as { providerRequestOptions(): { abortSignal: AbortSignal } }
    ).providerRequestOptions()
    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(options).toEqual({ abortSignal: signal })
    timeout.mockRestore()
  })
})
