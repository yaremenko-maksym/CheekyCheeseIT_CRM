import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { djinniProvider } from '../providers/sources/djinni.provider'
import { wwrProvider } from '../providers/sources/wwr.provider'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'

/**
 * sources-09: what the run row says a feed run READ, against a REAL Postgres, the real
 * `boundedFetchText` to a LOCAL fixture server, the real RSS providers, worker and ledger.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-worker.counts.integration.spec
 *
 * The filter must contain the literal `integration.spec`: `isIntegrationRun` in
 * `apps/api/vitest.config.mts` keys on that substring, and without it Vitest drops every
 * integration spec from file discovery and reports "No test files found".
 *
 * THE DEFECT THESE TWO CASES PIN. Until this spec's fix, the run row's `received` came only from
 * the page write (`store/source-record.store.ts` -> `writePageProgress`), where it is the number of
 * observations PERSISTED, and `invalid` was written by nothing at all. A feed whose items the
 * observation builder refuses therefore recorded `received 0, invalid 0` - byte-identical to an
 * empty feed, which is how every Djinni and WWR run on prod read as "zero items" while fetching
 * 420 KB (91 and 34 runs, 2026-11-19). The honest counts existed: `toStoredReportCounts`
 * (`providers/reporting-provider.ts`) computes them, and the worker dropped them into an in-memory
 * report nobody persisted.
 *
 * WHY THE BODIES ARE SHAPED HERE AND NOT THE COMMITTED CAPTURES. The refusal has to be one no
 * neighbouring PR removes: PR #1433 makes a Djinni item with no employer storable and PR #1428
 * gives WWR its namespace, so a case resting on MISSING_COMPANY or INVALID_NAMESPACE would stop
 * refusing anything days from now and pass vacuously. A title-less item is refused
 * (MISSING_TITLE) under every version of that contract.
 */
const TAG = randomUUID().slice(0, 8)

const item = (over: { title?: string; link: string; guid: string }): string => `
    <item>
      ${over.title === undefined ? '' : `<title>${over.title}</title>`}
      <link>${over.link}</link>
      <guid>${over.guid}</guid>
      <description>&lt;p&gt;body&lt;/p&gt;</description>
      <pubDate>Wed, 19 Nov 2026 10:00:00 +0000</pubDate>
    </item>`

const feed = (items: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>f</title><link>https://example.test/</link>
  <description>d</description>${items.join('')}
</channel></rss>`

/** Djinni-shaped: three items, none with a title, so every one is refused. */
const DJINNI_BODY = feed(
  [1, 2, 3].map((n) => item({ link: `https://djinni.co/jobs/${n}/`, guid: `dj-${TAG}-${n}` })),
)
/** WWR-shaped: `Company: Position` titles, and one item with no title at all. */
const WWR_BODY = feed([
  item({
    title: 'Acme: Platform Engineer',
    link: 'https://weworkremotely.com/l/1',
    guid: `w-${TAG}-1`,
  }),
  item({ title: 'Globex: SRE', link: 'https://weworkremotely.com/l/2', guid: `w-${TAG}-2` }),
  item({ link: 'https://weworkremotely.com/l/3', guid: `w-${TAG}-3` }),
])

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

interface CountsRow {
  outcome: string
  error_code: string | null
  received: number
  invalid: number
  created: number
  unchanged: number
  duplicates: number
  nonempty_at: string | null
}

async function runFeed(input: {
  type: 'DJINNI_RSS' | 'WWR_RSS'
  config: Record<string, unknown>
}): Promise<CountsRow> {
  const s = await w.source({ type: input.type, config: input.config })
  await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [s.sourceId] })
  const { rows } = await w.admin.query(
    `SELECT outcome::text AS outcome, error_code, received::int AS received, invalid::int AS invalid,
            created::int AS created, unchanged::int AS unchanged, duplicates::int AS duplicates,
            (SELECT s.last_nonempty_at::text FROM job_sources s WHERE s.id = $1) AS nonempty_at
       FROM job_collection_runs WHERE source_id = $1`,
    [s.sourceId],
  )
  expect(rows).toHaveLength(1)
  return rows[0] as CountsRow
}

describe.skipIf(!hasDatabaseUrl())('sources-09: a feed run records what it read', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    w = await openWorld(session, TAG)
    w.register(djinniProvider, ['djinni.co'])
    w.register(wwrProvider, ['weworkremotely.com'])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
    fixture.answer = (req) => ({
      body: req.host === 'djinni.co' ? DJINNI_BODY : WWR_BODY,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    })
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      await w.close()
    } finally {
      await session.close()
    }
  })

  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
  })

  it('a Djinni-shaped feed whose every item is refused records 3 received and 3 invalid, not an empty feed', async () => {
    const row = await runFeed({
      type: 'DJINNI_RSS',
      config: { configVersion: 1, primaryKeyword: 'Rust', namespace: 'djinni' },
    })
    expect(row.outcome).toBe('SUCCEEDED')
    expect(row.error_code).toBeNull()
    // Before the fix: received 0, invalid 0 - the prod symptom, indistinguishable from an empty feed.
    expect({ received: row.received, invalid: row.invalid }).toEqual({ received: 3, invalid: 3 })
    expect({ created: row.created, unchanged: row.unchanged, duplicates: row.duplicates }).toEqual({
      created: 0,
      unchanged: 0,
      duplicates: 0,
    })
    // SO-E3: the attempt answered with three items and kept none. `last_nonempty_at` is the one
    // column that separates "succeeding and finding nothing for a week" from "succeeding on
    // items we refuse", so it must move here. Before the fix it stayed NULL, because the only
    // `received` the ledger could see was the one the page write persisted: zero.
    expect(row.nonempty_at).not.toBeNull()
  }, 60_000)

  it('a WWR-shaped feed with one refused item of three records 3 received and 1 invalid beside the 2 it stored', async () => {
    const row = await runFeed({
      type: 'WWR_RSS',
      config: { configVersion: 1, namespace: 'wwr' },
    })
    expect(row.outcome).toBe('SUCCEEDED')
    // Before the fix: received 2 (what was persisted), invalid 0.
    expect({ received: row.received, invalid: row.invalid }).toEqual({ received: 3, invalid: 1 })
    expect(row.created).toBe(2)
    // The SUCCEEDED CHECK (`ck_job_collection_runs_succeeded_complete`) holds with a live
    // `invalid`: created + revised + unchanged + duplicates + invalid = received. The row exists,
    // so Postgres accepted it; this states the arithmetic the constraint checked.
    expect(row.created + row.unchanged + row.duplicates + row.invalid).toBe(row.received)
  }, 60_000)
})
