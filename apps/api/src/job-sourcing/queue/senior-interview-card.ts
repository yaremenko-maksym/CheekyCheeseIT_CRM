import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * The senior-facing half of an HR queue submission (task-sources-07c, owner decision 2026-11-19).
 *
 * A SENIOR has no access to the vacancy queue at all — not the suggestions, not the
 * opportunity-open action, not the exclusion filters (`JobSourcingService.assertNotSenior`). What
 * they see instead is the RESULT of HR's work, as an ordinary card on the Interviews page they
 * already use: `GET /interviews` is `@Roles('ADMIN','SENIOR','HR')` and
 * `InterviewAccessPolicyService` already scopes a SENIOR to their own rows, so nothing about the
 * read path changes here.
 *
 * ONE CARD PER (OPPORTUNITY, SENIOR), FOR THE CARD'S WHOLE LIFE. That is a database fact, not a
 * convention here: the partial unique index `uq_interviews_job_opportunity_senior`
 * (`2026-11-19_interviews_job_opportunity.sql`) enforces it. It has to be the opportunity and not
 * the assignment, because the REPLACE branch of `JobQueueActionsService.submit` DELETEs a RELEASED
 * assignment row and INSERTs a fresh one with a NEW id — keyed on the assignment, a
 * cancel-then-replace would hand the senior a second, duplicate card for the same vacancy.
 *
 * Both functions run inside the SAME transaction as the `job_queue_assignments` write, so a card
 * can never exist without its submission, nor a submission without its card.
 */

/**
 * Create — or bring back — the submitted senior's interview card.
 *
 * Three cases, one statement:
 *   * no card for this (opportunity, senior) yet → INSERT one in stage `SUBMITTED`;
 *   * a card exists and is `ARCHIVED` (HR cancelled earlier) → restore it to `SUBMITTED`, keeping
 *     every note the senior wrote. This is the mirror of {@link archiveSubmittedInterviewCard}
 *     that the owner asked for: a re-submit must not produce a second card;
 *   * a card exists in any other stage → LEAVE IT ALONE (the `DO UPDATE … WHERE` predicate). The
 *     senior has already moved it forward, and yanking it back to the first column would destroy
 *     real progress. The statement then touches no rows and returns `null`.
 *
 * `hrId` follows the rule `InterviewsService.create` already uses: the acting user when they are
 * an HR, NULL otherwise. The actor may be an ADMIN submitting in STUDIO scope, and writing an
 * ADMIN's id into a column named `hr_id` would corrupt the HR-summary reads.
 *
 * `company_name` is NOT NULL and capped at 255, while `job_opportunities.employer_name` is
 * nullable and unbounded — hence `COALESCE(…, o.title)` (title IS NOT NULL) and `left(…, 255)`.
 * `vacancy_url` is capped at 1000: an over-long URL becomes NULL rather than a truncated link that
 * would 404 on click.
 *
 * @returns the card's id — the SAME id across a cancel-and-resubmit cycle, which is what the
 *          "no second card" guarantee means in practice — or `null` when an existing card was
 *          deliberately left where the senior had put it.
 */
export async function createSubmittedInterviewCard(
  tx: SqlExecutor,
  input: {
    readonly opportunityId: string
    readonly seniorId: string
    /** The acting user's id, written to `hr_id` only when `actorIsHr`. */
    readonly actorId: string
    readonly actorIsHr: boolean
  },
): Promise<string | null> {
  const hrId = input.actorIsHr ? input.actorId : null
  const { rows } = await tx.execute(
    sql`INSERT INTO interviews
          (senior_id, hr_id, company_name, vacancy_url, stage, position,
           job_opportunity_id, match_key_changed_at)
        SELECT ${input.seniorId}::uuid,
               ${hrId}::uuid,
               left(COALESCE(o.employer_name, o.title), 255),
               CASE WHEN length(o.application_url) <= 1000 THEN o.application_url END,
               'SUBMITTED',
               (SELECT count(*) FROM interviews p
                 WHERE p.senior_id = ${input.seniorId}::uuid AND p.stage = 'SUBMITTED'),
               o.id,
               now()
          FROM job_opportunities o
         WHERE o.id = ${input.opportunityId}::uuid
        ON CONFLICT (job_opportunity_id, senior_id) WHERE job_opportunity_id IS NOT NULL
        DO UPDATE SET stage = 'SUBMITTED', updated_at = now()
              WHERE interviews.stage = 'ARCHIVED'
     RETURNING id`,
  )
  const row = rows[0]
  return row === undefined ? null : String(row['id'])
}

/**
 * HR cancelled the submission: take the card off the senior's active board (owner decision Q3).
 *
 * `ARCHIVED`, never `REJECTED` — nobody rejected the senior, HR withdrew them, and `REJECTED`
 * would be a false statement on a board the senior reads. Nothing the senior wrote is touched:
 * only `stage` moves, every `notes_*` column and the vacancy link survive, so a later re-submit
 * restores the card with its history intact.
 *
 * Terminal stages are left alone. A card already `HIRED` or `REJECTED` records an OUTCOME, and
 * withdrawing a submission must not erase one — in particular `HIRED` has already created a
 * project (`created_project_id`), which archiving would silently contradict.
 *
 * @returns the archived card's id, or `null` when there was nothing to archive (a hand-made card,
 *          a card already archived, or one in a terminal stage).
 */
export async function archiveSubmittedInterviewCard(
  tx: SqlExecutor,
  input: { readonly opportunityId: string; readonly seniorId: string },
): Promise<string | null> {
  const { rows } = await tx.execute(
    sql`UPDATE interviews
           SET stage = 'ARCHIVED', updated_at = now()
         WHERE job_opportunity_id = ${input.opportunityId}::uuid
           AND senior_id = ${input.seniorId}::uuid
           AND stage NOT IN ('ARCHIVED', 'HIRED', 'REJECTED')
     RETURNING id`,
  )
  const row = rows[0]
  return row === undefined ? null : String(row['id'])
}
