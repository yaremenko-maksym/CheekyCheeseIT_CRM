/**
 * Technical roles: a fixed list of 34 functions a vacancy hires for and a senior can be swapped
 * into (research `docs/architecture/research/2026-11-16-it-role-taxonomy.md` §1). Technology and
 * seniority are separate axes. Ids are stable: deprecate one, never rename it.
 */
import type { MessageDescriptor } from '@lingui/core'
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

/* eslint-disable lingui/no-unlocalized-strings --
   label descriptor registry — `message:` literals are the i18n source (read by `lingui extract`).
   Block-scoped so the schemas above stay checked. */
/**
 * Role labels. The uk text is the research §1 "UK (proposed)" column; the en text lives in the en
 * catalog. Every uk label is a proposal that goes through copy-reviewer.
 */
export const TECHNICAL_ROLE_LABELS: Record<TechnicalRole, MessageDescriptor> = {
  SOFTWARE_ENGINEER: /* i18n */ {
    id: 'technical-role.SOFTWARE_ENGINEER',
    message: 'Інженер-програміст (без спеціалізації)',
  },
  BACKEND_ENGINEER: /* i18n */ {
    id: 'technical-role.BACKEND_ENGINEER',
    message: 'Бекенд-розробник',
  },
  FRONTEND_ENGINEER: /* i18n */ {
    id: 'technical-role.FRONTEND_ENGINEER',
    message: 'Фронтенд-розробник',
  },
  FULLSTACK_ENGINEER: /* i18n */ {
    id: 'technical-role.FULLSTACK_ENGINEER',
    message: 'Фулстек-розробник',
  },
  DESKTOP_ENGINEER: /* i18n */ {
    id: 'technical-role.DESKTOP_ENGINEER',
    message: 'Розробник десктопних застосунків',
  },
  BUSINESS_APPLICATIONS_ENGINEER: /* i18n */ {
    id: 'technical-role.BUSINESS_APPLICATIONS_ENGINEER',
    message: 'Розробник ERP/CRM та low-code-платформ',
  },
  IOS_ENGINEER: /* i18n */ { id: 'technical-role.IOS_ENGINEER', message: 'iOS-розробник' },
  ANDROID_ENGINEER: /* i18n */ {
    id: 'technical-role.ANDROID_ENGINEER',
    message: 'Android-розробник',
  },
  CROSS_PLATFORM_MOBILE_ENGINEER: /* i18n */ {
    id: 'technical-role.CROSS_PLATFORM_MOBILE_ENGINEER',
    message: 'Крос-платформний мобільний розробник',
  },
  DATA_ENGINEER: /* i18n */ { id: 'technical-role.DATA_ENGINEER', message: 'Інженер даних' },
  DATABASE_ENGINEER: /* i18n */ {
    id: 'technical-role.DATABASE_ENGINEER',
    message: 'Інженер баз даних (DBA)',
  },
  DATA_ANALYST: /* i18n */ { id: 'technical-role.DATA_ANALYST', message: 'Аналітик даних / BI' },
  DATA_SCIENTIST: /* i18n */ {
    id: 'technical-role.DATA_SCIENTIST',
    message: 'Data Scientist',
  },
  ML_ENGINEER: /* i18n */ {
    id: 'technical-role.ML_ENGINEER',
    message: 'Інженер машинного навчання',
  },
  AI_ENGINEER: /* i18n */ {
    id: 'technical-role.AI_ENGINEER',
    message: 'AI-інженер (LLM-застосунки)',
  },
  DEVOPS_ENGINEER: /* i18n */ {
    id: 'technical-role.DEVOPS_ENGINEER',
    message: 'DevOps / Platform-інженер',
  },
  SITE_RELIABILITY_ENGINEER: /* i18n */ {
    id: 'technical-role.SITE_RELIABILITY_ENGINEER',
    message: 'Інженер з надійності (SRE)',
  },
  SYSTEM_ADMINISTRATOR: /* i18n */ {
    id: 'technical-role.SYSTEM_ADMINISTRATOR',
    message: 'Системний адміністратор',
  },
  NETWORK_ENGINEER: /* i18n */ {
    id: 'technical-role.NETWORK_ENGINEER',
    message: 'Мережевий інженер',
  },
  SUPPORT_ENGINEER: /* i18n */ {
    id: 'technical-role.SUPPORT_ENGINEER',
    message: 'Інженер технічної підтримки (L2/L3)',
  },
  QA_ENGINEER: /* i18n */ {
    id: 'technical-role.QA_ENGINEER',
    message: 'QA-інженер (мануальне тестування)',
  },
  QA_AUTOMATION_ENGINEER: /* i18n */ {
    id: 'technical-role.QA_AUTOMATION_ENGINEER',
    message: 'QA Automation-інженер (SDET)',
  },
  SECURITY_ENGINEER: /* i18n */ {
    id: 'technical-role.SECURITY_ENGINEER',
    message: 'Інженер з кібербезпеки',
  },
  SECURITY_ANALYST: /* i18n */ {
    id: 'technical-role.SECURITY_ANALYST',
    message: 'Аналітик з кібербезпеки (SOC / IR / GRC)',
  },
  PENETRATION_TESTER: /* i18n */ { id: 'technical-role.PENETRATION_TESTER', message: 'Пентестер' },
  EMBEDDED_ENGINEER: /* i18n */ {
    id: 'technical-role.EMBEDDED_ENGINEER',
    message: 'Розробник вбудованих систем',
  },
  HARDWARE_ENGINEER: /* i18n */ {
    id: 'technical-role.HARDWARE_ENGINEER',
    message: 'Інженер апаратного забезпечення',
  },
  GAME_DEVELOPER: /* i18n */ {
    id: 'technical-role.GAME_DEVELOPER',
    message: 'Розробник ігор і графіки',
  },
  BLOCKCHAIN_ENGINEER: /* i18n */ {
    id: 'technical-role.BLOCKCHAIN_ENGINEER',
    message: 'Блокчейн / Web3-розробник',
  },
  SOFTWARE_ARCHITECT: /* i18n */ {
    id: 'technical-role.SOFTWARE_ARCHITECT',
    message: 'Архітектор ПЗ / рішень',
  },
  ENGINEERING_MANAGER: /* i18n */ {
    id: 'technical-role.ENGINEERING_MANAGER',
    message: 'Керівник розробки (Engineering Manager)',
  },
  CTO: /* i18n */ { id: 'technical-role.CTO', message: 'Технічний директор (CTO)' },
  BUSINESS_ANALYST: /* i18n */ {
    id: 'technical-role.BUSINESS_ANALYST',
    message: 'Бізнес- / системний аналітик (IT)',
  },
  UI_UX_DESIGNER: /* i18n */ {
    id: 'technical-role.UI_UX_DESIGNER',
    message: 'Продуктовий дизайнер (UI/UX)',
  },
}

/** Group labels. The uk group names are authored here (research has none): copy-reviewer. */
export const TECHNICAL_ROLE_GROUP_LABELS: Record<TechnicalRoleGroup, MessageDescriptor> = {
  SOFTWARE_ENGINEERING: /* i18n */ {
    id: 'technical-role-group.SOFTWARE_ENGINEERING',
    message: 'Розробка ПЗ',
  },
  MOBILE: /* i18n */ { id: 'technical-role-group.MOBILE', message: 'Мобільна розробка' },
  DATA_AI: /* i18n */ { id: 'technical-role-group.DATA_AI', message: 'Дані та ШІ' },
  INFRASTRUCTURE_OPERATIONS: /* i18n */ {
    id: 'technical-role-group.INFRASTRUCTURE_OPERATIONS',
    message: 'Інфраструктура та експлуатація',
  },
  QUALITY_ASSURANCE: /* i18n */ {
    id: 'technical-role-group.QUALITY_ASSURANCE',
    message: 'Забезпечення якості',
  },
  SECURITY: /* i18n */ { id: 'technical-role-group.SECURITY', message: 'Безпека' },
  EMBEDDED_HARDWARE: /* i18n */ {
    id: 'technical-role-group.EMBEDDED_HARDWARE',
    message: 'Вбудовані та апаратні системи',
  },
  GAME: /* i18n */ { id: 'technical-role-group.GAME', message: 'Ігри та графіка' },
  BLOCKCHAIN: /* i18n */ { id: 'technical-role-group.BLOCKCHAIN', message: 'Блокчейн' },
  ARCHITECTURE_LEADERSHIP: /* i18n */ {
    id: 'technical-role-group.ARCHITECTURE_LEADERSHIP',
    message: 'Архітектура та технічне лідерство',
  },
  ADJACENT_ANALYSIS_DESIGN: /* i18n */ {
    id: 'technical-role-group.ADJACENT_ANALYSIS_DESIGN',
    message: 'Аналітика та продуктовий дизайн',
  },
}
/* eslint-enable lingui/no-unlocalized-strings */
