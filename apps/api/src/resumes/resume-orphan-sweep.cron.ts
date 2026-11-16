/**
 * ResumeOrphanSweepCron — deletes CVs under `senior-resumes/` that no row points at (backlog 441).
 *
 * The resumes service deletes a superseded or unreferenced source, and a superseded PDF, right
 * after the write that unreferences it. When that delete fails it only logs, and the object — a
 * full CV — stays in R2 with nothing left to reach it. This job is the retry for all of them.
 *
 * An object is deleted only when BOTH hold:
 *   - no `senior_resumes` row references its key, in any column that can hold one:
 *     `source_s3_key`, `pdf_s3_key`, `staged_pdf_s3_key`, `staged_previous->'pdfKey'`;
 *   - its `LastModified` is older than ORPHAN_GRACE_MS, so an upload whose row write has not
 *     landed yet is never taken. An object listed without a `LastModified` is kept.
 *     The age is read twice: from the listing, then by a HEAD right before the delete. A render
 *     re-uploads a fingerprinted key before it writes `pdf_s3_key`, so an old orphan's key can
 *     turn live after its page was listed; the HEAD sees the fresh date and keeps it. A key gone
 *     by the HEAD is skipped; a failed HEAD counts as a failed delete.
 *
 * The referenced set is reloaded for every listing page, AFTER that page is listed: a render
 * re-uploads a deterministic key, so a snapshot taken at the start of the run could be stale by
 * the time a later page is deleted. Fail safe: a listing or DB failure stops the run, deleting
 * nothing more; a single failed delete is logged and the rest go on.
 *
 * Daily, not hourly: orphans appear only when a storage delete fails, and the 24 h grace means an
 * orphan waits a day anyway; each run lists the whole prefix, which R2 bills per request.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { describeDbError } from '../database/pg-errors'
import { DatabaseService } from '../database/database.service'
import { seniorResumes } from '../database/schema'
import { S3Service } from '../documents/s3.service'

export const SENIOR_RESUMES_PREFIX = 'senior-resumes/'
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
/** Delete attempts per run (failed ones count): bounds the run if the referenced set ever reads empty. */
export const MAX_ORPHAN_DELETES_PER_RUN = 500

export interface OrphanSweepResult {
  listed: number
  deleted: number
  failed: number
  /** Aged objects kept because a row references them. */
  referenced: number
  /** Objects inside the grace window. */
  young: number
  /** Objects listed without a LastModified. */
  undated: number
  /** Unreferenced aged objects already gone by the re-check right before the delete. */
  gone: number
  /** False when the run stopped early (a failure or the cap). */
  complete: boolean
}

@Injectable()
export class ResumeOrphanSweepCron {
  private readonly logger = new Logger(ResumeOrphanSweepCron.name)
  /** One run at a time in this process: a slow run must not overlap the next tick or a manual call. */
  private running = false

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
  ) {}

  /**
   * The scheduler entry point. Zero-argument on purpose: `cron` calls `onTick(onComplete)` and
   * `@nestjs/schedule` forwards it, so `sweep` decorated directly would get that as its `now`.
   */
  @Cron('45 5 * * *')
  async handleSweep(): Promise<void> {
    await this.sweep()
  }

  /** Never throws: every failure is caught and logged inside, so the scheduler keeps running. */
  async sweep(now: Date = new Date()): Promise<OrphanSweepResult | null> {
    if (this.running) {
      this.logger.log('Resume orphan sweep skipped: a run is already in progress')
      return null
    }
    this.running = true
    try {
      return await this.run(now)
    } finally {
      this.running = false
    }
  }

  private async run(now: Date): Promise<OrphanSweepResult> {
    const cutoff = now.getTime() - ORPHAN_GRACE_MS
    const r: OrphanSweepResult = {
      listed: 0,
      deleted: 0,
      failed: 0,
      referenced: 0,
      young: 0,
      undated: 0,
      gone: 0,
      complete: false,
    }
    let token: string | undefined
    // Stryker disable next-line StringLiteral: equivalent, the loop's first statement overwrites it before any read
    let stage = 'list'
    try {
      do {
        stage = 'list'
        const page = await this.s3.listObjects(token, SENIOR_RESUMES_PREFIX)
        token = page.nextContinuationToken
        r.listed += page.objects.length
        const aged: string[] = []
        for (const obj of page.objects) {
          if (!obj.key.startsWith(SENIOR_RESUMES_PREFIX)) continue
          // S3Service.listObjects turns a missing LastModified into epoch 0: unknown age, keep it.
          if (obj.lastModified.getTime() === 0) r.undated += 1
          else if (obj.lastModified.getTime() >= cutoff) r.young += 1
          else aged.push(obj.key)
        }
        if (aged.length === 0) continue

        stage = 'references'
        const referenced = await this.referencedKeys()
        for (const key of aged) {
          if (referenced.has(key)) {
            r.referenced += 1
            continue
          }
          if (r.deleted + r.failed >= MAX_ORPHAN_DELETES_PER_RUN) {
            this.logger.warn(
              `Resume orphan sweep hit the cap of ${MAX_ORPHAN_DELETES_PER_RUN} deletes; the rest waits for the next run`,
            )
            this.summary(r)
            return r
          }
          try {
            // Re-check the age: a render may have re-uploaded this key since the page was listed,
            // and its row write may land after `referencedKeys()` read the table.
            const modified = await this.s3.headLastModified(key)
            if (modified === null) {
              r.gone += 1 // gone already: nothing to delete
              continue
            }
            if (modified.getTime() >= cutoff) {
              r.young += 1
              continue
            }
            await this.s3.deleteOrThrow(key)
            r.deleted += 1
          } catch (err: unknown) {
            r.failed += 1
            this.logger.warn(`Resume orphan not deleted: key=${key} reason="${reason(err)}"`)
          }
        }
      } while (token)
    } catch (err: unknown) {
      this.logger.warn(
        `Resume orphan sweep stopped: stage=${stage} reason="${reason(err)}" deleted=${r.deleted} failed=${r.failed}`,
      )
      this.summary(r)
      return r
    }
    r.complete = true
    this.summary(r)
    return r
  }

  /** Every key any row can still reach. One row per user, so the whole table is small. */
  private async referencedKeys(): Promise<Set<string>> {
    const rows = await this.db.db
      .select({
        source: seniorResumes.sourceS3Key,
        pdf: seniorResumes.pdfS3Key,
        staged: seniorResumes.stagedPdfS3Key,
        previous: seniorResumes.stagedPrevious,
      })
      .from(seniorResumes)
    const keys = new Set<string>()
    for (const row of rows) {
      // `staged_previous` is the staged result a running staged-edit or item run may restore.
      const previous = (row.previous as { pdfKey?: unknown } | null)?.pdfKey
      for (const key of [row.source, row.pdf, row.staged, previous]) {
        if (typeof key === 'string') keys.add(key)
      }
    }
    return keys
  }

  private summary(r: OrphanSweepResult): void {
    this.logger.log(
      `Resume orphan sweep: listed=${r.listed} deleted=${r.deleted} failed=${r.failed} referenced=${r.referenced} young=${r.young} undated=${r.undated} gone=${r.gone} complete=${r.complete}`,
    )
  }
}

function reason(err: unknown): string {
  return describeDbError(err) ?? (err instanceof Error ? err.message : 'unknown error')
}
