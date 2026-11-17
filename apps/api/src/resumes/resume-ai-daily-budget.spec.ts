/**
 * ResumeAiDailyBudget without a database: the cap arithmetic, the UTC day bounds and the exact
 * reservation statement. The real behaviour of that statement (refusal, rollover, concurrency) is
 * proven against Postgres as `crm_app` in resume-ai-daily-budget.integration.spec.ts.
 */
import { RESUME_LIMITS } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it, vi } from 'vitest'
import * as schema from '../database/schema'
import {
  RESUME_AI_DAILY_CALL_CAP,
  RESUME_AI_METER_ACCOUNT_KEY,
  ResumeAiDailyBudget,
  nextUtcMidnight,
  releaseCallQuery,
  reserveCallQuery,
  utcDayBounds,
} from './resume-ai-daily-budget'

describe('RESUME_AI_DAILY_CALL_CAP', () => {
  it('worst-case calls fit within 50 % of the 10 000 free Neurons a day', () => {
    // Pins the arithmetic in the constant's comment: raising the cap, the input limit or the
    // prompt overhead (1 100 tokens on top of the resume text) past the share fails here.
    const neuronsPerInputToken = 0.351 / 0.011 / 1_000
    const neuronsPerOutputToken = 0.555 / 0.011 / 1_000
    const inputTokens = RESUME_LIMITS.extractionInputChars + 1_100
    const perCall = inputTokens * neuronsPerInputToken + 1_400 * neuronsPerOutputToken
    expect(RESUME_AI_DAILY_CALL_CAP * perCall).toBeLessThanOrEqual(5_000)
    expect((RESUME_AI_DAILY_CALL_CAP + 1) * perCall).toBeGreaterThan(5_000)
  })
})

describe('utcDayBounds', () => {
  it('spans the UTC day containing the instant, whatever the time of day', () => {
    expect(utcDayBounds(new Date('2026-11-17T23:59:59.999Z'))).toEqual({
      start: new Date('2026-11-17T00:00:00.000Z'),
      end: new Date('2026-11-18T00:00:00.000Z'),
    })
    expect(utcDayBounds(new Date('2026-11-18T00:00:00.000Z'))).toEqual({
      start: new Date('2026-11-18T00:00:00.000Z'),
      end: new Date('2026-11-19T00:00:00.000Z'),
    })
  })

  it('crosses a month and a year end', () => {
    expect(utcDayBounds(new Date('2026-12-31T12:00:00.000Z')).end).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    )
  })
})

describe('reserveCallQuery', () => {
  const now = new Date('2026-11-17T10:00:00.000Z')
  // Built inside each test, never at collection time: Stryker cannot see a statement built there.
  const render = () => reserveCallQuery(drizzle.mock({ schema }), now, 'cloudflare:test', 7).toSQL()

  it('inserts a DAY / MODEL_CALL meter row starting at 1 with today as its window', () => {
    const { sql: text, params } = render()
    expect(text).toMatch(/^insert into "job_account_meters"/)
    expect(params.slice(0, 7)).toEqual([
      'cloudflare:test',
      'MODEL_CALL',
      'DAY',
      7,
      1,
      '2026-11-17T00:00:00.000Z',
      '2026-11-18T00:00:00.000Z',
    ])
    expect(params.slice(7)).toEqual(Array(4).fill(now.toISOString()))
  })

  it('on conflict: rolls a finished day over to 1, else adds 1, and takes the code limit', () => {
    const { sql: text } = render()
    // A NULL `resets_at` counts as rolled over (R2): `NULL <= now` alone is NULL, i.e. never.
    const rolled = `COALESCE("job_account_meters"."resets_at" <= $8::timestamptz, true)`
    expect(text).toContain(
      `on conflict ("account_key","unit","window_kind") do update set "limit_amount" = excluded.limit_amount, ` +
        `"used" = CASE WHEN ${rolled} THEN 1 ELSE "job_account_meters"."used" + 1 END, ` +
        `"window_started_at" = CASE WHEN ${rolled.replace('$8', '$9')} THEN excluded.window_started_at ELSE "job_account_meters"."window_started_at" END, ` +
        `"resets_at" = CASE WHEN ${rolled.replace('$8', '$10')} THEN excluded.resets_at ELSE "job_account_meters"."resets_at" END, ` +
        `"updated_at" = now() `,
    )
  })

  it('updates only while there is room, so a spent day returns no row', () => {
    const { sql: text } = render()
    expect(text).toContain(
      `where (CASE WHEN COALESCE("job_account_meters"."resets_at" <= $11::timestamptz, true) THEN 0 ELSE "job_account_meters"."used" END)` +
        ` + "job_account_meters"."reserved" + "job_account_meters"."uncertain" < excluded.limit_amount returning "used"`,
    )
  })
})

describe('releaseCallQuery', () => {
  const now = new Date('2026-11-17T10:00:00.000Z')
  const render = () => releaseCallQuery(drizzle.mock({ schema }), now, 'cloudflare:test').toSQL()

  it('takes one call back from the reservation day only, and never below 0', () => {
    const { sql: text, params } = render()
    expect(text).toBe(
      'update "job_account_meters" set "used" = "job_account_meters"."used" - 1, "updated_at" = now() ' +
        'where ("job_account_meters"."account_key" = $1 and "job_account_meters"."unit" = $2 and ' +
        '"job_account_meters"."window_kind" = $3 and "job_account_meters"."window_started_at" = $4 and ' +
        '"job_account_meters"."used" > $5)',
    )
    expect(params).toEqual(['cloudflare:test', 'MODEL_CALL', 'DAY', '2026-11-17T00:00:00.000Z', 0])
  })
})

describe('nextUtcMidnight', () => {
  it('is the end of the UTC day utcDayBounds reports', () => {
    const now = new Date('2026-11-17T23:59:59.999Z')
    expect(nextUtcMidnight(now)).toEqual(utcDayBounds(now).end)
    expect(nextUtcMidnight(now)).toEqual(new Date('2026-11-18T00:00:00.000Z'))
  })
})

describe('ResumeAiDailyBudget.releaseCall', () => {
  /** A db whose `update` builds the real statement (drizzle.mock) and records its SQL. */
  function budgetUpdating() {
    const mock = drizzle.mock({ schema })
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      update: (table: typeof schema.jobAccountMeters) => ({
        set: (values: never) => ({
          where: (where: never) => {
            statements.push(mock.update(table).set(values).where(where).toSQL())
            return Promise.resolve(undefined)
          },
        }),
      }),
    }
    return { budget: new ResumeAiDailyBudget({ db } as never), statements }
  }

  it('releases from the resume meter for the current UTC day by default', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00.000Z') })
    try {
      const { budget, statements } = budgetUpdating()
      await expect(budget.releaseCall()).resolves.toBeUndefined()
      expect(statements).toHaveLength(1)
      expect(statements[0]?.params).toEqual([
        'cloudflare:resume-extraction',
        'MODEL_CALL',
        'DAY',
        '2026-11-17T00:00:00.000Z',
        0,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases from the day of the instant it is given', async () => {
    const { budget, statements } = budgetUpdating()
    await budget.releaseCall(new Date('2026-11-16T23:00:00.000Z'), 'cloudflare:test')
    expect(statements[0]?.params.slice(0, 4)).toEqual([
      'cloudflare:test',
      'MODEL_CALL',
      'DAY',
      '2026-11-16T00:00:00.000Z',
    ])
  })

  it('passes a database failure through', async () => {
    const db = {
      update: () => {
        throw new Error('connection refused')
      },
    }
    await expect(new ResumeAiDailyBudget({ db } as never).releaseCall()).rejects.toThrow(
      'connection refused',
    )
  })
})

describe('ResumeAiDailyBudget.reserveCall', () => {
  function budgetReturning(rows: unknown[]) {
    const calls: Array<{ values: unknown }> = []
    const db = {
      insert: () => ({
        values: (values: unknown) => {
          calls.push({ values })
          return {
            onConflictDoUpdate: () => ({ returning: () => Promise.resolve(rows) }),
          }
        },
      }),
    }
    return { budget: new ResumeAiDailyBudget({ db } as never), calls }
  }

  it('is true when the statement returned the reserved row', async () => {
    const { budget } = budgetReturning([{ used: 3 }])
    await expect(budget.reserveCall()).resolves.toBe(true)
  })

  it('is false when the statement returned nothing (the day is spent)', async () => {
    const { budget } = budgetReturning([])
    await expect(budget.reserveCall()).resolves.toBe(false)
  })

  it('defaults to the resume meter, the code cap and the current time', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00.000Z') })
    try {
      const { budget, calls } = budgetReturning([{ used: 1 }])
      await budget.reserveCall()
      expect(RESUME_AI_METER_ACCOUNT_KEY).toBe('cloudflare:resume-extraction')
      expect(calls[0]?.values).toMatchObject({
        accountKey: 'cloudflare:resume-extraction',
        limitAmount: RESUME_AI_DAILY_CALL_CAP,
        windowStartedAt: new Date('2026-11-17T00:00:00.000Z'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a database failure through instead of treating it as room', async () => {
    const db = {
      insert: () => {
        throw new Error('connection refused')
      },
    }
    const budget = new ResumeAiDailyBudget({ db } as never)
    await expect(budget.reserveCall()).rejects.toThrow('connection refused')
  })
})
