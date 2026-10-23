import { describe, expect, it } from 'vitest'

import { interviewCallKeyIsSet } from './interviews.service'

/**
 * `interviewCallKeyIsSet` decides whether creating an interview writes an
 * `interview-call-changed` audit row (SR-865-H-1). In `create` that decision is
 * only visible as a row in the audit table, i.e. integration-only — see
 * `.claude/rules/common/mutation-gate-integration-specs.md`. The predicate is
 * pure, so the truth table belongs here.
 */
describe('interviewCallKeyIsSet', () => {
  const when = new Date('2026-10-07T12:00:00.000Z')

  it('is true when either half of the auto-match key is present', () => {
    expect(
      interviewCallKeyIsSet({ callUrl: 'https://meet.google.com/abc', scheduledAt: null }),
    ).toBe(true)
    expect(interviewCallKeyIsSet({ callUrl: null, scheduledAt: when })).toBe(true)
    expect(
      interviewCallKeyIsSet({ callUrl: 'https://meet.google.com/abc', scheduledAt: when }),
    ).toBe(true)
  })

  it('is false only when neither half is present', () => {
    expect(interviewCallKeyIsSet({ callUrl: null, scheduledAt: null })).toBe(false)
  })

  it('treats an empty call URL as present (it is still a written value)', () => {
    expect(interviewCallKeyIsSet({ callUrl: '', scheduledAt: null })).toBe(true)
  })
})
