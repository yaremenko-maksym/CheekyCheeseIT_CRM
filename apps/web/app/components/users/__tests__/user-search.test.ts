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
    const label = ukLabel('BACKEND_ENGINEER')
    expect(label).not.toBe('BACKEND_ENGINEER')
    expect(matchesUserQuery(senior(), label.slice(0, 5), ukLabel)).toBe(true)
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
