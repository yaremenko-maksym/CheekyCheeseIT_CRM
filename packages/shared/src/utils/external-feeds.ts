import type { TechnicalRole } from '../schemas/technical-roles'

/**
 * Deep links into job sites the collector cannot read (no feed, a technical block, or the owner
 * excluded them) or reads only in part (one Djinni feed per keyword; 20-25 detail pages a run on
 * the HTML sources). HR opens them in a new tab; nothing here is fetched by the CRM.
 *
 * Every template was checked by hand on 2026-11-24 (one request each): DOU and EU Remote Jobs
 * answer with the filtered list; The Muse reads `q`, `remote` and `posted` (it has no seniority
 * filter); LinkedIn's `f_E` / `f_WT` show only when signed in, so manual QA checks them there.
 * Welcome to the Jungle's search reads no filter from the URL, so its link is the plain job list.
 *
 * Checked by hand on 2026-11-25 (one request each): Djinni reads `primary_keyword`, `exp_level`
 * and `employment`; JustJoin.it reads the category path and `experience-levels`; No Fluff Jobs
 * reads the category path and `criteria` (an unknown category falls back to all jobs); Dice reads
 * `q`, `filters.workplaceTypes` and `filters.postedDate`; The Hub reads `roles` and `countryCode`;
 * Landing.jobs reads `q` and `remote`; Jobspresso reads `search_keywords`. Next Level Jobs needs
 * a sign-in for its search, so its link is the home page list.
 */

export type ExternalFeedId =
  | 'DOU'
  | 'LINKEDIN'
  | 'THE_MUSE'
  | 'EU_REMOTE_JOBS'
  | 'WELCOME_TO_THE_JUNGLE'
  | 'DJINNI'
  | 'JUSTJOIN'
  | 'NO_FLUFF_JOBS'
  | 'DICE'
  | 'THE_HUB'
  | 'LANDING_JOBS'
  | 'NEXT_LEVEL_JOBS'
  | 'JOBSPRESSO'

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

/* eslint-disable lingui/no-unlocalized-strings --
   DOU's own category values, sent to its URL as is; never shown in the CRM. */
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
/* eslint-enable lingui/no-unlocalized-strings */

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

/** Djinni's `primary_keyword` per role (values from its filter tree); unmapped roles list all. */
export const ROLE_TO_DJINNI_KEYWORD: Partial<Record<TechnicalRole, string>> = {
  FRONTEND_ENGINEER: 'JavaScript',
  FULLSTACK_ENGINEER: 'Fullstack',
  BUSINESS_APPLICATIONS_ENGINEER: 'ERP',
  IOS_ENGINEER: 'iOS',
  ANDROID_ENGINEER: 'Android',
  DATA_ENGINEER: 'Data Engineer',
  DATABASE_ENGINEER: 'SQL',
  DATA_ANALYST: 'Data Analyst',
  DATA_SCIENTIST: 'Data Science',
  ML_ENGINEER: 'ML AI',
  AI_ENGINEER: 'ML AI',
  DEVOPS_ENGINEER: 'DevOps',
  SITE_RELIABILITY_ENGINEER: 'DevOps',
  SYSTEM_ADMINISTRATOR: 'Sysadmin',
  SUPPORT_ENGINEER: 'Support',
  QA_ENGINEER: 'QA',
  QA_AUTOMATION_ENGINEER: 'QA Automation',
  SECURITY_ENGINEER: 'Security',
  SECURITY_ANALYST: 'Security Analyst',
  PENETRATION_TESTER: 'Penetration Tester',
  EMBEDDED_ENGINEER: 'Embedded',
  HARDWARE_ENGINEER: 'Hardware Engineer',
  GAME_DEVELOPER: 'Game Developer',
  SOFTWARE_ARCHITECT: 'Architect',
  ENGINEERING_MANAGER: 'Engineering Manager',
  CTO: 'CTO',
  BUSINESS_ANALYST: 'Business Analyst',
  UI_UX_DESIGNER: 'UI UX',
}

/** JustJoin.it's category path segment per role; unmapped roles list all remote jobs. */
export const ROLE_TO_JUSTJOIN_CATEGORY: Partial<Record<TechnicalRole, string>> = {
  FRONTEND_ENGINEER: 'javascript',
  BUSINESS_APPLICATIONS_ENGINEER: 'erp',
  IOS_ENGINEER: 'mobile',
  ANDROID_ENGINEER: 'mobile',
  CROSS_PLATFORM_MOBILE_ENGINEER: 'mobile',
  DATA_ENGINEER: 'data',
  DATABASE_ENGINEER: 'data',
  DATA_ANALYST: 'analytics',
  DATA_SCIENTIST: 'ai',
  ML_ENGINEER: 'ai',
  AI_ENGINEER: 'ai',
  DEVOPS_ENGINEER: 'devops',
  SITE_RELIABILITY_ENGINEER: 'devops',
  SYSTEM_ADMINISTRATOR: 'admin',
  NETWORK_ENGINEER: 'admin',
  SUPPORT_ENGINEER: 'support',
  QA_ENGINEER: 'testing',
  QA_AUTOMATION_ENGINEER: 'testing',
  SECURITY_ENGINEER: 'security',
  SECURITY_ANALYST: 'security',
  PENETRATION_TESTER: 'security',
  GAME_DEVELOPER: 'game',
  SOFTWARE_ARCHITECT: 'architecture',
  ENGINEERING_MANAGER: 'pm',
  BUSINESS_ANALYST: 'analytics',
  UI_UX_DESIGNER: 'ux',
}

/** No Fluff Jobs' category path segment per role (each checked to resolve); unmapped = all jobs. */
export const ROLE_TO_NOFLUFF_CATEGORY: Partial<Record<TechnicalRole, string>> = {
  BACKEND_ENGINEER: 'backend',
  FRONTEND_ENGINEER: 'frontend',
  FULLSTACK_ENGINEER: 'fullstack',
  BUSINESS_APPLICATIONS_ENGINEER: 'erp',
  IOS_ENGINEER: 'mobile',
  ANDROID_ENGINEER: 'mobile',
  CROSS_PLATFORM_MOBILE_ENGINEER: 'mobile',
  DATA_ENGINEER: 'data',
  DATABASE_ENGINEER: 'data',
  DATA_ANALYST: 'data',
  DATA_SCIENTIST: 'artificial-intelligence',
  ML_ENGINEER: 'artificial-intelligence',
  AI_ENGINEER: 'artificial-intelligence',
  DEVOPS_ENGINEER: 'devops',
  SITE_RELIABILITY_ENGINEER: 'devops',
  SUPPORT_ENGINEER: 'support',
  QA_ENGINEER: 'testing',
  QA_AUTOMATION_ENGINEER: 'testing',
  SECURITY_ENGINEER: 'security',
  SECURITY_ANALYST: 'security',
  PENETRATION_TESTER: 'security',
  EMBEDDED_ENGINEER: 'embedded',
  SOFTWARE_ARCHITECT: 'architecture',
  ENGINEERING_MANAGER: 'project-manager',
  BUSINESS_ANALYST: 'business-analyst',
  UI_UX_DESIGNER: 'ux',
}

/** The Hub's `roles` value per role; only these three were seen on its job list. */
export const ROLE_TO_THEHUB_ROLE: Partial<Record<TechnicalRole, string>> = {
  BACKEND_ENGINEER: 'backenddeveloper',
  FRONTEND_ENGINEER: 'frontenddeveloper',
  FULLSTACK_ENGINEER: 'fullstackdeveloper',
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

/** The first role's value in a site's own map; `undefined` when there is no role or no entry. */
function mapped(
  map: Partial<Record<TechnicalRole, string>>,
  filters: FeedFilters,
): string | undefined {
  const role = filters.roles[0]
  // Stryker disable next-line ConditionalExpression: equivalent, indexing the map with undefined also gives undefined
  return role === undefined ? undefined : map[role]
}

/** `/<segment>` when there is one, else nothing. */
function segment(value: string | undefined): string {
  return value === undefined ? '' : `/${enc(value)}`
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
  {
    id: 'WELCOME_TO_THE_JUNGLE',
    label: 'Welcome to the Jungle',
    buildUrl: () => 'https://www.welcometothejungle.com/en/jobs',
  },
  {
    id: 'DJINNI',
    label: 'Djinni',
    // exp_level=5y five years or more, employment=remote fully remote
    buildUrl: (f) =>
      `https://djinni.co/jobs/${query([
        ['primary_keyword', mapped(ROLE_TO_DJINNI_KEYWORD, f)],
        ['exp_level', '5y'],
        ['employment', 'remote'],
      ])}`,
  },
  {
    id: 'JUSTJOIN',
    label: 'JustJoin.it',
    buildUrl: (f) =>
      `https://justjoin.it/job-offers/remote${segment(mapped(ROLE_TO_JUSTJOIN_CATEGORY, f))}${query(
        [['experience-levels', 'senior']],
      )}`,
  },
  {
    id: 'NO_FLUFF_JOBS',
    label: 'No Fluff Jobs',
    buildUrl: (f) =>
      `https://nofluffjobs.com/remote${segment(mapped(ROLE_TO_NOFLUFF_CATEGORY, f))}${query([
        ['criteria', 'seniority=senior'],
      ])}`,
  },
  {
    id: 'DICE',
    label: 'Dice',
    // Dice has no seniority filter; SEVEN = posted in the last 7 days
    buildUrl: (f) =>
      `https://www.dice.com/jobs${query([
        ['q', keyword(f)],
        ['filters.workplaceTypes', 'Remote'],
        ['filters.postedDate', 'SEVEN'],
      ])}`,
  },
  {
    id: 'THE_HUB',
    label: 'The Hub',
    buildUrl: (f) =>
      `https://thehub.io/jobs${query([
        ['roles', mapped(ROLE_TO_THEHUB_ROLE, f)],
        ['countryCode', 'REMOTE'],
      ])}`,
  },
  {
    id: 'LANDING_JOBS',
    label: 'Landing.jobs',
    buildUrl: (f) =>
      `https://landing.jobs/jobs${query([
        ['q', keyword(f)],
        ['remote', 'true'],
      ])}`,
  },
  {
    id: 'NEXT_LEVEL_JOBS',
    label: 'Next Level Jobs',
    buildUrl: () => 'https://nextleveljobs.eu/',
  },
  {
    id: 'JOBSPRESSO',
    label: 'Jobspresso',
    buildUrl: (f) =>
      `https://jobspresso.co/remote-work/${query([['search_keywords', keyword(f)]])}`,
  },
]
