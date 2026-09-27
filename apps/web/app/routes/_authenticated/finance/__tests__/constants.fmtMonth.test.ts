/**
 * constants.fmtMonth.test.ts — task-i18n-3d-pr1-fix (mutation-gate follow-up).
 *
 * `fmtMonth` builds `new Date(year, month - 1, 1)` from LOCAL date
 * components, then delegates to `@crm/shared`'s `formatDate` with an
 * explicit `timeZone: 'UTC'`. Asserting on the real FORMATTED STRING
 * (`constants.i18n.test.ts` tried this first) is host-timezone-dependent: on
 * a positive-offset host, local midnight on the 1st converts to the
 * PREVIOUS UTC day, rolling the displayed month back by one — reproduced
 * directly under `mutation-gate.mjs`'s Stryker worker even with `TZ` pinned
 * inside the test body (`process.env['TZ'] = 'UTC'` had no effect there,
 * unlike in a plain Node script — this file's happy-dom environment likely
 * owns its own `Date`/`Intl` binding, independent of `process.env.TZ`).
 *
 * This file sidesteps the timezone round-trip entirely: it spies on
 * `formatDate` and asserts on the ARGUMENTS `fmtMonth` passes it — the
 * `Date` object's own `getMonth()` (a LOCAL-time getter, matching however
 * the `Date` was constructed, no UTC conversion involved) and the `style`
 * string — instead of the round-tripped, timezone-sensitive formatted
 * output. `vi.mock('@crm/shared', ...)` is file-scoped (Vitest hoists the
 * mock only for THIS module), so it cannot affect the real-catalog
 * assertions in `constants.i18n.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above plain top-level `const`s — `vi.hoisted`
// is the documented way to define a value the (also hoisted) factory can close
// over without a "Cannot access before initialization" TDZ error.
const { formatDateSpy } = vi.hoisted(() => ({ formatDateSpy: vi.fn(() => 'STUBBED') }))

vi.mock('@crm/shared', async () => {
  const actual = await vi.importActual<typeof import('@crm/shared')>('@crm/shared')
  return {
    ...actual,
    formatDate: formatDateSpy,
  }
})

import { fmtMonth } from '../constants'

describe('fmtMonth — month arithmetic + style, via a formatDate spy (ArithmeticOperator/StringLiteral mutants)', () => {
  beforeEach(() => {
    formatDateSpy.mockClear()
  })

  it('passes the 0-indexed month (year, month - 1, 1) and the "monthYear" style', () => {
    fmtMonth('2026-05')
    expect(formatDateSpy).toHaveBeenCalledTimes(1)
    const call = formatDateSpy.mock.calls[0]!
    const dateArg = call[0] as Date
    const styleArg = call[2]
    // `month - 1` mutated to `month + 1` would pass month index 5 (June)
    // instead of 4 (May, 0-indexed) — `getMonth()` reads it back exactly as
    // constructed, no formatting/timezone round-trip involved.
    expect(dateArg.getFullYear()).toBe(2026)
    expect(dateArg.getMonth()).toBe(4)
    expect(dateArg.getDate()).toBe(1)
    // An emptied StringLiteral would pass '' instead of 'monthYear'.
    expect(styleArg).toBe('monthYear')
  })

  it('returns "—" for a nullish/empty month without calling formatDate', () => {
    expect(fmtMonth(null)).toBe('—')
    expect(fmtMonth(undefined)).toBe('—')
    expect(fmtMonth('')).toBe('—')
    expect(formatDateSpy).not.toHaveBeenCalled()
  })
})
