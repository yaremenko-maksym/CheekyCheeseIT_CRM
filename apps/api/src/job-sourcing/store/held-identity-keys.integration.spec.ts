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
import { type ObservationSeed, cleanupStore, observation } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { resolveRecordsTx } from './canonical.store'
import { heldIdentityKeys } from './held-identity-keys'
import { saveObservationPage } from './source-record.store'

/**
 * Task sources-12 — against real Postgres, as `crm_app`:
 * - AC 1: `heldIdentityKeys` answers exactly which sitemap ids the source already holds, so the
 *   adapter fetches only the rest;
 * - AC 3: a Next Level Jobs observation whose posting URL is the employer's ATS job URL (the
 *   "Apply here" button) joins the opportunity the ATS adapter already holds, through the existing
 *   ATS_JOB_KEY seam — no second opportunity.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const NLJ: JobSourceType = 'NEXTLEVELJOBS_HTML'
const ATS: JobSourceType = 'GREENHOUSE_ATS'
const BOARD = `${PREFIX}-gh`
const BOARD_NS = `greenhouse:${BOARD}`
const NLJ_NS = `${PREFIX}-nlj`
const ats = (n: number) => `https://boards.greenhouse.io/${BOARD}/jobs/${n}`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
const runs = new Map<JobSourceType, RunHandle>()
let seq = 0

async function runFor(type: JobSourceType): Promise<RunHandle> {
  const existing = runs.get(type)
  if (existing !== undefined) return existing
  const h = handleOf(await kit.claimOne(await kit.reporting({ type })))
  runs.set(type, h)
  return h
}

async function record(seed: Omit<ObservationSeed, 'tag'>): Promise<string> {
  const o = observation({ ...seed, tag: TAG })
  seq += 1
  const [saved] = await saveObservationPage(db, await runFor(o.identity.provider), {
    observations: [o],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

/** One title per job: records of one board sharing a title are several jobs (sources-18). */
const titleOf = (job: number) => `Go Engineer ${job}`

/** A Next Level Jobs record as the adapter writes it: the ATS URL is the posting URL. */
const nljRecord = (id: string, job: number) =>
  record({
    provider: NLJ,
    namespace: NLJ_NS,
    nativeId: id,
    title: titleOf(job),
    postingUrl: ats(job),
    applicationUrl: ats(job),
  })

const atsRecord = (job: number) =>
  record({
    provider: ATS,
    namespace: BOARD_NS,
    nativeId: String(job),
    title: titleOf(job),
    postingUrl: ats(job),
  })

async function opportunityOf(recordId: string): Promise<string | undefined> {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources
      WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows[0]?.opportunity_id as string | undefined
}

const key = (id: string) => JSON.stringify([id])

describe.skipIf(!hasDatabaseUrl())('sources-12: held keys and ATS dedup (real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry([NLJ, ATS]), catalog)
    const { rows: users } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'sources-12 spec', 'ADMIN') RETURNING id`,
      [`s12-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, users[0].id as string)
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

  describe('AC 1: heldIdentityKeys', () => {
    it('returns exactly the asked keys the source holds, scoped by type and namespace', async () => {
      await nljRecord('held-a', 9001)
      await nljRecord('held-b', 9002)
      // The same id under another namespace and under another type is not "held" here.
      await record({ provider: NLJ, namespace: `${PREFIX}-other`, nativeId: 'held-c' })
      await record({ provider: ATS, namespace: NLJ_NS, nativeId: 'held-d' })

      const held = await heldIdentityKeys(db, {
        sourceType: NLJ,
        namespace: NLJ_NS,
        keys: [key('held-a'), key('held-b'), key('held-c'), key('held-d'), key('unseen')],
      })
      expect([...held].sort()).toEqual([key('held-a'), key('held-b')])
    })

    it('an empty list asks nothing and holds nothing', async () => {
      expect(await heldIdentityKeys(db, { sourceType: NLJ, namespace: NLJ_NS, keys: [] })).toEqual(
        new Set(),
      )
    })

    it('a key with quotes and commas is data, not SQL', async () => {
      const odd = `x', 'y"); DROP TABLE job_source_records; --`
      await record({ provider: NLJ, namespace: NLJ_NS, nativeId: odd, postingUrl: ats(9003) })
      const held = await heldIdentityKeys(db, {
        sourceType: NLJ,
        namespace: NLJ_NS,
        keys: [key(odd), key('held-a')],
      })
      expect([...held].sort()).toEqual([key('held-a'), key(odd)].sort())
    })
  })

  describe('AC 3: no duplicate of a posting the ATS adapter holds', () => {
    it('ATS first, then Next Level Jobs: the copy attaches to the same opportunity', async () => {
      const a = await atsRecord(7001)
      const [ra] = await resolveRecordsTx(db, [a])
      expect(ra).toMatchObject({ kind: 'NEW' })
      const n = await nljRecord('6b00b2d9022782031e2a7001', 7001)
      const [rn] = await resolveRecordsTx(db, [n])
      expect(rn).toMatchObject({ kind: 'ATTACH' })
      expect(await opportunityOf(n)).toBe(await opportunityOf(a))
    })

    it('Next Level Jobs first, then the ATS: one opportunity, the ATS record joins the copy', async () => {
      // sources-18 case (c), replacing the sources-12 pin of two opportunities flagged CONFLICT: a
      // non-ATS first-comer still claims no ATS token (SR-M-2), but the ATS record, finding no
      // owner, joins the copy-only opportunity through ATS_COPY and claims its own token there.
      const n = await nljRecord('6b00b2d9022782031e2a7002', 7002)
      expect(await resolveRecordsTx(db, [n])).toMatchObject([{ kind: 'NEW' }])
      const a = await atsRecord(7002)
      expect(await resolveRecordsTx(db, [a])).toMatchObject([{ kind: 'ATTACH' }])
      expect(await opportunityOf(a)).toBe(await opportunityOf(n))
      const { rows } = await session.admin.query(
        `SELECT opportunity_id FROM job_opportunity_identity_tokens
          WHERE released_at IS NULL AND token_key LIKE $1`,
        [`%${BOARD}%7002%`],
      )
      expect(rows.map((r) => r.opportunity_id)).toEqual([await opportunityOf(a)])
      expect(await resolveRecordsTx(db, [n])).toMatchObject([
        { kind: 'KEEP', opportunityId: await opportunityOf(a) },
      ])
    })

    it('a Next Level Jobs record whose button names another job stays apart', async () => {
      const a = await atsRecord(7003)
      expect(await resolveRecordsTx(db, [a])).toMatchObject([{ kind: 'NEW' }])
      // The same title as the ATS job, but the button points at job 7004.
      const n = await record({
        provider: NLJ,
        namespace: NLJ_NS,
        nativeId: '6b00b2d9022782031e2a7004',
        title: titleOf(7003),
        postingUrl: ats(7004),
        applicationUrl: ats(7004),
      })
      expect(await resolveRecordsTx(db, [n])).toMatchObject([{ kind: 'NEW' }])
      expect(await opportunityOf(n)).not.toBe(await opportunityOf(a))
    })
  })
})
