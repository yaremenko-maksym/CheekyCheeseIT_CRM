import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  archiveSubmittedInterviewCard,
  createSubmittedInterviewCard,
} from './senior-interview-card'

/**
 * task-sources-07c — the senior's interview card against a REAL Postgres, connected as `crm_app`
 * (the role the API actually runs under), so three things that no unit double can reach are facts
 * here rather than intentions:
 *
 *   1. **The statement is accepted at all.** `createSubmittedInterviewCard` writes `interviews` with
 *      raw SQL, so a NOT NULL column it does not supply, a `varchar` it overruns or an enum label
 *      the database has not got is a runtime 500 that the scripted-executor unit spec cannot see.
 *   2. **The grants suffice.** `interviews` is privilege class A, so the existing table-level
 *      INSERT/UPDATE should already cover the new `job_opportunity_id` column — "should" being
 *      exactly the kind of claim this suite exists to convert into a result. Running as `crm_app`
 *      and not as the migration role is the whole point.
 *   3. **One card per (opportunity, senior), for the card's whole life.** The upsert, the restore
 *      from ARCHIVED, and the deliberate refusal to drag a card the senior has already moved back
 *      to the first column are all decided by the partial unique index plus the `DO UPDATE … WHERE`
 *      predicate — i.e. by the database, not by the TypeScript.
 *
 * The index/column/FK shapes themselves are pinned by
 * `database/interviews-job-opportunity-forward-ddl.integration.spec.ts`, which applies the staged
 * DDL files twice against a scratch schema. This file assumes the schema is already there (via
 * `db:push`) and tests the BEHAVIOUR on top of it.
 *
 * ISOLATION: the database is shared. Every row this suite writes is tagged with a per-run
 * `randomUUID` and removed in `afterEach`; nothing is counted globally, so a foreign interview or
 * opportunity is never read, asserted on or deleted. NEVER `crm_db` — `beforeAll` refuses it:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-interview-card.integration.spec
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
/** The executor under test: `crm_app`, exactly as the request path has it. */
let app: SqlExecutor
let seniorId: string
let otherSeniorId: string
let hrId: string
let adminId: string

/** A user the interviews FK will accept. `admin`, because a spec must not need the API's grants. */
async function seedUser(role: 'SENIOR' | 'HR' | 'ADMIN'): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO users (email, display_name, role, google_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `07c-${TAG}-${role}-${randomUUID().slice(0, 6)}@example.test`,
      `07c ${role}`,
      role,
      `07c-${TAG}-${randomUUID()}`,
    ],
  )
  return String(rows[0].id)
}

/** One opportunity. `employerName`/`applicationUrl` are nullable, hence the explicit arguments. */
async function seedOpportunity(
  employerName: string | null,
  applicationUrl: string | null,
): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key, employer_name, application_url)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`07c ${TAG} fallback title`, `07c-${TAG}-title-key`, employerName, applicationUrl],
  )
  return String(rows[0].id)
}

interface CardRow {
  id: string
  stage: string
  hr_id: string | null
  company_name: string
  vacancy_url: string | null
  job_opportunity_id: string | null
  notes_domain: string | null
}

/** Read a card back through the migration role, so the grants never get a say in the assertion. */
async function readCard(id: string): Promise<CardRow | undefined> {
  const { rows } = await session.admin.query(
    `SELECT id, stage::text AS stage, hr_id, company_name, vacancy_url, job_opportunity_id,
            notes_domain
       FROM interviews WHERE id = $1`,
    [id],
  )
  return rows[0] as CardRow | undefined
}

describe.skipIf(!hasDatabaseUrl())('senior interview card on a real database', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    app = drizzle(session.pool)
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (String(rows[0].db) === 'crm_db') throw new Error('refusing to run against the live crm_db')
    seniorId = await seedUser('SENIOR')
    otherSeniorId = await seedUser('SENIOR')
    hrId = await seedUser('HR')
    adminId = await seedUser('ADMIN')
  }, 120_000)

  afterEach(async () => {
    // Only this run's rows: `interviews` cascades from the users, the opportunities are tagged.
    await session.admin.query(`DELETE FROM interviews WHERE senior_id = ANY($1::uuid[])`, [
      [seniorId, otherSeniorId],
    ])
    await session.admin.query(`DELETE FROM job_opportunities WHERE title_key = $1`, [
      `07c-${TAG}-title-key`,
    ])
  })

  afterAll(async () => {
    if (session === undefined) return
    await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [seniorId, otherSeniorId, hrId, adminId].filter(Boolean),
    ])
    await session.close()
  })

  it('creates the card in SUBMITTED, linked to the opportunity, as crm_app', async () => {
    // Also the grants assertion: a missing INSERT privilege on the new column would be 42501 here.
    const opportunityId = await seedOpportunity('Acme Logistics', 'https://jobs.example.test/a1')

    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(cardId).not.toBeNull()
    expect(await readCard(cardId!)).toMatchObject({
      stage: 'SUBMITTED',
      hr_id: hrId,
      company_name: 'Acme Logistics',
      vacancy_url: 'https://jobs.example.test/a1',
      job_opportunity_id: opportunityId,
    })
  })

  it('falls back to the opportunity title when the source states no employer', async () => {
    // `company_name` is NOT NULL and `employer_name` is nullable — without the COALESCE this is a
    // 23502 at the moment HR presses submit, which is a 500 in the product.
    const opportunityId = await seedOpportunity(null, null)

    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(await readCard(cardId!)).toMatchObject({
      company_name: `07c ${TAG} fallback title`,
      vacancy_url: null,
    })
  })

  it('leaves hr_id NULL when an ADMIN submits', async () => {
    const opportunityId = await seedOpportunity('Acme Logistics', null)

    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: adminId,
      actorIsHr: false,
    })

    expect(await readCard(cardId!)).toMatchObject({ hr_id: null })
  })

  it('a second submit of the same pair creates NO second card', async () => {
    // The guarantee the partial unique index exists for. Before it, the REPLACE branch of `submit`
    // (DELETE the released assignment, INSERT a new one) would have handed the senior a duplicate.
    const opportunityId = await seedOpportunity('Acme Logistics', null)
    const first = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    const second = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    // Already SUBMITTED, so the `WHERE stage = 'ARCHIVED'` predicate matches nothing: no row
    // returned, and — the part that matters — no row added.
    expect(second).toBeNull()
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM interviews
        WHERE job_opportunity_id = $1 AND senior_id = $2`,
      [opportunityId, seniorId],
    )
    expect(rows[0].n).toBe(1)
    expect(first).not.toBeNull()
  })

  it('cancel archives the card, and a re-submit restores THE SAME card with its notes', async () => {
    // Owner decision Q3: ARCHIVE on cancel, and a re-submit must not produce a second card. "The
    // same card" is the whole point — the senior's notes are on it.
    const opportunityId = await seedOpportunity('Acme Logistics', null)
    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })
    await session.admin.query(`UPDATE interviews SET notes_domain = $1 WHERE id = $2`, [
      'senior wrote this',
      cardId,
    ])

    const archived = await archiveSubmittedInterviewCard(app, { opportunityId, seniorId })
    expect(archived).toBe(cardId)
    expect(await readCard(cardId!)).toMatchObject({
      stage: 'ARCHIVED',
      notes_domain: 'senior wrote this',
    })

    const restored = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(restored).toBe(cardId)
    expect(await readCard(cardId!)).toMatchObject({
      stage: 'SUBMITTED',
      notes_domain: 'senior wrote this',
    })
  })

  it('a re-submit does NOT drag a card the senior has already moved back to the first column', async () => {
    // Real progress beats tidiness: the senior has reached TECH_INTERVIEW, and HR re-submitting
    // must not reset that. The statement touches no rows and says so by returning null.
    const opportunityId = await seedOpportunity('Acme Logistics', null)
    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })
    await session.admin.query(`UPDATE interviews SET stage = 'TECH_INTERVIEW' WHERE id = $1`, [
      cardId,
    ])

    const again = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(again).toBeNull()
    expect(await readCard(cardId!)).toMatchObject({ stage: 'TECH_INTERVIEW' })
  })

  it('archive never erases a recorded outcome — a HIRED card is left alone', async () => {
    // HIRED has already created a project. Archiving it would silently contradict that.
    const opportunityId = await seedOpportunity('Acme Logistics', null)
    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })
    await session.admin.query(`UPDATE interviews SET stage = 'HIRED' WHERE id = $1`, [cardId])

    expect(await archiveSubmittedInterviewCard(app, { opportunityId, seniorId })).toBeNull()
    expect(await readCard(cardId!)).toMatchObject({ stage: 'HIRED' })
  })

  it('archive is a no-op when there is no card for the pair', async () => {
    const opportunityId = await seedOpportunity('Acme Logistics', null)

    expect(await archiveSubmittedInterviewCard(app, { opportunityId, seniorId })).toBeNull()
  })

  it('two seniors submitted to one vacancy each get their own card', async () => {
    // The index is on the PAIR. If it were on the opportunity alone, the second senior's submission
    // would be swallowed and HR would see a success with nothing on the board.
    const opportunityId = await seedOpportunity('Acme Logistics', null)

    const a = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })
    const b = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId: otherSeniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('an over-long application URL becomes NULL rather than a truncated 404 link', async () => {
    // `vacancy_url` is varchar(1000) and `application_url` is unbounded text. A `left(…, 1000)`
    // would hand the senior a link that looks real and does not resolve.
    const long = `https://jobs.example.test/${'x'.repeat(1050)}`
    const opportunityId = await seedOpportunity('Acme Logistics', long)

    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    expect(await readCard(cardId!)).toMatchObject({ vacancy_url: null })
  })

  it('an over-long employer name is truncated, because company_name cannot be NULL', async () => {
    // The opposite call from the URL above, and deliberately so: a shortened company name is still
    // a usable label, while NULL is not allowed and dropping the card would lose the submission.
    const opportunityId = await seedOpportunity('E'.repeat(300), null)

    const cardId = await createSubmittedInterviewCard(app, {
      opportunityId,
      seniorId,
      actorId: hrId,
      actorIsHr: true,
    })

    const row = await readCard(cardId!)
    expect(row?.company_name).toHaveLength(255)
  })
})
