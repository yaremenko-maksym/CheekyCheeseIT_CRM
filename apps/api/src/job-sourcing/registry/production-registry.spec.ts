import type { ConfigService } from '@nestjs/config'
import type { JobSourceType } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { meteredContext } from '../../test/quota-harness'
import type { Env } from '../../config/env'
import { DouRssProvider } from '../dou.provider'
import { claimGate } from '../ownership/ledger-policy'
import { SourceNotReadyError } from '../providers/sources/quota-provider'
import { LEDGER_CATALOG_SNAPSHOT } from '../runtime/ledger-catalog.snapshot'
import { catalogFromSnapshot, productionLedgerCatalog } from '../runtime/production-catalog'
import { JobSourceRegistry } from './job-source-registry'
import { createProductionRegistry } from './production-registry'
import { LegacyDouAdapter, type ReportingAdapter } from './registered-adapter'
import { REPORTING_WIRING } from './reporting-wiring'

/**
 * The production registry registers DOU (legacy) and every wired REPORTING adapter, and
 * registering is not enabling: the manifest's readiness stays the gate.
 */

const NOW = new Date('2026-11-16T09:00:00Z')
const FAKE_KEY = 'fake-key-0000-not-a-real-credential'
const KEYED_ENV = ['JOOBLE_API_KEY', 'RAPIDAPI_KEY', 'THEIRSTACK_API_KEY', 'REED_API_KEY'] as const

const configWith = (values: Partial<Record<string, string>>) => {
  const get = vi.fn((key: string) => values[key])
  return { config: { get } as unknown as ConfigService<Env, true>, get }
}

const reportingOf = (r: JobSourceRegistry, type: JobSourceType): ReportingAdapter => {
  const adapter = r.get(type)
  if (adapter?.contract !== 'REPORTING') throw new Error(`${type} is not a REPORTING adapter`)
  return adapter
}

describe('createProductionRegistry covers exactly the wired REPORTING types (AC1)', () => {
  const registry = createProductionRegistry(new DouRssProvider())
  const wired = Object.keys(REPORTING_WIRING) as JobSourceType[]

  it('DOU is unchanged: the legacy contract, the provider it was handed', () => {
    const dou = new DouRssProvider()
    const r = createProductionRegistry(dou)
    expect(r.get('DOU_RSS')?.contract).toBe('LEGACY')
    expect(r.legacyProvider('DOU_RSS')).toBe(dou)
  })

  it('registers DOU plus every REPORTING_WIRING type, and nothing else', () => {
    expect(wired.length).toBeGreaterThan(0)
    expect([...registry.types()].sort()).toEqual(['DOU_RSS', ...wired].sort())
  })

  it.each(wired)('%s: REPORTING, built with its own wiring (version + pinned hosts)', (type) => {
    const adapter = reportingOf(registry, type)
    expect(adapter.provider.type).toBe(type)
    expect(adapter.transportWired).toBe(true)
    expect(adapter.adapterVersion).toBe(REPORTING_WIRING[type]?.adapterVersion)
    expect(adapter.adapterVersion).not.toBeNull()
    expect(REPORTING_WIRING[type]?.allowedHosts).toBeDefined()
  })

  const fixedHost = wired.filter((t) => Array.isArray(REPORTING_WIRING[t]?.allowedHosts))

  it('at least one wired type has a fixed host list', () => {
    expect(fixedHost.length).toBeGreaterThan(0)
  })

  it.each(fixedHost)('%s: transport pinned to exactly its wiring hosts', (type) => {
    expect(reportingOf(registry, type).allowedHostsFor({} as never)).toEqual(
      REPORTING_WIRING[type]?.allowedHosts,
    )
  })

  it('the unwired type stays unregistered (WORKINGNOMADS_API); Reed is registered (PR #1372)', () => {
    expect(reportingOf(registry, 'REED_API').adapterVersion).toBe('reed-2')
    expect(registry.get('WORKINGNOMADS_API')).toBeUndefined()
  })

  it('Greenhouse carries collectDetail exactly when GREENHOUSE_ATS is ON_DEMAND', () => {
    const detailOf = (onDemand: readonly JobSourceType[]) =>
      typeof (
        reportingOf(
          createProductionRegistry(new DouRssProvider(), undefined, onDemand),
          'GREENHOUSE_ATS',
        ).provider as { collectDetail?: unknown }
      ).collectDetail
    expect(detailOf(['GREENHOUSE_ATS'])).toBe('function')
    expect(detailOf(['LEVER_ATS'])).toBe('undefined')
    // The default is the production catalog's ON_DEMAND set.
    const prodOnDemand = productionLedgerCatalog().onDemandTypes().includes('GREENHOUSE_ATS')
    const provider = reportingOf(registry, 'GREENHOUSE_ATS').provider as { collectDetail?: unknown }
    expect(typeof provider.collectDetail === 'function').toBe(prodOnDemand)
  })
})

describe('keyed adapters read their key from ConfigService', () => {
  it('reads each quota credential env key once at build', () => {
    const { config, get } = configWith({})
    createProductionRegistry(new DouRssProvider(), config)
    for (const key of KEYED_ENV) expect(get).toHaveBeenCalledWith(key, { infer: true })
  })

  it('no ConfigService / no key: the keyed adapter refuses before any request', async () => {
    for (const config of [undefined, configWith({}).config]) {
      const p = reportingOf(
        createProductionRegistry(new DouRssProvider(), config),
        'JOOBLE_API',
      ).provider
      const f = fakeCollectionContext({ now: NOW, responses: [] })
      const parsed = p.parseConfig({ configVersion: 1, keywords: 'developer', location: 'remote' })
      await expect(p.collectReport(parsed, meteredContext(f).ctx)).rejects.toThrow(
        SourceNotReadyError,
      )
      expect(f.sent).toEqual([])
    }
  })

  it('a configured key is the one the request carries', async () => {
    const { config } = configWith({ JOOBLE_API_KEY: FAKE_KEY })
    const p = reportingOf(
      createProductionRegistry(new DouRssProvider(), config),
      'JOOBLE_API',
    ).provider
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify({ totalCount: 0, jobs: [] }) }],
    })
    const parsed = p.parseConfig({ configVersion: 1, keywords: 'developer', location: 'remote' })
    await p.collectReport(parsed, meteredContext(f).ctx)
    expect(f.sent.length).toBeGreaterThan(0)
    expect(JSON.stringify(f.sent[0])).toContain(FAKE_KEY)
  })
})

describe('registering is not enabling: readiness stays the gate (AC2)', () => {
  const registry = createProductionRegistry(new DouRssProvider())
  const gateOf =
    (r: JobSourceRegistry, catalog: ReturnType<typeof productionLedgerCatalog>) =>
    (entryId: string, type: JobSourceType) =>
      claimGate({
        adapter: r.get(type),
        entry: catalog.entry(entryId),
        dbNow: NOW,
        meterKey: 'meter-key',
        scheduled: false,
      })

  // Picked at runtime, never hardcoded: a parallel change to the manifest must not break this.
  const catalog = productionLedgerCatalog()
  const candidate = LEDGER_CATALOG_SNAPSHOT.entries.find(
    (e) =>
      e.type in REPORTING_WIRING &&
      catalog.entry(e.id)?.entryReadiness(NOW) === 'CANDIDATE' &&
      catalog.entry(e.id)?.activationFacts(NOW).readiness === 'CANDIDATE' &&
      catalog.entry(e.id)?.activationFacts(NOW).payloadVerified === true,
  )

  it('a CANDIDATE source with a registered adapter passes the enable gate', () => {
    expect(candidate).toBeDefined()
    expect(gateOf(registry, catalog)(candidate!.id, candidate!.type)).toBeNull()
  })

  it('the same source was refused NOT_ACTIVATABLE by the DOU-only registry (the prod 409)', () => {
    const douOnly = new JobSourceRegistry([new LegacyDouAdapter(new DouRssProvider())])
    expect(gateOf(douOnly, catalog)(candidate!.id, candidate!.type)).toBe('NOT_ACTIVATABLE')
  })

  it('the same type with a standing (non-evidence) blocker is still refused', () => {
    const blocked = catalogFromSnapshot({
      ...LEDGER_CATALOG_SNAPSHOT,
      types: LEDGER_CATALOG_SNAPSHOT.types.map((t) =>
        t.type === candidate!.type ? { ...t, blockerCodes: ['OWNER_DECISION_REQUIRED'] } : t,
      ),
    })
    expect(gateOf(registry, blocked)(candidate!.id, candidate!.type)).toBe('READINESS_BLOCKED')
  })

  it('no wired entry with a standing non-evidence blocker passes the enable gate', () => {
    const evidence = new Set(['NO_CAPTURE', 'NO_API_CAPTURE'])
    const blockedEntries = LEDGER_CATALOG_SNAPSHOT.entries.filter((e) => {
      const facts = catalog.entry(e.id)?.activationFacts(NOW)
      return (
        e.type in REPORTING_WIRING &&
        facts !== undefined &&
        facts.blockerCodes.some((c) => !evidence.has(c))
      )
    })
    expect(blockedEntries.length).toBeGreaterThan(0)
    for (const e of blockedEntries) {
      expect(gateOf(registry, catalog)(e.id, e.type), `${e.id}`).not.toBeNull()
    }
  })
})
