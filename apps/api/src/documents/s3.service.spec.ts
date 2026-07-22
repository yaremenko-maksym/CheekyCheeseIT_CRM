/**
 * S3Service — unit tests.
 *
 * We mock the @aws-sdk/client-s3 client.send() so the tests stay offline.
 * The interesting bits are:
 *   - PutObjectCommand always carries CacheControl + SSE headers
 *   - getPresignedDownloadUrl default TTL is 24h (86400 s)
 *   - delete() swallows errors (idempotency for the hard-delete flow)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ConfigService } from '@nestjs/config'
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { DEFAULT_PRESIGN_TTL_SEC, S3Service } from './s3.service'

// Hoisted mocks
const sendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return {
    ...real,
    S3Client: vi.fn(function () {
      return { send: sendSpy }
    }),
  }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlSpy(...args),
}))

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const env: Record<string, unknown> = {
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'crm-documents',
    S3_FORCE_PATH_STYLE: true,
    S3_USE_SSE: true,
    AWS_ACCESS_KEY_ID: 'minioadmin',
    AWS_SECRET_ACCESS_KEY: 'minioadmin',
    ...overrides,
  }
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService
}

beforeEach(() => {
  sendSpy.mockReset()
  getSignedUrlSpy.mockReset()
})

describe('S3Service.upload', () => {
  it('sends PutObjectCommand with immutable Cache-Control + SSE AES256', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue(undefined)

    await service.upload('documents/RESUME/x/y.jpg', Buffer.from('abc'), 'image/jpeg')

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const cmd = sendSpy.mock.calls[0]![0] as PutObjectCommand
    expect(cmd).toBeInstanceOf(PutObjectCommand)
    expect(cmd.input.Bucket).toBe('crm-documents')
    expect(cmd.input.Key).toBe('documents/RESUME/x/y.jpg')
    expect(cmd.input.ContentType).toBe('image/jpeg')
    expect(cmd.input.CacheControl).toBe('public, max-age=31536000, immutable')
    expect(cmd.input.ServerSideEncryption).toBe('AES256')
  })

  it('omits SSE when S3_USE_SSE=false (dev/MinIO opt-out)', async () => {
    const service = new S3Service(makeConfig({ S3_USE_SSE: false }))
    sendSpy.mockResolvedValue(undefined)

    await service.upload('k', Buffer.from('abc'), 'image/jpeg')
    const cmd = sendSpy.mock.calls[0]![0] as PutObjectCommand
    expect(cmd.input.ServerSideEncryption).toBeUndefined()
  })

  it('omits SSE when S3_USE_SSE=false (Cloudflare R2 prod path — R2 rejects SSE-S3 header)', async () => {
    // Cloudflare R2 does not implement the SSE-S3 protocol. Sending
    // ServerSideEncryption: 'AES256' to R2 results in an API error.
    // R2 encrypts all data at rest by default, so omitting the header
    // is both required for R2 compatibility and safe from a security standpoint.
    const service = new S3Service(
      makeConfig({
        S3_USE_SSE: false,
        S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
        S3_FORCE_PATH_STYLE: false,
      }),
    )
    sendSpy.mockResolvedValue(undefined)

    await service.upload('documents/RESUME/x/y.pdf', Buffer.from('pdf'), 'application/pdf')

    const cmd = sendSpy.mock.calls[0]![0] as PutObjectCommand
    expect(cmd.input.ServerSideEncryption).toBeUndefined()
    // Cache-Control must still be set regardless of SSE mode
    expect(cmd.input.CacheControl).toBe('public, max-age=31536000, immutable')
  })

  it('sends SSE AES256 when S3_USE_SSE=true (AWS S3 prod path)', async () => {
    const service = new S3Service(makeConfig({ S3_USE_SSE: true }))
    sendSpy.mockResolvedValue(undefined)

    await service.upload('documents/CONTRACT/x/y.pdf', Buffer.from('pdf'), 'application/pdf')

    const cmd = sendSpy.mock.calls[0]![0] as PutObjectCommand
    expect(cmd.input.ServerSideEncryption).toBe('AES256')
    expect(cmd.input.CacheControl).toBe('public, max-age=31536000, immutable')
  })
})

describe('S3Service.getPresignedDownloadUrl', () => {
  it('default TTL = 24h (86400 sec) and expiresAt aligns with now+TTL', async () => {
    const service = new S3Service(makeConfig())
    getSignedUrlSpy.mockResolvedValue('https://signed.example/key?sig=abc')

    const before = Date.now()
    const result = await service.getPresignedDownloadUrl('k')
    const after = Date.now()

    expect(result.url).toContain('signed.example')
    expect(getSignedUrlSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      expiresIn: DEFAULT_PRESIGN_TTL_SEC,
    })
    expect(DEFAULT_PRESIGN_TTL_SEC).toBe(24 * 60 * 60) // 86400 s

    const expiresMs = new Date(result.expiresAt).getTime()
    expect(expiresMs - before).toBeGreaterThanOrEqual(86_400_000 - 10)
    expect(expiresMs - after).toBeLessThanOrEqual(86_400_000 + 10)
  })

  it('caller can override TTL (used by tests / future short-lived flows)', async () => {
    const service = new S3Service(makeConfig())
    getSignedUrlSpy.mockResolvedValue('url')
    await service.getPresignedDownloadUrl('k', 300)
    expect(getSignedUrlSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      expiresIn: 300,
    })
  })

  it('downloadAs defaults to inline Content-Disposition (so receipt previews render in-browser instead of auto-downloading)', async () => {
    const service = new S3Service(makeConfig())
    getSignedUrlSpy.mockResolvedValue('url')

    // Simulate a cyrillic filename — the kind of thing variant 3 hybrid is for.
    await service.getPresignedDownloadUrl('k', undefined, 'Договор Иванов.pdf')

    const [, command] = getSignedUrlSpy.mock.calls[0]!
    const cd = (command as { input: { ResponseContentDisposition?: string } }).input
      .ResponseContentDisposition
    expect(cd).toBeDefined()
    // Default disposition is inline — fixes "PDF/receipt auto-downloads every
    // time SENIOR opens a transaction" regression.
    expect(cd).toContain('inline')
    expect(cd).not.toContain('attachment')
    // ASCII fallback: cyrillic stripped to underscores
    expect(cd).toContain('filename="')
    // RFC 5987 UTF-8 slot: percent-encoded original
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('Договор Иванов.pdf')}`)
  })

  it('explicit disposition="attachment" still forces a Save dialog (for dedicated download endpoints)', async () => {
    const service = new S3Service(makeConfig())
    getSignedUrlSpy.mockResolvedValue('url')

    await service.getPresignedDownloadUrl('k', undefined, 'invoice.pdf', 'attachment')

    const [, command] = getSignedUrlSpy.mock.calls[0]!
    const cd = (command as { input: { ResponseContentDisposition?: string } }).input
      .ResponseContentDisposition
    expect(cd).toBeDefined()
    expect(cd).toContain('attachment')
    expect(cd).toContain('filename="invoice.pdf"')
  })

  it('omits Content-Disposition when downloadAs is not provided', async () => {
    const service = new S3Service(makeConfig())
    getSignedUrlSpy.mockResolvedValue('url')
    await service.getPresignedDownloadUrl('k')
    const [, command] = getSignedUrlSpy.mock.calls[0]!
    expect(
      (command as { input: { ResponseContentDisposition?: string } }).input
        .ResponseContentDisposition,
    ).toBeUndefined()
  })
})

describe('S3Service.delete', () => {
  it('sends DeleteObjectCommand for the key', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue(undefined)
    await service.delete('k')
    const cmd = sendSpy.mock.calls[0]![0] as DeleteObjectCommand
    expect(cmd).toBeInstanceOf(DeleteObjectCommand)
    expect(cmd.input.Key).toBe('k')
  })

  it('swallows errors (idempotency — re-running hard-delete must not throw)', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockRejectedValue(new Error('NoSuchKey'))
    await expect(service.delete('k')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// F1 (task-fix-pr-390-round3 / MED-1): deleteOrThrow — additive, fail-loud
// sibling of delete(). Compensated pipelines (VacanciesRetentionCronService)
// need the reject signal delete() intentionally never gives them.
// ---------------------------------------------------------------------------

describe('S3Service.deleteOrThrow', () => {
  it('sends DeleteObjectCommand for the key', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue(undefined)
    await service.deleteOrThrow('k')
    const cmd = sendSpy.mock.calls[0]![0] as DeleteObjectCommand
    expect(cmd).toBeInstanceOf(DeleteObjectCommand)
    expect(cmd.input.Key).toBe('k')
  })

  it('resolves when the underlying send() succeeds (missing key is still a 204-style success)', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue(undefined)
    await expect(service.deleteOrThrow('missing-key')).resolves.toBeUndefined()
  })

  it('propagates transport errors — the opposite contract of delete() (MED-1 fix)', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockRejectedValue(new Error('R2 unreachable'))
    await expect(service.deleteOrThrow('k')).rejects.toThrow('R2 unreachable')
  })
})

// ---------------------------------------------------------------------------
// MED-A security hardening: listObjects must be scoped to 'documents/' prefix
// ---------------------------------------------------------------------------

describe('S3Service.listObjects — Prefix-scoped listing (MED-A)', () => {
  it('always sends ListObjectsV2Command with Prefix="documents/" regardless of continuation token', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue({ Contents: [], NextContinuationToken: undefined })

    await service.listObjects()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const cmd = sendSpy.mock.calls[0]![0] as ListObjectsV2Command
    expect(cmd).toBeInstanceOf(ListObjectsV2Command)
    expect(cmd.input.Prefix).toBe('documents/')
    expect(cmd.input.Bucket).toBe('crm-documents')
  })

  it('includes ContinuationToken when provided AND still scopes Prefix', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue({ Contents: [], NextContinuationToken: undefined })

    await service.listObjects('token-page-2')

    const cmd = sendSpy.mock.calls[0]![0] as ListObjectsV2Command
    expect(cmd.input.Prefix).toBe('documents/')
    expect(cmd.input.ContinuationToken).toBe('token-page-2')
  })

  it('maps returned Contents to { key, sizeBytes, lastModified } and omits items with no Key', async () => {
    const service = new S3Service(makeConfig())
    const now = new Date('2026-01-01T00:00:00Z')
    sendSpy.mockResolvedValue({
      Contents: [
        { Key: 'documents/RESUME/a.pdf', Size: 1024, LastModified: now },
        { Key: undefined, Size: 99 }, // must be filtered out
        { Key: 'documents/RECEIPT/b.jpg', Size: 2048, LastModified: now },
      ],
      NextContinuationToken: 'next-token',
    })

    const result = await service.listObjects()

    expect(result.objects).toHaveLength(2)
    expect(result.objects[0]).toEqual({
      key: 'documents/RESUME/a.pdf',
      sizeBytes: 1024,
      lastModified: now,
    })
    expect(result.objects[1]).toEqual({
      key: 'documents/RECEIPT/b.jpg',
      sizeBytes: 2048,
      lastModified: now,
    })
    expect(result.nextContinuationToken).toBe('next-token')
  })

  it('returns nextContinuationToken=undefined on the last page', async () => {
    const service = new S3Service(makeConfig())
    sendSpy.mockResolvedValue({ Contents: [], NextContinuationToken: undefined })

    const result = await service.listObjects()
    expect(result.nextContinuationToken).toBeUndefined()
  })
})
