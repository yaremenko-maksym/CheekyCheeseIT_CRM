import type { TechnicalRole } from '../schemas/technical-roles'

/**
 * Deep links into job sites the collector can never connect to (no feed, or the owner refused us
 * access). HR opens them in a new tab; nothing here is fetched by the CRM.
 *
 * Every template was checked by hand on 2026-11-24 (one request each): DOU and EU Remote Jobs
 * answer with the filtered list; The Muse reads `q`, `remote` and `posted` (it has no seniority
 * filter); LinkedIn's `f_E` / `f_WT` show only when signed in, so manual QA checks them there.
 * Welcome to the Jungle is left out: its search no longer reads any filter from the URL.
 */

export type ExternalFeedId = 'DOU' | 'LINKEDIN' | 'THE_MUSE' | 'EU_REMOTE_JOBS'

export interface FeedFilters {
  /** The senior's roles; only the first one drives the link. Empty = general filters. */
  roles: readonly TechnicalRole[]
}

export interface ExternalFeed {
  id: ExternalFeedId
  /** Brand name, shown as is in every locale. */
  label: string
  buildUrl: (filters: FeedFilters) => string
}

/** DOU's own `category` list, copied from its vacancy filter. */
export const DOU_CATEGORIES = [
  '.NET', 'Account Manager', 'AI/ML', 'Analyst', 'Android', 'Animator', 'Architect', 'Artist',
  'Assistant', 'Big Data', 'Blockchain', 'C++', 'C-level', 'Copywriter', 'Data Engineer',
  'Data Science', 'DBA', 'Design', 'DevOps', 'Embedded', 'Engineering Manager', 'Erlang', 'ERP/CRM',
  'Finance', 'Flutter', 'Front End', 'Golang', 'Hardware', 'HR', 'iOS/macOS', 'Java', 'Legal',
  'Marketing', 'No-code', 'Node.js', 'Office Manager', 'Other', 'PHP', 'Procurement',
  'Product Manager', 'Project Manager', 'Python', 'QA', 'React Native', 'Ruby', 'Rust', 'Sales',
  'Salesforce', 'SAP', 'Scala', 'Scrum Master', 'Security', 'SEO', 'Support', 'SysAdmin',
  'Technical Writer', 'Unity', 'Unreal Engine', 'Військова справа',
] as const // prettier-ignore

export type DouCategory = (typeof DOU_CATEGORIES)[number]

/** Only roles DOU files under one category; the rest search by keyword. */
export const ROLE_TO_DOU_CATEGORY: Partial<Record<TechnicalRole, DouCategory>> = {
  FRONTEND_ENGINEER: 'Front End',
  BUSINESS_APPLICATIONS_ENGINEER: 'ERP/CRM',
  IOS_ENGINEER: 'iOS/macOS',
  ANDROID_ENGINEER: 'Android',
  DATA_ENGINEER: 'Data Engineer',
  DATABASE_ENGINEER: 'DBA',
  DATA_ANALYST: 'Analyst',
  DATA_SCIENTIST: 'Data Science',
  ML_ENGINEER: 'AI/ML',
  AI_ENGINEER: 'AI/ML',
  DEVOPS_ENGINEER: 'DevOps',
  SITE_RELIABILITY_ENGINEER: 'DevOps',
  SYSTEM_ADMINISTRATOR: 'SysAdmin',
  SUPPORT_ENGINEER: 'Support',
  QA_ENGINEER: 'QA',
  QA_AUTOMATION_ENGINEER: 'QA',
  SECURITY_ENGINEER: 'Security',
  SECURITY_ANALYST: 'Security',
  PENETRATION_TESTER: 'Security',
  EMBEDDED_ENGINEER: 'Embedded',
  HARDWARE_ENGINEER: 'Hardware',
  BLOCKCHAIN_ENGINEER: 'Blockchain',
  SOFTWARE_ARCHITECT: 'Architect',
  ENGINEERING_MANAGER: 'Engineering Manager',
  CTO: 'C-level',
  BUSINESS_ANALYST: 'Analyst',
  UI_UX_DESIGNER: 'Design',
}

/** English search words per role: the role labels are localized, the job sites search in English. */
export const FEED_KEYWORDS: Record<TechnicalRole, string> = {
  SOFTWARE_ENGINEER: 'software engineer',
  BACKEND_ENGINEER: 'backend engineer',
  FRONTEND_ENGINEER: 'frontend engineer',
  FULLSTACK_ENGINEER: 'full stack engineer',
  DESKTOP_ENGINEER: 'desktop developer',
  BUSINESS_APPLICATIONS_ENGINEER: 'erp developer',
  IOS_ENGINEER: 'ios engineer',
  ANDROID_ENGINEER: 'android engineer',
  CROSS_PLATFORM_MOBILE_ENGINEER: 'mobile engineer',
  DATA_ENGINEER: 'data engineer',
  DATABASE_ENGINEER: 'database engineer',
  DATA_ANALYST: 'data analyst',
  DATA_SCIENTIST: 'data scientist',
  ML_ENGINEER: 'machine learning engineer',
  AI_ENGINEER: 'ai engineer',
  DEVOPS_ENGINEER: 'devops engineer',
  SITE_RELIABILITY_ENGINEER: 'site reliability engineer',
  SYSTEM_ADMINISTRATOR: 'system administrator',
  NETWORK_ENGINEER: 'network engineer',
  SUPPORT_ENGINEER: 'support engineer',
  QA_ENGINEER: 'qa engineer',
  QA_AUTOMATION_ENGINEER: 'qa automation engineer',
  SECURITY_ENGINEER: 'security engineer',
  SECURITY_ANALYST: 'security analyst',
  PENETRATION_TESTER: 'penetration tester',
  EMBEDDED_ENGINEER: 'embedded engineer',
  HARDWARE_ENGINEER: 'hardware engineer',
  GAME_DEVELOPER: 'game developer',
  BLOCKCHAIN_ENGINEER: 'blockchain engineer',
  SOFTWARE_ARCHITECT: 'software architect',
  ENGINEERING_MANAGER: 'engineering manager',
  CTO: 'cto',
  BUSINESS_ANALYST: 'business analyst',
  UI_UX_DESIGNER: 'ui/ux designer',
}

const enc = encodeURIComponent

/** `?a=1&b` from pairs; a `null` value is a bare flag, an `undefined` one is left out. */
function query(pairs: [string, string | null | undefined][]): string {
  const parts = pairs.flatMap(([k, v]) =>
    v === undefined ? [] : [v === null ? k : `${k}=${enc(v)}`],
  )
  return parts.length ? `?${parts.join('&')}` : ''
}

function keyword(filters: FeedFilters): string | undefined {
  const role = filters.roles[0]
  // Stryker disable next-line ConditionalExpression: equivalent, indexing the map with undefined also gives undefined
  return role === undefined ? undefined : FEED_KEYWORDS[role]
}

function douUrl(filters: FeedFilters): string {
  const role = filters.roles[0]
  // Stryker disable next-line ConditionalExpression: equivalent, indexing the map with undefined also gives undefined
  const category = role === undefined ? undefined : ROLE_TO_DOU_CATEGORY[role]
  const search = category === undefined ? keyword(filters) : undefined
  return `https://jobs.dou.ua/vacancies/${query([
    ['category', category],
    ['search', search],
    ['exp', '5plus'],
    ['remote', null],
  ])}`
}

export const EXTERNAL_FEEDS: readonly ExternalFeed[] = [
  { id: 'DOU', label: 'DOU', buildUrl: douUrl },
  {
    id: 'LINKEDIN',
    label: 'LinkedIn',
    // f_E=4 mid-senior, f_WT=2 remote, sortBy=DD newest first
    buildUrl: (f) =>
      `https://www.linkedin.com/jobs/search/${query([
        ['keywords', keyword(f)],
        ['f_E', '4'],
        ['f_WT', '2'],
        ['sortBy', 'DD'],
      ])}`,
  },
  {
    id: 'THE_MUSE',
    label: 'The Muse',
    buildUrl: (f) =>
      `https://www.themuse.com/search${query([
        ['q', keyword(f)],
        ['remote', '1'],
        ['posted', '30'],
      ])}`,
  },
  {
    id: 'EU_REMOTE_JOBS',
    label: 'EU Remote Jobs',
    buildUrl: (f) => `https://euremotejobs.com/jobs/${query([['search_keywords', keyword(f)]])}`,
  },
]
