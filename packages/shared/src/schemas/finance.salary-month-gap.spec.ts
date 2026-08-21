/**
 * finance.salary-month-gap.spec.ts — unit tests for the schemas backing
 * task-salary-month-gap-and-status (E-5): salaryMonthGapQuerySchema,
 * salaryMonthGapReceiverSchema, salaryMonthGapReportSchema,
 * salaryMonthBackfillSchema.
 *
 * mutation-gate (AC6): pins the month-format regexes and the role enum at
 * the schema boundary directly — a positive parse alone cannot kill a
 * `^`/`$`-anchor removal or a digit-class widening, only a targeted negative
 * case can (e.g. a string that a WIDER pattern would wrongly accept).
 */
import { describe, expect, it } from 'vitest'
import {
  salaryMonthGapQuerySchema,
  salaryMonthGapReceiverSchema,
  salaryMonthGapReportSchema,
  salaryMonthBackfillSchema,
} from './finance'

const RECEIVER_ID = 'a0000000-0000-4000-8000-000000000001'
const PROJECT_ID = 'a0000000-0000-4000-8000-000000000002'

describe('salaryMonthGapReceiverSchema', () => {
  function receiver(overrides: Record<string, unknown> = {}) {
    return {
      userId: RECEIVER_ID,
      displayName: 'HR One',
      role: 'HR',
      expectedAmount: 1500,
      projectId: null,
      projectName: null,
      ...overrides,
    }
  }

  it('parses a valid HR/ACCOUNTANT entry (projectId/projectName null)', () => {
    expect(receiverParses(receiver())).toBe(true)
    expect(receiverParses(receiver({ role: 'ACCOUNTANT' }))).toBe(true)
  })

  it('parses a valid JUNIOR entry with project context', () => {
    expect(
      receiverParses(receiver({ role: 'JUNIOR', projectId: PROJECT_ID, projectName: 'Proj One' })),
    ).toBe(true)
  })

  it('rejects a role outside HR/ACCOUNTANT/JUNIOR (e.g. SENIOR — cron-ineligible, out of scope)', () => {
    expect(receiverParses(receiver({ role: 'SENIOR' }))).toBe(false)
    expect(receiverParses(receiver({ role: 'DROP' }))).toBe(false)
    expect(receiverParses(receiver({ role: 'ADMIN' }))).toBe(false)
  })

  it('rejects a non-uuid userId', () => {
    expect(receiverParses(receiver({ userId: 'not-a-uuid' }))).toBe(false)
  })

  function receiverParses(value: unknown): boolean {
    return salaryMonthGapReceiverSchema.safeParse(value).success
  }
})

describe('salaryMonthGapReportSchema — month format', () => {
  function reportWith(month: string) {
    return { month, missing: [] }
  }

  it('accepts a well-formed YYYY-MM month', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('2026-08')).success).toBe(true)
  })

  it('rejects a 3-digit year (kills a widened {4} quantifier)', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('026-08')).success).toBe(false)
  })

  it('rejects a 1-digit month (kills a widened {2} quantifier)', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('2026-8')).success).toBe(false)
  })

  it('rejects a leading extra character (kills removal of the ^ anchor)', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('x2026-08')).success).toBe(false)
  })

  it('rejects a trailing extra character (kills removal of the $ anchor)', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('2026-08x')).success).toBe(false)
  })

  it('rejects non-digit characters where digits are required (kills \\d → \\D)', () => {
    expect(salaryMonthGapReportSchema.safeParse(reportWith('aaaa-08')).success).toBe(false)
  })

  it('surfaces the exact "YYYY-MM" error message on rejection', () => {
    // ZodError#message is the issues array JSON-stringified — the custom
    // message text still appears verbatim inside it, so a substring `toThrow`
    // pins it without a conditional `expect` (banned by vitest/no-conditional-
    // expect even inside a try/catch).
    expect(() => salaryMonthGapReportSchema.parse(reportWith('bad'))).toThrow(
      "Expected 'YYYY-MM' format",
    )
  })

  it('parses missing entries end to end', () => {
    const result = salaryMonthGapReportSchema.parse({
      month: '2026-08',
      missing: [
        {
          userId: RECEIVER_ID,
          displayName: 'HR One',
          role: 'HR',
          expectedAmount: 1500,
          projectId: null,
          projectName: null,
        },
      ],
    })
    expect(result.missing).toHaveLength(1)
  })
})

describe('salaryMonthGapQuerySchema — optional ?month=YYYY-MM', () => {
  it('accepts an absent month', () => {
    expect(salaryMonthGapQuerySchema.safeParse({}).success).toBe(true)
  })

  it('accepts a well-formed month', () => {
    const result = salaryMonthGapQuerySchema.parse({ month: '2026-08' })
    expect(result.month).toBe('2026-08')
  })

  it('rejects month 00 (kills a widened 0[1-9] alternative)', () => {
    expect(salaryMonthGapQuerySchema.safeParse({ month: '2026-00' }).success).toBe(false)
  })

  it('rejects month 13 (kills a widened 1[0-2] alternative)', () => {
    expect(salaryMonthGapQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false)
  })

  it('accepts every real month 01..12', () => {
    for (let m = 1; m <= 12; m++) {
      const month = `2026-${String(m).padStart(2, '0')}`
      expect(salaryMonthGapQuerySchema.safeParse({ month }).success).toBe(true)
    }
  })

  it('rejects a leading/trailing extra character (anchors)', () => {
    expect(salaryMonthGapQuerySchema.safeParse({ month: 'x2026-08' }).success).toBe(false)
    expect(salaryMonthGapQuerySchema.safeParse({ month: '2026-08x' }).success).toBe(false)
  })

  it('surfaces the exact "month must be YYYY-MM" error message on rejection', () => {
    expect(() => salaryMonthGapQuerySchema.parse({ month: 'bad' })).toThrow('month must be YYYY-MM')
  })
})

describe('salaryMonthBackfillSchema — month REQUIRED (unlike the report query)', () => {
  it('rejects a missing month — backfill must never default to "whatever month it is now"', () => {
    expect(salaryMonthBackfillSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a well-formed month', () => {
    const result = salaryMonthBackfillSchema.parse({ month: '2026-08' })
    expect(result.month).toBe('2026-08')
  })

  it('rejects month 00 / 13 (same alternation as the query schema)', () => {
    expect(salaryMonthBackfillSchema.safeParse({ month: '2026-00' }).success).toBe(false)
    expect(salaryMonthBackfillSchema.safeParse({ month: '2026-13' }).success).toBe(false)
  })

  it('rejects a leading/trailing extra character (anchors)', () => {
    expect(salaryMonthBackfillSchema.safeParse({ month: 'x2026-08' }).success).toBe(false)
    expect(salaryMonthBackfillSchema.safeParse({ month: '2026-08x' }).success).toBe(false)
  })

  it('surfaces the exact "month must be YYYY-MM" error message on rejection', () => {
    expect(() => salaryMonthBackfillSchema.parse({ month: 'bad' })).toThrow('month must be YYYY-MM')
  })
})
