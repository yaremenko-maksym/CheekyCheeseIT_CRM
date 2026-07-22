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
 * SSE: Controlled by S3_USE_SSE env flag (default false).
 *   S3_USE_SSE=true  — AWS S3: sends ServerSideEncryption: AES256 on every PutObject.
 *   S3_USE_SSE=false — MinIO (dev) and Cloudflare R2 (prod): header is omitted.
 *     MinIO ignores SSE-S3 without a KMS backend; R2 rejects the header entirely
 *     because it does not implement the SSE-S3 protocol. Both providers encrypt
 *     data at rest by default, so omitting the header is safe and correct.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { DocumentCategory } from '@crm/shared'
import type { Env } from '../config/env'

/**
 * Default presigned URL TTL. 24 hours (86400 sec) — used for non-sensitive
 * categories (AVATAR, LOGO). TanStack Query is configured with a 4h staleTime
 * for download-url queries so the round-trip is rare.
 */
export const DEFAULT_PRESIGN_TTL_SEC = 24 * 60 * 60

/**
 * Short TTL (30 minutes) for sensitive document categories.
 * Applied to: CONTRACT, RECEIPT, INVOICE, RESUME, SCAN.
 * AVATAR and LOGO are low-sensitivity (no PII beyond the image itself) and
 * keep the default 24h TTL for a smoother UX (profile pictures, project logos).
 */
export const SENSITIVE_PRESIGN_TTL_SEC = 30 * 60

/**
 * Categories that require a short presigned URL TTL for security reasons.
 * These contain PII or financial data that should not remain accessible
 * via a link for more than 30 minutes.
 */
const SENSITIVE_CATEGORIES = new Set<DocumentCategory>([
  'CONTRACT',
  'RECEIPT',
  'INVOICE',
  'RESUME',
  'SCAN',
])

/**
 * Returns the presigned URL TTL in seconds for the given document category.
 * Sensitive categories use SENSITIVE_PRESIGN_TTL_SEC (30 min); others use
 * DEFAULT_PRESIGN_TTL_SEC (24h).
 */
export function presignTtlForCategory(category: DocumentCategory | null | undefined): number {
  if (category && SENSITIVE_CATEGORIES.has(category)) {
    return SENSITIVE_PRESIGN_TTL_SEC
  }
  return DEFAULT_PRESIGN_TTL_SEC
}

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
   * Content-Disposition header that pins the filename in the browser's save
   * dialog (so a file uploaded as "Договор Иванов.pdf" survives the ASCII-
   * only S3 key tail). The default disposition is **`inline`** — this lets
   * receipt previews (image / PDF) render directly inside `<img>` / `<iframe>`
   * / `<object>` tags instead of triggering an auto-download every time a
   * user opens a transaction detail dialog. Pass `disposition: 'attachment'`
   * when you want a real "Save as…" prompt (e.g. an explicit Download
   * button).
   */
  async getPresignedDownloadUrl(
    key: string,
    ttlSec: number | undefined = DEFAULT_PRESIGN_TTL_SEC,
    downloadAs?: string | undefined,
    disposition: 'inline' | 'attachment' = 'inline',
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
            ResponseContentDisposition: `${disposition}; filename="${this.asciiFallback(downloadAs)}"; filename*=UTF-8''${encodeURIComponent(downloadAs)}`,
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
   * Fetch an object's raw bytes. Used by trusted server code (InvoicesService)
   * that needs to compute a fresh SHA-256 of the currently stored invoice PDF
   * before accepting a counterparty signature — guards against the case where
   * a different process (or admin DB edit) replaced the document between
   * generation and sign.
   *
   * Throws on missing keys + transport-level errors; the caller decides how
   * to surface that to the API client (typically as a 409/500).
   */
  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
    // AWS SDK v3's Body is a streaming Readable; the SDK exposes
    // `transformToByteArray()` for convenience. We then wrap it in a Node
    // Buffer so it's compatible with the rest of the documents pipeline.
    if (!res.Body) {
      throw new Error(`S3 getObject returned empty body for key="${key}"`)
    }
    const bytes = await res.Body.transformToByteArray()
    return Buffer.from(bytes)
  }

  /**
   * Delete an object. Idempotent: S3 returns 204 even when the key is
   * missing, so the only swallowed errors here are network-level. The
   * documents service uses this from the hard-delete endpoint.
   *
   * "Best-effort, swallow" contract — use this when the CALLER has no
   * compensating action to take on a transport failure (the UI-facing
   * hard-delete flow: the DB row is already gone or about to go regardless,
   * and re-running hard-delete is always safe/idempotent). If your caller
   * NEEDS to react to a failed R2 delete (e.g. keep a DB row around so a
   * retry loop picks it up again), use `deleteOrThrow` instead — this method
   * will NEVER give you that signal, it always resolves.
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
      this.logger.warn(`S3 delete failed for key="${key}": ${(err as Error).message}`)
    }
  }

  /**
   * Delete an object, propagating transport-level failures to the caller
   * (sec MED-1 / task-fix-pr-390-round3 F1). ADDITIVE — `delete()` above and
   * all of its existing call sites are untouched.
   *
   * Use this instead of `delete()` for COMPENSATED pipelines, where the
   * caller has a real recovery action to take when the R2 delete fails —
   * e.g. `VacanciesRetentionCronService`: leave the DB row in place so the
   * next daily run retries the R2 delete, instead of orphaning an
   * unreferenced PII resume in R2 with nothing left driving a retry.
   * `delete()`'s "log and swallow" contract can never signal that failure to
   * a caller, which is exactly the bug this method fixes for that call site.
   *
   * Still idempotent for the missing-key case (S3/MinIO return 204/succeed
   * for a DeleteObject on a key that no longer exists) — only genuine
   * transport/API errors reject.
   */
  async deleteOrThrow(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
  }

  /**
   * List objects in the bucket with S3 ListObjectsV2 pagination.
   *
   * Returns one page of results per call. Pass `continuationToken` (from the
   * previous page's `nextContinuationToken`) to fetch subsequent pages. When
   * `nextContinuationToken` is undefined the caller has exhausted all objects.
   *
   * Used by DocumentsReconciliationService to enumerate the full bucket and
   * find orphan objects (keys that exist in S3 but have no matching row in
   * the `documents` table).
   *
   * Security: scoped to `Prefix: 'documents/'` so the reconciler can ONLY
   * see and potentially delete managed document objects. Backup directories,
   * CI artifacts, or anything uploaded outside the managed prefix are
   * invisible to this method — even when running on a shared bucket.
   */
  async listObjects(continuationToken?: string): Promise<{
    objects: Array<{ key: string; sizeBytes: number; lastModified: Date }>
    nextContinuationToken: string | undefined
  }> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: 'documents/',
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    )

    const objects = (res.Contents ?? [])
      .filter((item): item is typeof item & { Key: string } => item.Key !== undefined)
      .map((item) => ({
        key: item.Key,
        sizeBytes: item.Size ?? 0,
        lastModified: item.LastModified ?? new Date(0),
      }))

    return {
      objects,
      nextContinuationToken: res.NextContinuationToken,
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
