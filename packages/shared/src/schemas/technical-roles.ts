/**
 * Technical roles: a fixed list of 34 functions a vacancy hires for and a senior can be swapped
 * into (research `docs/architecture/research/2026-11-16-it-role-taxonomy.md` §1). Technology and
 * seniority are separate axes. Ids are stable: deprecate one, never rename it.
 */
import { z } from 'zod'

/** The 34 roles, in research §1.1–§1.11 order. This order is the canonical sort order. */
export const TECHNICAL_ROLES = [
  // SOFTWARE_ENGINEERING
  'SOFTWARE_ENGINEER',
  'BACKEND_ENGINEER',
  'FRONTEND_ENGINEER',
  'FULLSTACK_ENGINEER',
  'DESKTOP_ENGINEER',
  'BUSINESS_APPLICATIONS_ENGINEER',
  // MOBILE
  'IOS_ENGINEER',
  'ANDROID_ENGINEER',
  'CROSS_PLATFORM_MOBILE_ENGINEER',
  // DATA_AI
  'DATA_ENGINEER',
  'DATABASE_ENGINEER',
  'DATA_ANALYST',
  'DATA_SCIENTIST',
  'ML_ENGINEER',
  'AI_ENGINEER',
  // INFRASTRUCTURE_OPERATIONS
  'DEVOPS_ENGINEER',
  'SITE_RELIABILITY_ENGINEER',
  'SYSTEM_ADMINISTRATOR',
  'NETWORK_ENGINEER',
  'SUPPORT_ENGINEER',
  // QUALITY_ASSURANCE
  'QA_ENGINEER',
  'QA_AUTOMATION_ENGINEER',
  // SECURITY
  'SECURITY_ENGINEER',
  'SECURITY_ANALYST',
  'PENETRATION_TESTER',
  // EMBEDDED_HARDWARE
  'EMBEDDED_ENGINEER',
  'HARDWARE_ENGINEER',
  // GAME
  'GAME_DEVELOPER',
  // BLOCKCHAIN
  'BLOCKCHAIN_ENGINEER',
  // ARCHITECTURE_LEADERSHIP
  'SOFTWARE_ARCHITECT',
  'ENGINEERING_MANAGER',
  'CTO',
  // ADJACENT_ANALYSIS_DESIGN
  'BUSINESS_ANALYST',
  'UI_UX_DESIGNER',
] as const

export type TechnicalRole = (typeof TECHNICAL_ROLES)[number]

export const TECHNICAL_ROLE_GROUP_IDS = [
  'SOFTWARE_ENGINEERING',
  'MOBILE',
  'DATA_AI',
  'INFRASTRUCTURE_OPERATIONS',
  'QUALITY_ASSURANCE',
  'SECURITY',
  'EMBEDDED_HARDWARE',
  'GAME',
  'BLOCKCHAIN',
  'ARCHITECTURE_LEADERSHIP',
  'ADJACENT_ANALYSIS_DESIGN',
] as const

export type TechnicalRoleGroup = (typeof TECHNICAL_ROLE_GROUP_IDS)[number]

export const TECHNICAL_ROLE_GROUPS: readonly {
  id: TechnicalRoleGroup
  roles: readonly TechnicalRole[]
}[] = [
  {
    id: 'SOFTWARE_ENGINEERING',
    roles: [
      'SOFTWARE_ENGINEER',
      'BACKEND_ENGINEER',
      'FRONTEND_ENGINEER',
      'FULLSTACK_ENGINEER',
      'DESKTOP_ENGINEER',
      'BUSINESS_APPLICATIONS_ENGINEER',
    ],
  },
  { id: 'MOBILE', roles: ['IOS_ENGINEER', 'ANDROID_ENGINEER', 'CROSS_PLATFORM_MOBILE_ENGINEER'] },
  {
    id: 'DATA_AI',
    roles: [
      'DATA_ENGINEER',
      'DATABASE_ENGINEER',
      'DATA_ANALYST',
      'DATA_SCIENTIST',
      'ML_ENGINEER',
      'AI_ENGINEER',
    ],
  },
  {
    id: 'INFRASTRUCTURE_OPERATIONS',
    roles: [
      'DEVOPS_ENGINEER',
      'SITE_RELIABILITY_ENGINEER',
      'SYSTEM_ADMINISTRATOR',
      'NETWORK_ENGINEER',
      'SUPPORT_ENGINEER',
    ],
  },
  { id: 'QUALITY_ASSURANCE', roles: ['QA_ENGINEER', 'QA_AUTOMATION_ENGINEER'] },
  { id: 'SECURITY', roles: ['SECURITY_ENGINEER', 'SECURITY_ANALYST', 'PENETRATION_TESTER'] },
  { id: 'EMBEDDED_HARDWARE', roles: ['EMBEDDED_ENGINEER', 'HARDWARE_ENGINEER'] },
  { id: 'GAME', roles: ['GAME_DEVELOPER'] },
  { id: 'BLOCKCHAIN', roles: ['BLOCKCHAIN_ENGINEER'] },
  { id: 'ARCHITECTURE_LEADERSHIP', roles: ['SOFTWARE_ARCHITECT', 'ENGINEERING_MANAGER', 'CTO'] },
  { id: 'ADJACENT_ANALYSIS_DESIGN', roles: ['BUSINESS_ANALYST', 'UI_UX_DESIGNER'] },
]

/** `SOFTWARE_ENGINEER` is the vacancy-only fallback: every senior has a real function. */
export const SENIOR_SELECTABLE_ROLES = TECHNICAL_ROLES.filter(
  (role): role is Exclude<TechnicalRole, 'SOFTWARE_ENGINEER'> => role !== 'SOFTWARE_ENGINEER',
)

export type SeniorSelectableRole = Exclude<TechnicalRole, 'SOFTWARE_ENGINEER'>

export const technicalRoleSchema = z.enum(TECHNICAL_ROLES)
export const seniorSelectableRoleSchema = z.enum(
  SENIOR_SELECTABLE_ROLES as [SeniorSelectableRole, ...SeniorSelectableRole[]],
)

/** Sorts roles into `TECHNICAL_ROLES` order (a stable, comparable form for storage and digests). */
export function sortRoles<R extends TechnicalRole>(roles: readonly R[]): R[] {
  return [...roles].sort((a, b) => TECHNICAL_ROLES.indexOf(a) - TECHNICAL_ROLES.indexOf(b))
}

/** A senior's roles: 1..N distinct selectable roles, output in `TECHNICAL_ROLES` order. */
export const seniorRolesSchema = z
  .array(seniorSelectableRoleSchema)
  .min(1, 'zod.SENIOR_MIN_ROLES')
  // No coded message: the role picker cannot produce a duplicate, only a hand-made API call can.
  .refine((roles) => new Set(roles).size === roles.length)
  .transform((roles) => sortRoles(roles))

/**
 * Senior role -> the vacancy roles it also sees: the spec's "Widening matrix", copied literally.
 * One hop, non-transitive: a pair not listed here is a deliberate non-match.
 */
export const ROLE_WIDENING: Readonly<Record<SeniorSelectableRole, readonly TechnicalRole[]>> = {
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

/** The senior's own roles plus one hop of `ROLE_WIDENING` (never applied twice). */
export function widenRoles(roles: readonly SeniorSelectableRole[]): ReadonlySet<TechnicalRole> {
  return new Set<TechnicalRole>([...roles, ...roles.flatMap((role) => ROLE_WIDENING[role])])
}

/**
 * The vacancy roles a senior sees. `widened` is true only when something matched and none of it
 * is one of the senior's own roles.
 */
export function rolesMatch(
  senior: readonly SeniorSelectableRole[],
  vacancy: readonly TechnicalRole[],
): { matched: readonly TechnicalRole[]; widened: boolean } {
  const widened = widenRoles(senior)
  const own = new Set<TechnicalRole>(senior)
  const matched = vacancy.filter((role) => widened.has(role))
  return { matched, widened: matched.length > 0 && !matched.some((role) => own.has(role)) }
}
