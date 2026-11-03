import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { DETAIL_FETCH, enqueueDirty } from './dirty-work.store'
import { type ClaimedRun, JobRunLedger } from './job-run-ledger'

/**
 * SFS U10 (ADR 6a, step 3; AC5 + SPEC-M-1): the 08:30 DETAIL_ONLY pass's CLAIM predicate
 * (`claimDue`/`countDue` with `detailPass`), against a REAL Postgres, AS `crm_app`. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.detail-pass.integration
 *
 * Proves: (i) only detail-capable sources WITH a pending DETAIL_FETCH row of their own
 * source_type+namespace are claimed, others skipped; (iii) an IN_LIST (non-detail-capable) source is
 * NEVER claimed even with such a row — the inert proof, SPEC-M-1 enforced at the claim; (iv) the
 * `detail:<date>` cycle dedups (a second pass on the same cycle claims nothing). (ii) — the claimed
 * run issues NO list request and drains the backlog via the tail — is the worker's DETAIL_ONLY half
 * (CR-M-7, proven in job-run-worker specs #1229) wired here by the window/cron threading scope
 * DETAIL_ONLY (job-sourcing.cron.spec).
 */
const TAG = randomUUID().slice(0, 8)
const ON_DEMAND_TYPE: JobSourceType = 'REMOTIVE_API'
// A second reporting type kept IN_LIST — never in `onDemandTypes()`, so the inert proof (iii) holds
// regardless of the shared catalog's accumulated ON_DEMAND entries.
const IN_LIST_TYPE: JobSourceType = 'REMOTEOK_API'

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let db: ReturnType<typeof drizzle>
const seededRecords: string[] = []

async function cycle(key = fx.cycleKey()): Promise<string> {
  return (await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })).cycleId
}

/** A detail-capable (ON_DEMAND) or IN_LIST source; its namespace matches the fixtures' cleanup tag. */
async function source(
  type: JobSourceType,
  detailMode: 'ON_DEMAND' | 'IN_LIST',
): Promise<{ id: string; type: JobSourceType; namespace: string }> {
  const namespace = `t3spec-${TAG}-${randomUUID().slice(0, 8)}`
  const id = await kit.reporting(
    { type, namespace },
    detailMode === 'ON_DEMAND' ? { type, detailMode, detailPerRun: 5 } : { type },
  )
  return { id, type, namespace }
}

/** A PENDING DETAIL_FETCH row for a (type, namespace) — the same join the claim predicate uses. */
async function enqueueDetail(type: JobSourceType, namespace: string): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
     VALUES ($1::job_source_type, $2, 'NATIVE_ID', $3) RETURNING id`,
    [type, namespace, `${namespace}:${randomUUID()}`],
  )
  const recId = String(rows[0].id)
  seededRecords.push(recId)
  await enqueueDirty(db, 'SOURCE_RECORD', recId, 1, DETAIL_FETCH)
  return recId
}

const sourcesOf = (runs: readonly ClaimedRun[]) => runs.map((r) => r.sourceId).sort()

async function claimDetailPass(cycleId: string, ids: readonly string[]): Promise<ClaimedRun[]> {
  const { claimed } = await ledger.claimDue({
    cycleId,
    owner: 'detail-worker',
    limit: 50,
    onlyIds: ids,
    detailPass: { cycleId },
  })
  return claimed
}

describe.skipIf(!hasDatabaseUrl())(
  'U10: the 08:30 DETAIL_ONLY-pass claim predicate, as crm_app',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      ledger = new JobRunLedger(db, specRegistry([ON_DEMAND_TYPE, IN_LIST_TYPE]), catalog)
      const { rows } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'U10 detail spec', 'ADMIN') RETURNING id`,
        [`u10-detail-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
        if (seededRecords.length > 0) {
          await session.admin.query(
            `DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`,
            [seededRecords],
          )
        }
        await fx.cleanup()
        await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
      } finally {
        await session.close()
      }
    })

    it('runs on a scratch database, as crm_app', async () => {
      const { rows } = await session.pool.query('SELECT current_database() AS db')
      expect(rows[0].db).not.toBe('crm_db')
    })

    it('(i) claims only a detail-capable source with a pending DETAIL_FETCH row of its own type+namespace', async () => {
      const withWork = await source(ON_DEMAND_TYPE, 'ON_DEMAND')
      await enqueueDetail(withWork.type, withWork.namespace)
      const withoutWork = await source(ON_DEMAND_TYPE, 'ON_DEMAND') // detail-capable but no pending row
      // right type, WRONG namespace: a row that must not pull `wrongNs` in
      const wrongNs = await source(ON_DEMAND_TYPE, 'ON_DEMAND')
      await enqueueDetail(wrongNs.type, `t3spec-${TAG}-not-${randomUUID().slice(0, 8)}`)

      const ids = [withWork.id, withoutWork.id, wrongNs.id]
      const cycleId = await cycle()
      expect(sourcesOf(await claimDetailPass(cycleId, ids))).toEqual([withWork.id])
      expect(await ledger.countDue({ onlyIds: ids, detailPass: { cycleId } })).toBe(0) // the one claimable already ran in this cycle
    })

    it('(iii) inert proof / SPEC-M-1: an IN_LIST source with a pending DETAIL_FETCH row is never claimed', async () => {
      const inList = await source(IN_LIST_TYPE, 'IN_LIST')
      await enqueueDetail(inList.type, inList.namespace)
      const cycleId = await cycle()
      expect(await claimDetailPass(cycleId, [inList.id])).toEqual([])
      expect(await ledger.countDue({ onlyIds: [inList.id], detailPass: { cycleId } })).toBe(0)
    })

    it('(iv) the detail:<date> cycle dedups: a second pass on the same cycle claims nothing', async () => {
      const src = await source(ON_DEMAND_TYPE, 'ON_DEMAND')
      await enqueueDetail(src.type, src.namespace)
      const key = fx.cycleKey()
      const first = await cycle(key)
      const claimed = await claimDetailPass(first, [src.id])
      expect(sourcesOf(claimed)).toEqual([src.id])
      for (const run of claimed)
        await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
      // the handler fired again the same Kyiv day: same key -> same cycle, already ran -> claims none
      expect(await cycle(key)).toBe(first)
      expect(await claimDetailPass(first, [src.id])).toEqual([])
    })

    it('CR-H-1 / SR-M-1: a detail-pass refusal is recorded as SWEPT — it never pulls next_attempt_at earlier', async () => {
      // A detail-capable source, due only a day out, on a host whose gap is open for ~60 s: the
      // detail pass claims it (cadence-free) and is refused HOST_RATE_GAP, whose write-back would
      // move next_attempt_at to ~now+60s. Recorded as swept (GREATEST), the day-out slot must stand;
      // an un-swept write would pull it forward and hand the REGULAR run a second claim beside its own.
      const host = fx.host(`detail-gap-${randomUUID().slice(0, 6)}`)
      const namespace = `t3spec-${TAG}-${randomUUID().slice(0, 8)}`
      const id = await kit.reporting(
        {
          type: ON_DEMAND_TYPE,
          namespace,
          hostKey: host,
          nextAttemptSql: "clock_timestamp() + interval '1 day'",
        },
        { type: ON_DEMAND_TYPE, detailMode: 'ON_DEMAND', detailPerRun: 5 },
        { rate: { perMinute: 1, perDay: 100 }, floorHours: 0 },
      )
      await enqueueDetail(ON_DEMAND_TYPE, namespace)
      await session.admin.query(
        `INSERT INTO job_source_hosts (host_key, last_claimed_at) VALUES ($1, clock_timestamp())`,
        [host],
      )
      const before = (await fx.sourceRow(id)).next_in_s ?? -1
      const cycleId = await cycle()
      const { claimed, refused } = await ledger.claimDue({
        cycleId,
        owner: 'detail-worker',
        limit: 10,
        onlyIds: [id],
        detailPass: { cycleId },
      })
      expect(claimed).toEqual([])
      expect(refused).toEqual([{ sourceId: id, reason: 'HOST_RATE_GAP' }])
      // swept: the day-out slot is kept (GREATEST), not pulled to ~now+60s
      expect((await fx.sourceRow(id)).next_in_s ?? -1).toBeGreaterThan(before - 60)
    })

    it('sweep and detailPass are mutually exclusive on both claimDue and countDue', async () => {
      const cycleId = await cycle()
      const scope = { cycleId, skipIds: [] as string[] }
      await expect(
        ledger.claimDue({
          cycleId,
          owner: 'detail-worker',
          limit: 1,
          sweep: scope,
          detailPass: { cycleId },
        }),
      ).rejects.toThrow(/mutually exclusive/)
      await expect(ledger.countDue({ sweep: scope, detailPass: { cycleId } })).rejects.toThrow(
        /mutually exclusive/,
      )
    })

    it('a detail-pass claim naming another cycle is refused', async () => {
      const a = await cycle()
      const b = await cycle()
      await expect(
        ledger.claimDue({
          cycleId: a,
          owner: 'detail-worker',
          limit: 1,
          detailPass: { cycleId: b },
        }),
      ).rejects.toThrow(/another cycle/)
    })
  },
)
