import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobSourceType } from '@crm/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import { buildManifest } from '../providers/manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import type { CollectionBatch, ReportingJobSourceProvider } from '../providers/reporting-provider'
import { ReportingAdapter } from '../registry/registered-adapter'
import { REPORTING_WIRING } from '../registry/reporting-wiring'
import {
  type FixtureServer,
  routeFetchTo,
  startFixtureServer,
} from './__test-helpers__/runtime-harness'
import { buildCollectionContext } from './collection-context'

/**
 * r5 Task 2.5 T6 — one END-TO-END run per raised-cap source (Greenhouse, Ashby, Arbeitnow): the
 * real adapter, the PRODUCTION context, the real `boundedFetchText` pinned to the adapter's
 * declared hosts, and a LOCAL fixture server (the harness rewrites the target; nothing leaves the
 * machine). AC 3 end to end: a page of EXACTLY the declared cap is fetched and parsed; one byte
 * over it is refused by the transport and never reaches the parser.
 */
const manifest = buildManifest({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})
const MiB = 1024 * 1024
const FIXTURES = join(__dirname, '../providers/sources/__fixtures__')

/** The real page, padded with an envelope key no schema reads, to exactly `bytes` UTF-8 bytes. */
function pageOf(file: string, bytes: number): string {
  const page = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Record<string, unknown>
  const base = Buffer.byteLength(JSON.stringify({ ...page, _pad: '' }))
  const body = JSON.stringify({ ...page, _pad: 'x'.repeat(bytes - base) })
  expect(Buffer.byteLength(body)).toBe(bytes)
  return body
}

const CASES = [
  // [type, declared cap (hand-written), first-page fixture, what a later page answers]
  ['GREENHOUSE_ATS', 10 * MiB, 'greenhouse/airbnb-board.json', null],
  ['ASHBY_ATS', 10 * MiB, 'ashby/linear-board.json', null],
  ['ARBEITNOW_API', 8 * MiB, 'arbeitnow/page-1.json', 'arbeitnow/empty-page.json'],
] as const

let fixture: FixtureServer
let restoreFetch: () => void

async function runOnce(type: JobSourceType): Promise<CollectionBatch> {
  const entry = manifest.entries.find((e) => e.type === type)!
  const provider = MANIFEST_VALIDATION_ADAPTERS.get(type) as unknown as ReportingJobSourceProvider
  const adapter = new ReportingAdapter(provider, REPORTING_WIRING[type])
  const config = provider.parseConfig({ ...entry.config, configVersion: entry.configVersion })
  const run: ClaimedRun = {
    runId: '00000000-0000-4000-8000-0000000000aa',
    ownerToken: 'w:1',
    fencingEpoch: 1,
    sourceId: '00000000-0000-4000-8000-0000000000bb',
    cycleId: '00000000-0000-4000-8000-0000000000cc',
    attemptId: 'run-x',
    accountKey: null,
    sourceType: type,
    checkpoint: null,
  }
  const { ctx } = buildCollectionContext(
    {
      recordBan: async () => undefined,
      savePage: async () => undefined,
    },
    {
      run,
      hostKey: entry.hostKey,
      floorHours: 0,
      banScope: undefined,
      allowedHosts: adapter.allowedHostsFor(config),
      meter: null,
      secrets: [],
      policyVersion: 1,
      deadline: new Date(Date.now() + 120_000),
      leaseMs: 120_000,
      pageWriteTimeoutMs: 5_000,
    },
  )
  return provider.collectReport(config, ctx)
}

describe('T6: one end-to-end run per raised-cap source against a fixture server', () => {
  beforeAll(async () => {
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  })
  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
  })
  beforeEach(() => {
    __resetThrottleForTests()
    fixture.requests.length = 0
  })

  it.each(CASES)(
    '%s: a first page of exactly its %i-byte cap is fetched and parsed into observations',
    async (type, cap, first, later) => {
      const body = pageOf(first, cap)
      fixture.answer = () =>
        fixture.requests.length === 1
          ? { body }
          : { body: readFileSync(join(FIXTURES, later ?? first), 'utf8') }
      const batch = await runOnce(type)
      expect(batch.requests[0]).toMatchObject({ status: 200, error: null })
      expect(batch.observations.length).toBeGreaterThan(0)
      // every request went to the adapter's own declared host
      const hosts = REPORTING_WIRING[type]!.allowedHosts as readonly string[]
      for (const r of fixture.requests) expect(hosts).toContain(r.host)
    },
    60_000,
  )

  it.each(CASES)(
    '%s: one byte past its %i-byte cap is refused PAYLOAD_TOO_LARGE before any parse',
    async (type, cap, first) => {
      const body = pageOf(first, cap + 1)
      fixture.answer = () => ({ body })
      const batch = await runOnce(type)
      expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
      expect(batch.observations).toEqual([])
      expect(fixture.requests).toHaveLength(1)
    },
    60_000,
  )
})
