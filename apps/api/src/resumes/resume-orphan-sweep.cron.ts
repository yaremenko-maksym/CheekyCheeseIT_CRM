/**
 * ResumeOrphanSweepCron — deletes CVs under `senior-resumes/` (backlog 441) and staged PDFs under
 * `resumes/<id>/staged/` (backlog 448) that no row points at.
 *
 * Orphans come from three places, and this job collects all of them:
 *   - the resumes service deletes a superseded or unreferenced source right after the write that
 *     unreferences it; when that delete fails it only logs;
 *   - a render superseded while its row still exists leaves its upload here on purpose: a newer
 *     run of the same input writes the same key, so deleting it at once could erase the live PDF;
 *   - a Typst failure clears `pdf_s3_key`, so the older PDF it pointed at is unreferenced.
 * A deleted resume does not wait for this job: `deleteResume` erases the row's own prefixes.
 *
 * An object is deleted only when BOTH hold:
 *   - no `senior_resumes` row references its key, in any column that can hold one:
 *     `source_s3_key`, `pdf_s3_key`, `staged_pdf_s3_key`, `staged_previous->'pdfKey'`. The staged
 *     prefix is checked against the same set: Confirm moves the staged key into `pdf_s3_key`, so a
 *     staged-path key can be the live PDF;
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
 * Daily, not hourly: the 24 h grace means an orphan waits a day anyway, and each run lists the
 * whole prefix, which R2 bills per request.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { describeDbError } from '../database/pg-errors'
import { DatabaseService } from '../database/database.service'
import { seniorResumes } from '../database/schema'
import { S3Service } from '../documents/s3.service'

export const SENIOR_RESUMES_PREFIX = 'senior-resumes/'
export const STAGED_RESUMES_PREFIX = 'resumes/'
/** Only `stagedPdfKey`'s shape is swept under `resumes/`; anything else there is not ours to delete. */
const STAGED_PDF_KEY = /^resumes\/[^/]+\/staged\/[^/]+\.pdf$/
/** Swept in order into one result, each with its own cap; a failure in either stops the whole run. */
const SWEPT: ReadonlyArray<{ prefix: string; owns: (key: string) => boolean }> = [
  { prefix: SENIOR_RESUMES_PREFIX, owns: (key) => key.startsWith(SENIOR_RESUMES_PREFIX) },
  { prefix: STAGED_RESUMES_PREFIX, owns: (key) => STAGED_PDF_KEY.test(key) },
]
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
/**
 * Delete attempts per prefix per run (failed ones count): bounds the run if the referenced set ever
 * reads empty. Per prefix, so a backlog under `senior-resumes/` cannot starve the staged sweep.
 */
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
    // Stryker disable next-line StringLiteral: equivalent, the loop's first statement overwrites it before any read
    let stage = 'list'
    let capped = false
    try {
      for (const { prefix, owns } of SWEPT) {
        const attemptsBefore = r.deleted + r.failed
        let token: string | undefined
        do {
          stage = 'list'
          const page = await this.s3.listObjects(token, prefix)
          token = page.nextContinuationToken
          r.listed += page.objects.length
          const aged: string[] = []
          for (const obj of page.objects) {
            if (!owns(obj.key)) continue
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
            if (r.deleted + r.failed - attemptsBefore >= MAX_ORPHAN_DELETES_PER_RUN) {
              this.logger.warn(
                `Resume orphan sweep hit the cap of ${MAX_ORPHAN_DELETES_PER_RUN} deletes under ${prefix}; the rest waits for the next run`,
              )
              capped = true
              token = undefined // ends this prefix's listing; the next prefix still runs
              break
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
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Resume orphan sweep stopped: stage=${stage} reason="${reason(err)}" deleted=${r.deleted} failed=${r.failed}`,
      )
      this.summary(r)
      return r
    }
    r.complete = !capped
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
