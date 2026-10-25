import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import {
  type ObservationSeed,
  cleanupStore,
  legacyCounts,
  observation,
} from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import {
  type AdminActor,
  ForbiddenActorError,
  asAdminActor,
  linkRecord,
  releaseToken,
  resolveRecordsTx,
  splitRecord,
} from './canonical.store'
import { saveObservationPage } from './source-record.store'

/**
 * r5 Task 4.5 — the canonical repository against real Postgres, as `crm_app`. AC 3, 7, 8, 9, 10;
 * fix round 1: SR-M-2 (only the ATS's own adapter claims, KEEP re-checks, ADMIN release), SR-M-3
 * (role re-checked in the database), CR-M-7 (late owner, page-vs-canonical opposite order).
 * `T45_TOKEN_ITERATIONS` lowers AC 8's count for a quick local look; the AC is 200.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const ITERATIONS = Number(process.env['T45_TOKEN_ITERATIONS'] ?? 200)
/** The greenhouse board: a namespace under PREFIX, so cleanup reaches its records. */
const BOARD = `${PREFIX}-gh`
/** The adapter's own namespace for the board (`atsNamespace`): only its records may claim. */
const BOARD_NS = `greenhouse:${BOARD}`
const ats = (n: number | string) => `https://boards.greenhouse.io/${BOARD}/jobs/${n}`
const ATS: JobSourceType = 'GREENHOUSE_ATS'
const AGGREGATOR: JobSourceType = 'JSEARCH_API'

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let admin: AdminActor
let legacyBefore: { suggestions: number; postings: number }
const extraUsers: string[] = []
const runs = new Map<JobSourceType, RunHandle>()
let seq = 0

async function runFor(type: JobSourceType): Promise<RunHandle> {
  const existing = runs.get(type)
  if (existing !== undefined) return existing
  const h = handleOf(await kit.claimOne(await kit.reporting({ type })))
  runs.set(type, h)
  return h
}

/** Save one observation through the observation store; returns its record id. */
async function record(
  seed: Omit<ObservationSeed, 'tag' | 'namespace'> & { namespace?: string },
): Promise<string> {
  const o = observation({ namespace: `${PREFIX}-c`, ...seed, tag: TAG })
  seq += 1
  const [saved] = await saveObservationPage(db, await runFor(o.identity.provider), {
    observations: [o],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

async function activeOf(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id, decision FROM job_opportunity_sources
      WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows as { opportunity_id: string; decision: string }[]
}

async function historyOf(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id, decision, unlinked_at IS NOT NULL AS unlinked, unlink_reason, evidence
       FROM job_opportunity_sources WHERE source_record_id = $1 ORDER BY linked_at, id`,
    [recordId],
  )
  return rows as {
    opportunity_id: string
    decision: string
    unlinked: boolean
    unlink_reason: string | null
    evidence: Record<string, unknown>
  }[]
}

async function opportunity(id: string) {
  const { rows } = await session.admin.query(
    `SELECT revision, title_key, employer_key FROM job_opportunities WHERE id = $1`,
    [id],
  )
  return rows[0] as { revision: number; title_key: string; employer_key: string | null }
}

async function tokensFor(jobId: number) {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id, released_at IS NOT NULL AS released, released_by, release_reason
       FROM job_opportunity_identity_tokens WHERE token_key LIKE '%' || $1 || '%' ORDER BY claimed_at, id`,
    // The key's namespace is `us:<board>` (ats-job-key's regional prefix).
    [`:${BOARD}","${jobId}"`],
  )
  return rows as {
    opportunity_id: string
    released: boolean
    released_by: string | null
    release_reason: string | null
  }[]
}

async function newAdmin(name: string): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO users (email, display_name, role) VALUES ($1, 'T4.5 admin', 'ADMIN') RETURNING id`,
    [`t45-${name}-${TAG}@example.test`],
  )
  extraUsers.push(rows[0].id as string)
  return rows[0].id as string
}

/** Wait (bounded) until some backend of the app role is blocked on a lock. */
async function untilBlocked(): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND usename = 'crm_app' AND wait_event_type = 'Lock'`,
    )
    if (rows[0].n > 0) return
    if (Date.now() > deadline) throw new Error('setup: no backend became blocked on a lock')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!hasDatabaseUrl())('canonical store (Task 4.5, real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 8 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API', AGGREGATOR, ATS]), catalog)
    const { rows: users } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T4.5 canonical spec', 'ADMIN') RETURNING id`,
      [`t45c-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, users[0].id as string)
    admin = asAdminActor({ id: kit.actor, role: 'ADMIN' })
    legacyBefore = await legacyCounts(session.admin)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [kit.actor, ...extraUsers],
      ])
    } finally {
      await session.close()
    }
  })

  describe('AC 3: what merges and what does not', () => {
    it('a copy of an ATS-sourced job with the same trusted key -> one opportunity, one token', async () => {
      const a = await record({
        nativeId: '101',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(101),
      })
      const b = await record({ nativeId: 'y1', provider: AGGREGATOR, postingUrl: ats(101) })
      const [ra] = await resolveRecordsTx(db, [a])
      const [rb] = await resolveRecordsTx(db, [b])
      expect(ra).toMatchObject({ kind: 'NEW' })
      expect(rb).toMatchObject({
        kind: 'ATTACH',
        opportunityId: (ra as { opportunityId: string }).opportunityId,
      })
      expect((await activeOf(a))[0]?.opportunity_id).toBe((await activeOf(b))[0]?.opportunity_id)
      expect(await tokensFor(101)).toHaveLength(1)
      // Resolving again changes nothing: KEEP, no new link row.
      expect((await resolveRecordsTx(db, [a, b])).map((o) => o.kind)).toEqual(['KEEP', 'KEEP'])
      expect(await historyOf(b)).toHaveLength(1)
    })

    it('SR-M-2: an aggregator first-comer with a vendor job URL claims nothing', async () => {
      const a = await record({ nativeId: 'q1', provider: AGGREGATOR, postingUrl: ats(102) })
      expect(await resolveRecordsTx(db, [a])).toMatchObject([{ kind: 'NEW' }])
      expect(await tokensFor(102)).toEqual([])
      // The ATS's own record arrives later and still owns its key.
      const g = await record({
        nativeId: '102',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(102),
      })
      expect(await resolveRecordsTx(db, [g])).toMatchObject([{ kind: 'NEW' }])
      expect((await tokensFor(102)).map((t) => t.opportunity_id)).toEqual([
        (await activeOf(g))[0]?.opportunity_id,
      ])
    })

    it('PRE-M-1: a record of another board carrying this board`s job URL claims nothing', async () => {
      const other = await record({
        nativeId: '106',
        provider: ATS,
        namespace: `greenhouse:${PREFIX}-otherboard`,
        postingUrl: ats(106),
      })
      expect(await resolveRecordsTx(db, [other])).toMatchObject([{ kind: 'NEW' }])
      expect(await tokensFor(106)).toEqual([])
    })

    it('the same non-ATS URL under different native ids is NOT merged', async () => {
      const url = `https://acme-${TAG}.test/careers/apply`
      const a = await record({ nativeId: 'u1', postingUrl: url })
      const b = await record({ nativeId: 'u2', postingUrl: url })
      const out = await resolveRecordsTx(db, [a, b])
      expect(out.map((o) => o.kind)).toEqual(['NEW', 'NEW'])
      expect((await activeOf(a))[0]?.opportunity_id).not.toBe(
        (await activeOf(b))[0]?.opportunity_id,
      )
    })

    it('AC 7: the same company and title only are candidates (equal keys), never merged', async () => {
      const a = await record({ nativeId: 't1', title: 'Staff SRE', company: `Beta ${TAG}` })
      const b = await record({ nativeId: 't2', title: 'Staff SRE', company: `Beta ${TAG}` })
      await resolveRecordsTx(db, [a, b])
      const [oa, ob] = [(await activeOf(a))[0], (await activeOf(b))[0]]
      expect(oa?.opportunity_id).not.toBe(ob?.opportunity_id)
      const [pa, pb] = [
        await opportunity(oa?.opportunity_id as string),
        await opportunity(ob?.opportunity_id as string),
      ]
      expect([pa.title_key, pa.employer_key]).toEqual([pb.title_key, pb.employer_key])
    })
  })

  describe('AC 7 / AC 9: association, split, relink, and the ADMIN disposition', () => {
    it('keeps every link row and payload through link, split and relink', async () => {
      const a = await record({
        nativeId: '202',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(202),
      })
      const b = await record({ nativeId: 's2', provider: AGGREGATOR, postingUrl: ats(202) })
      await resolveRecordsTx(db, [a, b])
      const merged = (await activeOf(a))[0]?.opportunity_id as string
      expect((await activeOf(b))[0]?.opportunity_id).toBe(merged)
      const revisionBefore = (await opportunity(merged)).revision

      const split = await db.transaction((tx) => splitRecord(tx, admin, b, 'different team'))
      expect(split).not.toBe(merged)
      expect(await activeOf(b)).toEqual([{ opportunity_id: split, decision: 'CONFIRMED' }])
      expect((await opportunity(merged)).revision).toBe(revisionBefore + 1)

      // AC 9: AUTO never overwrites the ADMIN's decision: the token still points at `merged`.
      expect(await resolveRecordsTx(db, [b])).toEqual([
        { recordId: b, kind: 'CONFLICT', opportunityId: split, owners: [merged] },
      ])
      expect(await activeOf(b)).toEqual([{ opportunity_id: split, decision: 'CONFIRMED' }])

      // The ADMIN disposition resolves it: relink to `merged`, CONFIRMED.
      await db.transaction((tx) => linkRecord(tx, admin, b, merged, 'same job after all'))
      expect(await activeOf(b)).toEqual([{ opportunity_id: merged, decision: 'CONFIRMED' }])
      const history = await historyOf(b)
      expect(history.map((h) => [h.opportunity_id, h.decision, h.unlinked])).toEqual([
        [merged, 'AUTO', true],
        [split, 'CONFIRMED', true],
        [merged, 'CONFIRMED', false],
      ])
      expect(history[0]?.unlink_reason).toBe('ADMIN_SPLIT: different team')
      expect(history[1]?.unlink_reason).toBe('ADMIN_RELINK: same job after all')
      expect(history[2]?.evidence).toMatchObject({ actor: kit.actor, action: 'LINK' })
      // Payloads untouched: both records keep their one revision each.
      const { rows } = await session.admin.query(
        `SELECT count(*)::int AS n FROM job_source_record_revisions WHERE source_record_id = ANY($1::uuid[])`,
        [[a, b]],
      )
      expect(rows[0].n).toBe(2)
      // Every membership change advanced a revision and enqueued re-evaluation for it.
      const { rows: dirty } = await session.admin.query(
        `SELECT o.id FROM job_opportunities o
          WHERE o.id = ANY($1::uuid[]) AND NOT EXISTS (
            SELECT 1 FROM job_dirty_work d WHERE d.entity_kind = 'OPPORTUNITY' AND d.entity_id = o.id
              AND d.target_version = o.revision AND d.reason = 'CANONICAL_REVISION')`,
        [[merged, split]],
      )
      expect(dirty).toEqual([])
    })

    it('refuses a non-ADMIN actor at the mint and a forged one at the call', async () => {
      expect(() => asAdminActor({ id: kit.actor, role: 'HR' })).toThrow(ForbiddenActorError)
      expect(() => asAdminActor({ id: 'not-a-uuid', role: 'ADMIN' })).toThrow(ForbiddenActorError)
      const a = await record({ nativeId: 'g1' })
      await resolveRecordsTx(db, [a])
      const forged = { userId: kit.actor } as unknown as AdminActor
      await expect(db.transaction((tx) => splitRecord(tx, forged, a, 'x'))).rejects.toBeInstanceOf(
        ForbiddenActorError,
      )
      expect(await historyOf(a)).toHaveLength(1)
    })

    it('SR-M-3: an ADMIN demoted or archived after the mint is refused by the database check', async () => {
      const a = await record({ nativeId: 'g2' })
      await resolveRecordsTx(db, [a])
      const demoted = await newAdmin('demoted')
      const actor = asAdminActor({ id: demoted, role: 'ADMIN' })
      await session.admin.query(`UPDATE users SET role = 'HR' WHERE id = $1`, [demoted])
      await expect(db.transaction((tx) => splitRecord(tx, actor, a, 'x'))).rejects.toBeInstanceOf(
        ForbiddenActorError,
      )
      const archived = await newAdmin('archived')
      const actor2 = asAdminActor({ id: archived, role: 'ADMIN' })
      await session.admin.query(`UPDATE users SET archived_at = now() WHERE id = $1`, [archived])
      await expect(db.transaction((tx) => splitRecord(tx, actor2, a, 'x'))).rejects.toBeInstanceOf(
        ForbiddenActorError,
      )
      expect(await historyOf(a)).toHaveLength(1)
    })
  })

  describe('SR-M-2: squatting and its recovery', () => {
    it('a key claimed on bad data stays out of reach of a copy; an ADMIN release frees it, history kept', async () => {
      // The board's own record carries wrong data (a squat as far as the copy can tell).
      const squat = await record({
        nativeId: '303',
        namespace: BOARD_NS,
        provider: ATS,
        postingUrl: ats(303),
        title: 'Office Manager',
        company: 'Squatter',
      })
      const copy = await record({ nativeId: 'cp', provider: AGGREGATOR, postingUrl: ats(303) })
      await resolveRecordsTx(db, [squat])
      expect(await resolveRecordsTx(db, [copy])).toMatchObject([{ kind: 'NEW' }])
      const squatOpp = (await activeOf(squat))[0]?.opportunity_id as string
      expect((await activeOf(copy))[0]?.opportunity_id).not.toBe(squatOpp)
      expect((await tokensFor(303)).map((t) => t.opportunity_id)).toEqual([squatOpp])

      const key = (
        await session.admin.query(
          `SELECT token_key FROM job_opportunity_identity_tokens WHERE opportunity_id = $1`,
          [squatOpp],
        )
      ).rows[0].token_key as string
      await db.transaction((tx) => releaseToken(tx, admin, key, 'claimed on bad data'))
      await expect(
        db.transaction((tx) => releaseToken(tx, admin, key, 'twice')),
      ).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND' })
      // Released: the copy now finds no owner; the board record re-claims on its next pass.
      expect(await resolveRecordsTx(db, [squat])).toMatchObject([
        { kind: 'KEEP', opportunityId: squatOpp, unclaimed: [] },
      ])
      expect(await tokensFor(303)).toEqual([
        {
          opportunity_id: squatOpp,
          released: true,
          released_by: kit.actor,
          release_reason: 'claimed on bad data',
        },
        { opportunity_id: squatOpp, released: false, released_by: null, release_reason: null },
      ])
    })

    it('KEEP claims no new key for a record that no longer associates with its co-members', async () => {
      const m = await record({
        nativeId: '404',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(404),
      })
      // Job 405 of the board, first seen carrying job 404's URL: it attaches through 404's token.
      const c = await record({
        nativeId: '405',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(404),
      })
      await resolveRecordsTx(db, [m, c])
      expect((await activeOf(m))[0]?.opportunity_id).toBe((await activeOf(c))[0]?.opportunity_id)
      // Re-observed at its own URL, under another title: its own key is claimable, but it no
      // longer associates with its co-member, so KEEP reports the key instead of claiming it.
      const c2 = await record({
        nativeId: '405',
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(405),
        title: 'Head of Sales',
        version: 'moved',
      })
      expect(c2).toBe(c)
      const [out] = await resolveRecordsTx(db, [c])
      expect(out).toMatchObject({ kind: 'KEEP' })
      expect((out as { unclaimed: string[] }).unclaimed).toHaveLength(1)
      expect(await tokensFor(405)).toEqual([])
    })
  })

  describe('CR-M-7: the out-of-order paths, on real locks', () => {
    it('an owner committed after the plan is locked late, and the record is reported, not moved', async () => {
      const r = await record({ nativeId: 'lo', provider: AGGREGATOR, postingUrl: ats(505) })
      await resolveRecordsTx(db, [r])
      const x = (await activeOf(r))[0]?.opportunity_id as string
      const holder: PoolClient = await session.admin.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM job_opportunities WHERE id = $1 FOR UPDATE`, [x])
        const pending = resolveRecordsTx(db, [r]) // plans {X}, then waits for X
        await untilBlocked()
        // Meanwhile the ATS's own record claims the key for a new opportunity, and commits.
        const g = await record({
          nativeId: '505',
          provider: ATS,
          namespace: BOARD_NS,
          postingUrl: ats(505),
        })
        const [rg] = await resolveRecordsTx(db, [g])
        await holder.query('COMMIT')
        const owner = (rg as { opportunityId: string }).opportunityId
        expect(await pending).toEqual([
          { recordId: r, kind: 'CONFLICT', opportunityId: x, owners: [owner] },
        ])
      } finally {
        holder.release()
      }
      expect((await activeOf(r))[0]?.opportunity_id).toBe(x)
    })

    it('a page-order and a canonical-order transaction on two records converge (deadlock retried)', async () => {
      // Two records whose natural-key order is the reverse of their id order.
      let pair: [string, string] | undefined
      for (let i = 0; i < 20 && pair === undefined; i += 1) {
        const first = await record({ nativeId: `pv${i}a` })
        const second = await record({ nativeId: `pv${i}b` })
        if (first > second) pair = [first, second]
      }
      if (pair === undefined) throw new Error('setup: no pair with opposite orders in 20 tries')
      const [naturalFirst, naturalSecond] = pair
      const page: PoolClient = await session.admin.connect()
      let pageCode: string | null = null
      try {
        await page.query('BEGIN')
        await page.query(`SELECT 1 FROM job_source_records WHERE id = $1 FOR UPDATE`, [
          naturalFirst,
        ])
        const canonical = resolveRecordsTx(db, [naturalFirst, naturalSecond]) // locks naturalSecond first
        await untilBlocked()
        try {
          await page.query(`SELECT 1 FROM job_source_records WHERE id = $1 FOR UPDATE`, [
            naturalSecond,
          ])
          await page.query('COMMIT')
        } catch (e) {
          pageCode = String((e as { code?: string }).code)
          await page.query('ROLLBACK')
        }
        expect((await canonical).map((o) => o.kind)).toEqual(['NEW', 'NEW'])
      } finally {
        page.release()
      }
      // Postgres broke the cycle on one side: either the page got 40P01, or the canonical
      // transaction did and its retry converged after the page committed.
      expect([null, '40P01']).toContain(pageCode)
    })
  })

  it(`AC 8: simultaneous claim/merge of one token, alternating which transaction goes first, ${ITERATIONS} iterations`, async () => {
    const failures: string[] = []
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = 10_000 + i
      // The board's own record (the only possible claimant: PRE-M-1) and an aggregator copy.
      const a = await record({
        nativeId: String(key),
        provider: ATS,
        namespace: BOARD_NS,
        postingUrl: ats(key),
      })
      const b = await record({ nativeId: `k${i}b`, provider: AGGREGATOR, postingUrl: ats(key) })
      // resolveRecords locks by id and decides claimants first, so a merge call's own argument
      // order is not a lock order. What varies is which transaction gets the claimant first:
      //   0: both merge [a, b] / [b, a];  1: a alone, then [a, b] concurrently;  2: [b, a] and a.
      const variant = i % 3
      const settled = await Promise.allSettled(
        variant === 0
          ? [resolveRecordsTx(db, [a, b]), resolveRecordsTx(db, [b, a])]
          : variant === 1
            ? [resolveRecordsTx(db, [a]), resolveRecordsTx(db, [a, b])]
            : [resolveRecordsTx(db, [b, a]), resolveRecordsTx(db, [a])],
      )
      for (const s of settled) if (s.status === 'rejected') failures.push(String(s.reason))
      const { rows } = await session.admin.query(
        `SELECT t.opportunity_id,
                (SELECT count(*)::int FROM job_opportunity_identity_tokens WHERE token_key = t.token_key) AS tokens,
                (SELECT array_agg(DISTINCT s.opportunity_id::text) FROM job_opportunity_sources s
                  WHERE s.source_record_id IN ($2::uuid, $3::uuid) AND s.unlinked_at IS NULL) AS active,
                (SELECT count(*)::int FROM job_opportunity_sources s
                  WHERE s.source_record_id IN ($2::uuid, $3::uuid)) AS links,
                o.revision,
                EXISTS (SELECT 1 FROM job_dirty_work d WHERE d.entity_kind = 'OPPORTUNITY'
                         AND d.entity_id = o.id AND d.target_version = o.revision) AS enqueued
           FROM job_opportunity_identity_tokens t JOIN job_opportunities o ON o.id = t.opportunity_id
          WHERE t.token_key LIKE '%' || $1 || '%'`,
        [`"${key}"`, a, b],
      )
      const row = rows[0]
      // Exactly one owner, both records on it, one link each, the last version enqueued.
      expect({ i, row: row && { ...row, opportunity_id: undefined } }).toEqual({
        i,
        row: {
          opportunity_id: undefined,
          tokens: 1,
          active: [row?.opportunity_id],
          links: 2,
          revision: 2,
          enqueued: true,
        },
      })
    }
    expect(failures).toEqual([])
    // No opportunity was left behind by a losing attempt: every one is linked to something.
    const { rows: orphans } = await session.admin.query(
      `SELECT count(*)::int AS n FROM job_opportunities o
        WHERE NOT EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.opportunity_id = o.id)
          AND o.description_sha256 IN (SELECT sha256 FROM job_text_blobs WHERE text LIKE '%' || $1 || '%')`,
      [TAG],
    )
    expect(orphans[0].n).toBe(0)
  }, 600_000)

  it('AC 10: created no legacy suggestion or posting', async () => {
    expect(await legacyCounts(session.admin)).toEqual(legacyBefore)
  })
})
