import { describe, expect, it } from 'vitest'
import { actionKeySchema, tabKeySchema, viewPermissionsSchema } from './view-permissions'

// task-user-emails-invite: `actionKeySchema` had ZERO test coverage before
// this file — the mutation gate caught it immediately (`--changed` on
// packages/shared): a StringLiteral mutant replacing
// `'resend-personal-invite'` with `""` survived every existing test in this
// package, because nothing anywhere asserts this specific enum member
// exists. Pin every current member individually (not just one) so a future
// typo'd or emptied literal in ANY of them is caught the same way.
describe('actionKeySchema — every member is a real, distinct literal', () => {
  const MEMBERS = [
    'edit-profile',
    'change-role',
    'change-salary',
    'change-requisites',
    'set-note',
    'archive',
    'resend-personal-invite',
    'change-personal-email',
  ] as const

  it.each(MEMBERS)('accepts %s', (member) => {
    expect(actionKeySchema.parse(member)).toBe(member)
  })

  it('rejects an empty string (the exact shape a StringLiteral mutant produces)', () => {
    expect(actionKeySchema.safeParse('').success).toBe(false)
  })

  it('rejects a value not in the enum', () => {
    expect(actionKeySchema.safeParse('reassign-project').success).toBe(false)
  })

  it('has exactly the members above — nothing added or removed silently', () => {
    expect(actionKeySchema.options).toEqual(MEMBERS)
  })
})

describe('viewPermissionsSchema — smoke', () => {
  it('parses a realistic ADMIN-viewing-JUNIOR permissions payload', () => {
    const parsed = viewPermissionsSchema.parse({
      tabs: ['overview', 'requisites'],
      actions: ['edit-profile', 'resend-personal-invite'],
      fields: { realContacts: true, personalContact: false },
    })
    expect(parsed.actions).toContain('resend-personal-invite')
    expect(tabKeySchema.parse('overview')).toBe('overview')
  })
})
