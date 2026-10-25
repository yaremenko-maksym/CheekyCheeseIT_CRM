import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
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
  resolveRecordsTx,
  splitRecord,
} from './canonical.store'
import { saveObservationPage } from './source-record.store'

/**
 * r5 Task 4.5 — the canonical repository against real Postgres, as `crm_app`. AC 3, 7, 8, 9, 10.
 * `T45_TOKEN_ITERATIONS` lowers AC 8's count for a quick local look; the AC is 200.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const ITERATIONS = Number(process.env['T45_TOKEN_ITERATIONS'] ?? 200)
const BOARD = `acme${TAG}`
const ats = (n: number | string) => `https://boards.greenhouse.io/${BOARD}/jobs/${n}`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let admin: AdminActor
let legacyBefore: { suggestions: number; postings: number }
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

describe.skipIf(!hasDatabaseUrl())('canonical store (Task 4.5, real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 8 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API', 'JSEARCH_API']), catalog)
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
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  describe('AC 3: what merges and what does not', () => {
    it('cross-source copies with the same trusted ATS key -> one opportunity, one token', async () => {
      const a = await record({ nativeId: 'x1', postingUrl: ats(101) })
      const b = await record({ nativeId: 'y1', provider: 'JSEARCH_API', postingUrl: ats(101) })
      const [ra] = await resolveRecordsTx(db, [a])
      const [rb] = await resolveRecordsTx(db, [b])
      expect(ra).toMatchObject({ kind: 'NEW' })
      expect(rb).toMatchObject({
        kind: 'ATTACH',
        opportunityId: (ra as { opportunityId: string }).opportunityId,
      })
      expect((await activeOf(a))[0]?.opportunity_id).toBe((await activeOf(b))[0]?.opportunity_id)
      const { rows } = await session.admin.query(
        `SELECT count(*)::int AS n, count(DISTINCT opportunity_id)::int AS owners
           FROM job_opportunity_identity_tokens WHERE token_key LIKE '%' || $1 || '%'`,
        [`${BOARD}`],
      )
      expect(rows[0]).toMatchObject({ n: 1, owners: 1 })
      // Resolving again changes nothing: KEEP, no new link row.
      expect((await resolveRecordsTx(db, [a, b])).map((o) => o.kind)).toEqual(['KEEP', 'KEEP'])
      expect(await historyOf(b)).toHaveLength(1)
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
      const a = await record({ nativeId: 's1', postingUrl: ats(202) })
      const b = await record({ nativeId: 's2', provider: 'JSEARCH_API', postingUrl: ats(202) })
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
  })

  it(`AC 8: simultaneous claim/merge of one token, both orders, ${ITERATIONS} iterations`, async () => {
    const failures: string[] = []
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = 10_000 + i
      const a = await record({ nativeId: `k${i}a`, postingUrl: ats(key) })
      const b = await record({ nativeId: `k${i}b`, provider: 'JSEARCH_API', postingUrl: ats(key) })
      // Even: the same merge in both orders (the lock order makes them one order). Odd: each
      // transaction claims the token for its own record, so one loses the claim and re-runs.
      const settled = await Promise.allSettled(
        i % 2 === 0
          ? [resolveRecordsTx(db, [a, b]), resolveRecordsTx(db, [b, a])]
          : [resolveRecordsTx(db, [a]), resolveRecordsTx(db, [b])],
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
