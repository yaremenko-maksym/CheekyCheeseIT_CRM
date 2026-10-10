/**
 * interviews.spec.ts — unit tests for mySalaryStateSchema + mySalaryStatusSchema.
 *
 * task-salary-month-gap-and-status (E-6): the NEW `mySalaryState` field is a
 * 4-state discriminated union so "not configured", "configured but this role
 * is never cron-processed", and "configured, cron-eligible, row not created
 * yet" are distinguishable BY SHAPE (see the module comment on
 * `mySalaryStateSchema` in interviews.ts for the full rationale). The OLD
 * `mySalaryStatus` field is DEPRECATED but kept byte-identical to its
 * pre-task shape (security-review MED-3 — an already-loaded old frontend
 * bundle does a STRICT Zod .parse() and must not crash on it). These tests
 * pin BOTH wire contracts at the schema boundary — the API-level behaviour
 * (which state a given DB row resolves to) is covered separately in
 * apps/api's salary-status.helper.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  boardSeniorSchema,
  createInterviewSchema,
  updateInterviewSchema,
  mySalaryAggregateStateSchema,
  mySalaryStateSchema,
  mySalaryStatusSchema,
} from './interviews'

const LEGACY_EXISTS = {
  state: 'EXISTS' as const,
  amount: 1500,
  currency: 'USD' as const,
  status: 'PENDING' as const,
}

const AGGREGATE_EXISTS = {
  ...LEGACY_EXISTS,
  transactionCount: 1,
  totals: [
    {
      currency: 'USD' as const,
      amount: 1500,
      paidAmount: 0,
      pendingAmount: 1500,
      lockedAmount: 0,
    },
  ],
}

describe('mySalaryStateSchema (E-6 fix — the new 4-state field)', () => {
  it('parses NOT_CONFIGURED (no other fields)', () => {
    const result = mySalaryStateSchema.parse({ state: 'NOT_CONFIGURED' })
    expect(result).toEqual({ state: 'NOT_CONFIGURED' })
  })

  it('parses NOT_CRON_ELIGIBLE (no other fields) — configured but this role is never cron-processed', () => {
    const result = mySalaryStateSchema.parse({ state: 'NOT_CRON_ELIGIBLE' })
    expect(result).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
  })

  it('parses AWAITING_CREATION (no other fields)', () => {
    const result = mySalaryStateSchema.parse({ state: 'AWAITING_CREATION' })
    expect(result).toEqual({ state: 'AWAITING_CREATION' })
  })

  it('keeps the pre-multipart EXISTS shape byte-compatible', () => {
    const result = mySalaryStateSchema.parse(LEGACY_EXISTS)
    expect(result).toEqual(LEGACY_EXISTS)
  })

  it('EXISTS accepts only the legacy salary statuses', () => {
    for (const status of ['PENDING', 'PAID', 'LOCKED'] as const) {
      expect(() => mySalaryStateSchema.parse({ ...LEGACY_EXISTS, status })).not.toThrow()
    }
    expect(() =>
      mySalaryStateSchema.parse({ ...LEGACY_EXISTS, status: 'PARTIALLY_PAID' }),
    ).toThrow()
  })

  it('EXISTS accepts every valid currency', () => {
    for (const currency of ['USDT', 'USD', 'EUR', 'UAH'] as const) {
      expect(() =>
        mySalaryStateSchema.parse({
          ...LEGACY_EXISTS,
          currency,
        }),
      ).not.toThrow()
    }
  })

  it('rejects EXISTS missing amount/currency/status — the discriminant alone is not enough', () => {
    expect(() => mySalaryStateSchema.parse({ state: 'EXISTS' })).toThrow()
  })

  it('rejects an unknown state value', () => {
    expect(() => mySalaryStateSchema.parse({ state: 'BOGUS' })).toThrow()
  })

  it('rejects a bare null — this field is never nullable (unlike the deprecated mySalaryStatus)', () => {
    expect(() => mySalaryStateSchema.parse(null)).toThrow()
  })

  it('rejects an invalid status inside EXISTS (e.g. REJECTED — not a valid SALARY status)', () => {
    expect(() =>
      mySalaryStateSchema.parse({
        ...LEGACY_EXISTS,
        status: 'REJECTED',
      }),
    ).toThrow()
  })
})

describe('mySalaryAggregateStateSchema (additive multipart field)', () => {
  it('EXISTS accepts every multipart salary status', () => {
    for (const status of ['PENDING', 'PARTIALLY_PAID', 'PAID', 'LOCKED'] as const) {
      expect(mySalaryAggregateStateSchema.parse({ ...AGGREGATE_EXISTS, status })).toEqual({
        ...AGGREGATE_EXISTS,
        status,
      })
    }
  })

  it('parses aggregate metadata and PARTIALLY_PAID', () => {
    const result = mySalaryAggregateStateSchema.parse({
      ...AGGREGATE_EXISTS,
      status: 'PARTIALLY_PAID',
    })
    expect(result).toEqual({ ...AGGREGATE_EXISTS, status: 'PARTIALLY_PAID' })
  })

  it('permits null convenience amount/currency for a mixed-currency month', () => {
    expect(() =>
      mySalaryAggregateStateSchema.parse({
        ...AGGREGATE_EXISTS,
        amount: null,
        currency: null,
        transactionCount: 2,
        totals: [
          AGGREGATE_EXISTS.totals[0],
          {
            currency: 'EUR',
            amount: 400,
            paidAmount: 400,
            pendingAmount: 0,
            lockedAmount: 0,
          },
        ],
      }),
    ).not.toThrow()
  })

  it('keeps all three no-row states distinguishable', () => {
    for (const state of ['NOT_CONFIGURED', 'NOT_CRON_ELIGIBLE', 'AWAITING_CREATION'] as const) {
      expect(mySalaryAggregateStateSchema.parse({ state })).toEqual({ state })
    }
  })
})

describe('mySalaryStatusSchema (DEPRECATED — pins backward compatibility, security-review MED-3)', () => {
  it('parses null (the "nothing to show" case — no `state` discriminant, unlike mySalaryState)', () => {
    expect(mySalaryStatusSchema.parse(null)).toBeNull()
  })

  it('parses the object shape with amount/currency/status — no `state` key', () => {
    const result = mySalaryStatusSchema.parse({ amount: 1500, currency: 'USD', status: 'PENDING' })
    expect(result).toEqual({ amount: 1500, currency: 'USD', status: 'PENDING' })
  })

  it('rejects a `state`-shaped payload — required amount/currency/status are missing on it', () => {
    // Not because `state` itself is rejected (Zod objects here are non-strict
    // — unknown keys are silently dropped, not rejected, exactly what lets an
    // OLD client tolerate the NEW `mySalaryState` field being added
    // alongside it) — this throws because a bare `{ state: ... }` payload
    // has none of the three keys THIS schema actually requires. Pinned as a
    // negative case so this schema can never silently drift toward
    // `mySalaryStateSchema`'s discriminated-union shape.
    expect(() => mySalaryStatusSchema.parse({ state: 'AWAITING_CREATION' })).toThrow()
  })

  it('rejects an invalid status (e.g. REJECTED — not a valid SALARY status)', () => {
    expect(() =>
      mySalaryStatusSchema.parse({ amount: 100, currency: 'USD', status: 'REJECTED' }),
    ).toThrow()
  })

  it('rejects PARTIALLY_PAID so the deprecated enum remains byte-compatible with old clients', () => {
    expect(() =>
      mySalaryStatusSchema.parse({ amount: 100, currency: 'USD', status: 'PARTIALLY_PAID' }),
    ).toThrow()
  })

  it('rejects missing amount/currency/status on a non-null object', () => {
    expect(() => mySalaryStatusSchema.parse({})).toThrow()
  })
})

// task-hr-drop-team-senior-board — GET /api/interviews/seniors DTO.
describe('boardSeniorSchema', () => {
  const VALID = {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Иван Синьор',
    avatarUrl: 'https://example.com/avatar.png',
    avatarDocumentId: '22222222-2222-4222-8222-222222222222',
  }

  it('parses a full valid row and keeps every field intact', () => {
    // A round-trip equality check (not just `.not.toThrow()`) matters here:
    // an emptied schema (`z.object({})`) would ALSO accept this input
    // without throwing, but would silently strip every key — `result.id`
    // would come back `undefined`, not the id that went in.
    expect(boardSeniorSchema.parse(VALID)).toEqual(VALID)
  })

  it('accepts null avatarUrl and null avatarDocumentId', () => {
    const result = boardSeniorSchema.parse({ ...VALID, avatarUrl: null, avatarDocumentId: null })
    expect(result.avatarUrl).toBeNull()
    expect(result.avatarDocumentId).toBeNull()
  })

  it('rejects an empty object — id/displayName/avatarUrl/avatarDocumentId are all required', () => {
    expect(boardSeniorSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a non-UUID id', () => {
    expect(boardSeniorSchema.safeParse({ ...VALID, id: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects a non-UUID avatarDocumentId', () => {
    expect(boardSeniorSchema.safeParse({ ...VALID, avatarDocumentId: 'not-a-uuid' }).success).toBe(
      false,
    )
  })

  it('rejects an avatarUrl that is not a URL', () => {
    expect(boardSeniorSchema.safeParse({ ...VALID, avatarUrl: 'not-a-url' }).success).toBe(false)
  })

  it('rejects a missing displayName', () => {
    const { displayName: _displayName, ...withoutName } = VALID
    expect(boardSeniorSchema.safeParse(withoutName).success).toBe(false)
  })

  it('strips unmasked fields silently instead of rejecting them (allow-list, not deny-list)', () => {
    const result = boardSeniorSchema.parse({ ...VALID, email: 'leak@test.spec', techStack: ['x'] })
    expect(result).not.toHaveProperty('email')
    expect(result).not.toHaveProperty('techStack')
  })
})

describe('interview URL fields — http(s) scheme allow-list', () => {
  const base = { seniorId: '11111111-1111-4111-8111-111111111111', companyName: 'Acme' }

  it.each(['vacancyUrl', 'callUrl'] as const)(
    '%s rejects javascript:/data: on create and update',
    (field) => {
      for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>']) {
        expect(createInterviewSchema.safeParse({ ...base, [field]: bad }).success).toBe(false)
        expect(updateInterviewSchema.safeParse({ [field]: bad }).success).toBe(false)
      }
    },
  )

  it.each(['vacancyUrl', 'callUrl'] as const)('%s accepts http(s), null and omitted', (field) => {
    expect(createInterviewSchema.safeParse({ ...base, [field]: 'https://x.io/a' }).success).toBe(
      true,
    )
    expect(updateInterviewSchema.safeParse({ [field]: 'http://x.io/a' }).success).toBe(true)
    expect(updateInterviewSchema.safeParse({ [field]: null }).success).toBe(true)
    expect(updateInterviewSchema.safeParse({}).success).toBe(true)
  })
})
