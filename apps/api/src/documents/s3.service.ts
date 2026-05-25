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
   *
   * `downloadAs` (optional): when provided, the URL embeds a
   * Content-Disposition header that forces the browser to save the response
   * as the given filename instead of the raw S3 key tail. We use this so a
   * file uploaded as "Договор Иванов.pdf" (cyrillic) is saved under that
   * exact name even though the S3 key is ASCII-only ("Dogovor_Ivanov.pdf").
   */
  async getPresignedDownloadUrl(
    key: string,
    ttlSec: number | undefined = DEFAULT_PRESIGN_TTL_SEC,
    downloadAs?: string | undefined,
  ): Promise<PresignedDownloadResult> {
    const effectiveTtl = ttlSec ?? DEFAULT_PRESIGN_TTL_SEC
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(downloadAs
        ? {
            // RFC 5987 — `filename*=UTF-8''<percent-encoded>` lets us pass
            // cyrillic / unicode safely. We include a plain `filename=`
            // ASCII fallback for ancient clients (curl < 7.39, IE).
            ResponseContentDisposition: `attachment; filename="${this.asciiFallback(downloadAs)}"; filename*=UTF-8''${encodeURIComponent(downloadAs)}`,
          }
        : {}),
    })
    const url = await getSignedUrl(this.client, command, { expiresIn: effectiveTtl })
    const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString()
    return { url, expiresAt }
  }

  /**
   * Strip non-ASCII chars from a filename for the legacy `filename=` slot.
   * The `filename*=UTF-8''...` slot still carries the full name.
   */
  private asciiFallback(name: string): string {
    return name.replace(/[^\x20-\x7E]/g, '_')
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
