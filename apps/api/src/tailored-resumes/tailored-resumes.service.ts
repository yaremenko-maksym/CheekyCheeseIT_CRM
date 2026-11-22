/**
 * The tailored resume API (tailored-resume spec §9, plan Task 11): start a run, the batch status,
 * the per-senior detail and the PDF. RBAC is the job queue's (`tailored-access.ts`); every miss is
 * the queue's one `JOB_OPPORTUNITY_NOT_FOUND` 404. Reads never enqueue (plan D1, D10).
 */
import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import {
  type JobSourceType,
  type ResumeContent,
  type ResumeRenderStatus,
  type SessionUser,
  type TailoredEligibility,
  type TailoredGenerateRequest,
  type TailoredListQuery,
  type TailoredResumeDetailDto,
  type TailoredResumeErrorCode,
  type TailoredResumeRowDto,
  type TailoredRunStage,
  type TailoredRunStatus,
  type TailoredVerification,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { isDeadlock } from '../database/pg-errors'
import type { DrizzleTx } from '../database/types'
import { S3Service } from '../documents/s3.service'
import { DETAIL_FETCH } from '../job-sourcing/ownership/dirty-work.store'
import { canonicalUuid } from '../job-sourcing/queue/queue-scope'
import { JobQueueScopeService } from '../job-sourcing/queue/queue-scope.service'
import { notFound } from '../job-sourcing/queue/senior-eligibility'
import { productionLedgerCatalog } from '../job-sourcing/runtime/production-catalog'
import { loadOpportunity } from '../job-sourcing/runtime/recompute-inputs'
import type { SqlExecutor } from '../job-sourcing/scheduling/host-state'
import { AuditLogService } from '../users/audit-log.service'
import { authorizeSenior, visibleSeniors } from './tailored-access'
import { eligibilityOf } from './tailored-eligibility'
import { tailoredFilename } from './tailored-filename'
import { startRun, type StartResult } from './tailored-run'
import { TailoredRunner } from './tailored-runner'

const conflict = () => apiError('TAILORED_RESUME_CONFLICT', HttpStatus.CONFLICT)
const isActive = (s: string | null): boolean => s === 'QUEUED' || s === 'RUNNING'

/** The `tailored_resumes` columns the API reads. */
export type TailoredRow = {
  runStatus: TailoredRunStatus | null
  runId: string | null
  runStage: TailoredRunStage | null
  runErrorCode: TailoredResumeErrorCode | null
  pdfStatus: ResumeRenderStatus
  pdfRenderId: string | null
  pdfS3Key: string | null
  content: ResumeContent | null
  coverLetter: string | null
  verification: TailoredVerification | null
  baseVersion: number | null
  opportunityRevision: number | null
  generatedAt: Date | null
  editedAt: Date | null
}

type Base = { version: number; verificationStatus: string; content: ResumeContent }
type Person = { displayName: string; base: Base | undefined }

/** A senior the read did not find (deleted meanwhile) has no verified resume either. */
function eligibilityFor(person: Person | undefined, pending: boolean): TailoredEligibility {
  return person === undefined
    ? 'NO_VERIFIED_RESUME'
    : eligibilityOf({
        base: person.base ?? null,
        displayName: person.displayName,
        detailPending: pending,
      })
}

/** One batch row: state and eligibility, no text. `baseChanged` only for a published variant. */
export function rowDto(i: {
  seniorId: string
  row: TailoredRow | undefined
  person: Person | undefined
  revision: number
  pending: boolean
}): TailoredResumeRowDto {
  const { row } = i
  const published = row?.content != null
  return {
    seniorId: i.seniorId,
    eligibility: eligibilityFor(i.person, i.pending),
    runStatus: row?.runStatus ?? null,
    runStage: row?.runStage ?? null,
    runErrorCode: row?.runErrorCode ?? null,
    published,
    pdfStatus: row?.pdfStatus ?? 'IDLE',
    pdfRenderId: row?.pdfRenderId ?? null,
    baseChanged:
      published &&
      (row.baseVersion !== i.person?.base?.version || row.opportunityRevision !== i.revision),
  }
}

/** The per-senior answer: the row plus the published variant, if any. */
export function detailDto(
  dto: TailoredResumeRowDto,
  row:
    | Pick<TailoredRow, 'content' | 'coverLetter' | 'verification' | 'generatedAt' | 'editedAt'>
    | undefined,
): TailoredResumeDetailDto {
  const c = row?.content ?? null
  const v = row?.verification ?? null
  return {
    ...dto,
    coverLetter: row?.coverLetter ?? null,
    editable:
      c === null
        ? null
        : {
            summary: c.summary,
            skills: c.skills,
            experience: c.experience.map((e) => ({
              company: e.company,
              role: e.role,
              period: e.period,
              bullets: e.bullets,
            })),
          },
    summary:
      v === null
        ? null
        : {
            keptFromBase: v.keptFromBase,
            gaps: v.gaps,
            coverage: v.coverage,
            postingPartial: v.postingPartial,
          },
    generatedAt: row?.generatedAt?.toISOString() ?? null,
    editedAt: row?.editedAt?.toISOString() ?? null,
  }
}

/**
 * What the PDF route answers (spec §9): a render in flight is pending; else the published key is
 * served (the previous PDF during a regenerate); else a run still to publish is pending; else none.
 */
export function pdfAnswer(
  row: Pick<TailoredRow, 'runStatus' | 'pdfStatus' | 'pdfS3Key'> | undefined,
): { kind: 'PENDING' } | { kind: 'SERVE'; key: string } | { kind: 'NONE' } {
  if (row === undefined) return { kind: 'NONE' }
  if (isActive(row.pdfStatus)) return { kind: 'PENDING' }
  if (row.pdfS3Key !== null) return { kind: 'SERVE', key: row.pdfS3Key }
  return isActive(row.runStatus) ? { kind: 'PENDING' } : { kind: 'NONE' }
}

const time = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v))

function toRow(r: Record<string, unknown>): TailoredRow {
  return {
    runStatus: (r['run_status'] ?? null) as TailoredRunStatus | null,
    runId: (r['run_id'] ?? null) as string | null,
    runStage: (r['run_stage'] ?? null) as TailoredRunStage | null,
    runErrorCode: (r['run_error_code'] ?? null) as TailoredResumeErrorCode | null,
    pdfStatus: (r['pdf_status'] ?? 'IDLE') as ResumeRenderStatus,
    pdfRenderId: (r['pdf_render_id'] ?? null) as string | null,
    pdfS3Key: (r['pdf_s3_key'] ?? null) as string | null,
    content: (r['content'] ?? null) as ResumeContent | null,
    coverLetter: (r['cover_letter'] ?? null) as string | null,
    verification: (r['verification'] ?? null) as TailoredVerification | null,
    // node-postgres reads an int4 column as a number or null
    baseVersion: r['base_version'] as number | null,
    opportunityRevision: r['opportunity_revision'] as number | null,
    generatedAt: time(r['generated_at']),
    editedAt: time(r['edited_at']),
  }
}

@Injectable()
export class TailoredResumesService {
  /** The ON_DEMAND source types whose missing detail makes a posting pending (D1). */
  onDemandTypes: () => readonly JobSourceType[] = () => productionLedgerCatalog().onDemandTypes()

  // Explicit @Inject: the vitest/esbuild test env emits no `design:paramtypes`.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(JobQueueScopeService) private readonly scopes: JobQueueScopeService,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
    @Inject(S3Service) private readonly s3: S3Service,
    @Inject(TailoredRunner) private readonly runner: TailoredRunner,
  ) {}

  /**
   * POST: one transaction — authorize, eligibility, an active run answers with itself (before the
   * cap, so a double click at the cap stays idempotent), the daily cap, `startRun`, the audit row.
   * The run is enqueued only after the commit, and only when this request started it.
   */
  async generate(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    body: TailoredGenerateRequest,
  ): Promise<{ runId: string }> {
    const senior = canonicalUuid(seniorId)
    if (senior === null) throw notFound()
    const result = await this.write(async (tx): Promise<StartResult | Active> => {
      const scope = await authorizeSenior(this.scopes, user, opportunityId, senior, body.teamId, tx)
      const read = await this.read(tx, opportunityId, [senior])
      const row = read.rows.get(senior)
      const person = read.people.get(senior)
      const eligibility = eligibilityFor(person, read.pending)
      // Stryker disable next-line ConditionalExpression,OptionalChaining: equivalent — READY implies a person with a verified base; the second test only narrows the type
      if (eligibility !== 'READY' || person?.base === undefined) {
        throw apiError('TAILORED_RESUME_NOT_ELIGIBLE', HttpStatus.UNPROCESSABLE_ENTITY, {
          eligibility,
        })
      }
      if (row?.runId != null && isActive(row.runStatus)) {
        // Stryker disable next-line StringLiteral: equivalent — after the commit only CONFLICT and STARTED branch; any other kind answers its run id
        return { kind: 'ACTIVE', runId: row.runId }
      }
      // TASK-12 CALL SITE (daily team cap, plan D12): `await assertUnderDailyCap(tx, scope, cap)`
      // goes here — after the active-run answer above, before `startRun` — inside this same tx.
      const started = await startRun(tx, {
        opportunityId,
        seniorId: senior,
        userId: user.id,
        baseVersion: person.base.version,
        overwrite: body.overwrite,
      })
      if (started.kind === 'STARTED') {
        const after = (value: unknown) => ({ before: null, after: value })
        await this.audit.record(
          {
            actorId: user.id,
            targetId: senior,
            action: 'tailored_resume_generate',
            changes: {
              opportunityId: after(opportunityId),
              teamId: after(scope.kind === 'TEAM' ? scope.teamId : 'studio'),
              runId: after(started.runId),
              overwrite: after(body.overwrite),
            },
          },
          tx,
        )
      }
      return started
    })
    if (result.kind === 'CONFLICT') throw conflict()
    if (result.kind === 'STARTED') this.runner.enqueue(result.rowId, result.runId)
    return { runId: result.runId }
  }

  /** The batch status (D10): set queries over the visible seniors, in their order; no enqueue. */
  async list(
    user: SessionUser,
    opportunityId: string,
    query: TailoredListQuery,
  ): Promise<TailoredResumeRowDto[]> {
    const db = this.db.db
    const scope = await this.scopes.resolve(user, query.teamId, db)
    if (scope.kind === 'NONE') throw notFound()
    await this.scopes.assertVisible(scope, opportunityId, db)
    const ids = await visibleSeniors(this.scopes, scope, opportunityId, query.seniorIds, db)
    if (ids.length === 0) return []
    const read = await this.read(db, opportunityId, ids)
    return ids.map((id) => this.dtoOf(read, id))
  }

  /** The per-senior status, published variant and its short summary. */
  async detail(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    teamId: string | undefined,
  ): Promise<TailoredResumeDetailDto> {
    const { read, senior } = await this.readOne(user, opportunityId, seniorId, teamId)
    return detailDto(this.dtoOf(read, senior), read.rows.get(senior))
  }

  /** The published PDF, or pending while it cannot be served yet; the uniform 404 otherwise. */
  async pdf(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    teamId: string | undefined,
  ): Promise<
    { kind: 'PENDING' } | { kind: 'PDF'; body: Buffer; filename: { ascii: string; utf8: string } }
  > {
    const { read, senior, person } = await this.readOne(user, opportunityId, seniorId, teamId)
    const answer = pdfAnswer(read.rows.get(senior))
    if (answer.kind === 'NONE') throw notFound()
    if (answer.kind === 'PENDING') return answer
    return {
      kind: 'PDF',
      body: await this.s3.getObject(answer.key),
      filename: tailoredFilename(person.displayName, read.title),
    }
  }

  private async readOne(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    teamId: string | undefined,
  ) {
    const senior = canonicalUuid(seniorId)
    if (senior === null) throw notFound()
    const db = this.db.db
    await authorizeSenior(this.scopes, user, opportunityId, senior, teamId, db)
    const read = await this.read(db, opportunityId, [senior])
    // authorized a moment ago and deleted since: as gone as an unknown senior
    const person = read.people.get(senior)
    if (person === undefined) throw notFound()
    return { read, senior, person }
  }

  private dtoOf(read: Read, seniorId: string): TailoredResumeRowDto {
    return rowDto({
      seniorId,
      row: read.rows.get(seniorId),
      person: read.people.get(seniorId),
      revision: read.revision,
      pending: read.pending,
    })
  }

  /**
   * Everything the answers need for `ids`, in a fixed number of queries whatever their count: the
   * opportunity, its pending detail fetch, the tailored rows, and the seniors with their bases.
   */
  private async read(
    db: SqlExecutor,
    opportunityId: string,
    ids: readonly string[],
  ): Promise<Read> {
    const opportunity = await this.scopes.policy(() =>
      loadOpportunity(db, opportunityId, this.onDemandTypes()),
    )
    if (opportunity === null) throw notFound()
    const set = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`
    const { rows } = await db.execute(
      sql`SELECT * FROM tailored_resumes
           WHERE job_opportunity_id = ${opportunityId}::uuid AND senior_user_id IN ${set}`,
    )
    const { rows: people } = await db.execute(
      sql`SELECT u.id, u.display_name, r.version, r.verification_status, r.content
            FROM users u LEFT JOIN senior_resumes r ON r.user_id = u.id
           WHERE u.id IN ${set}`,
    )
    return {
      title: opportunity.canonical.fields.title,
      revision: opportunity.revision,
      pending: await this.postingPending(db, opportunity.onDemandMissing),
      rows: new Map(rows.map((r) => [String(r['senior_user_id']), toRow(r)])),
      people: new Map(
        people.map((p) => [
          String(p['id']),
          {
            displayName: String(p['display_name']),
            base:
              // Stryker disable next-line ConditionalExpression: equivalent — no resume and a status-less one both read NO_VERIFIED_RESUME, and a published row's baseChanged is true either way
              p['version'] == null
                ? undefined
                : {
                    version: Number(p['version']),
                    verificationStatus: String(p['verification_status']),
                    content: p['content'] as ResumeContent,
                  },
          },
        ]),
      ),
    }
  }

  /** D1: pending only while a DETAIL_FETCH for a missing record is really queued or claimed. */
  private async postingPending(
    db: SqlExecutor,
    missing: readonly { recordId: string; version: number }[],
  ): Promise<boolean> {
    if (missing.length === 0) return false
    const { rows } = await db.execute(
      sql`SELECT 1 AS queued FROM job_dirty_work d
           JOIN jsonb_to_recordset(${JSON.stringify(missing)}::jsonb) AS m("recordId" uuid, version bigint)
             ON d.entity_id = m."recordId" AND d.target_version = m.version
           WHERE d.entity_kind = 'SOURCE_RECORD' AND d.reason = ${DETAIL_FETCH}
             AND d.status IN ('PENDING', 'CLAIMED')
           LIMIT 1`,
    )
    return rows.length > 0
  }

  /**
   * One transaction. A deadlock victim (the eligibility check's `FOR SHARE` locks) rolled back
   * whole and gets one rerun; a second is the retryable conflict, never a 500 (C5).
   */
  private async write<T>(body: (tx: DrizzleTx) => Promise<T>, mayRerun = true): Promise<T> {
    try {
      return await this.db.db.transaction((tx) => body(tx))
    } catch (err: unknown) {
      if (!isDeadlock(err)) throw err
      if (mayRerun) return this.write(body, false)
      throw conflict()
    }
  }
}

/** An active run found before `startRun`: answered with itself, never enqueued again. */
type Active = { kind: 'ACTIVE'; runId: string }

type Read = {
  title: string
  revision: number
  pending: boolean
  rows: Map<string, TailoredRow>
  people: Map<string, Person>
}
