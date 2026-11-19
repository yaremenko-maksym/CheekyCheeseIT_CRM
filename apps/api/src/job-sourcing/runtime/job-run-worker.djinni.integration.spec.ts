import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { djinniProvider } from '../providers/sources/djinni.provider'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * SP-M-1 (fix round 2 of PR #1433): the whole chain that makes a Djinni posting PERSIST, asserted
 * on the rows rather than on an adapter's in-memory report.
 *
 * WHY THIS SHAPE. The two defects that kept prod at nothing-stored both live BETWEEN the adapter
 * and the store, so no provider-level spec can see either: an item is refused during
 * `observePage`, and the refusal is not persisted anywhere. So this runs the REAL run worker
 * (`job-run-worker.ts`) with the REAL Djinni binding and the REAL record store against a REAL
 * Postgres, and stubs only the HTTP boundary — the committed capture of the live feed, served by
 * the local fixture server (nothing leaves the machine; `djinni.co` is never contacted).
 *
 * WHAT IT PINS, and what each half would otherwise hide:
 *   - the employer the source withholds no longer refuses the item (`MISSING_COMPANY`);
 *   - the namespace the stored row leaves empty no longer refuses it either (`INVALID_NAMESPACE`).
 * Both refusals produce the SAME persisted picture — `received 0` with `invalid 0` — because the
 * run row's `received` counts the observations that reached the store (the page write in
 * `store/source-record.store.ts`), and the honest raw/quarantined counts of
 * `toStoredReportCounts` have no production consumer at all. That is why prod showed a 420727-byte
 * HTTP 200 next to `received 0`, and why this spec asserts the record rows too: `received` alone
 * cannot distinguish "stored nothing" from "was never asked".
 *
 * RED / GREEN. On `main` the run stores 0 records; on this branch it stores every item of the
 * capture. Both sides end SUCCEEDED after exactly one served request, so a red here is an
 * assertion about rows and never a setup failure.
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa_djinni_r2 \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.djinni.integration
 */
const TAG = randomUUID().slice(0, 8)
const DJINNI_HOST = 'djinni.co'

/**
 * The complete real response, byte for byte (`primary-keyword-rust.provenance.json`: 8 of 8 items,
 * fetched 2026-10-23). The round-2 task names a 97-item capture; no such capture is committed on
 * any ref, and the item count is not what either defect turns on — every item of a feed is refused
 * or every item is stored.
 */
const FIXTURES = join(__dirname, '..', 'providers', 'sources', '__fixtures__', 'djinni')
const FEED = readFileSync(join(FIXTURES, 'primary-keyword-rust.xml'), 'utf8')
const FEED_ITEMS = (FEED.match(/<item>/g) ?? []).length

/** What the records of one source look like: how many, and under which namespace. */
async function storedFor(w: World, sourceId: string) {
  const { rows } = await w.admin.query(
    `SELECT count(*)::int AS n, array_agg(DISTINCT namespace) AS namespaces,
            array_agg(DISTINCT identity_kind::text) AS kinds
       FROM job_source_records WHERE source_id = $1`,
    [sourceId],
  )
  return rows[0] as { n: number; namespaces: string[] | null; kinds: string[] | null }
}

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
const ownSources: string[] = []

describe.skipIf(!hasDatabaseUrl())('Djinni postings reach the record store (PR #1433)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    w.register(djinniProvider, [DJINNI_HOST])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      // `fx.cleanup` sweeps records by a tagged namespace, and these are stored under the real
      // `djinni` namespace by design, so they are removed by the source that created them. Before
      // `w.close()`: the FK is ON DELETE SET NULL, so a dropped source orphans them instead.
      if (ownSources.length > 0)
        await w.admin.query(`DELETE FROM job_source_records WHERE source_id = ANY($1::uuid[])`, [
          ownSources,
        ])
      await w.close()
    } finally {
      await session.close()
    }
  }, 120_000)

  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
  })

  it('runs on a scratch database, as crm_app', async () => {
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('a prod-shaped source row (empty namespace, no employer in the feed) stores every item', async () => {
    fixture.answer = () => ({
      body: FEED,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    })
    // Prod's exact row: `config` names only the keyword and `job_sources.namespace` is the empty
    // string the manifest wrote. The config carries no namespace key either, which parses to the
    // same empty namespace through the base schema's default — the defect does not depend on which
    // of the two is empty.
    const { sourceId } = await w.source({
      type: 'DJINNI_RSS',
      config: { primaryKeyword: 'Rust' },
    })
    ownSources.push(sourceId)
    await w.admin.query(`UPDATE job_sources SET namespace = '' WHERE id = $1`, [sourceId])

    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })

    // The run was asked, and the feed was served: a red below is about rows, not about setup.
    expect(report).toMatchObject({ outcome: 'SUCCEEDED', errorCode: null, finished: true })
    expect(fixture.requests.map((r) => `${r.host}${r.path}`)).toEqual([
      `${DJINNI_HOST}/jobs/rss/?primary_keyword=Rust`,
    ])

    // The capture has items at all — a zero here would make every assertion below vacuous.
    expect(FEED_ITEMS).toBeGreaterThan(0)
    const stored = await storedFor(w, sourceId)
    expect(stored.n).toBe(FEED_ITEMS)
    // Keyed under the namespace the ADAPTER supplies, never the empty one the row stores.
    expect(stored.namespaces).toEqual(['djinni'])
    expect(await runRow(w.admin, report!.runId)).toMatchObject({
      outcome: 'SUCCEEDED',
      received: FEED_ITEMS,
    })
  }, 60_000)
})
