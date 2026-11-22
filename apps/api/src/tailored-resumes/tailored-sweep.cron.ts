/**
 * TailoredSweepCron — ends what a dead process left behind on `tailored_resumes` (tailored-resume
 * spec §6, D14):
 *   - a generation run past its 10 min deadline is FAILED with STALLED through `failRun`, so the
 *     published variant and its PDF stay;
 *   - an HR edit re-render RUNNING past its 2 min deadline gets `pdf_status` FAILED; `pdf_s3_key`
 *     still points at the last good PDF;
 *   - daily, a PDF under `tailored-resumes/` that no row references and that is older than 1 h is
 *     deleted. Only `pdf_s3_key` can reference one: a run's or a render's own upload is published
 *     or dropped within its deadline, far inside the grace.
 *
 * Not gated by TAILORED_RESUME_ENABLED: with the feature off the table has no active rows and no
 * objects, so both sweeps find nothing. Neither handler ever throws, so the scheduler keeps running.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { describeDbError } from '../database/pg-errors'
import { tailoredResumes } from '../database/schema'
import { S3Service } from '../documents/s3.service'
import { MAX_ORPHAN_DELETES_PER_RUN } from '../resumes/resume-orphan-sweep.cron'
import { isTailoredPdfKey, TAILORED_RESUMES_PREFIX } from './tailored-keys'
import { ACTIVE_RUN_STATUSES, failRun, isRenderStalled, isStalled } from './tailored-run'
import { TailoredRunner } from './tailored-runner'

export const TAILORED_ORPHAN_GRACE_MS = 60 * 60_000

export interface TailoredOrphanSweepResult {
  deleted: number
  failed: number
  referenced: number
  /** Inside the grace, by the listing or by the HEAD right before the delete. */
  young: number
  /** Already gone by the HEAD right before the delete. */
  gone: number
  /** False when the run stopped early (a listing or DB failure, or the cap). */
  complete: boolean
}

@Injectable()
export class TailoredSweepCron {
  private readonly logger = new Logger(TailoredSweepCron.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly s3: S3Service,
    private readonly runner: TailoredRunner,
  ) {}

  /** Zero-argument on purpose: `cron` calls `onTick(onComplete)` and the scheduler forwards it. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepRuns(): Promise<void> {
    // A run waiting for a slot in this process is QUEUED and alive (backlog 436).
    await this.reapRuns(new Date(), this.runner.waitingRunIds())
  }

  @Cron('50 5 * * *')
  async sweepOrphans(): Promise<void> {
    await this.deleteOrphans(new Date())
  }

  /** Returns how many runs and renders it ended; never throws. */
  async reapRuns(
    now: Date,
    waiting: ReadonlySet<string>,
  ): Promise<{ runs: number; renders: number }> {
    const ended = { runs: 0, renders: 0 }
    let rows
    try {
      rows = await this.db.db
        .select({
          id: tailoredResumes.id,
          runStatus: tailoredResumes.runStatus,
          runId: tailoredResumes.runId,
          runQueuedAt: tailoredResumes.runQueuedAt,
          runStartedAt: tailoredResumes.runStartedAt,
          pdfStatus: tailoredResumes.pdfStatus,
          pdfRenderId: tailoredResumes.pdfRenderId,
          pdfRenderStartedAt: tailoredResumes.pdfRenderStartedAt,
        })
        .from(tailoredResumes)
        .where(
          or(
            inArray(tailoredResumes.runStatus, [...ACTIVE_RUN_STATUSES]),
            eq(tailoredResumes.pdfStatus, 'RUNNING'),
          ),
        )
    } catch (err: unknown) {
      this.logger.warn(`Tailored run sweep stopped: reason="${reason(err)}"`)
      return ended
    }
    for (const row of rows) {
      try {
        if (isStalled(row, now, waiting)) {
          const deps = { db: this.db.db, s3: this.s3, logger: this.logger }
          if (
            await failRun(deps, row.id, row.runId, 'STALLED', { provider: null, reason: 'SWEPT' })
          )
            ended.runs += 1
        }
        if (isRenderStalled(row, now) && (await this.failRender(row.id, row.pdfRenderId)))
          ended.renders += 1
      } catch (err: unknown) {
        this.logger.warn(`Tailored run sweep skipped row=${row.id} reason="${reason(err)}"`)
      }
    }
    return ended
  }

  /** CAS on the render id: a render that finished or was replaced since the read is left alone. */
  private async failRender(rowId: string, renderId: string | null): Promise<boolean> {
    const rows = await this.db.db
      .update(tailoredResumes)
      .set({
        pdfStatus: 'FAILED',
        pdfRenderError: 'STALLED',
        pdfRenderId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tailoredResumes.id, rowId),
          eq(tailoredResumes.pdfStatus, 'RUNNING'),
          renderId === null
            ? isNull(tailoredResumes.pdfRenderId)
            : eq(tailoredResumes.pdfRenderId, renderId),
        ),
      )
      .returning({ id: tailoredResumes.id })
    return rows.length > 0
  }

  /**
   * Lists the prefix page by page. Each page looks up only its own aged candidates in `pdf_s3_key`
   * (never the whole table, which holds a row per opportunity × senior), right before deciding them,
   * so a key published while the run was listing is seen. Every candidate's age is re-read by a HEAD right before its
   * delete; an object listed without a LastModified (epoch 0) is decided by that HEAD alone.
   */
  async deleteOrphans(now: Date): Promise<TailoredOrphanSweepResult> {
    const cutoff = now.getTime() - TAILORED_ORPHAN_GRACE_MS
    const r: TailoredOrphanSweepResult = {
      deleted: 0,
      failed: 0,
      referenced: 0,
      young: 0,
      gone: 0,
      complete: false,
    }
    try {
      let token: string | undefined
      do {
        const page = await this.s3.listObjects(token, TAILORED_RESUMES_PREFIX)
        token = page.nextContinuationToken
        const candidates: string[] = []
        for (const obj of page.objects) {
          if (!isTailoredPdfKey(obj.key)) continue
          if (obj.lastModified.getTime() >= cutoff) r.young += 1
          else candidates.push(obj.key)
        }
        if (candidates.length === 0) continue
        const referenced = await this.referencedKeys(candidates)
        for (const key of candidates) {
          if (referenced.has(key)) {
            r.referenced += 1
            continue
          }
          if (r.deleted + r.failed >= MAX_ORPHAN_DELETES_PER_RUN) {
            this.logger.warn(
              `Tailored orphan sweep hit the cap of ${MAX_ORPHAN_DELETES_PER_RUN} deletes; the rest waits for the next run`,
            )
            this.summary(r)
            return r
          }
          try {
            const modified = await this.s3.headLastModified(key)
            if (modified === null) r.gone += 1
            else if (modified.getTime() >= cutoff) r.young += 1
            else {
              await this.s3.deleteOrThrow(key)
              r.deleted += 1
            }
          } catch (err: unknown) {
            r.failed += 1
            this.logger.warn(`Tailored orphan not deleted: key=${key} reason="${reason(err)}"`)
          }
        }
      } while (token)
    } catch (err: unknown) {
      this.logger.warn(`Tailored orphan sweep stopped: reason="${reason(err)}"`)
      this.summary(r)
      return r
    }
    r.complete = true
    this.summary(r)
    return r
  }

  /** The candidates some row still references; `candidates` is never empty (the caller skips it). */
  private async referencedKeys(candidates: string[]): Promise<ReadonlySet<string | null>> {
    const rows = await this.db.db
      .select({ key: tailoredResumes.pdfS3Key })
      .from(tailoredResumes)
      .where(inArray(tailoredResumes.pdfS3Key, candidates))
    return new Set(rows.map((row) => row.key))
  }

  private summary(r: TailoredOrphanSweepResult): void {
    this.logger.log(
      `Tailored orphan sweep: deleted=${r.deleted} failed=${r.failed} referenced=${r.referenced} young=${r.young} gone=${r.gone} complete=${r.complete}`,
    )
  }
}

function reason(err: unknown): string {
  return describeDbError(err) ?? (err instanceof Error ? err.message : 'unknown error')
}
