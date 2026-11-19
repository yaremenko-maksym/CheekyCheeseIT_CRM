import { Logger } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import type { SqlExecutor } from '../scheduling/host-state'
import {
  archiveSubmittedInterviewCard,
  createSubmittedInterviewCard,
} from './senior-interview-card'

/**
 * task-sources-07c — the senior's interview card against a scripted executor.
 *
 * The real-DB behaviour (the partial unique index actually rejecting a second card, the
 * `ON CONFLICT` landing on it, the NULL exemption) is proven in
 * `interviews-job-opportunity-forward-ddl.integration.spec.ts` and
 * `senior-interview-card.integration.spec.ts`. This spec pins what a unit double CAN see, and it
 * exists because the mutation gate runs the unit suite only and cannot execute an
 * `*.integration.spec.ts` at all (`.claude/rules/common/mutation-gate-integration-specs.md`): the
 * `actorIsHr` branch and the row→outcome mapping would otherwise be reported `NoCoverage`.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const OPPORTUNITY = '6f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60'
const SENIOR = '1a2b3c4d-5e6f-4071-8a92-b3c4d5e6f701'
const ACTOR = '2b3c4d5e-6f70-4182-9a03-c4d5e6f70812'
const CARD = '3c4d5e6f-7081-4293-8a14-d5e6f7081923'

function scripted(rows: Record<string, unknown>[] = []) {
  const seen: { sql: string; params: unknown[] }[] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      seen.push(render(q))
      return Promise.resolve({ rows })
    },
  }
  return { tx, seen }
}

describe('createSubmittedInterviewCard', () => {
  it('writes the acting HR into hr_id', async () => {
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.params).toContain(ACTOR)
  })

  it('leaves hr_id NULL when the actor is not an HR', async () => {
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: false,
    })

    // An ADMIN submitting in STUDIO scope must not land in a column named `hr_id`: the
    // HR-summary reads treat it as "this HR's interview".
    expect(seen[0]!.params).not.toContain(ACTOR)
    expect(seen[0]!.params).toContain(null)
  })

  it('returns the card id the statement wrote', async () => {
    const { tx } = scripted([{ id: CARD }])

    await expect(
      createSubmittedInterviewCard(tx, {
        opportunityId: OPPORTUNITY,
        seniorId: SENIOR,
        actorId: ACTOR,
        actorIsHr: true,
      }),
    ).resolves.toBe(CARD)
  })

  it('returns null when the existing card was deliberately left where the senior put it', async () => {
    // No row comes back: the pair already has a card past SUBMITTED, so the
    // `DO UPDATE … WHERE stage = 'ARCHIVED'` predicate matched nothing.
    const { tx } = scripted([])

    await expect(
      createSubmittedInterviewCard(tx, {
        opportunityId: OPPORTUNITY,
        seniorId: SENIOR,
        actorId: ACTOR,
        actorIsHr: true,
      }),
    ).resolves.toBeNull()
  })

  it('upserts on the (job_opportunity_id, senior_id) pair and restores only from ARCHIVED', async () => {
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    const sql = seen[0]!.sql
    // Keyed on the opportunity, never the assignment: the REPLACE branch of `submit` deletes the
    // assignment row and re-inserts it with a NEW id, so an assignment key would hand the senior
    // a second card for the same vacancy.
    expect(sql).toContain('ON CONFLICT (job_opportunity_id, senior_id)')
    expect(sql).toContain("DO UPDATE SET stage = 'SUBMITTED'")
    expect(sql).toContain("WHERE interviews.stage = 'ARCHIVED'")
  })

  it('gives a restored card a fresh position, so it cannot tie with a card already there', async () => {
    // CR-L-1. `GET /interviews` orders by `[asc(stage), asc(position)]` with NO tie-break
    // (`interviews.service.ts:117`), so two cards sharing a position in the SUBMITTED column
    // order nondeterministically between requests. The restore branch used to update `stage` and
    // `updated_at` only, leaving the archived card's stale position.
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    expect(seen[0]!.sql).toContain('position = EXCLUDED.position')
  })

  it('numbers a new card from the highest position, not from the count', async () => {
    // CR-L-1, the other half: `count(*)` ties even on the pure INSERT path, because archiving a
    // card does NOT renormalise the SUBMITTED column. Submit A (0) and B (1), cancel A, submit C:
    // the count of SUBMITTED cards is 1, so C also gets 1 — and ties with B. `max + 1` cannot.
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    const sql = seen[0]!.sql
    expect(sql).toContain('max(p.position)')
    expect(sql).not.toContain('count(*)')
  })

  it('refreshes hr_id on a restore, without nulling it for an ADMIN re-submit', async () => {
    // SR-L-2. After team A cancels and team B re-submits a senior shared between the teams,
    // `hr_id` would otherwise still name team A's HR. COALESCE, not a bare EXCLUDED: an ADMIN
    // re-submit carries a NULL `hr_id`, and overwriting a real HR's attribution with NULL would
    // lose information rather than refresh it. (Attribution and HR-summary reads only — interview
    // ACCESS is by team membership, `interview-access-policy.service.ts`, never by `hr_id`.)
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    expect(seen[0]!.sql).toContain('hr_id = COALESCE(EXCLUDED.hr_id, interviews.hr_id)')
  })

  it('does NOT overwrite the editable company_name or vacancy_url on a restore', async () => {
    // SR-L-2, the deliberate half. Both columns are user-editable through
    // `updateInterviewSchema` (`packages/shared/src/schemas/interviews.ts`), so a card someone
    // corrected by hand must not be silently reverted to the vacancy's copy by a re-submit.
    const { tx, seen } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    const doUpdate = seen[0]!.sql.slice(seen[0]!.sql.indexOf('DO UPDATE'))
    expect(doUpdate).not.toContain('company_name')
    expect(doUpdate).not.toContain('vacancy_url')
  })

  it('logs the pair when no card was created, so a cardless submission is findable', async () => {
    // CR-L-2. `null` means the submission produced NO card (the pair sits in a non-ARCHIVED
    // stage — e.g. REJECTED from an earlier round, which the restore predicate will not touch).
    // The senior then sees nothing new and, before this, nothing anywhere recorded that the
    // feature's whole purpose silently did not happen.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { tx } = scripted([])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('SENIOR_INTERVIEW_CARD_NOT_CREATED')
    // Ids only — never a name, an employer or a URL: this line goes to the shared log.
    expect(message).toContain(OPPORTUNITY)
    expect(message).toContain(SENIOR)
    warn.mockRestore()
  })

  it('does not log when a card WAS created', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { tx } = scripted([{ id: CARD }])

    await createSubmittedInterviewCard(tx, {
      opportunityId: OPPORTUNITY,
      seniorId: SENIOR,
      actorId: ACTOR,
      actorIsHr: true,
    })

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('archiveSubmittedInterviewCard', () => {
  it('returns the archived card id', async () => {
    const { tx } = scripted([{ id: CARD }])

    await expect(
      archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR }),
    ).resolves.toBe(CARD)
  })

  it('returns null when there was nothing to archive', async () => {
    const { tx } = scripted([])

    await expect(
      archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR }),
    ).resolves.toBeNull()
  })

  it('archives, never rejects, and never touches a recorded outcome', async () => {
    const { tx, seen } = scripted([{ id: CARD }])

    await archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR })

    const sql = seen[0]!.sql
    // ARCHIVED, not REJECTED: nobody rejected the senior, HR withdrew the submission.
    expect(sql).toContain("SET stage = 'ARCHIVED'")
    expect(sql).not.toContain("SET stage = 'REJECTED'")
    expect(seen[0]!.params).toEqual([OPPORTUNITY, SENIOR])
  })

  it('archives a card ONLY out of SUBMITTED, leaving every progressed stage alone', async () => {
    // SR-M-3. This is the mirror of the create side's `DO UPDATE … WHERE stage = 'ARCHIVED'`,
    // and it was missing. The predicate used to be `NOT IN ('ARCHIVED','HIRED','REJECTED')`,
    // which still included HR_SCREEN, ENGLISH_CHECK, TECH_INTERVIEW, FINAL_INTERVIEW,
    // CLIENT_INTERVIEW and OFFER_RECEIVED — so an HR cancel archived a card the senior had
    // already progressed through real interview stages. Worse, it was then irrecoverable in
    // place: a re-submit restores only from ARCHIVED, which the card now was, so it came back in
    // SUBMITTED with its progress erased. Create refuses to drag a moved card forward; archive
    // now refuses to take a moved card away.
    const { tx, seen } = scripted([{ id: CARD }])

    await archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR })

    const sql = seen[0]!.sql
    expect(sql).toContain("stage = 'SUBMITTED'")
    expect(sql).not.toContain('stage NOT IN')
  })

  it('logs the pair when there was no SUBMITTED card to archive', async () => {
    // CR-L-2, the archive half: a cancel that took nothing off the senior's board is exactly as
    // invisible as a submission that created nothing, and now equally findable.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { tx } = scripted([])

    await archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR })

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('SENIOR_INTERVIEW_CARD_NOT_ARCHIVED')
    expect(message).toContain(OPPORTUNITY)
    expect(message).toContain(SENIOR)
    warn.mockRestore()
  })

  it('does not log when a card WAS archived', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { tx } = scripted([{ id: CARD }])

    await archiveSubmittedInterviewCard(tx, { opportunityId: OPPORTUNITY, seniorId: SENIOR })

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
