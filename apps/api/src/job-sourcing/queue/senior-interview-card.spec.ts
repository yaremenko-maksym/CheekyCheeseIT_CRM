import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

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
    // HIRED/REJECTED record an OUTCOME — and HIRED has already created a project.
    expect(sql).toContain("stage NOT IN ('ARCHIVED', 'HIRED', 'REJECTED')")
    expect(seen[0]!.params).toEqual([OPPORTUNITY, SENIOR])
  })
})
