import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { defineRssProvider } from '../providers/rss.provider'
import { djinniProvider } from '../providers/sources/djinni.provider'
import { wwrSpec } from '../providers/sources/wwr.provider'
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
      <pubDate>${new Date(Date.now() - 86_400_000).toUTCString()}</pubDate>
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
/** WWR-shaped: `Company: Position` titles, and one item with no title at all (a quarantine). */
const WWR_BODY = feed([
  item({
    title: 'Acme: Platform Engineer',
    link: 'https://weworkremotely.com/l/1',
    guid: `w-${TAG}-1`,
  }),
  item({ title: 'Globex: SRE', link: 'https://weworkremotely.com/l/2', guid: `w-${TAG}-2` }),
  item({ link: 'https://weworkremotely.com/l/3', guid: `w-${TAG}-3` }),
])
/**
 * Schema-invalid: two storable items and one whose mapper throws. The mapper fault is the
 * `MAPPER_THREW` path of the shared feed loop, which counts the item as `invalid` (not quarantine).
 * The `-bad` guid is what `faultyWwrSpec` keys on.
 */
const WWR_SCHEMA_INVALID_BODY = feed([
  item({
    title: 'Acme: Platform Engineer',
    link: 'https://weworkremotely.com/l/s1',
    guid: `w-${TAG}-s1`,
  }),
  item({ title: 'Globex: SRE', link: 'https://weworkremotely.com/l/s2', guid: `w-${TAG}-s2` }),
  item({
    title: 'Initech: Backend',
    link: 'https://weworkremotely.com/l/bad',
    guid: `w-${TAG}-bad`,
  }),
])

/** The real WWR spec, except that one entry's mapper throws. Behaves identically for every other entry. */
const faultyWwrSpec: typeof wwrSpec = {
  ...wwrSpec,
  mapEntry: (entry, config) => {
    if (entry.guid.endsWith('-bad')) throw new Error('mapper refuses this entry')
    return wwrSpec.mapEntry(entry, config)
  },
}
const faultyWwrProvider = defineRssProvider(faultyWwrSpec)

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void
/** The WWR body the fixture serves; a test swaps it before its run. */
let wwrBody = WWR_BODY

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
    w.register(faultyWwrProvider, ['weworkremotely.com'])
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
    fixture.answer = (req) => ({
      body: req.host === 'djinni.co' ? DJINNI_BODY : wwrBody,
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
    wwrBody = WWR_BODY
  })

  // sources-09 fix round 2 (CR-M-2, Master A1): quarantine is counted in no persisted counter.
  it('a Djinni-shaped feed whose every item is quarantined records nothing, exactly as on main', async () => {
    const row = await runFeed({
      type: 'DJINNI_RSS',
      config: { configVersion: 1, primaryKeyword: 'Rust', namespace: 'djinni' },
    })
    expect(row.outcome).toBe('SUCCEEDED')
    expect(row.error_code).toBeNull()
    // Round 1 wrote received 3, invalid 3 here. Quarantine now lands in no counter, so the run
    // reads as on main (no SCHEMA_DRIFT on a steady state) and the ledger's CHECKs hold on 0 / 0.
    expect({ received: row.received, invalid: row.invalid }).toEqual({ received: 0, invalid: 0 })
    expect({ created: row.created, unchanged: row.unchanged, duplicates: row.duplicates }).toEqual({
      created: 0,
      unchanged: 0,
      duplicates: 0,
    })
    // SO-E3, as narrowed in round 2: `last_nonempty_at` moves for schema-invalid and lost items,
    // not for a quarantine-only run.
    expect(row.nonempty_at).toBeNull()
  }, 60_000)

  it('a WWR-shaped feed with one quarantined item of three records the 2 it stored and no invalid', async () => {
    const row = await runFeed({
      type: 'WWR_RSS',
      config: { configVersion: 1, namespace: 'wwr' },
    })
    expect(row.outcome).toBe('SUCCEEDED')
    // Round 1 wrote received 3, invalid 1. The untitled item is quarantine, so it is in no counter.
    expect({ received: row.received, invalid: row.invalid }).toEqual({ received: 2, invalid: 0 })
    expect(row.created).toBe(2)
    expect(row.created + row.unchanged + row.duplicates + row.invalid).toBe(row.received)
  }, 60_000)

  it('a feed with one schema-invalid item of three records 3 received and 1 invalid beside the 2 it stored', async () => {
    wwrBody = WWR_SCHEMA_INVALID_BODY
    // A config of its own: `uq_job_sources_type_config` (type, config) refuses a second WWR source
    // with the same one. The namespace is a literal 'wwr' (PR #1428), so a category tells the two apart;
    // the fixture answers by host, so the category feed URL is served the same body.
    const row = await runFeed({
      type: 'WWR_RSS',
      config: { configVersion: 1, namespace: 'wwr', category: 'remote-devops-sysadmin-jobs' },
    })
    expect(row.outcome).toBe('SUCCEEDED')
    expect({ received: row.received, invalid: row.invalid }).toEqual({ received: 3, invalid: 1 })
    expect(row.created).toBe(2)
    expect(row.nonempty_at).not.toBeNull()
    // The SUCCEEDED CHECK (`ck_job_collection_runs_succeeded_complete`) holds with a live
    // `invalid`: created + revised + unchanged + duplicates + invalid = received.
    expect(row.created + row.unchanged + row.duplicates + row.invalid).toBe(row.received)
  }, 60_000)
})
