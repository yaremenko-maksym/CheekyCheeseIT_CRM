import { createHash, randomUUID } from 'node:crypto'
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
import { cleanupStore } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SourceObservation } from '../normalize/observation'
import { DETAIL_FETCH, enqueueDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { saveObservationPage } from '../store/source-record.store'
import { loadOpportunity } from './recompute-inputs'
import { RecomputeWorker, createRecomputeSteps } from './recompute-worker'

/**
 * SFS U10 part 3 — CR-M-2 / CR-M-3 / SPEC-M-3 against a real Postgres, as `crm_app`.
 *
 * CR-M-2: the non-empty `onDemandMissing` SQL (loadOpportunity with ON_DEMAND types) is run against
 * Postgres, not only regex-matched, so a SQL error would surface before any manifest flip.
 *
 * CR-M-3 / SPEC-M-3: a backing ON_DEMAND record whose current revision has NO description stops
 * counting as detail-pending once its current-version DETAIL_FETCH row has SETTLED (DONE / DEFERRED
 * / FAILED) — not only on FAILED. A 404 GONE or an empty-description detail completes the row DONE
 * yet writes no description, so the FAILED-only rule left the opportunity perpetually detail-pending.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `u10dp-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const TYPE = 'REMOTIVE_API' as const

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let senior: string

/** A no-description record of the spec's namespace: the ON_DEMAND list-only shape. */
function noDescriptionObservation(nativeId: string): SourceObservation {
  return {
    identity: {
      provider: TYPE,
      namespace: NAMESPACE,
      nativeId,
      identityKey: JSON.stringify([nativeId]),
      identityKind: 'NATIVE_ID',
    },
    sourcePostingUrl: `https://fixture.test/jobs/${nativeId}`,
    applicationUrl: null,
    originalFields: {} as SourceObservation['originalFields'],
    normalized: {
      title: 'Senior Go Engineer',
      companyName: `Acme ${TAG}`,
      companyNameNormalized: `acme ${TAG}`,
      location: 'Remote',
      descriptionMd: '', // no description -> description_sha256 is NULL, like an ON_DEMAND list row
      publishedAt: null,
      dates: [],
      tags: ['go'],
    },
    evidence: [],
    adapterVersion: 'remotive_api-1',
    normalizerVersion: 'n1',
    contentHash: createHash('sha256').update(`u10dp-${TAG}-${nativeId}`).digest('hex'),
  }
}

/** Write the record, then form its opportunity with two recompute passes (no auto DETAIL_FETCH). */
async function makeOpportunity(
  nativeId: string,
): Promise<{ recordId: string; opportunityId: string; version: number }> {
  const [saved] = await saveObservationPage(db, run, {
    observations: [noDescriptionObservation(nativeId)],
    checkpoint: specCheckpoint(1),
  })
  const recordId = saved?.recordId as string
  // createRecomputeSteps defaults onDemandTypes to [], so forming the opportunity enqueues no
  // DETAIL_FETCH of its own: this spec controls the row states explicitly below.
  const steps = createRecomputeSteps(db)
  const worker = new RecomputeWorker(steps, { owner: `u10dp-${TAG}`, batchSize: 50 })
  // SOURCE_RECORD -> (resolve, enqueue OPPORTUNITY) ; OPPORTUNITY -> (evaluate, install). Two passes
  // suffice for this record alone, but the dirty-work queue is shared with the rest of the suite, so
  // drain until nothing more is claimed (bounded) — otherwise leftover rows consume the two passes
  // and this record's OPPORTUNITY stays unprocessed (seen as a dropped opportunity on the first call).
  for (let i = 0; i < 10 && (await worker.runOnce()).claimed > 0; i += 1) {
    /* keep draining the shared queue */
  }
  const { rows } = await session.admin.query(
    `SELECT s.opportunity_id, h.observation_seq
       FROM job_opportunity_sources s
       JOIN job_source_record_heads h ON h.source_record_id = s.source_record_id
      WHERE s.source_record_id = $1 AND s.unlinked_at IS NULL`,
    [recordId],
  )
  if (rows[0] === undefined) {
    throw new Error(`makeOpportunity(${nativeId}): no linked opportunity formed for record ${recordId}`)
  }
  return {
    recordId,
    opportunityId: rows[0].opportunity_id as string,
    version: Number(rows[0].observation_seq),
  }
}

async function setStatus(recordId: string, status: string): Promise<void> {
  // A terminal status is paired with `completed_at` (ck_job_dirty_work_terminal_pair).
  await session.admin.query(
    `UPDATE job_dirty_work SET status = $2, completed_at = clock_timestamp()
      WHERE entity_kind = 'SOURCE_RECORD' AND entity_id = $1 AND reason = $3`,
    [recordId, status, DETAIL_FETCH],
  )
}

describe.skipIf(!hasDatabaseUrl())(
  'loadOpportunity detail-pending against Postgres (U10 CR-M-2 / CR-M-3)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession({ appPoolMax: 4 })
      const { rows } = await session.admin.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      const ledger = new JobRunLedger(db, specRegistry([TYPE]), catalog)
      const { rows: admins } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'U10dp admin', 'ADMIN') RETURNING id`,
        [`u10dp-admin-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
      run = handleOf(await kit.claimOne(await kit.reporting({ type: TYPE })))
      const { rows: seniors } = await session.admin.query(
        `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, 'U10dp senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
        [`u10dp-senior-${TAG}@example.test`],
      )
      senior = seniors[0].id as string
    })

    afterAll(async () => {
      if (session === undefined) return
      try {
        await session.admin.query(`DELETE FROM job_exclusion_filters WHERE senior_id = $1`, [
          senior,
        ])
        await cleanupStore(session.admin, PREFIX, TAG)
        await fx.cleanup()
        await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [kit.actor, senior],
        ])
      } finally {
        await session.close()
      }
    })

    it('CR-M-2: the non-empty onDemandMissing SQL runs against Postgres without error', async () => {
      const { opportunityId } = await makeOpportunity('sql-smoke')
      // The non-constant jsonb subquery executes; a SQL error (bad cast, column) would throw here.
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded).not.toBeNull()
      expect(Array.isArray(loaded?.onDemandMissing)).toBe(true)
    })

    it('a record with no description and no DETAIL_FETCH row is detail-pending', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('pending-none')
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.detailPending).toBe(true)
      expect(loaded?.onDemandMissing).toEqual([{ recordId, version }])
    })

    it('a PENDING current-version DETAIL_FETCH row keeps it detail-pending', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('pending-row')
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.detailPending).toBe(true)
      expect(loaded?.onDemandMissing).toEqual([{ recordId, version }])
    })

    it('CR-M-3: a DONE current-version row stops it being detail-pending (404 GONE / empty detail)', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('done-row')
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
      await setStatus(recordId, 'DONE')
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.detailPending).toBe(false)
      expect(loaded?.onDemandMissing).toEqual([])
    })

    it('a FAILED current-version row stops it being detail-pending', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('failed-row')
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
      await setStatus(recordId, 'FAILED')
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.detailPending).toBe(false)
      expect(loaded?.onDemandMissing).toEqual([])
    })

    it('a DEFERRED current-version row stops it being detail-pending', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('deferred-row')
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
      await setStatus(recordId, 'DEFERRED')
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.detailPending).toBe(false)
      expect(loaded?.onDemandMissing).toEqual([])
    })

    /**
     * AC4-TTL (ADR 6a step 4): advance the record to a NEW latest revision — with a description
     * (`withDescription`, as a detail-write does) or without (a fresh list observation) — stored
     * `ageDays` ago, and move the head to it. Returns the new `observation_seq`.
     */
    async function advanceRevision(
      recordId: string,
      opts: { withDescription: boolean; ageDays: number },
    ): Promise<number> {
      const { rows: head } = await session.admin.query(
        `SELECT latest_revision_id, observation_seq FROM job_source_record_heads WHERE source_record_id = $1`,
        [recordId],
      )
      const latestRev = head[0].latest_revision_id as string
      const nextSeq = Number(head[0].observation_seq) + 1
      let blobSha: string | null = null
      if (opts.withDescription) {
        blobSha = createHash('sha256').update(`u10ttl-${TAG}-${recordId}-${nextSeq}`).digest('hex')
        await session.admin.query(
          `INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [blobSha, `Detail description ${nextSeq}.`],
        )
      }
      // A fresh 64-hex content_hash per revision: unique, and valid under
      // ck_job_source_record_revisions_content_hash_hex (appending a '-vN' suffix is non-hex).
      const contentHash = createHash('sha256')
        .update(`u10ttl-${TAG}-${recordId}-${nextSeq}`)
        .digest('hex')
      const { rows: rev } = await session.admin.query(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized,
            original_identity, description_sha256, received_at)
         SELECT source_record_id, adapter_version, normalizer_version, $2,
                normalized, original_identity, $3, clock_timestamp() - make_interval(days => $4)
           FROM job_source_record_revisions WHERE id = $1 RETURNING id`,
        [latestRev, contentHash, blobSha, opts.ageDays],
      )
      await session.admin.query(
        `UPDATE job_source_record_heads
            SET latest_revision_id = $2, observation_seq = $3, observed_at = clock_timestamp()
          WHERE source_record_id = $1`,
        [recordId, rev[0].id, nextSeq],
      )
      return nextSeq
    }

    it('AC4-TTL: a detail aged over 14 days is onDemandStale (not detail-pending, not missing)', async () => {
      const { recordId, opportunityId } = await makeOpportunity('ttl-aged')
      const seq = await advanceRevision(recordId, { withDescription: true, ageDays: 20 })
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      // present description -> not missing, evaluable -> not detail-pending; but aged -> a re-fetch target
      expect(loaded?.onDemandMissing).toEqual([])
      expect(loaded?.detailPending).toBe(false)
      expect(loaded?.onDemandStale).toEqual([{ recordId, version: seq }])
    })

    it('AC4-TTL: a detail younger than 14 days is NOT re-fetched', async () => {
      const { recordId, opportunityId } = await makeOpportunity('ttl-fresh')
      await advanceRevision(recordId, { withDescription: true, ageDays: 3 })
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.onDemandStale).toEqual([])
      expect(loaded?.onDemandMissing).toEqual([])
      expect(loaded?.detailPending).toBe(false)
    })

    it('AC4-TTL: idempotent — a DETAIL_FETCH already queued at the current version is not re-surfaced', async () => {
      const { recordId, opportunityId } = await makeOpportunity('ttl-idem')
      const seq = await advanceRevision(recordId, { withDescription: true, ageDays: 20 })
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, seq, DETAIL_FETCH)
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      expect(loaded?.onDemandStale).toEqual([])
    })

    it('AC4 (b-list-change): a new NULL-description list revision after a settled fetch is missing again', async () => {
      const { recordId, opportunityId, version } = await makeOpportunity('list-change')
      // the detail was fetched and settled at the first list version
      await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
      await setStatus(recordId, 'DEFERRED')
      // a NEW list observation arrives: a revision WITHOUT a description, advancing the head
      const seq = await advanceRevision(recordId, { withDescription: false, ageDays: 0 })
      const loaded = await loadOpportunity(db, opportunityId, [TYPE])
      // the existing machinery re-surfaces it as MISSING at the new version (list-change re-fetch)
      expect(loaded?.onDemandMissing).toEqual([{ recordId, version: seq }])
      expect(loaded?.detailPending).toBe(true)
      expect(loaded?.onDemandStale).toEqual([])
    })
  },
)
