/**
 * pending-share.spec.ts — task-pending-share (position 5). Schema-level
 * boundary + message coverage for `pendingSeniorShareSchema` /
 * `rejectPendingShareSchema`.
 *
 * Written after the mutation gate (scripts/devops/mutation-gate.mjs
 * --changed) reported 9 survived mutants on this file — every one of them a
 * boundary number or an error-message string that nothing asserted on. The
 * service-level tests (projects.pending-share.spec.ts, users.pending-share.
 * spec.ts) exercise these schemas only through valid, mid-range inputs; they
 * never touch the EDGES these schemas exist to enforce. This file's whole
 * job is those edges.
 */
import { describe, expect, it } from 'vitest'
import { pendingSeniorShareSchema, rejectPendingShareSchema } from './pending-share'

describe('pendingSeniorShareSchema', () => {
  // task-648-fix-round-1 (COPY-H-2/COPY-H-3): `effectivePercentAfterApproval`
  // added as a required field alongside `percent` — see the schema's own
  // doc comment. A distinct value from `percent` here (55 vs the 42/0/100
  // used for `percent` below) so a test that accidentally read the wrong
  // field would fail loudly instead of coincidentally passing.
  const base = {
    approverId: 'a0000000-0000-4000-8000-000000000001',
    approverName: 'Senior One',
    effectivePercentAfterApproval: 55,
  }

  it('accepts a mid-range percent', () => {
    expect(pendingSeniorShareSchema.parse({ ...base, percent: 42 })).toEqual({
      ...base,
      percent: 42,
    })
  })

  it('accepts null percent (a legitimate "propose clearing the override" value)', () => {
    expect(pendingSeniorShareSchema.parse({ ...base, percent: null })).toEqual({
      ...base,
      percent: null,
    })
  })

  it('accepts the boundary values 0 and 100', () => {
    expect(pendingSeniorShareSchema.parse({ ...base, percent: 0 }).percent).toBe(0)
    expect(pendingSeniorShareSchema.parse({ ...base, percent: 100 }).percent).toBe(100)
  })

  it('rejects -1 (below the 0 floor)', () => {
    expect(() => pendingSeniorShareSchema.parse({ ...base, percent: -1 })).toThrow()
  })

  it('rejects 101 (above the 100 ceiling)', () => {
    expect(() => pendingSeniorShareSchema.parse({ ...base, percent: 101 })).toThrow()
  })

  it('rejects a non-integer percent', () => {
    expect(() => pendingSeniorShareSchema.parse({ ...base, percent: 42.5 })).toThrow()
  })

  it('rejects a non-UUID approverId', () => {
    expect(() =>
      pendingSeniorShareSchema.parse({ ...base, percent: 30, approverId: 'not-a-uuid' }),
    ).toThrow()
  })

  // task-648-fix-round-1: `effectivePercentAfterApproval` boundary coverage,
  // mirroring `percent`'s own edge tests above — same 0-100 int constraint,
  // but NEVER nullable (unlike `percent`, there is always a concrete
  // resolved value, even for a clear-override proposal).
  it('accepts the boundary values 0 and 100 for effectivePercentAfterApproval', () => {
    expect(
      pendingSeniorShareSchema.parse({ ...base, percent: null, effectivePercentAfterApproval: 0 })
        .effectivePercentAfterApproval,
    ).toBe(0)
    expect(
      pendingSeniorShareSchema.parse({
        ...base,
        percent: null,
        effectivePercentAfterApproval: 100,
      }).effectivePercentAfterApproval,
    ).toBe(100)
  })

  it('rejects a null effectivePercentAfterApproval (unlike percent, never nullable)', () => {
    expect(() =>
      pendingSeniorShareSchema.parse({ ...base, percent: 42, effectivePercentAfterApproval: null }),
    ).toThrow()
  })

  it('rejects -1 for effectivePercentAfterApproval (below the 0 floor)', () => {
    expect(() =>
      pendingSeniorShareSchema.parse({ ...base, percent: 42, effectivePercentAfterApproval: -1 }),
    ).toThrow()
  })

  it('rejects 101 for effectivePercentAfterApproval (above the 100 ceiling)', () => {
    expect(() =>
      pendingSeniorShareSchema.parse({ ...base, percent: 42, effectivePercentAfterApproval: 101 }),
    ).toThrow()
  })

  it('rejects a non-integer effectivePercentAfterApproval', () => {
    expect(() =>
      pendingSeniorShareSchema.parse({
        ...base,
        percent: 42,
        effectivePercentAfterApproval: 42.5,
      }),
    ).toThrow()
  })
})

describe('rejectPendingShareSchema', () => {
  it('accepts a normal reason', () => {
    expect(rejectPendingShareSchema.parse({ reason: 'Не согласован с командой' })).toEqual({
      reason: 'Не согласован с командой',
    })
  })

  it('rejects an empty reason with the exact required-reason message', () => {
    // `.toThrow(string)` — substring match against the thrown ZodError's own
    // `.message` — is the established convention for this (see
    // finance.salary-month-gap.spec.ts / teams.spec.ts); a `safeParse` +
    // `if (!result.success)` shape trips `vitest/no-conditional-expect`.
    expect(() => rejectPendingShareSchema.parse({ reason: '' })).toThrow(
      'Причина отказа обязательна',
    )
  })

  it('rejects a whitespace-only reason (trimmed before the min-length check)', () => {
    expect(() => rejectPendingShareSchema.parse({ reason: '   ' })).toThrow(
      'Причина отказа обязательна',
    )
  })

  it('accepts a reason exactly 500 characters long', () => {
    const reason = 'x'.repeat(500)
    expect(rejectPendingShareSchema.parse({ reason }).reason).toHaveLength(500)
  })

  it('rejects a reason of 501 characters with the exact too-long message', () => {
    const reason = 'x'.repeat(501)
    expect(() => rejectPendingShareSchema.parse({ reason })).toThrow(
      'Причина отказа слишком длинная (максимум 500 символов)',
    )
  })
})
