/**
 * DocumentsReconciliationService — S3 orphan reconciliation.
 *
 * Background: when a document is replaced (replace-with-delete, PR-3) the old
 * S3 object is deleted AFTER the DB commit (`deleteS3Keys()` post-commit). If
 * the process crashes between commit and delete, an S3 object exists with no
 * matching `documents` row — an "orphan".
 *
 * This service finds and (optionally) removes orphans safely:
 *   1. Lists ALL objects in the bucket with full pagination.
 *   2. Loads all known s3Key + thumbnailS3Key values from the DB into a Set.
 *   3. Applies a grace window (default 48 h) — objects newer than that are
 *      never touched (in-flight uploads not yet committed to DB).
 *   4. dryRun=true (default): logs a summary and returns the report without
 *      deleting anything.
 *   5. dryRun=false: deletes each orphan via S3Service.delete and records
 *      the count in the report.
 *
 * Endpoint: POST /api/documents/reconcile-orphans (ADMIN only).
 * There is intentionally no cron / scheduled job in this PR — the destr-
 * uctive mode is only reachable via an explicit ADMIN API call.
 */
import { Injectable, Logger } from '@nestjs/common'
import { S3Service } from './s3.service'
import { DatabaseService } from '../database/database.service'
import { documents } from '../database/schema'

// ---------------------------------------------------------------------------
// Public types (re-exported for controller + shared schema wiring)
// ---------------------------------------------------------------------------

/** Single S3 object entry as returned by listObjects. */
export interface S3ObjectInfo {
  key: string
  sizeBytes: number
  lastModified: Date
}

/** Report returned by reconcileOrphans. Matches reconcileReportSchema in shared. */
export interface ReconcileReport {
  /** Total S3 objects scanned across all pages. */
  scannedObjects: number
  /** Total DB keys loaded (s3Key + non-null thumbnailS3Key). */
  dbKeys: number
  /** Objects that are orphans (not in DB and older than graceHours). */
  orphans: S3ObjectInfo[]
  /** Sum of orphan object sizes in bytes. */
  orphanBytes: number
  /** Number of objects actually deleted (0 when dryRun=true). */
  deleted: number
  /** Whether this was a dry run. */
  dryRun: boolean
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DocumentsReconciliationService {
  private readonly logger = new Logger(DocumentsReconciliationService.name)

  constructor(
    private readonly s3: S3Service,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Reconcile S3 orphans.
   *
   * @param opts.dryRun    When true (default) nothing is deleted.
   * @param opts.graceHours Objects modified within this many hours are skipped
   *                        regardless of DB presence. Default: 48.
   */
  async reconcileOrphans(opts: {
    dryRun?: boolean
    graceHours?: number
  }): Promise<ReconcileReport> {
    const dryRun = opts.dryRun ?? true
    const graceHours = opts.graceHours ?? 48
    const graceMs = graceHours * 60 * 60 * 1000
    const cutoff = new Date(Date.now() - graceMs)

    this.logger.log(
      `[reconcile-orphans] Starting scan: dryRun=${dryRun}, graceHours=${graceHours}`,
    )

    // -----------------------------------------------------------------------
    // Step 1: Load all known S3 keys from DB (s3Key + thumbnailS3Key)
    // -----------------------------------------------------------------------
    const dbRows = await this.database.db
      .select({ s3Key: documents.s3Key, thumbnailS3Key: documents.thumbnailS3Key })
      .from(documents)

    const knownKeys = new Set<string>()
    for (const row of dbRows) {
      knownKeys.add(row.s3Key)
      if (row.thumbnailS3Key) {
        knownKeys.add(row.thumbnailS3Key)
      }
    }

    this.logger.log(`[reconcile-orphans] Loaded ${knownKeys.size} known keys from DB`)

    // -----------------------------------------------------------------------
    // Step 2: List ALL S3 objects with full pagination
    // -----------------------------------------------------------------------
    const allObjects: S3ObjectInfo[] = []
    let continuationToken: string | undefined = undefined

    do {
      const page = await this.s3.listObjects(continuationToken)
      allObjects.push(...page.objects)
      continuationToken = page.nextContinuationToken
    } while (continuationToken !== undefined)

    this.logger.log(`[reconcile-orphans] Scanned ${allObjects.length} S3 objects`)

    // -----------------------------------------------------------------------
    // Step 3: Find orphans = not in DB AND older than grace period
    // -----------------------------------------------------------------------
    const orphans: S3ObjectInfo[] = []
    for (const obj of allObjects) {
      if (knownKeys.has(obj.key)) continue // in DB → safe
      if (obj.lastModified >= cutoff) continue // within grace → skip
      orphans.push(obj)
    }

    const orphanBytes = orphans.reduce((sum, o) => sum + o.sizeBytes, 0)

    this.logger.log(
      `[reconcile-orphans] Found ${orphans.length} orphan(s) ` +
        `(${orphanBytes} bytes total). dryRun=${dryRun}`,
    )

    // -----------------------------------------------------------------------
    // Step 4: Delete (or dry-run)
    // -----------------------------------------------------------------------
    let deleted = 0

    if (!dryRun) {
      for (const orphan of orphans) {
        this.logger.warn(
          `[reconcile-orphans] Deleting orphan: key="${orphan.key}" ` +
            `size=${orphan.sizeBytes} lastModified=${orphan.lastModified.toISOString()}`,
        )
        await this.s3.delete(orphan.key)
        deleted++
      }
      this.logger.log(`[reconcile-orphans] Deleted ${deleted} orphan(s)`)
    } else {
      if (orphans.length > 0) {
        this.logger.log(
          `[reconcile-orphans] Dry run — would delete ${orphans.length} orphan(s):`,
        )
        for (const orphan of orphans) {
          this.logger.log(`  • ${orphan.key} (${orphan.sizeBytes} bytes)`)
        }
      }
    }

    return {
      scannedObjects: allObjects.length,
      dbKeys: knownKeys.size,
      orphans,
      orphanBytes,
      deleted,
      dryRun,
    }
  }
}
