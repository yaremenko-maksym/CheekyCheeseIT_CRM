/**
 * The tailored resume API (tailored-resume spec §9, plan Task 11): start a run, the batch status,
 * the per-senior detail and the PDF. RBAC is the job queue's (`tailored-access.ts`); every miss is
 * the queue's one `JOB_OPPORTUNITY_NOT_FOUND` 404. Reads never enqueue (plan D1, D10).
 */
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  type JobSourceType,
  type ResumeContent,
  type ResumeRenderStatus,
  type SessionUser,
  type TailoredEligibility,
  type TailoredEditRequest,
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
import { isS3NoSuchKey } from '../documents/s3-not-found.util'
import { DEFAULT_TAILORED_RESUME_DAILY_TEAM_CAP, type Env } from '../config/env'
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
import { assertUnderDailyCap, lockDailyCap } from './tailored-cap'
import { applyEdit } from './tailored-edit'
import { eligibilityOf } from './tailored-eligibility'
import { tailoredFilename } from './tailored-filename'
import { isTailoredActive, startRun, type StartResult } from './tailored-run'
import { TailoredRunner } from './tailored-runner'

const conflict = () => apiError('TAILORED_RESUME_CONFLICT', HttpStatus.CONFLICT)

/** The `tailored_resumes` columns the API reads. */
export type TailoredRow = {
  runStatus: TailoredRunStatus | null
  runId: string | null
  runStage: TailoredRunStage | null
  runErrorCode: TailoredResumeErrorCode | null
  pdfStatus: ResumeRenderStatus
  pdfRenderId: string | null
  pdfS3Key: string | null
  /** A variant is published (`content IS NOT NULL`); read without the text itself. */
  published: boolean
  /** The variant text: only the detail read selects it (null elsewhere). */
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
  const published = row?.published === true
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
  if (isTailoredActive(row.pdfStatus)) return { kind: 'PENDING' }
  if (row.pdfS3Key !== null) return { kind: 'SERVE', key: row.pdfS3Key }
  return isTailoredActive(row.runStatus) ? { kind: 'PENDING' } : { kind: 'NONE' }
}

/**
 * Sonnet 2: the batch, POST and PDF reads select the state only, never the variant text; the
 * detail adds `content`, `cover_letter` and `verification`.
 */
const STATE_COLUMNS = sql.raw(
  'senior_user_id, run_status, run_id, run_stage, run_error_code, pdf_status, pdf_render_id, ' +
    'pdf_s3_key, base_version, opportunity_revision, generated_at, edited_at, ' +
    'content IS NOT NULL AS published',
)
const VARIANT_COLUMNS = sql.join(
  [STATE_COLUMNS, sql.raw('content, cover_letter, verification')],
  sql.raw(', '),
)

/** A raw `db.execute` row carries a timestamptz as its text form (a fake may pass a Date). */
const time = (v: unknown): Date | null => (v == null ? null : new Date(v as string | Date))

function toRow(r: Record<string, unknown>): TailoredRow {
  return {
    runStatus: (r['run_status'] ?? null) as TailoredRunStatus | null,
    runId: (r['run_id'] ?? null) as string | null,
    runStage: (r['run_stage'] ?? null) as TailoredRunStage | null,
    runErrorCode: (r['run_error_code'] ?? null) as TailoredResumeErrorCode | null,
    pdfStatus: (r['pdf_status'] ?? 'IDLE') as ResumeRenderStatus,
    pdfRenderId: (r['pdf_render_id'] ?? null) as string | null,
    pdfS3Key: (r['pdf_s3_key'] ?? null) as string | null,
    published: r['published'] === true,
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
    @Optional() @Inject(ConfigService) config?: ConfigService<Env, true>,
  ) {
    this.dailyCap =
      config?.get('TAILORED_RESUME_DAILY_TEAM_CAP', { infer: true }) ??
      DEFAULT_TAILORED_RESUME_DAILY_TEAM_CAP
  }

  /** Generations one scope may start per Kyiv day (D12). */
  private readonly dailyCap: number

  /**
   * POST: one transaction — authorize, the scope's cap lock, eligibility, an active run answers
   * with itself (before the cap count, so a double click at the cap stays idempotent), the daily
   * cap, `startRun`, the audit row.
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
      const scopeKey = scope.kind === 'TEAM' ? scope.teamId : 'studio'
      // D12 / SR-L-2: the scope lock comes before the active-run read, so a double click waits for
      // the first click's transaction and answers with its run instead of counting against the cap.
      await lockDailyCap(tx, scopeKey)
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
      if (row?.runId != null && isTailoredActive(row.runStatus)) {
        // Stryker disable next-line StringLiteral: equivalent — after the commit only CONFLICT and STARTED branch; any other kind answers its run id
        return { kind: 'ACTIVE', runId: row.runId }
      }
      // D12: after the active-run answer, before `startRun`, under the lock above.
      await assertUnderDailyCap(tx, scopeKey, this.dailyCap, new Date())
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
              teamId: after(scopeKey),
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

  /**
   * PUT (HR edit, plan Task 12): one transaction — authorize, `applyEdit` on the row (merge, claim
   * the re-render), the audit row. Nothing published, or a run or a render active, is the retryable
   * 409. The re-render starts only after the commit.
   */
  async edit(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    body: TailoredEditRequest,
  ): Promise<{ renderId: string }> {
    const senior = canonicalUuid(seniorId)
    if (senior === null) throw notFound()
    const { rowId, renderId } = await this.write(async (tx) => {
      const scope = await authorizeSenior(this.scopes, user, opportunityId, senior, body.teamId, tx)
      const { rows } = await tx.execute(
        sql`SELECT id FROM tailored_resumes
             WHERE job_opportunity_id = ${opportunityId}::uuid AND senior_user_id = ${senior}::uuid`,
      )
      const id = rows[0]?.['id']
      const applied =
        id === undefined
          ? null
          : await applyEdit(tx, { rowId: String(id), userId: user.id, edit: body })
      if (applied === null) throw conflict()
      const after = (value: unknown) => ({ before: null, after: value })
      await this.audit.record(
        {
          actorId: user.id,
          targetId: senior,
          action: 'tailored_resume_edit',
          changes: {
            opportunityId: after(opportunityId),
            teamId: after(scope.kind === 'TEAM' ? scope.teamId : 'studio'),
            renderId: after(applied.renderId),
          },
        },
        tx,
      )
      return { rowId: String(id), renderId: applied.renderId }
    })
    this.runner.renderEdit(rowId, renderId)
    return { renderId }
  }

  /** The batch status (D10): set queries over the visible seniors, in their order; no enqueue. */
  async list(
    user: SessionUser,
    opportunityId: string,
    query: TailoredListQuery,
  ): Promise<TailoredResumeRowDto[]> {
    const db = this.db.db
    const scope = await this.scopes.resolveView(user, query.teamId, db)
    if (scope.kind === 'NONE') throw notFound()
    await this.scopes.assertVisible(scope, opportunityId, db)
    // A union answers for each of its teams that sees the opportunity, team by team, once each.
    const teams = scope.kind === 'TEAMS' ? scope.teams : [scope]
    const seen = new Set<string>()
    for (const team of teams) {
      if (scope.kind === 'TEAMS' && !(await this.scopes.isVisible(team, opportunityId, db)))
        continue
      for (const id of await visibleSeniors(this.scopes, team, opportunityId, query.seniorIds, db))
        seen.add(id)
    }
    const ids = [...seen]
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
    const { read, senior } = await this.readOne(user, opportunityId, seniorId, teamId, true)
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
    // SR-L-4: a publish between the read and the get deletes the key read; read the row once more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { read, senior, person } = await this.readOne(user, opportunityId, seniorId, teamId)
      const answer = pdfAnswer(read.rows.get(senior))
      if (answer.kind === 'NONE') throw notFound()
      if (answer.kind === 'PENDING') return answer
      const body = await this.s3.getObject(answer.key).catch((err: unknown) => {
        if (isS3NoSuchKey(err)) return null
        throw err
      })
      if (body !== null) {
        return { kind: 'PDF', body, filename: tailoredFilename(person.displayName, read.title) }
      }
    }
    throw notFound()
  }

  private async readOne(
    user: SessionUser,
    opportunityId: string,
    seniorId: string,
    teamId: string | undefined,
    withVariant = false,
  ) {
    const senior = canonicalUuid(seniorId)
    if (senior === null) throw notFound()
    const db = this.db.db
    await authorizeSenior(this.scopes, user, opportunityId, senior, teamId, db)
    const read = await this.read(db, opportunityId, [senior], withVariant)
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
    withVariant = false,
  ): Promise<Read> {
    const opportunity = await this.scopes.policy(() =>
      loadOpportunity(db, opportunityId, this.onDemandTypes()),
    )
    if (opportunity === null) throw notFound()
    const set = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`
    const { rows } = await db.execute(
      sql`SELECT ${withVariant ? VARIANT_COLUMNS : STATE_COLUMNS} FROM tailored_resumes
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
