import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'
import {
  jobQueueDismissalResponseSchema,
  jobQueueDismissReasonSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueSubmissionResponseSchema,
  type JobQueueCancelSubmissionRequestDto,
  type JobQueueDismissalResponseDto,
  type JobQueueDismissRequestDto,
  type JobQueueOpenedRequestDto,
  type JobQueueSubmissionResponseDto,
  type JobQueueSubmitRequestDto,
  type JobQueueUndoRequestDto,
  type SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import { uniqueViolationConstraint } from '../../database/pg-errors'
import { findMatchingExclusion } from '../filtering'
import { loadRoster } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  type ActionReplay,
  decideDismiss,
  decideSubmit,
  type ExistingSubmission,
  isoInstant,
  parseActionReplay,
  requestFingerprint,
  scopeTeamId,
  type WriteScope,
} from './queue-actions'
import { canonicalUuid, scopedTeamRowPredicate, visibleOpportunityPredicate } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/** The duplicates preview's bound (`jobQueueDuplicatesPreviewSchema`). */
const DUPLICATES_PREVIEW_MAX = 5

const IDEMPOTENCY_CONSTRAINT = 'uq_job_queue_actions_actor_idempotency'
const SUBMISSION_CONSTRAINT = 'uq_job_queue_assignments_opportunity_senior'
const DISMISSAL_CONSTRAINT = 'uq_job_queue_dismissals_opportunity_scope'

/** r5 Task 6.3 has no wire contract for suppress yet: Task 6.4 adds its route and schema. */
export interface JobQueueSuppressRequest {
  readonly idempotencyKey: string
}

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
const versionConflict = () => apiError('JOB_QUEUE_VERSION_CONFLICT', HttpStatus.CONFLICT)
const idempotencyConflict = () => apiError('JOB_QUEUE_IDEMPOTENCY_CONFLICT', HttpStatus.CONFLICT)

/**
 * A's LIVE submission of a senior shared with the actor's team (owner decision A3, option (a)): the
 * generic conflict plus the bare marker. Built from the generic body, so it can carry nothing of
 * the foreign row; the raw-JSON absence is pinned by the specs.
 */
function submittedElsewhere(): HttpException {
  const generic = versionConflict().getResponse() as Record<string, unknown>
  return new HttpException({ ...generic, submittedElsewhere: true }, HttpStatus.CONFLICT)
}

/**
 * r5 Task 6.3 — the queue's writes. The button records a submission and sends nothing to anyone:
 * nothing here has an outward side effect.
 *
 * Every write is one transaction, in this order (the plan's):
 *   1. the scope, resolved INSIDE the transaction (`JobQueueScopeService.resolve`, never cached);
 *   2. the opportunity rows locked, in sorted id order (`FOR NO KEY UPDATE`: mutually exclusive
 *      between writers, and it does not block the FK checks of other tables' inserts);
 *   3. the idempotency key: a retry answers from the log. After the locks, so a concurrent retry
 *      of one key on one opportunity waits and finds the first one's row;
 *   4. the actor's live role and membership, `FOR SHARE`: a demotion, an archival or a leave either
 *      committed first (this statement sees it and refuses) or waits for this commit;
 *   5. the visibility check and the action's own policy;
 *   6. the versioned write and its `job_queue_actions` row, so an audit failure rolls it back.
 *
 * WHY CANCEL AND UNDO DO NOT CALL `assertVisible`, and only they: they correct a record the actor's
 * own scope wrote, and reveal nothing the scope does not already hold. An opportunity stops being
 * visible on every revision bump until its recompute, and for good once its only matching senior
 * has left; with the check, a team could then never correct "logged by mistake". They still need a
 * live scope, a live actor and a row inside the scope (`scopedTeamRowPredicate`), and anything else
 * is the same 404.
 *
 * WHY A STOP-LISTED OR INELIGIBLE SENIOR IS A 404: HR sees how many seniors excluded an opportunity,
 * not who (plan §4), so a distinct answer here would name the senior.
 */
@Injectable()
export class JobQueueActionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueueScopeService) private readonly scopes: JobQueueScopeService,
  ) {}

  async submit(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueSubmitRequestDto,
  ): Promise<JobQueueSubmissionResponseDto> {
    const opportunity = canonicalUuid(opportunityId)
    const seniorId = canonicalUuid(request.seniorId)
    if (opportunity === null || seniorId === null) throw notFound()
    return this.write(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      const copies = await this.lockDuplicateSet(tx, opportunity)
      const target = copies.find((c) => c.id === opportunity)
      if (target === undefined) throw notFound()
      const fingerprint = requestFingerprint([
        'TAKEN',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        seniorId,
        request.expectedOpportunityRevision,
        request.expectedVersion ?? null,
        request.confirmPossibleDuplicate,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return this.submissionAnswer(tx, opportunity, earlier, 'TAKEN')

      await this.lockActor(tx, user, scope)
      await this.scopes.assertVisible(scope, opportunity, tx)
      await this.assertSeniorEligible(tx, scope, seniorId, target)
      if (target.revision !== request.expectedOpportunityRevision) throw versionConflict()

      const decision = decideSubmit(
        await this.existingSubmission(tx, opportunity, seniorId),
        scope,
        request.expectedVersion,
      )
      if (decision.kind === 'ELSEWHERE') throw submittedElsewhere()
      if (decision.kind === 'STALE') throw versionConflict()
      if (!request.confirmPossibleDuplicate) {
        await this.assertNoClaimedDuplicate(tx, scope, seniorId, opportunity, copies)
      }

      if (decision.kind === 'REPLACE') {
        // `job_queue_actions` has no FK to this table: the cancelled team's history stays in the log.
        await tx.execute(
          sql`DELETE FROM job_queue_assignments WHERE id = ${decision.id}::uuid AND state = 'RELEASED'`,
        )
      }
      const row =
        decision.kind === 'UPDATE'
          ? await this.reopenSubmission(tx, decision, user.id)
          : await this.insertSubmission(tx, opportunity, seniorId, scope, user.id)
      const before = decision.kind === 'UPDATE' ? decision.version : 0
      await this.logAction(tx, {
        kind: 'TAKEN',
        opportunity,
        actorId: user.id,
        scope,
        before,
        after: row.version,
        key: request.idempotencyKey,
        replay: {
          fp: fingerprint,
          submissionId: row.id,
          seniorId,
          assigneeId: user.id,
          submittedAt: row.takenAt,
        },
      })
      return jobQueueSubmissionResponseSchema.parse({
        submission: {
          id: row.id,
          opportunityId: opportunity,
          seniorId,
          state: 'TAKEN',
          submittedAt: row.takenAt,
          cancelledAt: null,
          version: row.version,
          submittedByName: await this.nameOf(tx, user.id),
        },
      })
    })
  }

  async cancelSubmission(
    user: SessionUser,
    opportunityId: string,
    submissionId: string,
    request: JobQueueCancelSubmissionRequestDto,
  ): Promise<JobQueueSubmissionResponseDto> {
    const opportunity = canonicalUuid(opportunityId)
    const submission = canonicalUuid(submissionId)
    if (opportunity === null || submission === null) throw notFound()
    return this.write(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      await this.lockTarget(tx, opportunity)
      const fingerprint = requestFingerprint([
        'RELEASED',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        submission,
        request.expectedVersion,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return this.submissionAnswer(tx, opportunity, earlier, 'RELEASED')

      await this.lockActor(tx, user, scope)
      const { rows } = await tx.execute(
        sql`SELECT a.senior_id, a.assignee_id, a.state, a.version, a.taken_at
              FROM job_queue_assignments a
             WHERE a.id = ${submission}::uuid AND a.opportunity_id = ${opportunity}::uuid
               AND ${scopedTeamRowPredicate(scope, sql`a.team_id`)}`,
      )
      const row = rows[0]
      if (row === undefined) throw notFound()
      if (row['state'] !== 'TAKEN' || row['version'] !== request.expectedVersion) {
        throw versionConflict()
      }
      const updated = await tx.execute(
        sql`UPDATE job_queue_assignments
               SET state = 'RELEASED', released_at = now(), released_by = ${user.id}::uuid,
                   version = version + 1, updated_at = now()
             WHERE id = ${submission}::uuid AND version = ${request.expectedVersion}
                   AND state = 'TAKEN'
         RETURNING version, released_at`,
      )
      const after = updated.rows[0]
      if (after === undefined) throw versionConflict()
      const assigneeId = String(row['assignee_id'])
      const seniorId = String(row['senior_id'])
      const submittedAt = isoInstant(row['taken_at'])
      await this.logAction(tx, {
        kind: 'RELEASED',
        opportunity,
        actorId: user.id,
        scope,
        before: request.expectedVersion,
        after: Number(after['version']),
        key: request.idempotencyKey,
        replay: { fp: fingerprint, submissionId: submission, seniorId, assigneeId, submittedAt },
      })
      return jobQueueSubmissionResponseSchema.parse({
        submission: {
          id: submission,
          opportunityId: opportunity,
          seniorId,
          state: 'RELEASED',
          submittedAt,
          cancelledAt: isoInstant(after['released_at']),
          version: Number(after['version']),
          submittedByName: await this.nameOf(tx, assigneeId),
        },
      })
    })
  }

  async dismiss(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueDismissRequestDto,
  ): Promise<JobQueueDismissalResponseDto> {
    const opportunity = canonicalUuid(opportunityId)
    if (opportunity === null) throw notFound()
    return this.write(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      // An HR never resolves to STUDIO, so a STUDIO dismissal is ADMIN-only by this comparison.
      if (scope.kind !== request.scope) throw notFound()
      await this.lockTarget(tx, opportunity)
      const fingerprint = requestFingerprint([
        'DISMISSED',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        request.reason,
        request.expectedVersion ?? null,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return dismissalAnswer(opportunity, scope, earlier, true)

      await this.lockActor(tx, user, scope)
      await this.scopes.assertVisible(scope, opportunity, tx)
      const existing = await this.existingDismissal(tx, opportunity, scope)
      const currentVersion = existing?.version ?? null
      const decision = decideDismiss(currentVersion, request.expectedVersion)
      if (decision === 'STALE') throw versionConflict()
      const { rows } = await tx.execute(
        decision === 'INSERT'
          ? sql`INSERT INTO job_queue_dismissals
                  (opportunity_id, scope_kind, team_id, reason, dismissed_by)
                VALUES (${opportunity}::uuid, ${scope.kind}, ${scopeTeamId(scope)}::uuid,
                        ${request.reason}, ${user.id}::uuid)
             RETURNING version`
          : sql`UPDATE job_queue_dismissals
                   SET reason = ${request.reason}, dismissed_by = ${user.id}::uuid,
                       dismissed_at = now(), undone_at = NULL, undone_by = NULL,
                       version = version + 1, updated_at = now()
                 WHERE opportunity_id = ${opportunity}::uuid AND scope_kind = ${scope.kind}
                   AND team_id IS NOT DISTINCT FROM ${scopeTeamId(scope)}::uuid
                   AND version = ${currentVersion}
             RETURNING version`,
      )
      const after = rows[0]
      if (after === undefined) throw versionConflict()
      const version = Number(after['version'])
      await this.logAction(tx, {
        kind: 'DISMISSED',
        opportunity,
        actorId: user.id,
        scope,
        before: currentVersion ?? 0,
        after: version,
        key: request.idempotencyKey,
        replay: { fp: fingerprint, dismissReason: request.reason },
      })
      return jobQueueDismissalResponseSchema.parse({
        opportunityId: opportunity,
        scope: scope.kind,
        reason: request.reason,
        hidden: true,
        version,
      })
    })
  }

  async undo(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueUndoRequestDto,
  ): Promise<JobQueueDismissalResponseDto> {
    const opportunity = canonicalUuid(opportunityId)
    if (opportunity === null) throw notFound()
    return this.write(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      if (scope.kind !== request.scope) throw notFound()
      await this.lockTarget(tx, opportunity)
      const fingerprint = requestFingerprint([
        'UNDONE',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        request.expectedVersion,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return dismissalAnswer(opportunity, scope, earlier, false)

      await this.lockActor(tx, user, scope)
      const existing = await this.existingDismissal(tx, opportunity, scope)
      if (existing === null) throw notFound()
      if (existing.undone || existing.version !== request.expectedVersion) throw versionConflict()
      const { rows } = await tx.execute(
        sql`UPDATE job_queue_dismissals
               SET undone_at = now(), undone_by = ${user.id}::uuid,
                   version = version + 1, updated_at = now()
             WHERE opportunity_id = ${opportunity}::uuid AND scope_kind = ${scope.kind}
               AND team_id IS NOT DISTINCT FROM ${scopeTeamId(scope)}::uuid
               AND version = ${request.expectedVersion} AND undone_at IS NULL
         RETURNING version`,
      )
      const after = rows[0]
      if (after === undefined) throw versionConflict()
      const version = Number(after['version'])
      await this.logAction(tx, {
        kind: 'UNDONE',
        opportunity,
        actorId: user.id,
        scope,
        before: request.expectedVersion,
        after: version,
        key: request.idempotencyKey,
        replay: { fp: fingerprint, dismissReason: existing.reason },
      })
      return jobQueueDismissalResponseSchema.parse({
        opportunityId: opportunity,
        scope: scope.kind,
        reason: jobQueueDismissReasonSchema.parse(existing.reason),
        hidden: false,
        version,
      })
    })
  }

  /**
   * Idempotent click telemetry per actor + opportunity + source record (the partial UNIQUE
   * `uq_job_queue_actions_opened_once`). No opportunity lock: it moves no state and must not queue
   * behind a submission. The source record must be a live link of this opportunity.
   */
  async opened(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueOpenedRequestDto,
  ): Promise<void> {
    const opportunity = canonicalUuid(opportunityId)
    const sourceRecord = canonicalUuid(request.sourceRecordId)
    if (opportunity === null || sourceRecord === null) throw notFound()
    await this.database.db.transaction(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      await this.scopes.assertVisible(scope, opportunity, tx)
      const link = await this.scopes.policy(() =>
        tx.execute(
          sql`SELECT 1 AS linked FROM job_opportunity_sources
               WHERE opportunity_id = ${opportunity}::uuid
                 AND source_record_id = ${sourceRecord}::uuid AND unlinked_at IS NULL`,
        ),
      )
      if (link.rows.length === 0) throw notFound()
      await tx.execute(
        sql`INSERT INTO job_queue_actions
              (kind, opportunity_id, source_record_id, actor_id, scope_kind, team_id, idempotency_key)
            VALUES ('OPENED', ${opportunity}::uuid, ${sourceRecord}::uuid, ${user.id}::uuid,
                    ${scope.kind}, ${scopeTeamId(scope)}::uuid,
                    ${`opened:${opportunity}:${sourceRecord}`})
            ON CONFLICT DO NOTHING`,
      )
    })
  }

  /**
   * ADMIN-only. No entity holds suppression state (the schema's `ck_job_queue_actions_versions`
   * lets SUPPRESSED carry no version for that reason), so the action row IS the record.
   */
  async suppress(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueSuppressRequest,
  ): Promise<void> {
    const opportunity = canonicalUuid(opportunityId)
    if (opportunity === null) throw notFound()
    await this.write(async (tx) => {
      const scope = await this.scopes.resolve(user, undefined, tx)
      if (scope.kind !== 'STUDIO') throw new ForbiddenException()
      await this.lockTarget(tx, opportunity)
      const fingerprint = requestFingerprint(['SUPPRESSED', opportunity])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return
      await this.lockActor(tx, user, scope)
      await this.logAction(tx, {
        kind: 'SUPPRESSED',
        opportunity,
        actorId: user.id,
        scope,
        before: null,
        after: null,
        key: request.idempotencyKey,
        replay: { fp: fingerprint },
      })
    })
  }

  /**
   * One transaction, and the two unique violations the locks do not make impossible. The same key
   * used concurrently on ANOTHER opportunity shares no lock: its 23505 rolled this attempt back, so
   * running it again answers from the log (the replay or the idempotency conflict). A submission or
   * dismissal violation is a lost race on a key the locks should have serialized: the generic
   * conflict, which names no row. Anything else is not anticipated and stays an error.
   */
  private async write<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const run = () => this.database.db.transaction((tx) => body(tx))
    try {
      return await run()
    } catch (err: unknown) {
      const constraint = uniqueViolationConstraint(err)
      if (constraint === IDEMPOTENCY_CONSTRAINT) return run()
      if (constraint === SUBMISSION_CONSTRAINT || constraint === DISMISSAL_CONSTRAINT) {
        throw versionConflict()
      }
      throw err
    }
  }

  private async writeScope(
    user: SessionUser,
    teamId: string | undefined,
    tx: SqlExecutor,
  ): Promise<WriteScope> {
    const scope = await this.scopes.resolve(user, teamId, tx)
    if (scope.kind === 'NONE') throw notFound()
    return scope
  }

  /**
   * The target and its possible-duplicate set, locked in sorted id order. No relation stores
   * "possible duplicate": the set is the opportunities sharing the resolver's candidate key
   * (`idx_job_opportunities_candidate_key`: employer key + title key), which an unknown employer
   * does not have. Locking a row the scope cannot see discloses nothing: only the target's answer
   * and the visible, own-scope conflict below are ever returned.
   */
  private async lockDuplicateSet(tx: SqlExecutor, opportunity: string): Promise<LockedCopy[]> {
    const { rows } = await tx.execute(
      sql`SELECT d.id, d.revision, d.title, d.employer_name
            FROM job_opportunities t
            JOIN job_opportunities d
              ON d.id = t.id
              OR (t.employer_key IS NOT NULL AND d.employer_key = t.employer_key
                  AND d.title_key = t.title_key)
           WHERE t.id = ${opportunity}::uuid
           ORDER BY d.id
             FOR NO KEY UPDATE OF d`,
    )
    return rows.map((r) => ({
      id: String(r['id']),
      revision: Number(r['revision']),
      title: String(r['title']),
      employerName: r['employer_name'] === null ? null : String(r['employer_name']),
    }))
  }

  private async lockTarget(tx: SqlExecutor, opportunity: string): Promise<void> {
    const { rows } = await tx.execute(
      sql`SELECT id FROM job_opportunities WHERE id = ${opportunity}::uuid FOR NO KEY UPDATE`,
    )
    if (rows.length === 0) throw notFound()
  }

  /** The answer of an earlier success with this key, `null` for a new key; a different request conflicts. */
  private async earlierAction(
    tx: SqlExecutor,
    actorId: string,
    key: string,
    fingerprint: string,
  ): Promise<EarlierAction | null> {
    const { rows } = await tx.execute(
      sql`SELECT reason, after_version, created_at FROM job_queue_actions
           WHERE actor_id = ${actorId}::uuid AND idempotency_key = ${key}`,
    )
    const row = rows[0]
    if (row === undefined) return null
    const replay = parseActionReplay(row['reason'])
    if (replay === null || replay.fp !== fingerprint) throw idempotencyConflict()
    return {
      replay,
      version: Number(row['after_version']),
      createdAt: isoInstant(row['created_at']),
    }
  }

  /** The earlier success itself, from the log: never the current row, which may be another team's. */
  private async submissionAnswer(
    tx: SqlExecutor,
    opportunity: string,
    earlier: EarlierAction,
    state: 'TAKEN' | 'RELEASED',
  ): Promise<JobQueueSubmissionResponseDto> {
    const { replay } = earlier
    return jobQueueSubmissionResponseSchema.parse({
      submission: {
        id: replay.submissionId,
        opportunityId: opportunity,
        seniorId: replay.seniorId,
        state,
        submittedAt: replay.submittedAt,
        cancelledAt: state === 'RELEASED' ? earlier.createdAt : null,
        version: earlier.version,
        submittedByName: await this.nameOf(tx, replay.assigneeId as string),
      },
    })
  }

  /** The actor as the database has them NOW: same role, not archived, still in the team (an HR). */
  private async lockActor(tx: SqlExecutor, user: SessionUser, scope: WriteScope): Promise<void> {
    const actor = await this.scopes.policy(() =>
      tx.execute(
        sql`SELECT id FROM users
             WHERE id = ${user.id}::uuid AND role = ${user.role} AND archived_at IS NULL
               FOR SHARE`,
      ),
    )
    if (actor.rows.length === 0) throw notFound()
    if (user.role === 'ADMIN') return
    const membership = await this.scopes.policy(() =>
      tx.execute(
        sql`SELECT id FROM team_members
             WHERE team_id = ${scopeTeamId(scope)}::uuid AND user_id = ${user.id}::uuid
               AND left_at IS NULL
               FOR SHARE`,
      ),
    )
    if (membership.rows.length === 0) throw notFound()
  }

  /**
   * An active, non-archived SENIOR member of the scope's team (ADMIN in STUDIO: of any live team),
   * locked `FOR SHARE` so a leave or an archival cannot pass this check and commit under the write;
   * and who has not stop-listed the opportunity (their own entries; a studio-wide exclusion is the
   * opportunity's verdict, and triage may be submitted).
   */
  private async assertSeniorEligible(
    tx: SqlExecutor,
    scope: WriteScope,
    seniorId: string,
    target: LockedCopy,
  ): Promise<void> {
    const member = await this.scopes.policy(() =>
      tx.execute(
        sql`SELECT tm.team_id FROM team_members tm
              JOIN users u ON u.id = tm.user_id
              JOIN teams t ON t.id = tm.team_id
             WHERE tm.user_id = ${seniorId}::uuid AND tm.left_at IS NULL
               AND u.role = 'SENIOR' AND u.archived_at IS NULL
               AND t.archived_at IS NULL AND t.type = 'SENIOR'
               AND ${scopedTeamRowPredicate(scope, sql`tm.team_id`)}
             ORDER BY tm.team_id
               FOR SHARE OF tm, u`,
      ),
    )
    if (member.rows.length === 0) throw notFound()
    const { exclusions } = await this.scopes.policy(() => loadRoster(tx))
    // Stryker disable next-line StringLiteral: equivalent — another fallback could only match an exclusion spelled exactly like it, and an unnamed employer has no such name
    const companyName = target.employerName ?? ''
    const stopListed = findMatchingExclusion(
      { companyName, title: target.title },
      exclusions.filter((e) => e.seniorId === seniorId),
    )
    if (stopListed !== null) throw notFound()
  }

  private async existingSubmission(
    tx: SqlExecutor,
    opportunity: string,
    seniorId: string,
  ): Promise<ExistingSubmission | null> {
    const { rows } = await tx.execute(
      sql`SELECT id, state, team_id, version FROM job_queue_assignments
           WHERE opportunity_id = ${opportunity}::uuid AND senior_id = ${seniorId}::uuid`,
    )
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: String(row['id']),
      state: row['state'] as ExistingSubmission['state'],
      teamId: row['team_id'] === null ? null : String(row['team_id']),
      version: Number(row['version']),
    }
  }

  /**
   * The senior's live submission on another copy, inside the actor's own scope and on an opportunity
   * the scope may see: only such a row can be previewed without disclosing anything. Runs after the
   * sorted locks, so two concurrent submissions to two copies cannot both pass unconfirmed.
   */
  private async assertNoClaimedDuplicate(
    tx: SqlExecutor,
    scope: WriteScope,
    seniorId: string,
    opportunity: string,
    copies: readonly LockedCopy[],
  ): Promise<void> {
    const others = copies.filter((c) => c.id !== opportunity)
    if (others.length === 0) return
    const ids = JSON.stringify(others.map((c) => c.id))
    const { rows } = await tx.execute(
      sql`SELECT a.opportunity_id FROM job_queue_assignments a
           WHERE a.senior_id = ${seniorId}::uuid AND a.state = 'TAKEN'
             AND a.opportunity_id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::uuid)
             AND ${scopedTeamRowPredicate(scope, sql`a.team_id`)}
             AND ${visibleOpportunityPredicate(scope, sql`a.opportunity_id`)}`,
    )
    if (rows.length === 0) return
    const claimed = new Set(rows.map((r) => String(r['opportunity_id'])))
    const items = others.filter((c) => claimed.has(c.id))
    throw new HttpException(
      jobQueuePossibleDuplicateConflictSchema.parse({
        code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
        possibleDuplicates: {
          items: items.slice(0, DUPLICATES_PREVIEW_MAX).map((c) => ({
            opportunityId: c.id,
            title: c.title,
            companyName: c.employerName,
          })),
          totalCount: items.length,
        },
      }),
      HttpStatus.CONFLICT,
    )
  }

  private async insertSubmission(
    tx: SqlExecutor,
    opportunity: string,
    seniorId: string,
    scope: WriteScope,
    actorId: string,
  ): Promise<WrittenSubmission> {
    const { rows } = await tx.execute(
      sql`INSERT INTO job_queue_assignments
            (opportunity_id, senior_id, scope_kind, team_id, assignee_id)
          VALUES (${opportunity}::uuid, ${seniorId}::uuid, ${scope.kind},
                  ${scopeTeamId(scope)}::uuid, ${actorId}::uuid)
       RETURNING id, version, taken_at`,
    )
    return writtenSubmission(rows[0])
  }

  private async reopenSubmission(
    tx: SqlExecutor,
    target: { readonly id: string; readonly version: number },
    actorId: string,
  ): Promise<WrittenSubmission> {
    const { rows } = await tx.execute(
      sql`UPDATE job_queue_assignments
             SET state = 'TAKEN', assignee_id = ${actorId}::uuid, taken_at = now(),
                 released_at = NULL, released_by = NULL, release_reason = NULL,
                 version = version + 1, updated_at = now()
           WHERE id = ${target.id}::uuid AND version = ${target.version} AND state = 'RELEASED'
       RETURNING id, version, taken_at`,
    )
    return writtenSubmission(rows[0])
  }

  private async existingDismissal(
    tx: SqlExecutor,
    opportunity: string,
    scope: WriteScope,
  ): Promise<ExistingDismissal | null> {
    const { rows } = await tx.execute(
      sql`SELECT version, reason, undone_at FROM job_queue_dismissals
           WHERE opportunity_id = ${opportunity}::uuid AND scope_kind = ${scope.kind}
             AND team_id IS NOT DISTINCT FROM ${scopeTeamId(scope)}::uuid`,
    )
    const row = rows[0]
    if (row === undefined) return null
    return {
      version: Number(row['version']),
      reason: String(row['reason']),
      undone: row['undone_at'] !== null,
    }
  }

  private async logAction(tx: SqlExecutor, action: ActionRow): Promise<void> {
    await tx.execute(
      sql`INSERT INTO job_queue_actions
            (kind, opportunity_id, actor_id, scope_kind, team_id, before_version, after_version,
             idempotency_key, reason)
          VALUES (${action.kind}, ${action.opportunity}::uuid, ${action.actorId}::uuid,
                  ${action.scope.kind}, ${scopeTeamId(action.scope)}::uuid,
                  ${action.before}, ${action.after}, ${action.key},
                  ${JSON.stringify(action.replay)})`,
    )
  }

  private async nameOf(tx: SqlExecutor, userId: string): Promise<string | null> {
    const { rows } = await tx.execute(
      sql`SELECT display_name FROM users WHERE id = ${userId}::uuid`,
    )
    return rows[0] === undefined ? null : String(rows[0]['display_name'])
  }
}

interface LockedCopy {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly employerName: string | null
}

interface EarlierAction {
  readonly replay: ActionReplay
  readonly version: number
  readonly createdAt: string
}

interface WrittenSubmission {
  readonly id: string
  readonly version: number
  readonly takenAt: string
}

interface ExistingDismissal {
  readonly version: number
  readonly reason: string
  readonly undone: boolean
}

interface ActionRow {
  readonly kind: 'TAKEN' | 'RELEASED' | 'DISMISSED' | 'UNDONE' | 'SUPPRESSED'
  readonly opportunity: string
  readonly actorId: string
  readonly scope: WriteScope
  readonly before: number | null
  readonly after: number | null
  readonly key: string
  readonly replay: ActionReplay
}

/** Zero rows means a conditional write lost its row under the lock: the generic conflict. */
function writtenSubmission(row: Record<string, unknown> | undefined): WrittenSubmission {
  if (row === undefined) throw versionConflict()
  return {
    id: String(row['id']),
    version: Number(row['version']),
    takenAt: isoInstant(row['taken_at']),
  }
}

function dismissalAnswer(
  opportunity: string,
  scope: WriteScope,
  earlier: EarlierAction,
  hidden: boolean,
): JobQueueDismissalResponseDto {
  return jobQueueDismissalResponseSchema.parse({
    opportunityId: opportunity,
    scope: scope.kind,
    reason: earlier.replay.dismissReason,
    hidden,
    version: earlier.version,
  })
}
