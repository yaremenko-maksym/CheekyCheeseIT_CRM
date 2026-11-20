import { Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { lockSeniorBoard } from '../../interviews/senior-board-lock'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Module-level, the same shape `sourcing-notice.ts` uses: these are free functions called inside
 * somebody else's transaction, not an injectable service.
 *
 * Both helpers can legitimately write NOTHING, and a silent no-op here means the senior-facing
 * half of a submission did not happen — the feature's entire purpose — with nothing anywhere
 * recording it (code review round 1, CR-L-2). Ids only in these lines: they go to the shared log,
 * so no name, employer or URL.
 */
// Stryker disable next-line StringLiteral: the logger context is a cosmetic label in log output only; no behaviour depends on it, so there is nothing to assert (same reasoning as `sourcing-notice.ts`)
const logger = new Logger('SeniorInterviewCard')

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
 *     that the owner asked for: a re-submit must not produce a second card. The restore also
 *     takes a FRESH `position` and refreshes `hr_id` — see below;
 *   * a card exists in any other stage → LEAVE IT ALONE (the `DO UPDATE … WHERE` predicate). The
 *     senior has already moved it forward, and yanking it back to the first column would destroy
 *     real progress. The statement then touches no rows and returns `null`.
 *
 * `hrId` follows the rule `InterviewsService.create` already uses: the acting user when they are
 * an HR, NULL otherwise. The actor may be an ADMIN submitting in STUDIO scope, and writing an
 * ADMIN's id into a column named `hr_id` would corrupt the HR-summary reads.
 *
 * WHAT THE RESTORE BRANCH UPDATES, AND WHAT IT DELIBERATELY DOES NOT (review round 1)
 *   * `position` — a FRESH one (CR-L-1). `GET /interviews` orders the board by
 *     `[asc(stage), asc(position)]` with no tie-break (`interviews.service.ts:117`), so two cards
 *     sharing a position order nondeterministically between requests. The restore used to leave
 *     the archived card's stale number behind.
 *   * `hr_id` — refreshed, under `COALESCE(EXCLUDED.hr_id, interviews.hr_id)` (SR-L-2). A senior
 *     shared between two teams could otherwise keep team A's HR on a card team B re-submitted.
 *     COALESCE rather than a bare `EXCLUDED.hr_id` because an ADMIN re-submit carries NULL, and
 *     replacing a real HR's attribution with NULL loses information instead of refreshing it.
 *     This is attribution and HR-summary reads only — interview ACCESS is decided by team
 *     membership (`interview-access-policy.service.ts`), never by `hr_id`.
 *   * `company_name` / `vacancy_url` — NOT touched, on purpose. Both are user-editable through
 *     `updateInterviewSchema`, so overwriting them with the vacancy's copy would silently revert
 *     a correction somebody made by hand.
 *
 * `position` counts from `max + 1`, not from `count(*)` (CR-L-1). Archiving a card does not
 * renormalise the SUBMITTED column, so the count is not the number of positions in use: submit A
 * (0) and B (1), cancel A, submit C — the count of SUBMITTED cards is 1, so C would also get 1 and
 * tie with B. `InterviewsService.create` still uses a count, which is a pre-existing latent tie on
 * the hand-made path and out of this change's scope.
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
  // CR6-L-3: the `max + 1` below is read under the same board lock a card move takes, so a
  // submit racing a move cannot land on a position the move is renumbering.
  await lockSeniorBoard(tx, input.seniorId)
  const { rows } = await tx.execute(
    sql`INSERT INTO interviews
          (senior_id, hr_id, company_name, vacancy_url, stage, position,
           job_opportunity_id, match_key_changed_at)
        SELECT ${input.seniorId}::uuid,
               ${hrId}::uuid,
               left(COALESCE(o.employer_name, o.title), 255),
               CASE WHEN length(o.application_url) <= 1000 THEN o.application_url END,
               'SUBMITTED',
               (SELECT COALESCE(max(p.position) + 1, 0) FROM interviews p
                 WHERE p.senior_id = ${input.seniorId}::uuid AND p.stage = 'SUBMITTED'),
               o.id,
               now()
          FROM job_opportunities o
         WHERE o.id = ${input.opportunityId}::uuid
        ON CONFLICT (job_opportunity_id, senior_id) WHERE job_opportunity_id IS NOT NULL
        DO UPDATE SET stage = 'SUBMITTED',
                      position = EXCLUDED.position,
                      hr_id = COALESCE(EXCLUDED.hr_id, interviews.hr_id),
                      updated_at = now()
              WHERE interviews.stage = 'ARCHIVED'
     RETURNING id`,
  )
  const row = rows[0]
  if (row === undefined) {
    logger.warn(
      `SENIOR_INTERVIEW_CARD_NOT_CREATED opportunity=${input.opportunityId} senior=${input.seniorId}`,
    )
    return null
  }
  return String(row['id'])
}

/**
 * HR cancelled the submission: take the card off the senior's active board (owner decision Q3).
 *
 * `ARCHIVED`, never `REJECTED` — nobody rejected the senior, HR withdrew them, and `REJECTED`
 * would be a false statement on a board the senior reads. Nothing the senior wrote is touched:
 * only `stage` moves, every `notes_*` column and the vacancy link survive, so a later re-submit
 * restores the card with its history intact.
 *
 * ONLY OUT OF `SUBMITTED` (security review round 1, SR-M-3). This is the exact mirror of
 * {@link createSubmittedInterviewCard}'s `DO UPDATE … WHERE interviews.stage = 'ARCHIVED'`: create
 * refuses to drag a moved card back, so archive refuses to take a moved card away. The predicate
 * used to be `NOT IN ('ARCHIVED','HIRED','REJECTED')`, which still matched `HR_SCREEN`,
 * `ENGLISH_CHECK`, `TECH_INTERVIEW`, `FINAL_INTERVIEW`, `CLIENT_INTERVIEW` and `OFFER_RECEIVED` —
 * so an HR cancel silently archived a card the senior had already progressed through real
 * interview stages, and the loss was not even recoverable in place: a re-submit restores only from
 * `ARCHIVED`, which the card now was, so it came back in `SUBMITTED` with its progress erased.
 *
 * This NARROWS the owner's Q3 ("ARCHIVE the card on HR cancel") to the case Q3 was about: a
 * submission nobody has acted on yet. A card mid-process stays on the board, where whoever is
 * running that process can still archive it by hand. Terminal stages (`HIRED`, `REJECTED`) are
 * untouched for the same reason as before — they record an OUTCOME, and `HIRED` has already
 * created a project (`created_project_id`) that archiving would silently contradict.
 *
 * @returns the archived card's id, or `null` when there was nothing in `SUBMITTED` to archive (a
 *          hand-made card, a card already archived, one the senior has progressed, or a terminal
 *          one). `null` is logged, because a cancel that took nothing off the board is otherwise
 *          as invisible as a submission that created nothing.
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
           AND stage = 'SUBMITTED'
     RETURNING id`,
  )
  const row = rows[0]
  if (row === undefined) {
    logger.warn(
      `SENIOR_INTERVIEW_CARD_NOT_ARCHIVED opportunity=${input.opportunityId} senior=${input.seniorId}`,
    )
    return null
  }
  return String(row['id'])
}
