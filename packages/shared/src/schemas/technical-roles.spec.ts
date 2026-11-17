import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/catalog'
import {
  ROLE_WIDENING,
  SENIOR_SELECTABLE_ROLES,
  TECHNICAL_ROLE_GROUP_LABELS,
  TECHNICAL_ROLE_GROUPS,
  TECHNICAL_ROLE_LABELS,
  TECHNICAL_ROLES,
  rolesMatch,
  seniorRolesSchema,
  technicalRoleSchema,
  widenRoles,
} from './technical-roles'

/**
 * A literal copy of the spec's "Widening matrix" (senior role -> also sees), typed by hand.
 * Never import or derive it: an edit to `ROLE_WIDENING` that does not also edit this table fails.
 */
const SPEC_MATRIX: Record<string, string[]> = {
  BACKEND_ENGINEER: ['FULLSTACK_ENGINEER', 'SOFTWARE_ENGINEER'],
  FRONTEND_ENGINEER: ['FULLSTACK_ENGINEER', 'SOFTWARE_ENGINEER'],
  FULLSTACK_ENGINEER: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'SOFTWARE_ENGINEER'],
  DESKTOP_ENGINEER: ['SOFTWARE_ENGINEER'],
  BUSINESS_APPLICATIONS_ENGINEER: ['SOFTWARE_ENGINEER'],
  IOS_ENGINEER: ['CROSS_PLATFORM_MOBILE_ENGINEER', 'SOFTWARE_ENGINEER'],
  ANDROID_ENGINEER: ['CROSS_PLATFORM_MOBILE_ENGINEER', 'SOFTWARE_ENGINEER'],
  CROSS_PLATFORM_MOBILE_ENGINEER: ['IOS_ENGINEER', 'ANDROID_ENGINEER', 'SOFTWARE_ENGINEER'],
  GAME_DEVELOPER: ['SOFTWARE_ENGINEER'],
  BLOCKCHAIN_ENGINEER: ['SOFTWARE_ENGINEER'],
  EMBEDDED_ENGINEER: ['HARDWARE_ENGINEER', 'SOFTWARE_ENGINEER'],
  HARDWARE_ENGINEER: ['EMBEDDED_ENGINEER'],
  DATA_ENGINEER: ['DATABASE_ENGINEER'],
  DATABASE_ENGINEER: ['DATA_ENGINEER'],
  DATA_ANALYST: [],
  DATA_SCIENTIST: ['ML_ENGINEER', 'AI_ENGINEER'],
  ML_ENGINEER: ['DATA_SCIENTIST', 'AI_ENGINEER'],
  AI_ENGINEER: ['ML_ENGINEER', 'DATA_SCIENTIST'],
  DEVOPS_ENGINEER: ['SITE_RELIABILITY_ENGINEER'],
  SITE_RELIABILITY_ENGINEER: ['DEVOPS_ENGINEER'],
  SYSTEM_ADMINISTRATOR: [],
  NETWORK_ENGINEER: [],
  SUPPORT_ENGINEER: [],
  QA_ENGINEER: ['QA_AUTOMATION_ENGINEER'],
  QA_AUTOMATION_ENGINEER: ['QA_ENGINEER'],
  SECURITY_ENGINEER: ['SECURITY_ANALYST', 'PENETRATION_TESTER'],
  SECURITY_ANALYST: ['SECURITY_ENGINEER'],
  PENETRATION_TESTER: ['SECURITY_ENGINEER'],
  SOFTWARE_ARCHITECT: [],
  ENGINEERING_MANAGER: [],
  CTO: [],
  BUSINESS_ANALYST: [],
  UI_UX_DESIGNER: [],
}

describe('technical roles', () => {
  it('has 34 roles in 11 groups, each role in exactly one group', () => {
    expect(TECHNICAL_ROLES).toHaveLength(34)
    expect(new Set(TECHNICAL_ROLES).size).toBe(34)
    expect(TECHNICAL_ROLE_GROUPS).toHaveLength(11)
    expect(TECHNICAL_ROLE_GROUPS.flatMap((g) => g.roles).sort()).toEqual(
      [...TECHNICAL_ROLES].sort(),
    )
  })

  it('groups follow the research headings in order, with the research role counts', () => {
    expect(TECHNICAL_ROLE_GROUPS.map((g) => [g.id, g.roles.length])).toEqual([
      ['SOFTWARE_ENGINEERING', 6],
      ['MOBILE', 3],
      ['DATA_AI', 6],
      ['INFRASTRUCTURE_OPERATIONS', 5],
      ['QUALITY_ASSURANCE', 2],
      ['SECURITY', 3],
      ['EMBEDDED_HARDWARE', 2],
      ['GAME', 1],
      ['BLOCKCHAIN', 1],
      ['ARCHITECTURE_LEADERSHIP', 3],
      ['ADJACENT_ANALYSIS_DESIGN', 2],
    ])
    // The enum order is the group order flattened.
    expect(TECHNICAL_ROLE_GROUPS.flatMap((g) => g.roles)).toEqual([...TECHNICAL_ROLES])
    expect(TECHNICAL_ROLES[0]).toBe('SOFTWARE_ENGINEER')
    expect(TECHNICAL_ROLES[33]).toBe('UI_UX_DESIGNER')
  })

  it('SOFTWARE_ENGINEER is vacancy-only', () => {
    expect(SENIOR_SELECTABLE_ROLES).toHaveLength(33)
    expect(SENIOR_SELECTABLE_ROLES).not.toContain('SOFTWARE_ENGINEER')
    expect(technicalRoleSchema.safeParse('SOFTWARE_ENGINEER').success).toBe(true)
    expect(seniorRolesSchema.safeParse(['SOFTWARE_ENGINEER']).success).toBe(false)
  })

  it('technicalRoleSchema refuses an id outside the list', () => {
    expect(technicalRoleSchema.safeParse('PROJECT_MANAGER').success).toBe(false)
  })

  it('seniorRolesSchema refuses [] with zod.SENIOR_MIN_ROLES and duplicates', () => {
    const empty = seniorRolesSchema.safeParse([])
    expect(empty.success).toBe(false)
    expect(empty.error?.issues[0]?.message).toBe('zod.SENIOR_MIN_ROLES')
    expect(seniorRolesSchema.safeParse(['QA_ENGINEER', 'QA_ENGINEER']).success).toBe(false)
    expect(seniorRolesSchema.safeParse(['QA_ENGINEER']).success).toBe(true)
  })

  it('seniorRolesSchema sorts to TECHNICAL_ROLES order', () => {
    expect(seniorRolesSchema.parse(['FRONTEND_ENGINEER', 'BACKEND_ENGINEER'])).toEqual([
      'BACKEND_ENGINEER',
      'FRONTEND_ENGINEER',
    ])
    expect(seniorRolesSchema.parse(['CTO', 'IOS_ENGINEER', 'DATA_ENGINEER'])).toEqual([
      'IOS_ENGINEER',
      'DATA_ENGINEER',
      'CTO',
    ])
  })

  it('widening is one-hop, non-transitive', () => {
    expect(widenRoles(['BACKEND_ENGINEER']).has('FULLSTACK_ENGINEER')).toBe(true)
    expect(widenRoles(['BACKEND_ENGINEER']).has('FRONTEND_ENGINEER')).toBe(false)
    expect(widenRoles(['HARDWARE_ENGINEER']).has('SOFTWARE_ENGINEER')).toBe(false)
    expect([...widenRoles(['CTO'])]).toEqual(['CTO'])
    expect([...widenRoles(['DATA_ENGINEER', 'QA_ENGINEER'])].sort()).toEqual([
      'DATABASE_ENGINEER',
      'DATA_ENGINEER',
      'QA_AUTOMATION_ENGINEER',
      'QA_ENGINEER',
    ])
  })

  it('ROLE_WIDENING has a row for every selectable role and nothing else', () => {
    expect(Object.keys(ROLE_WIDENING).sort()).toEqual([...SENIOR_SELECTABLE_ROLES].sort())
    expect(Object.keys(SPEC_MATRIX).sort()).toEqual([...SENIOR_SELECTABLE_ROLES].sort())
  })

  it.each(Object.entries(SPEC_MATRIX))('row %s matches the spec matrix exactly', (role, sees) => {
    expect([...ROLE_WIDENING[role as keyof typeof ROLE_WIDENING]].sort()).toEqual([...sees].sort())
  })

  it('rolesMatch reports widened only when no exact role matched', () => {
    expect(rolesMatch(['BACKEND_ENGINEER'], ['FULLSTACK_ENGINEER'])).toEqual({
      matched: ['FULLSTACK_ENGINEER'],
      widened: true,
    })
    expect(rolesMatch(['BACKEND_ENGINEER'], ['BACKEND_ENGINEER', 'FULLSTACK_ENGINEER'])).toEqual({
      matched: ['BACKEND_ENGINEER', 'FULLSTACK_ENGINEER'],
      widened: false,
    })
    expect(rolesMatch(['QA_ENGINEER'], ['DATA_ANALYST']).matched).toEqual([])
  })

  it('rolesMatch on an empty match is { matched: [], widened: false }', () => {
    expect(rolesMatch(['QA_ENGINEER'], ['DATA_ANALYST'])).toEqual({ matched: [], widened: false })
    expect(rolesMatch(['QA_ENGINEER'], [])).toEqual({ matched: [], widened: false })
  })
})

describe('technical role labels', () => {
  const EN_CATALOG = readFileSync(
    join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po'),
    'utf-8',
  )
  const enText = (id: string) =>
    EN_CATALOG.match(
      new RegExp(`msgid "${id.replace('.', '\\.')}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
    )?.[1]

  it('every role and group has a label descriptor with a stable id', () => {
    expect(Object.keys(TECHNICAL_ROLE_LABELS).sort()).toEqual([...TECHNICAL_ROLES].sort())
    for (const role of TECHNICAL_ROLES) {
      expect(TECHNICAL_ROLE_LABELS[role].id).toBe(`technical-role.${role}`)
      expect(TECHNICAL_ROLE_LABELS[role].message?.length ?? 0).toBeGreaterThan(0)
    }
    expect(Object.keys(TECHNICAL_ROLE_GROUP_LABELS).sort()).toEqual(
      TECHNICAL_ROLE_GROUPS.map((g) => g.id).sort(),
    )
    for (const { id } of TECHNICAL_ROLE_GROUPS) {
      expect(TECHNICAL_ROLE_GROUP_LABELS[id].id).toBe(`technical-role-group.${id}`)
      expect(TECHNICAL_ROLE_GROUP_LABELS[id].message?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every label id has a non-empty en translation in the catalog', () => {
    const ids = [
      ...Object.values(TECHNICAL_ROLE_LABELS),
      ...Object.values(TECHNICAL_ROLE_GROUP_LABELS),
    ].map((d) => d.id)
    expect(ids).toHaveLength(45)
    for (const id of ids) expect(enText(id), id).toMatch(/\S/)
  })

  it('renders the research labels in both locales', () => {
    const uk = createI18n('uk')
    const en = createI18n('en')
    expect(uk._(TECHNICAL_ROLE_LABELS.BACKEND_ENGINEER)).toBe('Бекенд-розробник')
    expect(en._(TECHNICAL_ROLE_LABELS.BACKEND_ENGINEER)).toBe('Back-end Engineer')
    expect(en._(TECHNICAL_ROLE_LABELS.QA_AUTOMATION_ENGINEER)).toBe('QA Automation Engineer / SDET')
    expect(en._(TECHNICAL_ROLE_GROUP_LABELS.DATA_AI)).toBe('Data & AI')
  })
})
