/**
 * The generation run's lifecycle on `tailored_resumes` (tailored-resume spec §6, §8): start, claim,
 * own, stage, fail, and the stall rules the sweep applies. Every run write compare-and-sets on
 * `run_id` while the run is active, so a run the sweep or a newer run took stops writing. None of
 * these ever writes the published variant (`content` … `verification`, `pdf_s3_key`): a failed or
 * in-flight run leaves what HR already has untouched.
 *
 * Rebuilt here rather than reused from the verified-base-resume run (`run-end.ts`): those helpers
 * are bound to `senior_resumes` and its staged columns.
 */
import { randomUUID } from 'node:crypto'
import type { Logger } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  tailoredResumeErrorCodeSchema,
  type ResumeVerificationErrorCode,
  type TailoredResumeErrorCode,
  type TailoredRunStage,
  type TailoredVerification,
} from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { tailoredResumes, type TailoredResumeRow } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { S3Service } from '../documents/s3.service'
import type { Unavailable } from '../resumes/verification/inference-clients'
import { deleteStagedQuietly } from '../resumes/verification/run-columns'
import { runPdfKey } from './tailored-keys'

type Db = DatabaseService['db'] | DrizzleTx

export const TAILORED_RUN_DEADLINE_MS = 10 * 60_000
export const TAILORED_RENDER_DEADLINE_MS = 2 * 60_000

/** The run statuses that own the row; the partial index covers exactly these. */
const ACTIVE: ('QUEUED' | 'RUNNING')[] = ['QUEUED', 'RUNNING']

/**
 * The provider behind a failed run, for the log only. `reason` is a closed code set: a provider's
 * error text can carry request content, so it never reaches the log (the verified-base run's
 * `RunOrigin` takes any string, and its transport suffix is free text).
 */
export type TailoredRunOrigin = {
  provider: string | null
  reason: Unavailable['reason'] | 'SWEPT'
  status?: number | undefined
}

/** Why a tailored run stopped. A reused verified-base gate's `RunFailure` is mapped with `toTailoredCode`. */
export class TailoredRunFailure extends Error {
  constructor(
    readonly code: TailoredResumeErrorCode,
    readonly gates: TailoredVerification['gates'] = [],
    readonly origin: TailoredRunOrigin | null = null,
  ) {
    super(code)
    this.name = 'TailoredRunFailure'
  }
}

/** A code both runs share maps to itself; a verified-base-only code (INCOMPLETE) to INTERNAL_ERROR. */
export function toTailoredCode(code: ResumeVerificationErrorCode): TailoredResumeErrorCode {
  const shared = tailoredResumeErrorCodeSchema.safeParse(code)
  return shared.success ? shared.data : 'INTERNAL_ERROR'
}

export type StartResult =
  | { kind: 'STARTED' | 'ACTIVE'; rowId: string; runId: string }
  /** BUSY: the row that refused the start changed before it could be read; asking again is safe. */
  | { kind: 'CONFLICT'; reason: 'PUBLISHED' | 'RENDERING' | 'BUSY' }

/**
 * Queues a run for (opportunity, senior): one `INSERT … ON CONFLICT DO UPDATE … WHERE` no run is
 * active, no PDF render is active, and nothing is published unless `overwrite`. When the update is
 * refused, Postgres still locks the conflicting row, so the read that follows in the same
 * transaction sees the state that refused it: an active run is returned as ACTIVE (a double click
 * starts nothing new), else the render or the published variant is the CONFLICT. A row that reads
 * as neither (gone, or freed meanwhile) is BUSY, never a published variant it does not have.
 */
export async function startRun(
  db: Db,
  p: {
    opportunityId: string
    seniorId: string
    userId: string
    baseVersion: number
    overwrite: boolean
  },
): Promise<StartResult> {
  return db.transaction(async (tx) => {
    const runId = randomUUID()
    const now = new Date()
    const run = {
      runStatus: 'QUEUED' as const,
      runId,
      runBaseVersion: p.baseVersion,
      runStage: null,
      runQueuedAt: now,
      runStartedAt: null,
      runErrorCode: null,
      runRequestedByUserId: p.userId,
      updatedAt: now,
    }
    // The existing row: no run is active and no PDF render is active.
    const free = sql`(${tailoredResumes.runStatus} IS NULL OR ${tailoredResumes.runStatus} NOT IN ('QUEUED', 'RUNNING')) AND ${tailoredResumes.pdfStatus} NOT IN ('QUEUED', 'RUNNING')`
    const [started] = await tx
      .insert(tailoredResumes)
      .values({ jobOpportunityId: p.opportunityId, seniorUserId: p.seniorId, ...run })
      .onConflictDoUpdate({
        target: [tailoredResumes.jobOpportunityId, tailoredResumes.seniorUserId],
        set: run,
        setWhere: p.overwrite ? free : sql`${free} AND ${tailoredResumes.content} IS NULL`,
      })
      .returning({ id: tailoredResumes.id })
    if (started) return { kind: 'STARTED', rowId: started.id, runId }

    const [row] = await tx
      .select({
        id: tailoredResumes.id,
        runStatus: tailoredResumes.runStatus,
        runId: tailoredResumes.runId,
        pdfStatus: tailoredResumes.pdfStatus,
        published: sql<boolean>`${tailoredResumes.content} IS NOT NULL`,
      })
      .from(tailoredResumes)
      .where(
        and(
          eq(tailoredResumes.jobOpportunityId, p.opportunityId),
          eq(tailoredResumes.seniorUserId, p.seniorId),
        ),
      )
    if (row?.runId && (row.runStatus === 'QUEUED' || row.runStatus === 'RUNNING')) {
      return { kind: 'ACTIVE', rowId: row.id, runId: row.runId }
    }
    if (row?.pdfStatus === 'QUEUED' || row?.pdfStatus === 'RUNNING') {
      return { kind: 'CONFLICT', reason: 'RENDERING' }
    }
    if (row?.published && !p.overwrite) return { kind: 'CONFLICT', reason: 'PUBLISHED' }
    return { kind: 'CONFLICT', reason: 'BUSY' }
  })
}

/** The CAS every run write shares: this run id still owns the row and the run is still active. */
const owned = (rowId: string, runId: string) =>
  and(
    eq(tailoredResumes.id, rowId),
    eq(tailoredResumes.runId, runId),
    inArray(tailoredResumes.runStatus, ACTIVE),
  )

/** QUEUED → RUNNING for this run id; null when the run was swept, replaced or already claimed. */
export async function claimRun(
  db: Db,
  rowId: string,
  runId: string,
): Promise<TailoredResumeRow | null> {
  const now = new Date()
  const [row] = await db
    .update(tailoredResumes)
    .set({ runStatus: 'RUNNING', runStartedAt: now, updatedAt: now })
    .where(
      and(
        eq(tailoredResumes.id, rowId),
        eq(tailoredResumes.runId, runId),
        eq(tailoredResumes.runStatus, 'QUEUED'),
      ),
    )
    .returning()
  return row ?? null
}

/** True while `runId` still owns the row: the read before every model call. */
export async function ownsRun(db: Db, rowId: string, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tailoredResumes.id })
    .from(tailoredResumes)
    .where(owned(rowId, runId))
  return row !== undefined
}

/** The progress stage the UI shows; false when the run no longer owns the row. */
export async function setStage(
  db: Db,
  rowId: string,
  runId: string,
  stage: TailoredRunStage,
): Promise<boolean> {
  const rows = await db
    .update(tailoredResumes)
    .set({ runStage: stage, updatedAt: new Date() })
    .where(owned(rowId, runId))
    .returning({ id: tailoredResumes.id })
  return rows.length > 0
}

type RunEndDeps = { db: DatabaseService['db']; s3: Pick<S3Service, 'delete'>; logger: Logger }

/**
 * FAILED with `code` on this run id; the published variant and its PDF are kept. Takes the root
 * handle, not a transaction: the run's own upload is deleted after the write has committed. One
 * structured warn line names the run, the code and the origin, never text. False when another run
 * or the sweep already took the row (the failure is still logged, `applied: false`).
 */
export async function failRun(
  deps: RunEndDeps,
  rowId: string,
  runId: string,
  code: TailoredResumeErrorCode,
  origin: TailoredRunOrigin | null = null,
): Promise<boolean> {
  const rows = await deps.db
    .update(tailoredResumes)
    .set({ runStatus: 'FAILED', runErrorCode: code, runStage: null, updatedAt: new Date() })
    .where(owned(rowId, runId))
    .returning({ id: tailoredResumes.id })
  const applied = rows.length > 0
  deps.logger.warn(
    JSON.stringify({
      event: 'tailored_resume_run_failed',
      runId,
      rowId,
      code,
      provider: origin?.provider ?? null,
      cause: origin?.reason ?? null,
      status: origin?.status ?? null,
      applied,
    }),
  )
  if (applied) await deleteStagedQuietly(deps.s3, deps.logger, runPdfKey(rowId, runId))
  return applied
}

type RunClock = Pick<TailoredResumeRow, 'runStatus' | 'runId' | 'runQueuedAt' | 'runStartedAt'>

/**
 * An active run past its 10 min deadline, measured from its claim, or from its queue while it was
 * never claimed. A run still waiting for a slot in this process is alive; the waiting set dies with
 * the process, so a dead process's runs are still reaped. An active run with no clock is stalled:
 * nothing else would ever end it.
 */
export function isStalled<T extends RunClock>(
  row: T,
  now: Date,
  waiting: ReadonlySet<string>,
): row is T & { runId: string } {
  if (row.runStatus !== 'QUEUED' && row.runStatus !== 'RUNNING') return false
  if (row.runId === null || waiting.has(row.runId)) return false
  const since = row.runStartedAt ?? row.runQueuedAt
  return since === null || now.getTime() - since.getTime() > TAILORED_RUN_DEADLINE_MS
}

/** An HR edit re-render RUNNING past its 2 min deadline (or with no start time). */
export function isRenderStalled(
  row: Pick<TailoredResumeRow, 'pdfStatus' | 'pdfRenderStartedAt'>,
  now: Date,
): boolean {
  if (row.pdfStatus !== 'RUNNING') return false
  const since = row.pdfRenderStartedAt
  return since === null || now.getTime() - since.getTime() > TAILORED_RENDER_DEADLINE_MS
}

/** The sweep selects by the same active set the CAS uses. */
export const ACTIVE_RUN_STATUSES: readonly ('QUEUED' | 'RUNNING')[] = ACTIVE
