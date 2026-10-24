import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Test } from '@nestjs/testing'
import type { JobSourceType } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { DouRssProvider } from '../dou.provider'
import type { JobSourceProvider } from '../job-source.provider'
import { buildManifest } from '../providers/manifest'
import { activationFactsByType } from '../providers/manifest.activation'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'
import { remoteokProvider } from '../providers/sources/remoteok.provider'
import { smartrecruitersProvider } from '../providers/sources/smartrecruiters.provider'
import { type ActivationFacts, activationOf } from './activation'
import { DuplicateJobSourceTypeError, JobSourceRegistry } from './job-source-registry'
import { createProductionRegistry } from './production-registry'
import { LegacyDouAdapter, ReportingAdapter } from './registered-adapter'

const legacy = (type: JobSourceType): LegacyDouAdapter =>
  new LegacyDouAdapter({ type, collect: () => Promise.resolve([]) } satisfies JobSourceProvider)
const reporting = (type: JobSourceType): ReportingAdapter =>
  new ReportingAdapter({ type } as unknown as ReportingJobSourceProvider)

const NOW = new Date('2026-10-24T00:00:00.000Z')
const VERIFIED: ActivationFacts = {
  readiness: 'CANDIDATE',
  blockerCodes: [],
  payloadVerified: true,
}

describe('JobSourceRegistry construction (AC1)', () => {
  it('rejects a second adapter for the same type, naming the type', () => {
    expect(() => new JobSourceRegistry([legacy('DOU_RSS'), legacy('DOU_RSS')])).toThrow(
      DuplicateJobSourceTypeError,
    )
    expect(() => new JobSourceRegistry([legacy('DOU_RSS'), legacy('DOU_RSS')])).toThrow(/DOU_RSS/)
  })

  it('the error carries its name and the offending type', () => {
    const err = (() => {
      try {
        new JobSourceRegistry([legacy('DOU_RSS'), legacy('DOU_RSS')])
      } catch (e) {
        return e as DuplicateJobSourceTypeError
      }
      return undefined
    })()
    expect(err?.name).toBe('DuplicateJobSourceTypeError')
    expect(err?.sourceType).toBe('DOU_RSS')
  })

  it('each adapter reports the type of the provider it wraps', () => {
    expect(legacy('DOU_RSS').type).toBe('DOU_RSS')
    expect(reporting('REMOTEOK_API').type).toBe('REMOTEOK_API')
  })

  it('rejects a duplicate across the two contracts', () => {
    expect(
      () => new JobSourceRegistry([legacy('REMOTEOK_API'), reporting('REMOTEOK_API')]),
    ).toThrow(DuplicateJobSourceTypeError)
  })

  it('accepts distinct types and lists them in registration order', () => {
    const r = new JobSourceRegistry([legacy('DOU_RSS'), reporting('REMOTEOK_API')])
    expect(r.types()).toEqual(['DOU_RSS', 'REMOTEOK_API'])
  })

  it('an empty registry is valid and holds nothing', () => {
    expect(new JobSourceRegistry([]).types()).toEqual([])
  })

  it('fails the module at init: Nest rejects compile() when the registry factory throws', async () => {
    const compile = Test.createTestingModule({
      providers: [
        {
          provide: JobSourceRegistry,
          useFactory: () => new JobSourceRegistry([legacy('DOU_RSS'), legacy('DOU_RSS')]),
        },
      ],
    }).compile()
    await expect(compile).rejects.toBeInstanceOf(DuplicateJobSourceTypeError)
  })
})

describe('lookup', () => {
  const dou = legacy('DOU_RSS')
  const rep = reporting('REMOTEOK_API')
  const r = new JobSourceRegistry([dou, rep])

  it('get returns the registered adapter or undefined', () => {
    expect(r.get('DOU_RSS')).toBe(dou)
    expect(r.get('REMOTEOK_API')).toBe(rep)
    expect(r.get('JOOBLE_API')).toBeUndefined()
  })

  it('legacyProvider yields only a legacy adapter provider', () => {
    expect(r.legacyProvider('DOU_RSS')).toBe(dou.provider)
    expect(r.legacyProvider('REMOTEOK_API')).toBeUndefined()
    expect(r.legacyProvider('JOOBLE_API')).toBeUndefined()
  })
})

describe('activationOf', () => {
  const rep = reporting('REMOTEOK_API')

  it('UNREGISTERED when no adapter is registered, whatever the facts say', () => {
    expect(activationOf(undefined, VERIFIED)).toBe('UNREGISTERED')
  })

  it('a legacy adapter is ACTIVATABLE without facts, and facts cannot demote it', () => {
    expect(activationOf(legacy('DOU_RSS'), undefined)).toBe('ACTIVATABLE')
    expect(
      activationOf(legacy('DOU_RSS'), {
        readiness: 'BLOCKED',
        blockerCodes: ['PERMISSION_PROHIBITED'],
        payloadVerified: false,
      }),
    ).toBe('ACTIVATABLE')
  })

  it('a reporting adapter without facts is NOT_VERIFIED: absence of evidence is not approval', () => {
    expect(activationOf(rep, undefined)).toBe('NOT_VERIFIED')
  })

  it('a reporting adapter with no blocker and a captured payload is ACTIVATABLE', () => {
    expect(activationOf(rep, VERIFIED)).toBe('ACTIVATABLE')
  })

  it.each(['NO_CAPTURE', 'NO_API_CAPTURE'] as const)(
    'permitted but %s only: NOT_VERIFIED, not BLOCKED',
    (code) => {
      expect(
        activationOf(rep, { readiness: 'BLOCKED', blockerCodes: [code], payloadVerified: false }),
      ).toBe('NOT_VERIFIED')
    },
  )

  it('a missing-capture blocker keeps NOT_VERIFIED even when the payload flag says verified', () => {
    expect(
      activationOf(rep, {
        readiness: 'CANDIDATE',
        blockerCodes: ['NO_CAPTURE'],
        payloadVerified: true,
      }),
    ).toBe('NOT_VERIFIED')
  })

  it('payload not verified with no blocker listed is still NOT_VERIFIED', () => {
    expect(activationOf(rep, { ...VERIFIED, payloadVerified: false })).toBe('NOT_VERIFIED')
  })

  it.each([
    'NO_ADAPTER',
    'PERMISSION_PROHIBITED',
    'PERMISSION_UNCLEAR',
    'KEY_REQUIRED',
    'STATUS_CONSTANT_BLOCKED',
    'AUTH_DEADLINE_PASSED',
    'POLICY_EXPIRED',
  ] as const)('a %s blocker is BLOCKED, even beside a missing capture', (code) => {
    expect(
      activationOf(rep, {
        readiness: 'BLOCKED',
        blockerCodes: ['NO_API_CAPTURE', code],
        payloadVerified: false,
      }),
    ).toBe('BLOCKED')
  })

  it('a reporting adapter whose manifest readiness is LEGACY is refused', () => {
    expect(activationOf(rep, { ...VERIFIED, readiness: 'LEGACY' })).toBe('BLOCKED')
  })

  it('BLOCKED readiness with no blocker code and a verified payload is refused', () => {
    expect(activationOf(rep, { ...VERIFIED, readiness: 'BLOCKED' })).toBe('BLOCKED')
  })
})

describe('activation query against the real manifest (AC3)', () => {
  const manifest = buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
  const facts = () => activationFactsByType(manifest, NOW)
  // Built per test, never at collection: a registry that throws here must fail a TEST, not the file.
  const makeRegistry = () =>
    new JobSourceRegistry([
      new LegacyDouAdapter(new DouRssProvider()),
      new ReportingAdapter(smartrecruitersProvider),
      new ReportingAdapter(remoteokProvider),
    ])

  it('SmartRecruiters: permitted by owner decision, no captured payload -> NOT_VERIFIED', () => {
    const f = facts().get('SMARTRECRUITERS_ATS')!
    // The permission blocker IS lifted by the decision; only the missing capture remains.
    expect(f.blockerCodes).toEqual(['NO_API_CAPTURE'])
    expect(f.payloadVerified).toBe(false)
    expect(makeRegistry().activation('SMARTRECRUITERS_ATS', f)).toBe('NOT_VERIFIED')
  })

  it('is never returned by the activation query, enabled or not', () => {
    const query = makeRegistry().activatable(facts())
    expect(query).not.toContain('SMARTRECRUITERS_ATS')
    expect(query).toContain('DOU_RSS')
  })

  it('a type that is not registered is UNREGISTERED and not returned', () => {
    expect(makeRegistry().activation('JOOBLE_API', facts().get('JOOBLE_API'))).toBe('UNREGISTERED')
    expect(makeRegistry().activatable(facts())).not.toContain('JOOBLE_API')
  })

  it('every status of a registered type agrees with activationOf over the same facts', () => {
    const registry = makeRegistry()
    for (const t of registry.types()) {
      expect(registry.activation(t, facts().get(t))).toBe(
        activationOf(registry.get(t), facts().get(t)),
      )
    }
  })

  it('evaluates readiness at the clock, not from a stored column', () => {
    // Recruitee is a candidate until its token deadline, then KEY_REQUIRED (Task 3.7 review).
    const rec = new JobSourceRegistry([reporting('RECRUITEE_ATS')])
    const before = activationFactsByType(manifest, new Date('2027-02-09T00:00:00.000Z'))
    const after = activationFactsByType(manifest, new Date('2027-02-10T00:00:00.000Z'))
    expect(before.get('RECRUITEE_ATS')!.readiness).not.toBe('LEGACY')
    expect(rec.activation('RECRUITEE_ATS', after.get('RECRUITEE_ATS'))).toBe('BLOCKED')
    expect(rec.activation('RECRUITEE_ATS', before.get('RECRUITEE_ATS'))).not.toBe('BLOCKED')
  })
})

describe('the production registry (AC2, AC5)', () => {
  it('holds DOU on the legacy contract and nothing else', () => {
    const dou = new DouRssProvider()
    const r = createProductionRegistry(dou)
    expect(r.types()).toEqual(['DOU_RSS'])
    expect(r.legacyProvider('DOU_RSS')).toBe(dou)
    expect(r.activatable(new Map())).toEqual(['DOU_RSS'])
  })

  it('the service keeps no provider map of its own', () => {
    const service = readFileSync(join(__dirname, '..', 'job-sourcing.service.ts'), 'utf8')
    expect(service).not.toMatch(/new Map<JobSourceType/)
    expect(service).not.toMatch(/\bproviders\b/)
  })

  it('the module registers the registry through the production factory', () => {
    const module = readFileSync(join(__dirname, '..', 'job-sourcing.module.ts'), 'utf8')
    expect(module).toMatch(/provide: JobSourceRegistry/)
    expect(module).toMatch(/useFactory: createProductionRegistry/)
  })
})
