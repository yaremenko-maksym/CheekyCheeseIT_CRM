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
  type CreateSuggestions,
  NonLegacyBridgeError,
  type RosterSenior,
  createSuggestionsForPostings,
  drainPostings,
  drainSuggestions,
  enqueueLegacyPostings,
  markCollected,
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

  it('CR-M-1: a transient DB fault leaves the row PENDING (not INVALID); the next run drains it', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting()])

    // A db whose per-row transaction rejects with a transient pg fault (deadlock 40P01).
    const transient = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
      severity: 'ERROR',
    })
    const flaky = {
      select: db.select.bind(db),
      transaction: () => Promise.reject(transient),
    } as unknown as typeof db

    await expect(drainPostings(flaky, run, () => undefined)).rejects.toThrow(/deadlock/)
    // Re-thrown, NOT marked INVALID: the row is still PENDING and no posting was created.
    expect((await bridgeRows(s, 'LEGACY_POSTING'))[0].status).toBe('PENDING')
    expect(await postingCount(s)).toBe(0)

    // The next run drains it cleanly.
    const r = await drainPostings(db, run, () => undefined)
    expect(r).toMatchObject({ created: 1, invalid: 0 })
    expect((await bridgeRows(s, 'LEGACY_POSTING'))[0].status).toBe('DONE')
  })

  it('CR-M-4: markCollected is fenced — a lost-lease executor writes no last_collected_at', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    const fenced: BridgeRun = { ...run, handle: { ...run.handle, ownerToken: 'superseded-token' } }

    await expect(markCollected(db, fenced)).rejects.toThrow()
    const { rows } = await session.admin.query(
      `SELECT last_collected_at FROM job_sources WHERE id = $1`,
      [s],
    )
    expect(rows[0].last_collected_at).toBeNull()

    // The real owner writes it.
    await markCollected(db, run)
    const after = await session.admin.query(
      `SELECT last_collected_at FROM job_sources WHERE id = $1`,
      [s],
    )
    expect(after.rows[0].last_collected_at).not.toBeNull()
  })

  // ── SPEC-M-1 / SPEC-M-2 / SPEC-M-3: the remaining crash rows + real fault injection ──────────

  const transientPg = (msg: string) =>
    Object.assign(new Error(msg), { code: '40P01', severity: 'ERROR' })

  /** A db that delegates to `real`, but whose Nth `transaction` call rejects (a mid-drain crash). */
  function throwOnNthTransaction(n: number, err: Error): typeof db {
    const realTx = db.transaction.bind(db)
    let count = 0
    return {
      select: db.select.bind(db),
      transaction: ((fn: unknown, opts: unknown) => {
        count += 1
        return count === n
          ? Promise.reject(err)
          : (realTx as (f: unknown, o: unknown) => Promise<unknown>)(fn, opts)
      }) as unknown as typeof db.transaction,
    } as unknown as typeof db
  }

  it('crash AFTER chargeBudget before T1 (nothing enqueued): the next run enqueues and delivers — nothing lost', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const crashed = await claimRun(s)
    // chargeBudget happened upstream; nothing was enqueued before the crash.
    await ledger.finish(crashed.handle, { outcome: 'FAILED', errorCode: 'UPSTREAM' })
    expect(await bridgeRows(s, 'LEGACY_POSTING')).toHaveLength(0)

    const next = await claimRun(s)
    await enqueueLegacyPostings(db, next, [douPosting()])
    expect(await drainPostings(db, next, () => undefined)).toMatchObject({ created: 1, invalid: 0 })
    expect(await drainSuggestions(db, next, roster())).toBe(1)
  })

  it('crash BEFORE a T3 commit (a real throw on the 2nd row): that row + the rest stay PENDING, the next run creates them', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting(), douPosting(), douPosting()])

    // Row 1 commits; row 2's transaction throws before it can commit; the drain aborts.
    await expect(
      drainPostings(throwOnNthTransaction(2, transientPg('mid-T3 crash')), run, () => undefined),
    ).rejects.toThrow(/mid-T3/)
    expect(await postingCount(s)).toBe(1) // only row 1 committed
    const afterCrash = await bridgeRows(s, 'LEGACY_POSTING')
    expect(afterCrash.filter((x) => x.status === 'PENDING')).toHaveLength(2)
    expect(afterCrash.filter((x) => x.status === 'INVALID')).toHaveLength(0) // NOT dropped

    // The next run drains the two that rolled back.
    const pr = await drainPostings(db, run, () => undefined)
    expect(pr).toMatchObject({ created: 2, invalid: 0 })
    expect(await postingCount(s)).toBe(3)
  })

  it('crash BEFORE a T4 checkpoint (a real throw mid-drain): createSuggestions is NEVER called with [], the row stays PENDING, the retry completes', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting(), douPosting()])
    await drainPostings(db, run, () => undefined) // 2 CREATED + 2 PENDING suggestion rows

    const calledWith: number[] = []
    let c = 0
    const spy: CreateSuggestions = async (tx, postings, r) => {
      calledWith.push(postings.length)
      c += 1
      if (c === 2) throw transientPg('mid-T4 crash')
      return createSuggestionsForPostings(tx, postings, r)
    }
    await expect(drainSuggestions(db, run, roster(), spy)).rejects.toThrow(/mid-T4/)
    // The fan-out is only ever handed a real posting — never an empty list (AC4).
    expect(calledWith.length).toBeGreaterThan(0)
    expect(calledWith.every((len) => len > 0)).toBe(true)
    const sug = await bridgeRows(s, 'LEGACY_SUGGESTION')
    expect(sug.filter((x) => x.status === 'DONE')).toHaveLength(1)
    expect(sug.filter((x) => x.status === 'PENDING')).toHaveLength(1)

    // The retry (real fan-out) completes the pending row; no duplicate suggestions.
    expect(await drainSuggestions(db, run, roster())).toBe(1)
    expect((await bridgeRows(s, 'LEGACY_SUGGESTION')).every((x) => x.status === 'DONE')).toBe(true)
    expect(await suggestionCount(s)).toBe(2)
  })

  it('crash AFTER a T4 commit: the DONE suggestion row is skipped by the next run (no duplicate)', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting()])
    await drainPostings(db, run, () => undefined)
    expect(await drainSuggestions(db, run, roster())).toBe(1)

    // "Crash" after the T4 commit, before finish; the next run re-drains.
    expect(await drainSuggestions(db, run, roster())).toBe(0)
    expect(await suggestionCount(s)).toBe(1)
  })

  it('crash at T5 before finish (delivered, run STARTED): the next run re-enqueues DO NOTHING and re-drains to a no-op', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const crashed = await claimRun(s)
    const postings = [douPosting(), douPosting()]
    await enqueueLegacyPostings(db, crashed, postings)
    await drainPostings(db, crashed, () => undefined)
    await drainSuggestions(db, crashed, roster())
    await markCollected(db, crashed) // T5 written, then "crash" before finish
    await ledger.finish(crashed.handle, { outcome: 'FAILED', errorCode: 'UPSTREAM' }) // recovery ends it
    expect(await postingCount(s)).toBe(2)
    expect(await suggestionCount(s)).toBe(2)

    const next = await claimRun(s)
    await enqueueLegacyPostings(db, next, postings) // same keys → DO NOTHING
    expect(await drainPostings(db, next, () => undefined)).toMatchObject({ created: 0, invalid: 0 })
    expect(await drainSuggestions(db, next, roster())).toBe(0)
    expect(await postingCount(s)).toBe(2)
    expect(await suggestionCount(s)).toBe(2)
  })

  it('SPEC-M-3: an APPLIED suggestion is never rewritten when its row re-drains (ON CONFLICT DO NOTHING)', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting()])
    await drainPostings(db, run, () => undefined)
    await drainSuggestions(db, run, roster())
    const sug = (await bridgeRows(s, 'LEGACY_SUGGESTION'))[0]
    // The senior answers APPLIED, then the delivery row is forced back to PENDING (a re-drain).
    await session.admin.query(
      `UPDATE job_suggestions SET status = 'APPLIED', status_changed_at = now()
         WHERE posting_id = $1 AND senior_id = $2`,
      [sug.posting_id, seniorId],
    )
    await session.admin.query(
      `UPDATE job_bridge_deliveries SET status = 'PENDING', delivered_at = NULL WHERE id IN
         (SELECT id FROM job_bridge_deliveries WHERE source_id = $1 AND consumer = 'LEGACY_SUGGESTION')`,
      [s],
    )

    expect(await drainSuggestions(db, run, roster())).toBe(0) // the unique index refuses the re-insert
    const answered = await session.admin.query(
      `SELECT status FROM job_suggestions WHERE posting_id = $1 AND senior_id = $2`,
      [sug.posting_id, seniorId],
    )
    expect(answered.rows[0].status).toBe('APPLIED') // NOT rewritten to NEW
  })

  it('SPEC-M-3: a fenced (lost-lease) executor fails assertOwned inside T3 and T4 and writes nothing', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    await enqueueLegacyPostings(db, run, [douPosting()])
    const fenced: BridgeRun = { ...run, handle: { ...run.handle, ownerToken: 'superseded-token' } }

    // T3 under a fenced run: assertOwned rejects (RunFencedError re-thrown, not INVALID), nothing written.
    await expect(drainPostings(db, fenced, () => undefined)).rejects.toThrow()
    expect(await postingCount(s)).toBe(0)
    expect((await bridgeRows(s, 'LEGACY_POSTING'))[0].status).toBe('PENDING')

    // Drain T3 as the real owner, then T4 under the fenced run: no suggestions written.
    await drainPostings(db, run, () => undefined)
    await expect(drainSuggestions(db, fenced, roster())).rejects.toThrow()
    expect(await suggestionCount(s)).toBe(0)
    expect((await bridgeRows(s, 'LEGACY_SUGGESTION'))[0].status).toBe('PENDING')
  })

  it('SR-M-1: the table boundary refuses a non-LEGACY run even with a valid run lease (no service gate)', async () => {
    const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
    const run = await claimRun(s)
    // A caller that skipped the service gate and handed a run claiming a reporting source type,
    // under an otherwise-valid lease. The boundary guard must refuse it before any row is written.
    const contaminated: BridgeRun = { ...run, sourceType: 'REMOTIVE_API' }

    await expect(enqueueLegacyPostings(db, contaminated, [douPosting()])).rejects.toBeInstanceOf(
      NonLegacyBridgeError,
    )
    expect(await bridgeRows(s, 'LEGACY_POSTING')).toHaveLength(0)

    // And the drain repeats the check: a LEGACY row enqueued honestly cannot be drained under a
    // contaminated run.
    await enqueueLegacyPostings(db, run, [douPosting()])
    await expect(drainPostings(db, contaminated, () => undefined)).rejects.toBeInstanceOf(
      NonLegacyBridgeError,
    )
    expect(await postingCount(s)).toBe(0)
    expect((await bridgeRows(s, 'LEGACY_POSTING')).every((x) => x.status === 'PENDING')).toBe(true)
  })
})
