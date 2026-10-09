import { ListPartsCommand } from '@aws-sdk/client-s3'
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
})
