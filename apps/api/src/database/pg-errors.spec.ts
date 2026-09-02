/**
 * Unit coverage for `pg-errors.ts`'s cause-chain walkers.
 *
 * SR-M-14 (security-review PR #623 round 6): `isDeadlock` was added purely
 * to fix a broken assertion inside `user-email-invites.integration.spec.ts`
 * (a `*.integration.spec.ts`, invisible to the mutation gate — see
 * `.claude/rules/common/mutation-gate-integration-specs.md`). Without a
 * UNIT-level double, the gate reported `PG_DEADLOCK_DETECTED = '40P01'` →
 * `''` as a genuine SURVIVED mutant (confirmed: `mutation:changed` against
 * this file with no test file present) — nothing at the unit level noticed
 * the sentinel value change at all. This file is that double: it drives
 * `isDeadlock` directly against constructed error shapes (real
 * `DrizzleQueryError`-style nesting, no live Postgres needed), the same way
 * a hypothetical `uniqueViolationConstraint.spec.ts` would for its sibling
 * function — this file doubles as that missing coverage too, since both
 * walkers share the exact same cause-chain-walking shape and neither had a
 * unit spec before this one.
 */
import { describe, expect, it } from 'vitest'
import {
  PG_DEADLOCK_DETECTED,
  PG_UNIQUE_VIOLATION,
  isDeadlock,
  isUniqueViolation,
  uniqueViolationConstraint,
} from './pg-errors'

describe('isDeadlock', () => {
  it('true when the TOP-LEVEL error carries code 40P01', () => {
    expect(isDeadlock({ code: '40P01' })).toBe(true)
  })

  it('true when the code is nested one level down, on .cause — the DrizzleQueryError shape', () => {
    // Mirrors the real shape verified against a live deadlock (see this
    // module's own doc): DrizzleQueryError.code is undefined, the real
    // SQLSTATE lives on .cause.code.
    const err = { code: undefined, cause: { code: '40P01' } }
    expect(isDeadlock(err)).toBe(true)
  })

  it('true when the code is nested two levels down', () => {
    const err = { cause: { cause: { code: '40P01' } } }
    expect(isDeadlock(err)).toBe(true)
  })

  it('false when no level of the chain carries 40P01', () => {
    const err = { code: 'ECONNRESET', cause: { code: '23505' } }
    expect(isDeadlock(err)).toBe(false)
  })

  it('false for null / undefined / a plain string', () => {
    expect(isDeadlock(null)).toBe(false)
    expect(isDeadlock(undefined)).toBe(false)
    expect(isDeadlock('boom')).toBe(false)
  })

  it('false for an error with no .cause at all', () => {
    expect(isDeadlock(new Error('plain'))).toBe(false)
  })

  it('bounded walk — a self-referential cause chain terminates instead of looping forever', () => {
    const err: { code: string; cause?: unknown } = { code: 'X' }
    err.cause = err
    expect(isDeadlock(err)).toBe(false)
  })

  it('bounded walk boundary: the code at exactly the 9th level (index 8) is NOT found — the walk stops one level short', () => {
    // Kills the `depth < 8` → `depth <= 8` OFF-BY-ONE mutant (survived
    // against the self-referential test alone, which never distinguishes
    // "stopped one iteration early" from "stopped correctly" — both report
    // `false` there). Builds an 9-node chain (indices 0..8) where ONLY the
    // deepest node (index 8) carries the deadlock code; every shallower
    // node is a deliberate non-match. The real bound (`depth < 8`) checks
    // indices 0..7 (8 iterations) and never reaches index 8 → `false`. The
    // mutant bound (`depth <= 8`) checks one iteration further, reaches
    // index 8, and returns `true` — the two disagree on this exact input.
    let chain: unknown = { code: PG_DEADLOCK_DETECTED }
    for (let i = 0; i < 8; i += 1) {
      chain = { code: 'not-a-deadlock', cause: chain }
    }
    expect(isDeadlock(chain)).toBe(false)
  })

  it('does not match a code that merely CONTAINS the deadlock SQLSTATE as a substring', () => {
    expect(isDeadlock({ code: '40P011' })).toBe(false)
    expect(isDeadlock({ code: 'PRE40P01' })).toBe(false)
  })

  it('PG_DEADLOCK_DETECTED is the literal Postgres deadlock SQLSTATE', () => {
    expect(PG_DEADLOCK_DETECTED).toBe('40P01')
  })
})

// `uniqueViolationConstraint` / `isUniqueViolation` had no unit spec before
// this file either (only exercised via `*.integration.spec.ts` real-DB
// collisions in transactions.service / company-account.service / users.service
// call sites) — added alongside `isDeadlock` since both walkers share the
// exact same shape and the mutation gate treats "changed lines" per-run, not
// per-function; a future change to either walker now has a unit double to
// fail against, not just an integration one.
describe('uniqueViolationConstraint / isUniqueViolation', () => {
  it('returns the constraint name for a top-level 23505 violation', () => {
    expect(uniqueViolationConstraint({ code: '23505', constraint: 'idx_foo' })).toBe('idx_foo')
  })

  it('returns the constraint name when nested on .cause (DrizzleQueryError shape)', () => {
    const err = { code: undefined, cause: { code: '23505', constraint: 'idx_bar' } }
    expect(uniqueViolationConstraint(err)).toBe('idx_bar')
  })

  it('returns empty string (still a violation) when the driver omits a constraint name', () => {
    expect(uniqueViolationConstraint({ code: '23505' })).toBe('')
  })

  it('returns null when nothing in the chain is a 23505', () => {
    expect(uniqueViolationConstraint({ code: '40P01' })).toBeNull()
    expect(uniqueViolationConstraint(null)).toBeNull()
  })

  it('isUniqueViolation mirrors uniqueViolationConstraint !== null', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '40P01' })).toBe(false)
  })

  it('PG_UNIQUE_VIOLATION is the literal Postgres unique-violation SQLSTATE', () => {
    expect(PG_UNIQUE_VIOLATION).toBe('23505')
  })
})
