import { describe, expect, it } from 'vitest'
import type { JobSourceTriggerMode } from '@crm/shared'
import { type ActivationFacts, activationOf } from '../registry/activation'
import type { RegisteredAdapter } from '../registry/registered-adapter'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from '../providers/manifest'
import { activationFactsByType } from '../providers/manifest.activation'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import { RECRUITEE_TOKEN_DEADLINE } from '../providers/sources/recruitee.provider'
import {
  DUE_REFUSALS,
  type DueContext,
  type DueRow,
  MAX_CONSECUTIVE_FAILURES,
  MAX_CONSECUTIVE_FAILURES_CEILING,
  MAX_EARLY_DUE_SLACK_MS,
  factsActivate,
  isDue,
  sourceAcceptsTrigger,
  typePassesFilter,
} from './due-policy'

const NOW = new Date('2026-11-01T05:00:00.000Z')
const MINUTE = 60_000
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)

const READY: ActivationFacts = { readiness: 'CANDIDATE', blockerCodes: [], payloadVerified: true }
const BLOCKED: ActivationFacts = {
  readiness: 'BLOCKED',
  blockerCodes: ['AUTH_DEADLINE_PASSED'],
  payloadVerified: true,
}

/** A row that is due on a schedule: every term satisfied. Each test breaks exactly one term. */
const dueRow = (over: Partial<DueRow> = {}): DueRow => ({
  enabled: true,
  adminState: 'ACTIVE',
  manifestId: 'remoteok.api',
  triggerMode: 'BOTH',
  nextAttemptAt: at(-MINUTE),
  cooldownUntil: null,
  consecutiveFailures: 0,
  ...over,
})
const ctx = (over: Partial<DueContext> = {}): DueContext => ({
  trigger: 'SCHEDULED',
  now: NOW,
  readiness: READY,
  // T3 (meter, ledger) and T8 (host state) own these; nothing supplies them yet, so every call here
  // says "not blocked" out loud. They are required fields: omitting one is a compile error.
  costBlocked: false,
  hostPaused: false,
  alreadyRunning: false,
  ...over,
})

describe('isDue', () => {
  it('a row meeting every term is due, on a schedule and by hand', () => {
    expect(isDue(dueRow(), ctx())).toEqual({ due: true })
    expect(isDue(dueRow(), ctx({ trigger: 'MANUAL' }))).toEqual({ due: true })
  })

  it('AC6: the failure cap is 3 and a row at it is never due, by either trigger; one below is', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3)
    expect(isDue(dueRow({ consecutiveFailures: 2 }), ctx())).toEqual({ due: true })
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      expect(isDue(dueRow({ consecutiveFailures: 3 }), ctx({ trigger }))).toEqual({
        due: false,
        reason: 'FAILURE_CAP',
      })
      expect(isDue(dueRow({ consecutiveFailures: 9 }), ctx({ trigger }))).toEqual({
        due: false,
        reason: 'FAILURE_CAP',
      })
    }
  })

  it('the cap is an input: a ceiling of 5 admits 4 failures and refuses 5', () => {
    const c = ctx({ maxConsecutiveFailures: 5 })
    expect(isDue(dueRow({ consecutiveFailures: 4 }), c)).toEqual({ due: true })
    expect(isDue(dueRow({ consecutiveFailures: 5 }), c)).toEqual({
      due: false,
      reason: 'FAILURE_CAP',
    })
  })

  it('AC6: PAUSED and RETIRED rows with enabled = true are never due, by either trigger', () => {
    for (const adminState of ['PAUSED', 'RETIRED'] as const) {
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        expect(isDue(dueRow({ adminState, enabled: true }), ctx({ trigger }))).toEqual({
          due: false,
          reason: 'NOT_ACTIVE',
        })
      }
    }
  })

  it('a disabled row is never due, by either trigger', () => {
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      expect(isDue(dueRow({ enabled: false }), ctx({ trigger }))).toEqual({
        due: false,
        reason: 'DISABLED',
      })
    }
  })

  it('AC5: a row with no manifest entry is never due, by schedule or by manual trigger', () => {
    for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
      expect(isDue(dueRow({ manifestId: null }), ctx({ trigger }))).toEqual({
        due: false,
        reason: 'NO_MANIFEST_ENTRY',
      })
    }
  })

  it('a type the manifest knows nothing of (no readiness facts) is not due', () => {
    expect(isDue(dueRow(), ctx({ readiness: undefined }))).toEqual({
      due: false,
      reason: 'READINESS_BLOCKED',
    })
  })

  it('readiness LEGACY (the DOU pipeline, outside the ledger) is not due either', () => {
    expect(isDue(dueRow(), ctx({ readiness: { ...READY, readiness: 'LEGACY' } }))).toEqual({
      due: false,
      reason: 'READINESS_BLOCKED',
    })
  })

  describe('AC1: readiness comes from the clock, never from the stored column', () => {
    const manifest = buildManifest({
      definitions: MANIFEST_DEFINITIONS,
      adapters: MANIFEST_VALIDATION_ADAPTERS,
      fixtureRoot: FIXTURE_ROOT,
    })
    // The stored column still says CANDIDATE: DueRow cannot even carry it.
    const seeded = dueRow({ manifestId: 'recruitee.ats' })

    it('a Recruitee row is due one millisecond before RECRUITEE_TOKEN_DEADLINE', () => {
      const before = new Date(RECRUITEE_TOKEN_DEADLINE.getTime() - 1)
      const facts = activationFactsByType(manifest, before).get('RECRUITEE_ATS')
      expect(facts?.readiness).toBe('CANDIDATE')
      expect(
        isDue({ ...seeded, nextAttemptAt: at(-MINUTE) }, ctx({ now: before, readiness: facts })),
      ).toEqual({ due: true })
    })

    it('exactly at and after the deadline the same row is not due, even with its cadence satisfied', () => {
      for (const now of [
        RECRUITEE_TOKEN_DEADLINE,
        new Date(RECRUITEE_TOKEN_DEADLINE.getTime() + 24 * 60 * MINUTE),
      ]) {
        const facts = activationFactsByType(manifest, now).get('RECRUITEE_ATS')
        expect(facts?.readiness).toBe('BLOCKED')
        for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
          expect(
            isDue(
              { ...seeded, nextAttemptAt: new Date(now.getTime() - MINUTE) },
              ctx({ now, trigger, readiness: facts }),
            ),
          ).toEqual({ due: false, reason: 'READINESS_BLOCKED' })
        }
      }
    })
  })

  describe('AC2: a manual run under a cooldown or a cost block is refused, with a reason', () => {
    it('cooldown', () => {
      expect(isDue(dueRow({ cooldownUntil: at(MINUTE) }), ctx({ trigger: 'MANUAL' }))).toEqual({
        due: false,
        reason: 'COOLING_DOWN',
      })
    })
    it('cost block', () => {
      expect(isDue(dueRow(), ctx({ trigger: 'MANUAL', costBlocked: true }))).toEqual({
        due: false,
        reason: 'COST_BLOCKED',
      })
    })
    it('host pause and a run already active refuse a manual run too', () => {
      expect(isDue(dueRow(), ctx({ trigger: 'MANUAL', hostPaused: true }))).toEqual({
        due: false,
        reason: 'HOST_PAUSED',
      })
      expect(isDue(dueRow(), ctx({ trigger: 'MANUAL', alreadyRunning: true }))).toEqual({
        due: false,
        reason: 'ALREADY_RUNNING',
      })
    })
    it('a cooldown that has just ended (equal to the clock) no longer refuses', () => {
      expect(isDue(dueRow({ cooldownUntil: NOW }), ctx())).toEqual({ due: true })
      expect(isDue(dueRow({ cooldownUntil: at(1) }), ctx())).toEqual({
        due: false,
        reason: 'COOLING_DOWN',
      })
    })
    it('false inputs do not refuse', () => {
      expect(
        isDue(dueRow(), ctx({ costBlocked: false, hostPaused: false, alreadyRunning: false })),
      ).toEqual({ due: true })
    })
  })

  describe('cadence term', () => {
    it('is due exactly at next_attempt_at, not a millisecond before', () => {
      expect(isDue(dueRow({ nextAttemptAt: NOW }), ctx())).toEqual({ due: true })
      expect(isDue(dueRow({ nextAttemptAt: at(1) }), ctx())).toEqual({
        due: false,
        reason: 'NOT_YET_DUE',
      })
    })
    it('a NULL next_attempt_at is not due on a schedule (the ADR SQL: NULL <= now is not true)', () => {
      expect(isDue(dueRow({ nextAttemptAt: null }), ctx())).toEqual({
        due: false,
        reason: 'NOT_YET_DUE',
      })
    })
    it('a manual trigger skips it: a future or NULL next_attempt_at is still due', () => {
      expect(isDue(dueRow({ nextAttemptAt: at(60 * MINUTE) }), ctx({ trigger: 'MANUAL' }))).toEqual(
        { due: true },
      )
      expect(isDue(dueRow({ nextAttemptAt: null }), ctx({ trigger: 'MANUAL' }))).toEqual({
        due: true,
      })
    })
  })

  describe('AC3: the legacy 10-minute early-due slack widens the cadence term only', () => {
    const slack = { cadenceSlackMs: MAX_EARLY_DUE_SLACK_MS }
    it('is ten minutes', () => {
      expect(MAX_EARLY_DUE_SLACK_MS).toBe(600_000)
    })
    it('admits a source up to ten minutes early, and not a millisecond more', () => {
      expect(isDue(dueRow({ nextAttemptAt: at(10 * MINUTE) }), ctx(slack))).toEqual({ due: true })
      expect(isDue(dueRow({ nextAttemptAt: at(10 * MINUTE + 1) }), ctx(slack))).toEqual({
        due: false,
        reason: 'NOT_YET_DUE',
      })
    })
    it('without the slack the same early source is not due', () => {
      expect(isDue(dueRow({ nextAttemptAt: at(5 * MINUTE) }), ctx())).toEqual({
        due: false,
        reason: 'NOT_YET_DUE',
      })
    })
    it('never overrides a cooldown', () => {
      expect(
        isDue(dueRow({ nextAttemptAt: at(5 * MINUTE), cooldownUntil: at(MINUTE) }), ctx(slack)),
      ).toEqual({ due: false, reason: 'COOLING_DOWN' })
    })
    it('never overrides a cost block, the failure cap, a host pause or a running run', () => {
      const early = dueRow({ nextAttemptAt: at(5 * MINUTE) })
      expect(isDue(early, ctx({ ...slack, costBlocked: true }))).toEqual({
        due: false,
        reason: 'COST_BLOCKED',
      })
      expect(isDue({ ...early, consecutiveFailures: 3 }, ctx(slack))).toEqual({
        due: false,
        reason: 'FAILURE_CAP',
      })
      expect(isDue(early, ctx({ ...slack, hostPaused: true }))).toEqual({
        due: false,
        reason: 'HOST_PAUSED',
      })
      expect(isDue(early, ctx({ ...slack, alreadyRunning: true }))).toEqual({
        due: false,
        reason: 'ALREADY_RUNNING',
      })
    })
  })

  describe('trigger policy', () => {
    const modes: JobSourceTriggerMode[] = ['SCHEDULED', 'MANUAL', 'BOTH']
    it('a SCHEDULED-only source refuses a manual trigger; a MANUAL-only source refuses a schedule', () => {
      expect(isDue(dueRow({ triggerMode: 'SCHEDULED' }), ctx({ trigger: 'MANUAL' }))).toEqual({
        due: false,
        reason: 'TRIGGER_MODE',
      })
      expect(isDue(dueRow({ triggerMode: 'MANUAL' }), ctx({ trigger: 'SCHEDULED' }))).toEqual({
        due: false,
        reason: 'TRIGGER_MODE',
      })
      expect(isDue(dueRow({ triggerMode: 'MANUAL' }), ctx({ trigger: 'MANUAL' }))).toEqual({
        due: true,
      })
    })
    it('matches sourceAcceptsTrigger for every pair', () => {
      for (const triggerMode of modes) {
        for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
          expect(isDue(dueRow({ triggerMode }), ctx({ trigger })).due).toBe(
            sourceAcceptsTrigger(triggerMode, trigger),
          )
        }
      }
    })
  })

  it('AC7: a manual trigger is due exactly when the scheduled predicate minus the cadence term is true', () => {
    const rows: DueRow[] = [
      dueRow(),
      dueRow({ nextAttemptAt: at(60 * MINUTE) }),
      dueRow({ nextAttemptAt: null }),
      dueRow({ enabled: false }),
      dueRow({ adminState: 'PAUSED' }),
      dueRow({ adminState: 'RETIRED' }),
      dueRow({ manifestId: null }),
      dueRow({ cooldownUntil: at(MINUTE) }),
      dueRow({ consecutiveFailures: 3 }),
    ]
    for (const readiness of [READY, BLOCKED]) {
      for (const costBlocked of [false, true]) {
        for (const row of rows) {
          // "scheduled minus cadence": the scheduled verdict with the cadence made satisfiable.
          const scheduledMinusCadence = isDue(
            { ...row, nextAttemptAt: at(-MINUTE) },
            ctx({ readiness, costBlocked }),
          ).due
          expect(isDue(row, ctx({ trigger: 'MANUAL', readiness, costBlocked })).due).toBe(
            scheduledMinusCadence,
          )
        }
      }
    }
  })

  describe('CR-M-1: readiness is T2 ACTIVATABLE, not merely CANDIDATE', () => {
    it('a CANDIDATE type whose payload is not verified is not due, by schedule or by hand', () => {
      const unverified: ActivationFacts = { ...READY, payloadVerified: false }
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        expect(isDue(dueRow(), ctx({ trigger, readiness: unverified }))).toEqual({
          due: false,
          reason: 'READINESS_BLOCKED',
        })
      }
    })
    it('a CANDIDATE type with an evidence blocker (NO_API_CAPTURE) is not due, by schedule or by hand', () => {
      const noCapture: ActivationFacts = {
        readiness: 'CANDIDATE',
        blockerCodes: ['NO_API_CAPTURE'],
        payloadVerified: true,
      }
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        expect(isDue(dueRow(), ctx({ trigger, readiness: noCapture }))).toEqual({
          due: false,
          reason: 'READINESS_BLOCKED',
        })
      }
    })
    it('factsActivate agrees with T2 activationOf (REPORTING) over every combination of facts', () => {
      const reporting = {
        contract: 'REPORTING',
        type: 'REMOTEOK_API',
      } as unknown as RegisteredAdapter
      for (const readiness of ['CANDIDATE', 'BLOCKED', 'LEGACY'] as const) {
        for (const blockerCodes of [
          [],
          ['NO_API_CAPTURE'],
          ['NO_CAPTURE'],
          ['AUTH_DEADLINE_PASSED'],
        ]) {
          for (const payloadVerified of [true, false]) {
            const facts: ActivationFacts = { readiness, blockerCodes, payloadVerified }
            expect(factsActivate(facts)).toBe(activationOf(reporting, facts) === 'ACTIVATABLE')
          }
        }
      }
      expect(factsActivate(undefined)).toBe(false)
    })
  })

  describe('SR-M-2: an invalid input fails closed', () => {
    const invalid = { due: false, reason: 'INVALID_INPUT' } as const
    it('a NaN cadence slack', () => {
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: Number.NaN }))).toEqual(invalid)
    })
    it('a NaN failure cap', () => {
      expect(isDue(dueRow(), ctx({ maxConsecutiveFailures: Number.NaN }))).toEqual(invalid)
    })
    it('an invalid now', () => {
      expect(isDue(dueRow(), ctx({ now: new Date(Number.NaN) }))).toEqual(invalid)
      expect(isDue(dueRow(), ctx({ now: new Date(Number.NaN), trigger: 'MANUAL' }))).toEqual(
        invalid,
      )
    })
    it('an invalid cooldown_until', () => {
      expect(isDue(dueRow({ cooldownUntil: new Date(Number.NaN) }), ctx())).toEqual(invalid)
    })
    it('an invalid next_attempt_at and a NaN or negative failure count', () => {
      expect(isDue(dueRow({ nextAttemptAt: new Date(Number.NaN) }), ctx())).toEqual(invalid)
      expect(isDue(dueRow({ consecutiveFailures: Number.NaN }), ctx())).toEqual(invalid)
      expect(isDue(dueRow({ consecutiveFailures: -1 }), ctx())).toEqual(invalid)
    })
  })

  describe('SR-M-3: the cap and the slack are bounded', () => {
    it('the ceiling is 5 and the slack maximum is ten minutes', () => {
      expect(MAX_CONSECUTIVE_FAILURES_CEILING).toBe(5)
      expect(MAX_EARLY_DUE_SLACK_MS).toBe(600_000)
    })
    it('a cap at the ceiling is accepted, one past it is refused for both triggers', () => {
      expect(isDue(dueRow(), ctx({ maxConsecutiveFailures: 5 }))).toEqual({ due: true })
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        expect(
          isDue(dueRow({ consecutiveFailures: 3 }), ctx({ trigger, maxConsecutiveFailures: 6 })),
        ).toEqual({ due: false, reason: 'INVALID_INPUT' })
        expect(
          isDue(dueRow({ consecutiveFailures: 3 }), ctx({ trigger, maxConsecutiveFailures: 99 })),
        ).toEqual({ due: false, reason: 'INVALID_INPUT' })
      }
      expect(isDue(dueRow(), ctx({ maxConsecutiveFailures: 0 }))).toEqual({
        due: false,
        reason: 'INVALID_INPUT',
      })
      expect(isDue(dueRow(), ctx({ maxConsecutiveFailures: 1 }))).toEqual({ due: true })
    })
    it('a slack at the maximum is accepted, one millisecond past it is refused, as is a negative one', () => {
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: 600_000 }))).toEqual({ due: true })
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: 600_001 }))).toEqual({
        due: false,
        reason: 'INVALID_INPUT',
      })
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: 1e12 }))).toEqual({
        due: false,
        reason: 'INVALID_INPUT',
      })
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: -1 }))).toEqual({
        due: false,
        reason: 'INVALID_INPUT',
      })
      expect(isDue(dueRow(), ctx({ cadenceSlackMs: 0 }))).toEqual({ due: true })
    })
  })

  describe('CR-M-5: a non-integer or infinite cap / slack is refused', () => {
    const invalid = { due: false, reason: 'INVALID_INPUT' } as const
    const bad = [2.5, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    it('failure cap, both triggers', () => {
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        for (const maxConsecutiveFailures of bad) {
          expect(isDue(dueRow(), ctx({ trigger, maxConsecutiveFailures }))).toEqual(invalid)
        }
      }
    })
    it('cadence slack, both triggers', () => {
      for (const trigger of ['SCHEDULED', 'MANUAL'] as const) {
        for (const cadenceSlackMs of [0.5, 1.5, ...bad]) {
          expect(isDue(dueRow(), ctx({ trigger, cadenceSlackMs }))).toEqual(invalid)
        }
      }
    })
    it('a fractional failure count in the row', () => {
      expect(isDue(dueRow({ consecutiveFailures: 1.5 }), ctx())).toEqual(invalid)
      expect(isDue(dueRow({ consecutiveFailures: Number.POSITIVE_INFINITY }), ctx())).toEqual(
        invalid,
      )
    })
  })

  describe('CR-LOW-A: the three blocking inputs are required at the type level', () => {
    it('omitting any of them does not compile (a regression to optional fails tsc)', () => {
      // @ts-expect-error costBlocked is required
      const noCost: DueContext = {
        trigger: 'SCHEDULED',
        now: NOW,
        readiness: READY,
        hostPaused: false,
        alreadyRunning: false,
      }
      // @ts-expect-error hostPaused is required
      const noHost: DueContext = {
        trigger: 'SCHEDULED',
        now: NOW,
        readiness: READY,
        costBlocked: false,
        alreadyRunning: false,
      }
      // @ts-expect-error alreadyRunning is required
      const noRun: DueContext = {
        trigger: 'SCHEDULED',
        now: NOW,
        readiness: READY,
        costBlocked: false,
        hostPaused: false,
      }
      // At runtime the omission reads as undefined, which isDue treats as not blocked: the type is the guard.
      expect([noCost, noHost, noRun]).toHaveLength(3)
    })
  })

  it('every refusal reason is reachable and listed', () => {
    const seen = new Set<string>()
    const probes: [DueRow, DueContext][] = [
      [dueRow(), ctx({ now: new Date(NaN) })],
      [dueRow({ enabled: false }), ctx()],
      [dueRow({ adminState: 'PAUSED' }), ctx()],
      [dueRow({ manifestId: null }), ctx()],
      [dueRow({ triggerMode: 'MANUAL' }), ctx()],
      [dueRow(), ctx({ readiness: BLOCKED })],
      [dueRow({ consecutiveFailures: 3 }), ctx()],
      [dueRow({ cooldownUntil: at(MINUTE) }), ctx()],
      [dueRow(), ctx({ costBlocked: true })],
      [dueRow(), ctx({ hostPaused: true })],
      [dueRow(), ctx({ alreadyRunning: true })],
      [dueRow({ nextAttemptAt: at(MINUTE) }), ctx()],
    ]
    for (const [row, c] of probes) {
      const v = isDue(row, c)
      if (!v.due) seen.add(v.reason)
    }
    expect([...seen]).toEqual([...DUE_REFUSALS])
  })
})

describe('sourceAcceptsTrigger (moved from the service, unchanged)', () => {
  it('BOTH accepts either trigger; SCHEDULED and MANUAL accept only themselves', () => {
    expect(sourceAcceptsTrigger('BOTH', 'SCHEDULED')).toBe(true)
    expect(sourceAcceptsTrigger('BOTH', 'MANUAL')).toBe(true)
    expect(sourceAcceptsTrigger('SCHEDULED', 'SCHEDULED')).toBe(true)
    expect(sourceAcceptsTrigger('SCHEDULED', 'MANUAL')).toBe(false)
    expect(sourceAcceptsTrigger('MANUAL', 'MANUAL')).toBe(true)
    expect(sourceAcceptsTrigger('MANUAL', 'SCHEDULED')).toBe(false)
  })
})

describe('typePassesFilter', () => {
  it('no filter passes every type', () => {
    expect(typePassesFilter('DOU_RSS')).toBe(true)
    expect(typePassesFilter('DOU_RSS', {})).toBe(true)
  })
  it('onlyTypes passes only members; an empty list passes nothing', () => {
    expect(typePassesFilter('DOU_RSS', { onlyTypes: ['DOU_RSS', 'REMOTEOK_API'] })).toBe(true)
    expect(typePassesFilter('JSEARCH_API', { onlyTypes: ['DOU_RSS', 'REMOTEOK_API'] })).toBe(false)
    expect(typePassesFilter('DOU_RSS', { onlyTypes: [] })).toBe(false)
  })
  it('excludeTypes passes everything but members; an empty list excludes nothing', () => {
    expect(typePassesFilter('DOU_RSS', { excludeTypes: ['DOU_RSS'] })).toBe(false)
    expect(typePassesFilter('REMOTEOK_API', { excludeTypes: ['DOU_RSS'] })).toBe(true)
    expect(typePassesFilter('DOU_RSS', { excludeTypes: [] })).toBe(true)
  })
  it('a type must pass both lists', () => {
    const both = { onlyTypes: ['DOU_RSS', 'REMOTEOK_API'], excludeTypes: ['DOU_RSS'] } as const
    expect(typePassesFilter('DOU_RSS', both)).toBe(false)
    expect(typePassesFilter('REMOTEOK_API', both)).toBe(true)
    expect(typePassesFilter('JSEARCH_API', both)).toBe(false)
  })
})
