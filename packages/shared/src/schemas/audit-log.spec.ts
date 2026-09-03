import { describe, expect, it } from 'vitest'
import { auditActionSchema } from './audit-log'

// security-review PR #623 round 4 — mutation gate (`--changed`) caught
// `personal_email_invite_resend` / `personal_email_changed` with ZERO test
// coverage: a `StringLiteral` mutant replacing either with `""` survived
// every existing test in this package, because nothing anywhere had ever
// parsed one of these two specific values. This file had NO coverage AT ALL
// before this — every member is pinned individually (not just the two new
// ones) so the same class of gap can't reopen for an older member either.
// Mirrors `view-permissions.spec.ts`'s `actionKeySchema` pattern exactly.
describe('auditActionSchema — every member is a real, distinct literal', () => {
  const MEMBERS = [
    'profile_created',
    'profile_edit',
    'requisites_edit',
    'requisites_read',
    'role_change',
    'salary_change',
    'note_set',
    'team_membership',
    'project_reassignment',
    'user_archived',
    'user_unarchived',
    'legal_name_change',
    'personal_email_invite_resend',
    'personal_email_changed',
  ] as const

  it.each(MEMBERS)('accepts %s', (member) => {
    expect(auditActionSchema.parse(member)).toBe(member)
  })

  it('rejects an empty string (the exact shape a StringLiteral mutant produces)', () => {
    expect(auditActionSchema.safeParse('').success).toBe(false)
  })

  it('rejects a value not in the enum', () => {
    expect(auditActionSchema.safeParse('account_deleted').success).toBe(false)
  })

  it('has exactly the members above — nothing added or removed silently', () => {
    expect(auditActionSchema.options).toEqual(MEMBERS)
  })
})
