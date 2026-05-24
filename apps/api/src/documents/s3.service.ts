/**
 * S3Service — thin abstraction over @aws-sdk/client-s3 for the documents module.
 *
 * Why this lives separately from DocumentsService:
 *  - lets us unit-test compression / RBAC / DB writes without spinning up S3
 *  - centralizes the Cache-Control + SSE headers so every upload is consistent
 *  - hides the AWS SDK behind a small surface (upload / presign / delete)
 *
 * Cache strategy: every object ships with `Cache-Control: public, max-age=
 * 31536000, immutable`. s3_key is derived from a fresh UUID per upload, so
 * the browser can cache a presigned URL's response for a full year without
 * ever fetching stale bytes — re-uploading produces a new key + new presigned
 * URL. See pm-brief.md "Caching strategy" for the full reasoning.
 *
 * Presigned URL TTL is 24h (86400s, see DEFAULT_PRESIGN_TTL_SEC). Browser
 * cache + immutable Cache-Control means a single real S3 GET per document
 * per browser session per day.
 *
 * SSE: AWS S3 SSE-S3 (AES-256, free) is enabled by default in prod. In dev
 * (MinIO) we still send the header — MinIO ignores it gracefully.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Env } from '../config/env'

/**
 * Default presigned URL TTL. 24 hours (86400 sec) — paired with the immutable
 * Cache-Control header above, this gives the browser a full day before it
 * needs a fresh signed URL. TanStack Query is configured with a 4h staleTime
 * for the download-url query so the round-trip is rare.
 */
export const DEFAULT_PRESIGN_TTL_SEC = 24 * 60 * 60

export interface PresignedDownloadResult {
  url: string
  expiresAt: string
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name)
  private readonly client: S3Client
  private readonly bucket: string
  private readonly useSse: boolean

  constructor(private readonly config: ConfigService<Env, true>) {
    const endpoint = this.config.get('S3_ENDPOINT', { infer: true })
    const region = this.config.get('S3_REGION', { infer: true })
    const forcePathStyle = this.config.get('S3_FORCE_PATH_STYLE', { infer: true })
    const accessKeyId = this.config.get('AWS_ACCESS_KEY_ID', { infer: true })
    const secretAccessKey = this.config.get('AWS_SECRET_ACCESS_KEY', { infer: true })
    this.bucket = this.config.get('S3_BUCKET', { infer: true })
    this.useSse = this.config.get('S3_USE_SSE', { infer: true })

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    })
  }

  /**
   * Upload a buffer to S3 under `key`. Sets immutable cache headers + SSE-S3.
   * Throws on any S3 error — caller (DocumentsService) must compensate (delete
   * the DB row) when this rejects.
   */
  async upload(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        // 1 year, immutable — see header comment
        CacheControl: 'public, max-age=31536000, immutable',
        ...(this.useSse ? { ServerSideEncryption: 'AES256' as const } : {}),
      }),
    )
  }

  /**
   * Return a presigned GET URL (default TTL 24h). Caller passes its own ttl
   * for tests; production paths always use the default.
   */
  async getPresignedDownloadUrl(
    key: string,
    ttlSec: number = DEFAULT_PRESIGN_TTL_SEC,
  ): Promise<PresignedDownloadResult> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    })
    const url = await getSignedUrl(this.client, command, { expiresIn: ttlSec })
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString()
    return { url, expiresAt }
  }

  /**
   * Delete an object. Idempotent: S3 returns 204 even when the key is
   * missing, so the only swallowed errors here are network-level. The
   * documents service uses this from the hard-delete endpoint.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )
    } catch (err) {
      // S3 / MinIO already return 204 for missing keys, so a thrown error
      // here is usually transport-level. Log and swallow — the DB delete
      // still proceeds. ADMIN can re-run hard-delete which will exit early
      // (row already gone) without retrying S3.
      this.logger.warn(
        `S3 delete failed for key="${key}": ${(err as Error).message}`,
      )
    }
  }

  /**
   * Exposed for unit tests that need to assert the bucket name without
   * reading env directly.
   */
  getBucket(): string {
    return this.bucket
  }
}
