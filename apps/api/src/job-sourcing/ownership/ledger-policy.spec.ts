import type { JobSourceType } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { COLLECTION_ERROR_CODES } from '../providers/reporting-provider'
import type { ActivationFacts } from '../registry/activation'
import { LegacyDouAdapter, ReportingAdapter } from '../registry/registered-adapter'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'
import type { JobSourceProvider } from '../job-source.provider'
import { nextSlot } from '../scheduling/next-slot'
import type { LedgerCatalogEntry } from './ledger-catalog'
import {
  CLAIM_REFUSALS,
  DEFAULT_LEDGER_OPTIONS,
  type GateInput,
  backoffMs,
  claimGate,
  endingEffect,
  nextAttemptAt,
  refusalWrite,
  SLOWDOWN_LEVEL_BEFORE_U2,
  resolveLedgerOptions,
  validateEnding,
} from './ledger-policy'

/**
 * The pure half of the run ledger (r5 Task 2.5 T3): the claim gates, the failure-accounting table
 * and the refusal write-back, as decisions. The SQL that applies them is proven against real
 * Postgres in `job-run-ledger.integration.spec.ts`; these cases are what the mutation gate sees.
 * Every expected value is written out here from the ADR's tables, not derived from the code.
 */

const NOW = new Date('2026-10-25T12:00:00.000Z')
const READY: ActivationFacts = { readiness: 'CANDIDATE', blockerCodes: [], payloadVerified: true }

function entry(over: Partial<LedgerCatalogEntry> = {}): LedgerCatalogEntry {
  return {
    type: 'REMOTIVE_API',
    quotaDeclared: false,
    fetchProfile: { intervalMinutes: 1440, offIntervalMinutes: null, window: null },
    floorHours: 0,
    activationFacts: () => READY,
    entryReadiness: () => 'CANDIDATE',
    ...over,
  }
}

const provider = (type: JobSourceType) => ({ type }) as unknown as ReportingJobSourceProvider
const wired = (type: JobSourceType = 'REMOTIVE_API') =>
  new ReportingAdapter(provider(type), {
    adapterVersion: 'remotive-1',
    allowedHosts: ['remotive.com'],
  })

const gate = (over: Partial<GateInput> = {}) =>
  claimGate({
    adapter: wired(),
    entry: entry(),
    dbNow: NOW,
    meterKey: null,
    scheduled: false,
    ...over,
  })

describe('U1b: a null fetch profile is never claimed by schedule (owner, Q8)', () => {
  const unscheduled = entry({ fetchProfile: null })

  it('a scheduled claim of a null-profile source is refused NOT_SCHEDULED', () => {
    expect(gate({ entry: unscheduled, scheduled: true })).toBe('NOT_SCHEDULED')
  })

  it('a manual claim of the same source is not refused for its profile', () => {
    expect(gate({ entry: unscheduled, scheduled: false })).toBeNull()
  })

  it('CR-M-1: a caller that omits `scheduled` (a type error) is refused, never let through', () => {
    // `scheduled` is required by the type; a JS caller or a cast that drops it fails closed.
    const omitted = {
      adapter: wired(),
      entry: unscheduled,
      dbNow: NOW,
      meterKey: null,
    } as unknown as GateInput
    expect(claimGate(omitted)).toBe('NOT_SCHEDULED')
  })

  it('a scheduled claim of a source with a profile passes', () => {
    expect(gate({ scheduled: true })).toBeNull()
  })

  it('the readiness refusal still comes first for a blocked null-profile entry', () => {
    const blocked = entry({ fetchProfile: null, entryReadiness: () => 'BLOCKED' })
    expect(gate({ entry: blocked, scheduled: true })).toBe('READINESS_BLOCKED')
  })

  it('CR-M-2: NOT_SCHEDULED is recorded once and leaves no next attempt (no recheck churn)', () => {
    expect(CLAIM_REFUSALS).toContain('NOT_SCHEDULED')
    expect(refusalWrite('NOT_SCHEDULED', null)).toEqual({ kind: 'NEVER' })
    expect(refusalWrite('NOT_SCHEDULED', new Date(NOW))).toEqual({ kind: 'NEVER' })
  })
})

describe('U1b: nextAttemptAt — the cadence a finish writes, from the profile', () => {
  // Tuesday 2027-03-09 10:20 Berlin (UTC+1) = 09:20 UTC.
  const TUE_1020_BERLIN = new Date('2027-03-09T09:20:00.000Z')
  const berlin = {
    intervalMinutes: 60,
    offIntervalMinutes: 180,
    window: {
      timeZone: 'Europe/Berlin',
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as ('MON' | 'TUE' | 'WED' | 'THU' | 'FRI')[],
      from: '08:00',
      to: '19:00',
    },
  }
  // The key's stagger on a 60-minute grid, hand-checked: fnv1a32('t.berlin') % 60.
  const key = 't.berlin'

  it('is nextSlot with the database clock, the floor in minutes, level 0 and the manifest id', () => {
    const at = nextAttemptAt(TUE_1020_BERLIN, key, entry({ fetchProfile: berlin }))
    expect(at).toEqual(
      nextSlot(TUE_1020_BERLIN, berlin, { floorMinutes: 0, slowdownLevel: 0, staggerKey: key }),
    )
    // Inside the window: within the next hour, never later.
    expect(at!.getTime() - TUE_1020_BERLIN.getTime()).toBeGreaterThan(0)
    expect(at!.getTime() - TUE_1020_BERLIN.getTime()).toBeLessThanOrEqual(60 * 60_000)
  })

  it('the provider floor (hours) pushes the slot at least that far out', () => {
    const at = nextAttemptAt(TUE_1020_BERLIN, key, entry({ fetchProfile: berlin, floorHours: 6 }))
    expect(at!.getTime() - TUE_1020_BERLIN.getTime()).toBeGreaterThan(6 * 3_600_000)
    expect(at!.getTime() - TUE_1020_BERLIN.getTime()).toBeLessThanOrEqual(7 * 3_600_000)
  })

  it('a fixed slot is returned as listed (Remotive 09:00 Kyiv, UTC+2 in March)', () => {
    const remotive = {
      intervalMinutes: 1440,
      offIntervalMinutes: null,
      window: null,
      fixedSlots: { timeZone: 'Europe/Kyiv', times: ['09:00'] },
    }
    expect(
      nextAttemptAt(TUE_1020_BERLIN, key, entry({ fetchProfile: remotive, floorHours: 6 })),
    ).toEqual(new Date('2027-03-10T07:00:00.000Z'))
  })

  it('a null profile leaves no next attempt', () => {
    expect(nextAttemptAt(TUE_1020_BERLIN, key, entry({ fetchProfile: null }))).toBeNull()
  })

  it('an entry the catalog does not hold falls back to the daily cadence of before', () => {
    expect(nextAttemptAt(TUE_1020_BERLIN, key, undefined)).toEqual(
      new Date('2027-03-10T09:20:00.000Z'),
    )
  })

  it('the slow-down level is 0 until U2 adds the column', () => {
    expect(SLOWDOWN_LEVEL_BEFORE_U2).toBe(0)
  })
})

describe('COLLECTION_ERROR_CODES gains the three ledger codes (T3 AC 9)', () => {
  it.each(['RUN_FENCED', 'LEASE_EXPIRED', 'NOT_MARKED_SENT'])('%s is a member', (code) => {
    expect(COLLECTION_ERROR_CODES as readonly string[]).toContain(code)
  })
})

describe('claimGate — step 2 of the claim, on the locked row (SR-H-5)', () => {
  it('a wired, activatable, ready, unmetered source passes', () => {
    expect(gate()).toBeNull()
  })

  it('refuses a LEGACY adapter (DOU) as NOT_ACTIVATABLE, before the manifest is consulted (AC 18)', () => {
    const dou = new LegacyDouAdapter({ type: 'DOU_RSS' } as unknown as JobSourceProvider)
    expect(gate({ adapter: dou, entry: undefined })).toBe('NOT_ACTIVATABLE')
  })

  it('refuses an unregistered type as NOT_ACTIVATABLE', () => {
    expect(gate({ adapter: undefined })).toBe('NOT_ACTIVATABLE')
  })

  it('refuses an unresolvable manifest id as MANIFEST_ENTRY_MISSING', () => {
    expect(gate({ entry: undefined })).toBe('MANIFEST_ENTRY_MISSING')
  })

  it('refuses a manifest entry of another type as MANIFEST_ENTRY_MISSING', () => {
    expect(gate({ entry: entry({ type: 'ARBEITNOW_API' }) })).toBe('MANIFEST_ENTRY_MISSING')
  })

  it('refuses a type with no captured evidence (NOT_VERIFIED) as NOT_ACTIVATABLE', () => {
    const facts: ActivationFacts = { ...READY, blockerCodes: ['NO_CAPTURE'] }
    expect(gate({ entry: entry({ activationFacts: () => facts }) })).toBe('NOT_ACTIVATABLE')
  })

  it('refuses an unverified payload as NOT_ACTIVATABLE', () => {
    const facts: ActivationFacts = { ...READY, payloadVerified: false }
    expect(gate({ entry: entry({ activationFacts: () => facts }) })).toBe('NOT_ACTIVATABLE')
  })

  it('refuses a type-level blocker (a passed deadline) as READINESS_BLOCKED', () => {
    const facts: ActivationFacts = {
      readiness: 'BLOCKED',
      blockerCodes: ['AUTH_DEADLINE_PASSED'],
      payloadVerified: true,
    }
    expect(gate({ entry: entry({ activationFacts: () => facts }) })).toBe('READINESS_BLOCKED')
  })

  it('refuses an entry whose own readiness is blocked as READINESS_BLOCKED', () => {
    expect(gate({ entry: entry({ entryReadiness: () => 'BLOCKED' }) })).toBe('READINESS_BLOCKED')
  })

  it('evaluates both readiness functions at the database clock it is given (SR-L-21)', () => {
    const seen: number[] = []
    const e = entry({
      activationFacts: (at) => {
        seen.push(at.getTime())
        return READY
      },
      entryReadiness: (at) => {
        seen.push(at.getTime())
        return 'CANDIDATE'
      },
    })
    gate({ entry: e })
    expect(seen).toEqual([NOW.getTime(), NOW.getTime()])
  })

  it('refuses an adapter with no allowedHosts as TRANSPORT_NOT_WIRED', () => {
    const bare = new ReportingAdapter(provider('REMOTIVE_API'), { adapterVersion: 'remotive-1' })
    expect(gate({ adapter: bare })).toBe('TRANSPORT_NOT_WIRED')
  })

  it('refuses an adapter with no adapter version as TRANSPORT_NOT_WIRED', () => {
    const bare = new ReportingAdapter(provider('REMOTIVE_API'), { allowedHosts: ['remotive.com'] })
    expect(gate({ adapter: bare })).toBe('TRANSPORT_NOT_WIRED')
  })

  it('refuses a metered type with no meter as METER_MISSING, and passes it with one', () => {
    const metered = entry({ quotaDeclared: true })
    expect(gate({ entry: metered, meterKey: null })).toBe('METER_MISSING')
    expect(gate({ entry: metered, meterKey: 'jsearch:main' })).toBeNull()
  })

  it('every refusal it returns is a member of the closed list', () => {
    for (const r of ['NOT_ACTIVATABLE', 'MANIFEST_ENTRY_MISSING', 'READINESS_BLOCKED']) {
      expect(CLAIM_REFUSALS as readonly string[]).toContain(r)
    }
    expect([...CLAIM_REFUSALS]).toEqual([
      'MANIFEST_ENTRY_MISSING',
      'NOT_ACTIVATABLE',
      'READINESS_BLOCKED',
      'TRANSPORT_NOT_WIRED',
      'METER_MISSING',
      'HOST_KEY_MISSING',
      'HOST_PAUSED',
      'HOST_BUSY',
      'HOST_RATE_GAP',
      'HOST_DAILY_CAP',
      'NOT_SCHEDULED',
    ])
  })
})

describe('refusalWrite — what a scheduled refusal commits', () => {
  const opens = new Date('2026-10-26T00:00:00.000Z')

  it('HOST_BUSY sets nothing', () => {
    expect(refusalWrite('HOST_BUSY', opens)).toEqual({ kind: 'NONE' })
  })

  it.each(['HOST_PAUSED', 'HOST_RATE_GAP', 'HOST_DAILY_CAP'] as const)(
    '%s moves next_attempt_at to when the slot opens',
    (reason) => {
      expect(refusalWrite(reason, opens)).toEqual({ kind: 'UNTIL', at: opens })
    },
  )

  it('a host refusal with no opening instant falls back to the recheck', () => {
    expect(refusalWrite('HOST_PAUSED', null)).toEqual({ kind: 'RECHECK' })
  })

  it.each([
    'MANIFEST_ENTRY_MISSING',
    'NOT_ACTIVATABLE',
    'READINESS_BLOCKED',
    'TRANSPORT_NOT_WIRED',
    'METER_MISSING',
    'HOST_KEY_MISSING',
  ] as const)('persistent %s is pushed out by the recheck interval', (reason) => {
    expect(refusalWrite(reason, opens)).toEqual({ kind: 'RECHECK' })
  })
})

describe('validateEnding — the closed table of how a run may end', () => {
  it.each([
    ['SUCCEEDED', null],
    ['PARTIAL', 'PAGE_CAP'],
    ['PARTIAL', 'COST_STOP'],
    ['PARTIAL', 'DEADLINE'],
    ['CANCELLED', 'CANCELLED'],
    ['FAILED', 'ACCESS_POLICY'],
    ['FAILED', 'CURSOR_CYCLE'],
    ['FAILED', 'RUN_FENCED'],
  ] as const)('accepts %s / %s', (outcome, code) => {
    expect(() => validateEnding(outcome, code)).not.toThrow()
  })

  it('names the refused combination', () => {
    expect(() => validateEnding('PARTIAL', 'ACCESS_POLICY')).toThrow(
      'a run cannot end PARTIAL / ACCESS_POLICY',
    )
  })

  it.each([
    ['STARTED', null],
    ['STARTED', 'UPSTREAM'],
    ['STARTED', 'CANCELLED'],
    ['SUCCEEDED', 'PAGE_CAP'],
    ['PARTIAL', null],
    ['PARTIAL', 'ACCESS_POLICY'],
    ['CANCELLED', null],
    ['CANCELLED', 'DEADLINE'],
    ['FAILED', null],
    ['FAILED', 'NOT_A_CODE'],
    ['FAILED', 'LEASE_EXPIRED'],
  ] as const)('refuses %s / %s', (outcome, code) => {
    expect(() => validateEnding(outcome as never, code as never)).toThrow(RangeError)
  })
})

describe('endingEffect — failure accounting by how the run ended (SR-H-4, SR-M-14, SR-M-22)', () => {
  it('SUCCEEDED resets', () => {
    expect(endingEffect('SUCCEEDED', null, false)).toBe('SUCCESS')
  })

  it.each(['PAGE_CAP', 'DEADLINE'] as const)('PARTIAL/%s with pages persisted is neutral', (c) => {
    expect(endingEffect('PARTIAL', c, true)).toBe('NEUTRAL')
  })

  it.each(['PAGE_CAP', 'DEADLINE'] as const)(
    'PARTIAL/%s with ZERO pages persisted is a failure (SR-M-22)',
    (c) => {
      expect(endingEffect('PARTIAL', c, false)).toBe('FAILURE')
    },
  )

  it('PARTIAL/COST_STOP waits for the meter reset, pages or not', () => {
    expect(endingEffect('PARTIAL', 'COST_STOP', false)).toBe('COST_STOP')
    expect(endingEffect('PARTIAL', 'COST_STOP', true)).toBe('COST_STOP')
  })

  it('CANCELLED is neutral', () => {
    expect(endingEffect('CANCELLED', 'CANCELLED', false)).toBe('NEUTRAL')
  })

  it('only a PARTIAL ending can be a cost stop: a FAILED run carrying COST_STOP still counts', () => {
    expect(endingEffect('FAILED', 'COST_STOP', true)).toBe('FAILURE')
  })

  it.each(['ACCESS_POLICY', 'PARSE_DRIFT', 'CURSOR_CYCLE', 'LEASE_EXPIRED'] as const)(
    'FAILED/%s is a failure whatever was persisted (SR-L-18 for LEASE_EXPIRED)',
    (c) => {
      expect(endingEffect('FAILED', c, true)).toBe('FAILURE')
    },
  )
})

describe('backoffMs — doubling from the base, capped', () => {
  const base = 3_600_000
  const max = 4 * base

  it('the first failure waits the base, then doubles', () => {
    expect(backoffMs(1, base, max)).toBe(3_600_000)
    expect(backoffMs(2, base, max)).toBe(7_200_000)
    expect(backoffMs(3, base, max)).toBe(14_400_000)
  })

  it('never exceeds the cap', () => {
    expect(backoffMs(4, base, max)).toBe(14_400_000)
    expect(backoffMs(60, base, max)).toBe(14_400_000)
  })

  it('refuses a non-positive count, naming it', () => {
    expect(() => backoffMs(0, base, max)).toThrow('backoff: invalid failure count 0')
  })
})

describe('resolveLedgerOptions — config values with ceilings', () => {
  it('defaults hold the ADR relations: H-free, L below RUN_MAX_AGE, cap 3', () => {
    const o = resolveLedgerOptions()
    expect(o).toEqual(DEFAULT_LEDGER_OPTIONS)
    expect(o.maxConsecutiveFailures).toBe(3)
    expect(o.leaseMs).toBe(300_000)
    expect(o.runMaxAgeMs).toBe(7_200_000)
    expect(o.refusalRecheckMs).toBe(21_600_000)
    expect(o.maxClaimScan).toBe(50)
    expect(o.claimLockTimeoutMs).toBe(2_000)
    expect(o.backoffBaseMs).toBe(3_600_000)
    expect(o.backoffMaxMs).toBe(86_400_000)
  })

  it('accepts an override inside its ceiling', () => {
    expect(resolveLedgerOptions({ leaseMs: 1000, maxClaimScan: 500 })).toMatchObject({
      leaseMs: 1000,
      maxClaimScan: 500,
    })
  })

  it.each([
    ['leaseMs', 0],
    ['leaseMs', 3_600_001],
    ['runMaxAgeMs', 86_400_001],
    ['refusalRecheckMs', 0],
    ['refusalRecheckMs', 604_800_001],
    ['maxClaimScan', 0],
    ['maxClaimScan', 501],
    ['maxClaimScan', 1.5],
    ['claimLockTimeoutMs', 0],
    ['claimLockTimeoutMs', 30_001],
    ['backoffBaseMs', 0],
    ['backoffMaxMs', 604_800_001],
    ['maxConsecutiveFailures', 6],
    ['maxConsecutiveFailures', 0],
  ] as const)('refuses %s = %s', (key, value) => {
    expect(() => resolveLedgerOptions({ [key]: value })).toThrow(RangeError)
  })

  it('refuses a lease longer than the run max age, and accepts one equal to it', () => {
    expect(() => resolveLedgerOptions({ leaseMs: 600_000, runMaxAgeMs: 300_000 })).toThrow(
      'the lease must not outlive RUN_MAX_AGE',
    )
    expect(resolveLedgerOptions({ leaseMs: 600_000, runMaxAgeMs: 600_000 }).leaseMs).toBe(600_000)
  })

  it('refuses a backoff base above its cap, and accepts one equal to it', () => {
    expect(() =>
      resolveLedgerOptions({ backoffBaseMs: 7_200_000, backoffMaxMs: 3_600_000 }),
    ).toThrow('the backoff base exceeds its cap')
    expect(
      resolveLedgerOptions({ backoffBaseMs: 3_600_000, backoffMaxMs: 3_600_000 }).backoffBaseMs,
    ).toBe(3_600_000)
  })

  it('the lower bound is 1 inclusive, and the refusal names the option and its range', () => {
    expect(resolveLedgerOptions({ maxClaimScan: 1 }).maxClaimScan).toBe(1)
    expect(() => resolveLedgerOptions({ maxClaimScan: 0 })).toThrow(
      'ledger option maxClaimScan = 0 is outside 1..500',
    )
  })
})
