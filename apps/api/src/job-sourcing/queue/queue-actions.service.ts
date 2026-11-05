import { createHash } from 'node:crypto'
import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'
import {
  jobQueueDismissalResponseSchema,
  jobQueueDismissReasonSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueSubmissionResponseSchema,
  type JobQueueCancelSubmissionRequestDto,
  type JobQueueDismissalResponseDto,
  type JobQueueDismissRequestDto,
  type JobQueueManualCardRequestDto,
  type JobQueueOpenedRequestDto,
  type JobQueueSubmissionResponseDto,
  type JobQueueSubmitRequestDto,
  type JobQueueSuppressRequestDto,
  type JobQueueUndoRequestDto,
  type SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import { isDeadlock, uniqueViolationConstraint } from '../../database/pg-errors'
import { findMatchingExclusion } from '../filtering'
import { exclusionPosting } from '../funnel/evaluate'
import { normalizeCompanyName, normalizeTitle } from '../identity/resolver'
import { canonicalizePostingUrl } from '../job-source.provider'
import { loadOpportunity, loadSeniorExclusions } from '../runtime/recompute-inputs'
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
import {
  canonicalUuid,
  possibleDuplicateJoin,
  scopedTeamRowPredicate,
  visibleOpportunityPredicate,
} from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/** The duplicates preview's bound (`jobQueueDuplicatesPreviewSchema`). */
const DUPLICATES_PREVIEW_MAX = 5

const IDEMPOTENCY_CONSTRAINT = 'uq_job_queue_actions_actor_idempotency'
const SUBMISSION_CONSTRAINT = 'uq_job_queue_assignments_opportunity_senior'
const DISMISSAL_CONSTRAINT = 'uq_job_queue_dismissals_opportunity_scope'

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
const versionConflict = () => apiError('JOB_QUEUE_VERSION_CONFLICT', HttpStatus.CONFLICT)
const idempotencyConflict = () => apiError('JOB_QUEUE_IDEMPOTENCY_CONFLICT', HttpStatus.CONFLICT)
const seniorIneligible = () =>
  apiError('JOB_QUEUE_SENIOR_INELIGIBLE', HttpStatus.UNPROCESSABLE_ENTITY)
const resumeUnusable = () => apiError('JOB_QUEUE_RESUME_UNUSABLE', HttpStatus.UNPROCESSABLE_ENTITY)
const manualDuplicate = () => apiError('JOB_QUEUE_MANUAL_DUPLICATE', HttpStatus.CONFLICT)

/**
 * The advisory-lock class of a manual card's application-URL key: two concurrent creates with one
 * link serialize on it, so the second sees the first card. The second key is `hashtext(urlKey)`.
 */
const MANUAL_URL_LOCK_CLASS = 0x6d616e75

function withoutFragment(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  return url.href
}

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
 * Every write is one transaction, in this order:
 *   1. the scope, resolved INSIDE the transaction (`JobQueueScopeService.resolve`, never cached);
 *   2. the opportunity rows locked, in sorted id order (`FOR NO KEY UPDATE`: mutually exclusive
 *      between writers, and it does not block the FK checks of other tables' inserts);
 *   3. the actor's live role, the scope's team and the actor's membership, `FOR SHARE`: a demotion,
 *      an archival or a leave either committed first (the statement sees it and refuses) or waits
 *      for this commit;
 *   4. the target: visible in the scope, or for cancel and undo a row inside the scope;
 *   5. the idempotency key: a retry answers from the log. After the locks, so a concurrent retry
 *      of one key on one opportunity waits and finds the first one's row; and after step 4, so a
 *      key is no existence oracle: a hidden target and a missing one answer the same 404 whatever
 *      the key, and a retry whose target has since become invisible gets that 404 too (fail closed);
 *   6. the action's own policy;
 *   7. the versioned write and its `job_queue_actions` row, so an audit failure rolls it back.
 *
 * WHY CANCEL AND UNDO DO NOT CALL `assertVisible`, and only they: they correct a record the actor's
 * own scope wrote, and reveal nothing the scope does not already hold. An opportunity stops being
 * visible on every revision bump until its recompute, and for good once its only matching senior
 * has left; with the check, a team could then never correct "logged by mistake". They still need a
 * live scope, a live actor and a row inside the scope (`scopedTeamRowPredicate`), and anything else
 * is the same 404. The same holds after an ADMIN's suppression (r5 Task 6.4): a team may still
 * cancel its own submission or undo its own dismissal on a suppressed opportunity, because the
 * answer carries only that team's own row and the opportunity stays absent from every read.
 *
 * WHY A STOP-LISTED OR INELIGIBLE SENIOR IS A 404: HR sees how many seniors excluded an opportunity,
 * not who (plan §4). The shared 404 hides the reason, not the senior: HR names the senior in the
 * request, so comparing the answers for its team's seniors still shows which of them cannot be
 * submitted. It cannot tell a stop-list from a lost eligibility, or a missing posting.
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
      await this.lockActor(tx, user, scope)
      await this.scopes.assertVisible(scope, opportunity, tx)
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
      if (earlier !== null) {
        return this.submissionAnswer(tx, opportunity, earlier, 'TAKEN', seniorId, user.id)
      }

      await this.assertSeniorEligible(tx, scope, seniorId, opportunity)
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
        replay: { fp: fingerprint, submissionId: row.id, submittedAt: row.takenAt },
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

  /**
   * r5 Phase 6 — POST /job-queue/manual: an HR / ADMIN creates a card for a vacancy found outside
   * the sources, and the same transaction submits a senior of the named team to it, so a card never
   * exists without its submission: any refusal below rolls the card back with everything else.
   *
   * The card is owned by the team (`manual_team_id`): only that team sees it (the MANUAL branch of
   * `visibleOpportunityPredicate`). It has no source record and no match row, and every match
   * evaluation path skips it (the recompute enqueue, the roster fan-out, the evaluation worker's
   * `loadOpportunity`): only its own team ever works on it.
   * The role re-check behind the controller's `@Roles` is `resolve`'s: a role outside ADMIN / HR is
   * a 403 there. The scope must be TEAM: an HR outside the team, like an unknown or archived team,
   * is the 404.
   * Unlike `submit`, an ineligible senior or an unusable resume is a 422: the actor creates the card
   * and names both, so the refusal discloses nothing about an existing opportunity.
   *
   * Duplicates, two layers. (1) An `applicationUrl` is reduced to the posting dedupe key
   * (`canonicalizePostingUrl`, stored as `application_url_key`); ANY opportunity, whatever its
   * visibility, already carrying that key or exactly that link refuses the create with the generic
   * `JOB_QUEUE_MANUAL_DUPLICATE` (409), which names no team and no card. A card without a link
   * cannot be checked this way. (2) The senior's live submission to a possible duplicate in the
   * actor's scope is `submit`'s `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` until the request confirms.
   */
  async createManualCard(
    user: SessionUser,
    request: JobQueueManualCardRequestDto,
  ): Promise<JobQueueSubmissionResponseDto> {
    const teamId = canonicalUuid(request.submission.teamId)
    const seniorId = canonicalUuid(request.submission.seniorId)
    const resumeId = canonicalUuid(request.submission.resumeId)
    if (teamId === null || seniorId === null || resumeId === null) throw notFound()
    const descriptionSha256 = createHash('sha256').update(request.descriptionMd).digest('hex')
    const applicationUrl = request.applicationUrl ?? null
    // The schema admits https only, which the dedupe key always accepts.
    const urlKey = canonicalizePostingUrl(applicationUrl)
    // A sourced row stores its link as the parsed href with the fragment cleared.
    const urlHref = applicationUrl === null ? null : withoutFragment(applicationUrl)
    return this.write(async (tx) => {
      const scope = await this.writeScope(user, teamId, tx)
      if (scope.kind !== 'TEAM') throw notFound()
      await this.lockActor(tx, user, scope)
      const fingerprint = requestFingerprint([
        'MANUAL',
        teamId,
        seniorId,
        resumeId,
        request.title,
        request.companyName,
        applicationUrl,
        descriptionSha256,
        request.confirmPossibleDuplicate,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) {
        await this.scopes.assertVisible(scope, earlier.opportunity, tx)
        return this.submissionAnswer(tx, earlier.opportunity, earlier, 'TAKEN', seniorId, user.id)
      }

      if (urlKey !== null) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${MANUAL_URL_LOCK_CLASS}::int, hashtext(${urlKey}))`,
        )
        const taken = await tx.execute(
          sql`SELECT 1 FROM job_opportunities
               WHERE application_url_key = ${urlKey} OR application_url = ${urlHref}
               LIMIT 1`,
        )
        if (taken.rows.length > 0) throw manualDuplicate()
      }

      await tx.execute(
        sql`INSERT INTO job_text_blobs (sha256, text)
            VALUES (${descriptionSha256}, ${request.descriptionMd})
            ON CONFLICT (sha256) DO NOTHING`,
      )
      const card = await tx.execute(
        sql`INSERT INTO job_opportunities
              (title, title_key, employer_name, employer_key, application_url,
               application_url_key, description_sha256, manual_team_id)
            VALUES (${request.title}, ${normalizeTitle(request.title)}, ${request.companyName},
                    ${normalizeCompanyName(request.companyName)}, ${applicationUrl},
                    ${urlKey}, ${descriptionSha256}, ${teamId}::uuid)
         RETURNING id`,
      )
      const opportunity = String(card.rows[0]?.['id'])
      const copies = await this.lockDuplicateSet(tx, opportunity)
      await this.assertSeniorEligible(tx, scope, seniorId, opportunity, seniorIneligible)
      const resume = await this.scopes.policy(() =>
        tx.execute(
          sql`SELECT id FROM senior_resumes
               WHERE id = ${resumeId}::uuid AND user_id = ${seniorId}::uuid AND status = 'READY'
                 FOR SHARE`,
        ),
      )
      if (resume.rows.length === 0) throw resumeUnusable()
      if (!request.confirmPossibleDuplicate) {
        await this.assertNoClaimedDuplicate(tx, scope, seniorId, opportunity, copies)
      }

      const row = await this.insertSubmission(tx, opportunity, seniorId, scope, user.id, resumeId)
      await this.logAction(tx, {
        kind: 'TAKEN',
        opportunity,
        actorId: user.id,
        scope,
        before: 0,
        after: row.version,
        key: request.idempotencyKey,
        replay: { fp: fingerprint, submissionId: row.id, submittedAt: row.takenAt, resumeId },
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
      await this.lockActor(tx, user, scope)
      const { rows } = await tx.execute(
        sql`SELECT a.senior_id, a.assignee_id, a.state, a.version, a.taken_at
              FROM job_queue_assignments a
             WHERE a.id = ${submission}::uuid AND a.opportunity_id = ${opportunity}::uuid
               AND ${scopedTeamRowPredicate(scope, sql`a.team_id`)}`,
      )
      const row = rows[0]
      if (row === undefined) throw notFound()
      const assigneeId = String(row['assignee_id'])
      const seniorId = String(row['senior_id'])
      const fingerprint = requestFingerprint([
        'RELEASED',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        submission,
        request.expectedVersion,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) {
        return this.submissionAnswer(tx, opportunity, earlier, 'RELEASED', seniorId, assigneeId)
      }

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
      const submittedAt = isoInstant(row['taken_at'])
      await this.logAction(tx, {
        kind: 'RELEASED',
        opportunity,
        actorId: user.id,
        scope,
        before: request.expectedVersion,
        after: Number(after['version']),
        key: request.idempotencyKey,
        replay: { fp: fingerprint, submissionId: submission, submittedAt },
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
      await this.lockActor(tx, user, scope)
      await this.scopes.assertVisible(scope, opportunity, tx)
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
      await this.lockActor(tx, user, scope)
      const existing = await this.existingDismissal(tx, opportunity, scope)
      if (existing === null) throw notFound()
      const fingerprint = requestFingerprint([
        'UNDONE',
        opportunity,
        scope.kind,
        scopeTeamId(scope),
        request.expectedVersion,
      ])
      const earlier = await this.earlierAction(tx, user.id, request.idempotencyKey, fingerprint)
      if (earlier !== null) return dismissalAnswer(opportunity, scope, earlier, false)

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
   * behind a submission. The actor is checked live, like every write, and the source record must be
   * a live link of this opportunity.
   */
  async opened(
    user: SessionUser,
    opportunityId: string,
    request: JobQueueOpenedRequestDto,
  ): Promise<void> {
    const opportunity = canonicalUuid(opportunityId)
    const sourceRecord = canonicalUuid(request.sourceRecordId)
    if (opportunity === null || sourceRecord === null) throw notFound()
    await this.write(async (tx) => {
      const scope = await this.writeScope(user, request.teamId, tx)
      await this.lockActor(tx, user, scope)
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
   * lets SUPPRESSED carry no version for that reason), so the action row IS the record, and
   * `visibleOpportunityPredicate` reads it: every TEAM read and write that checks visibility stops
   * seeing the opportunity. The request is the wire schema the route has already parsed.
   */
  async suppress(
    user: SessionUser,
    opportunityId: string,
    { idempotencyKey }: JobQueueSuppressRequestDto,
  ): Promise<void> {
    const opportunity = canonicalUuid(opportunityId)
    if (opportunity === null) throw notFound()
    await this.write(async (tx) => {
      const scope = await this.scopes.resolve(user, undefined, tx)
      if (scope.kind !== 'STUDIO') throw new ForbiddenException()
      await this.lockTarget(tx, opportunity)
      await this.lockActor(tx, user, scope)
      const fingerprint = requestFingerprint(['SUPPRESSED', opportunity])
      const earlier = await this.earlierAction(tx, user.id, idempotencyKey, fingerprint)
      if (earlier !== null) return
      await this.logAction(tx, {
        kind: 'SUPPRESSED',
        opportunity,
        actorId: user.id,
        scope,
        before: null,
        after: null,
        key: idempotencyKey,
        replay: { fp: fingerprint },
      })
    })
  }

  /**
   * One transaction, and what the locks do not make impossible. The same key used concurrently on
   * ANOTHER opportunity shares no lock: its 23505 rolled this attempt back, so one rerun answers
   * from the log (the replay or the idempotency conflict). Lock order is not global (a sibling write
   * can hold a user row this one waits for), so a deadlock victim gets the same one rerun: its
   * transaction rolled back whole, so nothing is applied twice. A submission or dismissal violation
   * is a lost race on a key the locks should have serialized: the generic conflict, which names no
   * row. Anything else, a second deadlock included, is not anticipated and stays an error.
   */
  private async write<T>(body: (tx: SqlExecutor) => Promise<T>, mayRerun = true): Promise<T> {
    try {
      return await this.database.db.transaction((tx) => body(tx))
    } catch (err: unknown) {
      const constraint = uniqueViolationConstraint(err)
      if (constraint === SUBMISSION_CONSTRAINT || constraint === DISMISSAL_CONSTRAINT) {
        throw versionConflict()
      }
      if (mayRerun && (constraint === IDEMPOTENCY_CONSTRAINT || isDeadlock(err))) {
        return this.write(body, false)
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
   * The target and its possible-duplicate set (`possibleDuplicateJoin`), locked in sorted id
   * order. A row the scope cannot see may be locked here, but no answer carries its content:
   * only the target's answer and the visible, own-scope conflict below are returned. What such a
   * lock can expose is its wait: a caller may be slowed by a write on a copy it cannot see.
   */
  private async lockDuplicateSet(tx: SqlExecutor, opportunity: string): Promise<LockedCopy[]> {
    const { rows } = await tx.execute(
      sql`SELECT d.id, d.revision, d.title, d.employer_name
            FROM job_opportunities t
            JOIN job_opportunities d ON ${possibleDuplicateJoin('t', 'd')}
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
      sql`SELECT reason, after_version, created_at, opportunity_id FROM job_queue_actions
           WHERE actor_id = ${actorId}::uuid AND idempotency_key = ${key}`,
    )
    const row = rows[0]
    if (row === undefined) return null
    const replay = parseActionReplay(row['reason'])
    if (replay === null || replay.fp !== fingerprint) throw idempotencyConflict()
    return {
      opportunity: String(row['opportunity_id']),
      replay,
      version: Number(row['after_version']),
      createdAt: isoInstant(row['created_at']),
    }
  }

  /**
   * The earlier success from the log (its id, instant and version): never read from the current row
   * of the opportunity and senior, which may be another team's. The senior and assignee come from
   * the caller, who took them from the verified request or from the in-scope row the key's id names.
   */
  private async submissionAnswer(
    tx: SqlExecutor,
    opportunity: string,
    earlier: EarlierAction,
    state: 'TAKEN' | 'RELEASED',
    seniorId: string,
    assigneeId: string,
  ): Promise<JobQueueSubmissionResponseDto> {
    const { replay } = earlier
    return jobQueueSubmissionResponseSchema.parse({
      submission: {
        id: replay.submissionId,
        opportunityId: opportunity,
        seniorId,
        state,
        submittedAt: replay.submittedAt,
        cancelledAt: state === 'RELEASED' ? earlier.createdAt : null,
        version: earlier.version,
        submittedByName: await this.nameOf(tx, assigneeId),
      },
    })
  }

  /**
   * The actor as the database has them NOW, and the scope's team: same role, not archived, the team
   * live and not archived, still a member (an HR). All `FOR SHARE`, so none of it can change under
   * the write.
   */
  private async lockActor(tx: SqlExecutor, user: SessionUser, scope: WriteScope): Promise<void> {
    const actor = await this.scopes.policy(() =>
      tx.execute(
        sql`SELECT id FROM users
             WHERE id = ${user.id}::uuid AND role = ${user.role} AND archived_at IS NULL
               FOR SHARE`,
      ),
    )
    if (actor.rows.length === 0) throw notFound()
    if (scope.kind === 'TEAM') {
      const team = await this.scopes.policy(() =>
        tx.execute(
          sql`SELECT id FROM teams
               WHERE id = ${scope.teamId}::uuid AND archived_at IS NULL AND type = 'SENIOR'
                 FOR SHARE`,
        ),
      )
      if (team.rows.length === 0) throw notFound()
    }
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
   * with membership, user and team locked `FOR SHARE`, so a leave or an archival of any of them
   * cannot pass this check and commit under the write; and who has not stop-listed the opportunity.
   * Their own entries, matched on the funnel's posting (so the DOU slug alias counts) and through its
   * row mapping; a studio-wide exclusion is the opportunity's verdict, and triage may be submitted.
   */
  private async assertSeniorEligible(
    tx: SqlExecutor,
    scope: WriteScope,
    seniorId: string,
    opportunity: string,
    refuse: () => HttpException = notFound,
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
               FOR SHARE OF tm, u, t`,
      ),
    )
    if (member.rows.length === 0) throw refuse()
    const loaded = await this.scopes.policy(() => loadOpportunity(tx, opportunity))
    if (loaded === null) throw refuse()
    const own = await this.scopes.policy(() => loadSeniorExclusions(tx, seniorId))
    const stopListed = findMatchingExclusion(exclusionPosting(loaded.canonical), own)
    if (stopListed !== null) throw refuse()
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
    /** Only the manual card names one; an ordinary submit records NULL. */
    resumeId: string | null = null,
  ): Promise<WrittenSubmission> {
    const { rows } = await tx.execute(
      sql`INSERT INTO job_queue_assignments
            (opportunity_id, senior_id, scope_kind, team_id, assignee_id, resume_id)
          VALUES (${opportunity}::uuid, ${seniorId}::uuid, ${scope.kind},
                  ${scopeTeamId(scope)}::uuid, ${actorId}::uuid, ${resumeId}::uuid)
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
  /** The opportunity the logged action wrote: a manual card's retry learns its card from here. */
  readonly opportunity: string
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
