import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { Env } from '../../../config/env'

const PART_URL_TTL_SECONDS = 15 * 60
const PLAYBACK_URL_TTL_SECONDS = 30 * 60

export type UploadedMediaPart = { partNumber: number; etag: string }

/** S3/R2 implementation detail of the generic external-media protocol. No media bytes pass through CRM. */
@Injectable()
export class RecordingMediaStorageService {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly useSse: boolean

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true })
    this.useSse = config.get('S3_USE_SSE', { infer: true })
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('AWS_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', { infer: true }),
      },
    })
  }

  async begin(key: string, mimeType: string): Promise<string> {
    return this.safe(async () => {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: mimeType,
          CacheControl: 'private, no-store',
          ...(this.useSse ? { ServerSideEncryption: 'AES256' as const } : {}),
        }),
      )
      if (!result.UploadId) throw new Error('Missing provider upload ID')
      return result.UploadId
    })
  }

  /** Origin of presigned UploadPart URLs, including SDK virtual-host bucket rewriting. */
  async uploadOrigin(): Promise<string | null> {
    const signed = await this.signPart('meeting-recordings/discovery', 'discovery', 1)
    const url = new URL(signed.url)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null
  }

  async signPart(key: string, uploadId: string, partNumber: number) {
    return this.safe(async () => ({
      method: 'PUT' as const,
      url: await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: PART_URL_TTL_SECONDS },
      ),
      headers: {} as Record<string, string>,
      expiresAt: new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString(),
    }))
  }

  /** ListParts paginates at 1,000; resume and completion must see the entire provider manifest. */
  async listParts(key: string, uploadId: string): Promise<UploadedMediaPart[]> {
    return this.safe(async () => {
      const parts: UploadedMediaPart[] = []
      let marker: string | undefined
      do {
        const page = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        )
        for (const part of page.Parts ?? []) {
          if (!part.PartNumber || !part.ETag) throw new Error('Malformed provider part')
          parts.push({ partNumber: part.PartNumber, etag: part.ETag })
        }
        if (!page.IsTruncated) break
        const next = page.NextPartNumberMarker
        if (!next || String(next) === marker) throw new Error('Malformed provider pagination')
        marker = String(next)
      } while (true)
      return parts.sort((a, b) => a.partNumber - b.partNumber)
    })
  }

  async complete(key: string, uploadId: string, parts: UploadedMediaPart[]): Promise<void> {
    await this.safe(async () => {
      const completed: CompletedPart[] = parts.map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      }))
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: completed },
        }),
      )
    })
  }

  /** HEAD is authoritative after completion, including when the provider's reply was lost. */
  async head(key: string): Promise<{ bytes: number; mimeType: string } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      if (result.ContentLength === undefined || !result.ContentType) {
        throw new Error('Incomplete provider object metadata')
      }
      return { bytes: result.ContentLength, mimeType: result.ContentType }
    } catch (error: unknown) {
      if (isNotFound(error)) return null
      throw new ServiceUnavailableException('MEDIA_STORAGE_UNAVAILABLE')
    }
  }

  async playback(key: string, mimeType: string) {
    return this.safe(async () => ({
      url: await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentType: mimeType,
          ResponseContentDisposition: 'inline',
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: PLAYBACK_URL_TTL_SECONDS },
      ),
      expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SECONDS * 1000).toISOString(),
    }))
  }

  async abort(key: string, uploadId: string): Promise<void> {
    await this.safe(async () => {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      )
    })
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      // The SDK can include presigned URLs, bucket keys and provider credentials in error text.
      throw new ServiceUnavailableException('MEDIA_STORAGE_UNAVAILABLE')
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  )
}
