import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { __resetThrottleForTests, type BoundedFetchOptions } from '../http/bounded-fetch'
import type { ClaimedRun } from '../ownership/job-run-ledger'
import { buildManifest } from '../providers/manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'
import { createJoobleProvider } from '../providers/sources/jooble.provider'
import { createJSearchProvider } from '../providers/sources/jsearch.provider'
import { createTheirStackProvider } from '../providers/sources/theirstack.provider'
import { readQuotaCredential } from '../quota-credentials'
import { buildCollectionContext } from '../runtime/collection-context'
import { ReportingAdapter } from './registered-adapter'
import { REPORTING_WIRING } from './reporting-wiring'

/**
 * r5 Task 2.5 T6, AC 1 and AC 2: every reporting adapter's declared hosts and byte caps reach the
 * transport, through the PRODUCTION context, for every manifest entry; and the transport refuses
 * anything off the list. A spy stands in for the transport; nothing leaves the process.
 */
const manifest = buildManifest({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})

const KEY = readQuotaCredential('jooble', () => 'wiring-spec-key')
/** The adapters, the keyed ones built WITH a (fake) key so they reach the transport. */
const ADAPTERS: ReadonlyMap<string, ReportingJobSourceProvider> = new Map(
  [
    ...MANIFEST_VALIDATION_ADAPTERS.values(),
    createJoobleProvider({ credential: KEY }),
    createJSearchProvider({ credential: KEY }),
    createTheirStackProvider({ credential: KEY }),
  ].map((p) => [p.type, p as unknown as ReportingJobSourceProvider]),
)

const MiB = 1024 * 1024
/**
 * What each type's requests declare, read off the adapters' own documented caps (hand-written here,
 * not computed from the constants, so a changed cap fails this table). `undefined` = no cap
 * declared, so the transport's 2 MiB default applies.
 */
const EXPECTED_MAX_BYTES: Readonly<Record<string, number | undefined>> = {
  ARBEITNOW_API: 8 * MiB,
  ASHBY_ATS: 10 * MiB,
  GREENHOUSE_ATS: 10 * MiB,
  HN_HIRING: 4 * MiB,
  RECRUITEE_ATS: 10 * MiB,
  WORKABLE_ATS: 10 * MiB,
}

const RUN = (sourceType: string): ClaimedRun => ({
  runId: '00000000-0000-4000-8000-0000000000aa',
  ownerToken: 'w:1',
  fencingEpoch: 1,
  sourceId: '00000000-0000-4000-8000-0000000000bb',
  cycleId: '00000000-0000-4000-8000-0000000000cc',
  attemptId: 'run-x',
  accountKey: null,
  sourceType: sourceType as ClaimedRun['sourceType'],
  checkpoint: null,
})

interface Seen {
  readonly url: string
  readonly opts: BoundedFetchOptions
}

/** One run of the entry's adapter through the production context; the first request is refused. */
async function firstRequestOf(entry: (typeof manifest.entries)[number]) {
  const provider = ADAPTERS.get(entry.type)!
  const adapter = new ReportingAdapter(provider, REPORTING_WIRING[entry.type])
  const config = provider.parseConfig({ ...entry.config, configVersion: entry.configVersion })
  const hosts = adapter.allowedHostsFor(config)
  const seen: Seen[] = []
  const control = buildCollectionContext(
    {
      transport: async (url, opts) => {
        seen.push({ url, opts })
        throw new Error('wiring-spec: stop')
      },
      recordBan: async () => undefined,
      savePage: async () => undefined,
      now: () => new Date('2026-10-25T10:00:00Z'),
    },
    {
      run: RUN(entry.type),
      hostKey: entry.hostKey,
      floorHours: 0,
      banScope: undefined,
      allowedHosts: hosts,
      meter: null,
      secrets: [],
      policyVersion: 1,
      deadline: new Date('2026-10-25T11:00:00Z'),
      leaseMs: 60_000,
      pageWriteTimeoutMs: 5_000,
    },
  )
  await provider.collectReport(config, control.ctx).catch(() => undefined)
  return { adapter, hosts, seen }
}

const wiredEntries = manifest.entries.filter((e) => REPORTING_WIRING[e.type] !== undefined)

describe('T6 AC 1: declared hosts and byte caps reach the transport, for every entry', () => {
  it('every reporting type is wired except Reed and Working Nomads (and legacy DOU)', () => {
    const reporting = [...MANIFEST_VALIDATION_ADAPTERS.keys()].sort()
    const wired = Object.keys(REPORTING_WIRING).sort()
    expect(reporting.filter((t) => !wired.includes(t))).toEqual(['REED_API', 'WORKINGNOMADS_API'])
    expect(wired.filter((t) => !reporting.includes(t as never))).toEqual([])
    expect(wired).toHaveLength(21)
  })

  it('Arbeitnow is pinned to exactly www.arbeitnow.com', () => {
    expect(REPORTING_WIRING.ARBEITNOW_API?.allowedHosts).toEqual(['www.arbeitnow.com'])
  })

  it('every one-host type is pinned to its literal host, with a version (hand-written table)', () => {
    const fixed: Record<string, string> = {
      ARBEITNOW_API: 'www.arbeitnow.com',
      ASHBY_ATS: 'api.ashbyhq.com',
      DJINNI_RSS: 'djinni.co',
      EUREMOTEJOBS_RSS: 'euremotejobs.com',
      GREENHOUSE_ATS: 'boards-api.greenhouse.io',
      HIMALAYAS_API: 'himalayas.app',
      HN_HIRING: 'hn.algolia.com',
      JOBGETHER_API: 'jobgether.com',
      JOBICY_API: 'jobicy.com',
      JOOBLE_API: 'jooble.org',
      JSEARCH_API: 'jsearch.p.rapidapi.com',
      MUSE_API: 'www.themuse.com',
      REMOTEOK_API: 'remoteok.com',
      REMOTIVE_API: 'remotive.com',
      SMARTRECRUITERS_ATS: 'api.smartrecruiters.com',
      THEIRSTACK_API: 'api.theirstack.com',
      WORKABLE_ATS: 'apply.workable.com',
      WWR_RSS: 'weworkremotely.com',
    }
    for (const [type, host] of Object.entries(fixed)) {
      const wiring = REPORTING_WIRING[type as keyof typeof REPORTING_WIRING]
      expect(wiring?.allowedHosts, type).toEqual([host])
      expect(wiring?.adapterVersion, type).toMatch(/^[a-z-]+-\d+$/)
    }
    // the three config-dependent ones are functions (covered per entry below)
    for (const type of ['LEVER_ATS', 'PERSONIO_ATS', 'RECRUITEE_ATS'] as const) {
      expect(typeof REPORTING_WIRING[type]?.allowedHosts, type).toBe('function')
      expect(REPORTING_WIRING[type]?.adapterVersion, type).toMatch(/^[a-z-]+-\d+$/)
    }
  })

  it('the manifest has entries for the wired types, so the run below is not vacuous', () => {
    expect(wiredEntries.length).toBeGreaterThanOrEqual(30)
  })

  it.each(wiredEntries.map((e) => [e.id, e] as const))(
    '%s: the spy sees the adapter`s hosts and its declared maxBytes, and every request stays on them',
    async (_id, entry) => {
      const { adapter, hosts, seen } = await firstRequestOf(entry)
      expect(adapter.transportWired).toBe(true)
      expect(adapter.adapterVersion).toMatch(/^[a-z-]+-\d+$/)
      expect(hosts.length).toBeGreaterThan(0)
      expect(seen.length).toBeGreaterThan(0)
      for (const s of seen) {
        expect(s.opts.allowedHosts).toEqual(hosts)
        expect(hosts).toContain(new URL(s.url).host)
        expect(s.opts.maxBytes).toBe(EXPECTED_MAX_BYTES[entry.type])
      }
    },
  )

  it('a tenant adapter is pinned to the tenant`s own host, never its apex', async () => {
    const byId = (id: string) => manifest.entries.find((e) => e.id === id)!
    expect((await firstRequestOf(byId('recruitee.board.bunq'))).hosts).toEqual([
      'bunq.recruitee.com',
    ])
    expect((await firstRequestOf(byId('personio.board.westwing'))).hosts).toEqual([
      'westwing.jobs.personio.de',
    ])
    expect((await firstRequestOf(byId('lever.board.eu.siteimprove'))).hosts).toEqual([
      'api.eu.lever.co',
    ])
    expect((await firstRequestOf(byId('lever.board.spotify'))).hosts).toEqual(['api.lever.co'])
  })

  it('an adapter with no wiring is not transport-wired (the claim refuses it)', () => {
    const provider = ADAPTERS.get('JOOBLE_API')!
    expect(new ReportingAdapter(provider).transportWired).toBe(false)
    expect(new ReportingAdapter(provider, { allowedHosts: [] }).transportWired).toBe(false)
    expect(new ReportingAdapter(provider, { allowedHosts: () => [] }).transportWired).toBe(true)
  })
})

describe('T6 AC 2: the production transport refuses an unlisted host and a redirect off the list', () => {
  const arbeitnow = () =>
    buildCollectionContext(
      {
        recordBan: async () => undefined,
        savePage: async () => undefined,
      },
      {
        run: RUN('ARBEITNOW_API'),
        hostKey: 'www.arbeitnow.com',
        floorHours: 0,
        banScope: undefined,
        allowedHosts: REPORTING_WIRING.ARBEITNOW_API!.allowedHosts as readonly string[],
        meter: null,
        secrets: [],
        policyVersion: 1,
        deadline: new Date(Date.now() + 60_000),
        leaseMs: 60_000,
        pageWriteTimeoutMs: 5_000,
      },
    ).ctx

  beforeEach(() => __resetThrottleForTests())
  afterEach(() => vi.unstubAllGlobals())

  it.each(['https://arbeitnow.com/api/job-board-api', 'https://evil.example/api'])(
    'a request to %s is refused before anything is sent',
    async (url) => {
      const f = vi.fn()
      vi.stubGlobal('fetch', f)
      await expect(arbeitnow().fetchText({ url })).rejects.toThrow('host not allowed')
      expect(f).not.toHaveBeenCalled()
    },
  )

  it('a redirect from the pinned host to its apex is refused before the second request', async () => {
    const f = vi.fn().mockResolvedValueOnce(
      Object.defineProperty(
        new Response(null, {
          status: 302,
          headers: { location: 'https://arbeitnow.com/api/job-board-api' },
        }),
        'url',
        { value: 'https://www.arbeitnow.com/api/job-board-api' },
      ),
    )
    vi.stubGlobal('fetch', f)
    await expect(
      arbeitnow().fetchText({ url: 'https://www.arbeitnow.com/api/job-board-api' }),
    ).rejects.toThrow('host not allowed')
    expect(f).toHaveBeenCalledTimes(1)
  })
})
