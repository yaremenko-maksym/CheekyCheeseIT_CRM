import { describe, expect, it } from 'vitest'
import {
  API_ERROR_FALLBACK_EN,
  jobSourceListSchema,
  jobSourceSchema,
  jobSourceSwitchResultSchema,
  setJobSourceEnabledSchema,
} from './index'

/**
 * r5 Task 6.5 — the ADMIN source switch contract: the strict PATCH body, its answer, and the
 * ADDITIVE operational fields on `jobSourceSchema` (an old client's DTO must keep parsing).
 */

/** Exactly what `GET /job-sourcing/sources` answered before Task 6.5 (and `SourceBudgetPanel` reads). */
const OLD_DTO = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'DOU_RSS',
  enabled: true,
  triggerMode: 'SCHEDULED',
  lastCollectedAt: null,
  disabledReason: null,
  budget: {
    state: 'UNLIMITED',
    limit: null,
    window: null,
    used: 0,
    remaining: null,
    resetsAt: null,
  },
}

const EXTENDED = {
  ...OLD_DTO,
  readiness: 'BLOCKED',
  readinessReason: 'credential not verified',
  adminState: 'PAUSED',
  lastAttemptAt: '2026-11-01T08:00:00.000Z',
  lastSuccessAt: '2026-10-31T08:00:00.000Z',
  lastNonemptyAt: '2026-10-30T08:00:00.000Z',
  nextAttemptAt: '2026-11-02T08:00:00.000Z',
  cooldownUntil: '2026-11-01T12:00:00.000Z',
  consecutiveFailures: 2,
  lastErrorCode: 'ACCESS_POLICY',
  hostPausedUntil: '2026-11-03T00:00:00.000Z',
  hostPauseReason: 'HTTP_403',
  costUnit: 'REQUEST',
  resumeCheckpoint: true,
  healthState: 'FAILING',
}

describe('setJobSourceEnabledSchema — the PATCH body', () => {
  it.each([true, false])('accepts { enabled: %s }', (enabled) => {
    expect(setJobSourceEnabledSchema.parse({ enabled })).toEqual({ enabled })
  })

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['a string boolean', { enabled: 'true' }],
    ['a null', { enabled: null }],
    ['a number', { enabled: 1 }],
    ['an extra config key', { enabled: true, config: { url: 'https://evil.test' } }],
    ['an extra readiness key', { enabled: true, readiness: 'VERIFIED' }],
    ['an extra quota key', { enabled: true, budgetUsed: 0 }],
  ])('refuses %s', (_label, body) => {
    expect(setJobSourceEnabledSchema.safeParse(body).success).toBe(false)
  })
})

describe('jobSourceSwitchResultSchema', () => {
  const OK = {
    id: '11111111-1111-4111-8111-111111111111',
    enabled: false,
    changed: true,
    cancelledRuns: 1,
  }

  it('parses an answer', () => {
    expect(jobSourceSwitchResultSchema.parse(OK)).toEqual(OK)
  })

  it.each([
    ['a negative run count', { ...OK, cancelledRuns: -1 }],
    ['a fractional run count', { ...OK, cancelledRuns: 0.5 }],
    ['a non-uuid id', { ...OK, id: 'src-1' }],
    ['no changed flag', { id: OK.id, enabled: true, cancelledRuns: 0 }],
  ])('refuses %s', (_label, value) => {
    expect(jobSourceSwitchResultSchema.safeParse(value).success).toBe(false)
  })
})

describe('jobSourceSchema — additive Task 6.5 fields', () => {
  it('an old client`s DTO still parses, with no field invented', () => {
    expect(jobSourceSchema.parse(OLD_DTO)).toEqual(OLD_DTO)
    expect(jobSourceListSchema.parse({ items: [OLD_DTO] })).toEqual({ items: [OLD_DTO] })
  })

  it('the extended DTO parses with every value kept', () => {
    expect(jobSourceSchema.parse(EXTENDED)).toEqual(EXTENDED)
  })

  it('every new field is nullable where the column is', () => {
    const nulls = {
      ...OLD_DTO,
      readinessReason: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastNonemptyAt: null,
      nextAttemptAt: null,
      cooldownUntil: null,
      lastErrorCode: null,
      hostPausedUntil: null,
      hostPauseReason: null,
      costUnit: null,
      healthState: null,
    }
    expect(jobSourceSchema.parse(nulls)).toEqual(nulls)
  })

  it.each([
    ['an unknown readiness', { readiness: 'READY' }],
    ['an unknown admin state', { adminState: 'DISABLED' }],
    ['an over-long readiness reason', { readinessReason: 'x'.repeat(501) }],
    ['a non-ISO attempt instant', { lastAttemptAt: 'yesterday' }],
    ['a non-ISO cooldown', { cooldownUntil: '2026-11-01' }],
    ['a negative failure count', { consecutiveFailures: -1 }],
    ['a fractional failure count', { consecutiveFailures: 1.5 }],
    ['a lower-case error code', { lastErrorCode: 'access_policy' }],
    ['a free-text host pause reason', { hostPauseReason: 'the provider said no' }],
    ['an unknown cost unit', { costUnit: 'TOKEN' }],
    ['a non-boolean checkpoint flag', { resumeCheckpoint: 'yes' }],
    ['an unknown health state', { healthState: 'BROKEN' }],
  ])('refuses %s', (_label, over) => {
    expect(jobSourceSchema.safeParse({ ...OLD_DTO, ...over }).success).toBe(false)
  })
})

describe('the switch error codes', () => {
  it.each(['JOB_SOURCE_NOT_FOUND', 'JOB_SOURCE_NOT_READY', 'JOB_SOURCE_AUTH_PAUSED'] as const)(
    '%s has an English fallback',
    (code) => {
      expect(API_ERROR_FALLBACK_EN[code].length).toBeGreaterThan(0)
    },
  )
})
