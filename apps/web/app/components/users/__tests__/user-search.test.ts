/**
 * SPEC-M-1: the users-list search matches a SENIOR's technical roles — both the stored key
 * and the localized label the row renders — alongside the pre-existing fields.
 */

import { describe, expect, it } from 'vitest'
import { TECHNICAL_ROLE_LABELS, type TechnicalRole } from '@crm/shared'
import { matchesUserQuery, type UserSearchable } from '../constants'

// The uk catalog is the msgid source, so the descriptor's own `message` is the uk label.
const ukLabel = (role: TechnicalRole) => TECHNICAL_ROLE_LABELS[role].message ?? role

const senior = (overrides: Partial<UserSearchable> = {}): UserSearchable => ({
  displayName: 'Petro Senior',
  email: 'petro@cheekycheese.dev',
  telegram: '@petro',
  techStack: ['Go'],
  technicalRoles: ['BACKEND_ENGINEER'],
  ...overrides,
})

describe('matchesUserQuery', () => {
  it('matches the stored technical-role key', () => {
    expect(matchesUserQuery(senior(), 'backend_eng', ukLabel)).toBe(true)
  })

  it('matches the localized technical-role label the row renders', () => {
    // A stub resolver, not the catalog: its text shares nothing with the key, so a match can only
    // have come from the label clause. (With the real uk label, a prefix of it can also be a
    // substring of the key, and the test would pass with the label clause deleted.)
    const stub = () => 'Ляльковий підпис'
    expect(matchesUserQuery(senior(), 'ляльковий підпис', stub)).toBe(true)
    expect(matchesUserQuery(senior(), 'ляльковий підпис', ukLabel)).toBe(false)
    // and the real catalog label the row actually renders matches too
    expect(matchesUserQuery(senior(), ukLabel('BACKEND_ENGINEER'), ukLabel)).toBe(true)
  })

  it('does not match a role the user does not hold', () => {
    expect(matchesUserQuery(senior(), 'qa_engineer', ukLabel)).toBe(false)
    expect(matchesUserQuery(senior(), ukLabel('QA_ENGINEER'), ukLabel)).toBe(false)
  })

  it('keeps matching the pre-existing fields', () => {
    const u = senior({ technicalRoles: [] })
    expect(matchesUserQuery(u, 'petro senior', ukLabel)).toBe(true)
    expect(matchesUserQuery(u, 'PETRO@CHEEKY', ukLabel)).toBe(true)
    expect(matchesUserQuery(u, '@petr', ukLabel)).toBe(true)
    expect(matchesUserQuery(u, 'go', ukLabel)).toBe(true)
    expect(matchesUserQuery(u, 'rust', ukLabel)).toBe(false)
  })

  it('searches every entry of a multi-item techStack', () => {
    const u = senior({ techStack: ['Go', 'PostgreSQL'], technicalRoles: [] })
    expect(matchesUserQuery(u, 'postgres', ukLabel)).toBe(true)
    // the ', ' the join inserts is not itself matchable content
    expect(matchesUserQuery(u, 'go, postgresql', ukLabel)).toBe(true)
  })

  it('an empty or whitespace-only query matches everyone', () => {
    expect(matchesUserQuery(senior(), '', ukLabel)).toBe(true)
    expect(matchesUserQuery(senior(), '   ', ukLabel)).toBe(true)
  })

  it('tolerates the null/absent shapes the DTO allows', () => {
    const bare: UserSearchable = {
      displayName: 'Nobody',
      email: 'nobody@cheekycheese.dev',
      telegram: null,
      techStack: null,
      technicalRoles: [],
    }
    expect(matchesUserQuery(bare, 'backend', ukLabel)).toBe(false)
    expect(matchesUserQuery(bare, 'nobody', ukLabel)).toBe(true)
  })
})
