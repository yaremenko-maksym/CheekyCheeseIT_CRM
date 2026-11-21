import { toMonthly } from '../funnel/layer1'

/**
 * The structured salary of a posting (owner decision 2026-11-21): filled ONLY from a source's own
 * structured fields, never parsed out of free text. One definition for the observation contract,
 * the canonical claim and the funnel (`funnel/layer1.types.ts` re-exports it).
 */

export type SalaryPeriod = 'HOUR' | 'MONTH' | 'YEAR'

/** A stated figure as persisted with the observation; a range has both bounds. */
export interface SalaryObservation {
  min: number | null
  max: number | null
  /** ISO 4217, upper case. */
  currency: string
  period: SalaryPeriod
}

/**
 * Exclusive upper bound of a stated amount AND of its monthly equivalent. The monthly one keeps a
 * huge hourly figure out of `salary_monthly_top` (`numeric(12,2)`), whose overflow would fail the
 * whole canonical write.
 */
export const MAX_SALARY_AMOUNT = 1e9

const PERIODS: ReadonlySet<string> = new Set<SalaryPeriod>(['HOUR', 'MONTH', 'YEAR'])
const CURRENCY = /^[A-Z]{3}$/

const round2 = (n: number): number => Math.round(n * 100) / 100

/** A present bound rounded to 2 decimals, `null` when absent, `undefined` when invalid. */
function bound(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = round2(value)
  return rounded > 0 && rounded < MAX_SALARY_AMOUNT ? rounded : undefined
}

/**
 * The trust-boundary check of an adapter's salary: the statement as stored, or `null`. A refused
 * salary is dropped, never a reason to quarantine the posting.
 */
export function normalizeSalary(raw: unknown): SalaryObservation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const min = bound(r['min'])
  const max = bound(r['max'])
  if (min === undefined || max === undefined || (min === null && max === null)) return null
  if (min !== null && max !== null && min > max) return null
  const currency = typeof r['currency'] === 'string' ? r['currency'].trim().toUpperCase() : ''
  if (!CURRENCY.test(currency)) return null
  const period = r['period']
  if (typeof period !== 'string' || !PERIODS.has(period)) return null
  const salary: SalaryObservation = { min, max, currency, period: period as SalaryPeriod }
  return salaryMonthlyTop(salary) < MAX_SALARY_AMOUNT ? salary : null
}

/** The monthly top of the range (max, else min), as `classifySalary` reads it; 2 decimals. */
export function salaryMonthlyTop(s: SalaryObservation): number {
  return round2(toMonthly((s.max ?? s.min) as number, s.period))
}

/** The content-hash part: a flat array, fixed order (the hash payload is a JSON tuple). */
export function salaryHashPart(
  s: SalaryObservation,
): [string, SalaryPeriod, number | null, number | null] {
  return [s.currency, s.period, s.min, s.max]
}

/** The salary as ONE canonical claim, so no bound can come from another member than its currency. */
export function encodeSalaryClaim(s: SalaryObservation): string {
  return [s.currency, s.period, s.min ?? '', s.max ?? ''].join('|')
}

export function decodeSalaryClaim(claim: string): SalaryObservation | null {
  const parts = claim.split('|')
  if (parts.length !== 4) return null
  const [currency, period, min, max] = parts as [string, string, string, string]
  return normalizeSalary({
    currency,
    period,
    min: min === '' ? null : Number(min),
    max: max === '' ? null : Number(max),
  })
}
