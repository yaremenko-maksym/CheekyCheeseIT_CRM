import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import type { NormalizedPosting } from '../job-source.provider'
import {
  type BridgeRun,
  type RosterSenior,
  drainPostings,
  drainSuggestions,
  enqueueLegacyPostings,
} from './bridge-delivery'
import { contentVersion } from './content-version'

/**
 * r5 Task 4.6 S6d — the durable bridge drains (T1 / T3 / T4) against a REAL Postgres, AS `crm_app`.
 * The ADR crash table (`2026-10-31-dou-bridge-run-ownership.md`, section 2) is proven here: each
 * row's post-crash state is built, then the next run's retry is shown idempotent and
 * `createSuggestions` is never offered an empty list.
 *
 * NEVER `crm_db` (`openCrmAppSession` refuses it). The staged table is pushed in setup:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run bridge-delivery.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let ledger: JobRunLedger
let db: NodePgDatabase<typeof schema>
let seniorId: string
let seq = 0

const STAGED_DDL = join(process.cwd(), 'drizzle/manual-staged/2026-10-31_job_bridge_deliveries.sql')

function douPosting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  seq += 1
  const url = `https://jobs.dou.ua/${TAG}/vacancies/${seq}/`
  return {
    sourceType: 'DOU_RSS',
    externalId: url,
    url,
    title: `Role ${seq}`,
    companyName: `Company ${seq}`,
    companyNameNormalized: `company ${seq}`,
    location: 'Kyiv',
    descriptionMd: `Description ${seq}`,
    publishedAt: new Date('2026-10-30T08:00:00.000Z'),
    fingerprint: `fp-${TAG}-${seq}`,
    remote: true,
    employmentType: 'FULL_TIME',
    seniorityHint: 'SENIOR',
    tags: ['typescript'],
    ...over,
  }
}

async function claimRun(sourceId: string): Promise<BridgeRun> {
  const { cycleId } = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })
  const claim = await ledger.claimLegacyRun({ cycleId, owner: 'dou-bridge', sourceId })
  if (claim.kind !== 'CLAIMED') throw new Error(`setup: ${sourceId} refused ${claim.reason}`)
  return runOf(claim.run, sourceId)
}

function runOf(run: ClaimedRun, sourceId: string): BridgeRun {
  return {
    handle: { runId: run.runId, ownerToken: run.ownerToken, fencingEpoch: run.fencingEpoch },
    sourceId,
    sourceType: 'DOU_RSS',
  }
}

const roster = (): RosterSenior[] => [{ seniorId, exclusions: [] }]

/** A raw PENDING LEGACY_POSTING delivery row (used to inject a payload the job_postings insert refuses). */
async function enqueueRaw(
  run: BridgeRun,
  fingerprint: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.admin.query(
    `INSERT INTO job_bridge_deliveries
       (source_id, provider, consumer, identity_key, content_version, payload, enqueued_by_run)
     VALUES ($1, 'DOU_RSS', 'LEGACY_POSTING', $2, 'v-raw', $3::jsonb, $4)`,
    [run.sourceId, fingerprint, JSON.stringify(payload), run.handle.runId],
  )
}

async function bridgeRows(sourceId: string, consumer: 'LEGACY_POSTING' | 'LEGACY_SUGGESTION') {
  const { rows } = await session.admin.query(
    `SELECT status, outcome, posting_id, suggestions_created, content_version
       FROM job_bridge_deliveries WHERE source_id = $1 AND consumer = $2 ORDER BY created_at`,
    [sourceId, consumer],
  )
  return rows as {
    status: string
    outcome: string | null
    posting_id: string | null
    suggestions_created: number | null
    content_version: string
  }[]
}

async function postingCount(sourceId: string): Promise<number> {
  const { rows } = await session.admin.query(
    `SELECT count(*)::int AS n FROM job_postings WHERE source_id = $1`,
    [sourceId],
  )
  return rows[0].n as number
}

async function suggestionCount(sourceId: string): Promise<number> {
  const { rows } = await session.admin.query(
    `SELECT count(*)::int AS n FROM job_suggestions s
       JOIN job_postings p ON p.id = s.posting_id WHERE p.source_id = $1`,
    [sourceId],
  )
  return rows[0].n as number
}

describe.skipIf(!hasDatabaseUrl())('bridge delivery drains against Postgres (S6d)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    await session.admin.query(readFileSync(STAGED_DDL, 'utf8'))
    fx = new LedgerFixtures(session.admin, TAG)
    db = drizzle(session.pool, { schema })
    ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), new SpecCatalog())
    const sr = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S6d senior', 'SENIOR') RETURNING id`,
      [`s6d-senior-${TAG}@example.test`],
    )
    seniorId = sr.rows[0].id as string
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      const ids = fx.sourceIds
      await session.admin.query(
        `DELETE FROM job_suggestions WHERE posting_id IN (SELECT id FROM job_postings WHERE source_id = ANY($1::uuid[]))`,
        [ids],
      )
      await session.admin.query(
        `DELETE FROM job_bridge_deliveries WHERE source_id = ANY($1::uuid[])
           OR enqueued_by_run IN (SELECT id FROM job_collection_runs WHERE source_id = ANY($1::uuid[]))`,
        [ids],
      )
      await session.admin.query(`DELETE FROM job_postings WHERE source_id = ANY($1::uuid[])`, [ids])
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [seniorId])
    } finally {
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('T1: enqueues one LEGACY_POSTING row per element of the complete array; re-enqueue is DO NOTHING', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    const postings = [douPosting(), douPosting(), douPosting()]

    await enqueueLegacyPostings(db, run, postings)
    expect((await bridgeRows(s, 'LEGACY_POSTING')).length).toBe(3)

    // A second run of the same source re-enqueues the same (consumer, identity, version): DO NOTHING.
    await ledger.finish(run.handle, { outcome: 'SUCCEEDED', errorCode: null })
    const run2 = await claimRun(s)
    await enqueueLegacyPostings(db, run2, postings)
    expect((await bridgeRows(s, 'LEGACY_POSTING')).length).toBe(3)
  })

  it('T3: a CREATED posting inserts job_postings + a PENDING suggestion row; a re-drain skips the DONE row', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    const p = douPosting()
    await enqueueLegacyPostings(db, run, [p])

    const r1 = await drainPostings(db, run, () => undefined)
    expect(r1).toEqual({ created: 1, duplicate: 0, invalid: 0 })
    expect(await postingCount(s)).toBe(1)
    const postingRows = await bridgeRows(s, 'LEGACY_POSTING')
    expect(postingRows[0]).toMatchObject({ status: 'DONE', outcome: 'CREATED' })
    const sugRows = await bridgeRows(s, 'LEGACY_SUGGESTION')
    expect(sugRows).toHaveLength(1)
    expect(sugRows[0]).toMatchObject({ status: 'PENDING', posting_id: postingRows[0].posting_id })

    // Re-drain: the DONE posting row is skipped, no second job_postings row.
    const r2 = await drainPostings(db, run, () => undefined)
    expect(r2).toEqual({ created: 0, duplicate: 0, invalid: 0 })
    expect(await postingCount(s)).toBe(1)
  })

  it('T3: a DUPLICATE posting (same fingerprint, new version) is DUPLICATE with NO suggestion row — first write wins', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    const p = douPosting()
    await enqueueLegacyPostings(db, run, [p])
    await drainPostings(db, run, () => undefined)

    // Same fingerprint, changed description → a new content_version → a fresh delivery row.
    const changed = { ...p, descriptionMd: `${p.descriptionMd} (edited)` }
    expect(contentVersion(changed)).not.toBe(contentVersion(p))
    await enqueueLegacyPostings(db, run, [changed])
    const r = await drainPostings(db, run, () => undefined)

    expect(r).toEqual({ created: 0, duplicate: 1, invalid: 0 })
    expect(await postingCount(s)).toBe(1) // first write wins: no second posting
    const postingRows = await bridgeRows(s, 'LEGACY_POSTING')
    expect(postingRows.map((x) => x.outcome).sort()).toEqual(['CREATED', 'DUPLICATE'])
    // A DUPLICATE creates no suggestion row, so only the CREATED one exists.
    expect(await bridgeRows(s, 'LEGACY_SUGGESTION')).toHaveLength(1)
  })

  it('T3: a payload the database refuses is isolated as INVALID; the other rows still deliver', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    const good = douPosting()
    await enqueueLegacyPostings(db, run, [good])
    // A row whose job_postings insert the DB refuses (title NOT NULL) — valid jsonb, bad posting.
    const badFp = `fp-${TAG}-bad-${seq}`
    await enqueueRaw(run, badFp, {
      sourceType: 'DOU_RSS',
      externalId: badFp,
      url: `https://jobs.dou.ua/${TAG}/bad/`,
      title: null,
      companyName: 'C',
      companyNameNormalized: 'c',
      location: null,
      descriptionMd: 'd',
      publishedAt: null,
      fingerprint: badFp,
    })

    let logged = 0
    const r = await drainPostings(db, run, () => (logged += 1))

    expect(r.invalid).toBe(1)
    expect(r.created).toBe(1)
    expect(logged).toBe(1)
    const rows = await bridgeRows(s, 'LEGACY_POSTING')
    const bad = rows.find((x) => x.content_version === 'v-raw')
    expect(bad?.status).toBe('INVALID')
    expect(rows.filter((x) => x.status === 'DONE')).toHaveLength(1)
  })

  it('T4: creates suggestions for the roster and is idempotent on a second drain', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting(), douPosting()])
    await drainPostings(db, run, () => undefined)

    const n1 = await drainSuggestions(db, run, roster())
    expect(n1).toBe(2) // one senior × two postings
    expect(await suggestionCount(s)).toBe(2)
    const sug = await bridgeRows(s, 'LEGACY_SUGGESTION')
    expect(sug.every((x) => x.status === 'DONE')).toBe(true)

    const n2 = await drainSuggestions(db, run, roster())
    expect(n2).toBe(0) // DONE rows skipped
    expect(await suggestionCount(s)).toBe(2)
  })

  it('crash AFTER T1 (PENDING rows, no job_postings): the next run re-enqueues DO NOTHING and delivers exactly once', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const crashed = await claimRun(s)
    const postings = [douPosting(), douPosting()]
    await enqueueLegacyPostings(db, crashed, postings) // T1 committed, then "crash"
    await ledger.finish(crashed.handle, { outcome: 'FAILED', errorCode: 'UPSTREAM' })
    expect(await postingCount(s)).toBe(0)

    const next = await claimRun(s)
    await enqueueLegacyPostings(db, next, postings) // same keys → DO NOTHING
    expect(await bridgeRows(s, 'LEGACY_POSTING')).toHaveLength(2)
    const pr = await drainPostings(db, next, () => undefined)
    const sn = await drainSuggestions(db, next, roster())

    expect(pr).toEqual({ created: 2, duplicate: 0, invalid: 0 })
    expect(sn).toBe(2)
    expect(await postingCount(s)).toBe(2)
    expect(await suggestionCount(s)).toBe(2)
  })

  it('crash AFTER a T3 commit (DONE posting + PENDING suggestion): the next run drains the suggestion — never createSuggestions([])', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const crashed = await claimRun(s)
    await enqueueLegacyPostings(db, crashed, [douPosting()])
    await drainPostings(db, crashed, () => undefined) // DONE posting + PENDING suggestion, then "crash"
    await ledger.finish(crashed.handle, { outcome: 'FAILED', errorCode: 'UPSTREAM' })
    expect(await suggestionCount(s)).toBe(0)
    const pendingSug = await bridgeRows(s, 'LEGACY_SUGGESTION')
    expect(pendingSug).toHaveLength(1)
    expect(pendingSug[0].status).toBe('PENDING')

    const next = await claimRun(s)
    const pr = await drainPostings(db, next, () => undefined) // nothing new: DONE row skipped
    const sn = await drainSuggestions(db, next, roster()) // the PENDING suggestion carries the posting

    expect(pr).toEqual({ created: 0, duplicate: 0, invalid: 0 })
    expect(sn).toBe(1) // a real posting was offered, not an empty list
    expect(await suggestionCount(s)).toBe(1)
  })

  it('crash BEFORE a T4 checkpoint (suggestions written, row still PENDING): a re-drain is a no-op via the unique index', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting()])
    await drainPostings(db, run, () => undefined)
    const sugRow = (await bridgeRows(s, 'LEGACY_SUGGESTION'))[0]
    // Simulate: the suggestion row's createSuggestions committed, but its checkpoint did not — the
    // row is forced back to PENDING with its suggestions already in place.
    await session.admin.query(
      `INSERT INTO job_suggestions (posting_id, senior_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sugRow.posting_id, seniorId],
    )
    await session.admin.query(
      `UPDATE job_bridge_deliveries SET status = 'PENDING', delivered_at = NULL WHERE id IN
         (SELECT id FROM job_bridge_deliveries WHERE source_id = $1 AND consumer = 'LEGACY_SUGGESTION')`,
      [s],
    )
    expect(await suggestionCount(s)).toBe(1)

    const n = await drainSuggestions(db, run, roster())
    expect(n).toBe(0) // the unique (posting_id, senior_id) index makes the re-insert a no-op
    expect(await suggestionCount(s)).toBe(1) // no duplicate suggestion
    expect((await bridgeRows(s, 'LEGACY_SUGGESTION'))[0].status).toBe('DONE')
  })

  it('a reporting (non-LEGACY) source is refused by claimLegacyRun and produces no LEGACY_* rows', async () => {
    const s = await fx.source({ type: 'REMOTIVE_API' })
    const { cycleId } = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })
    const claim = await ledger.claimLegacyRun({ cycleId, owner: 'dou-bridge', sourceId: s })
    expect(claim).toMatchObject({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
    expect(await bridgeRows(s, 'LEGACY_POSTING')).toHaveLength(0)
  })
})
