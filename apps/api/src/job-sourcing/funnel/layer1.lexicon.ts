/**
 * Layer 1 phrase tables: DATA ONLY. Matching rules live in `layer1.ts`.
 *
 * Matching contract (see `phraseRegex`): the text is lower-cased and `-`, `–`, `_` are read as a
 * space, so "Full-Time" and "full_time" are the phrase "full time". A phrase matches whole words;
 * a trailing `*` makes it a stem ("віддален*" matches "віддалено"). Phrases are letters, digits and
 * spaces only: nothing here is regex syntax. No phrase of a list is a prefix of another phrase of
 * the same list, so the order inside a list never changes a result.
 *
 * Every phrase has exactly one row in `layer1.spec.ts`.
 */

export const REMOTE_PHRASES = [
  'remote',
  'remotely',
  'work from home',
  'working from home',
  'wfh',
  'telecommut*',
  'fully distributed',
  'віддален*',
  'дистанційн*',
  'удаленн*',
  'удалённ*',
  'дистанцион*',
  'zdaln*',
  'homeoffice',
] as const

export const HYBRID_PHRASES = [
  'hybrid',
  'partially remote',
  'гібрид*',
  'гибрид*',
  'частково віддален*',
] as const

export const ONSITE_PHRASES = [
  'onsite',
  'on site',
  'in office',
  'office based',
  'work from office',
  'work from the office',
  'офісний формат',
  'офисный формат',
  'робота в офісі',
  'работа в офисе',
  'vor ort',
] as const

/** A following word that turns "onsite" into something that is not a place of work. */
export const ONSITE_NOT_A_WORKPLACE_FOLLOWERS = [
  'interview',
  'meeting',
  'event',
  'visit',
  'offsite',
  'training',
  'workshop',
  'onboarding',
] as const

export const NEGATORS = [
  'no',
  'not',
  'non',
  'without',
  'never',
  'neither',
  'nor',
  'не',
  'нет',
  'ні',
  'без',
  'kein',
  'keine',
  'nie',
  'brak',
  'bez',
] as const

export const SOFTENER_STEMS = [
  'occasional',
  'optional',
  'rare',
  'periodic',
  'quarterly',
  'annual',
  'sometimes',
  'епізодичн',
  'іноді',
] as const

export const FULL_TIME_PHRASES = [
  'full time',
  'fulltime',
  'повна зайнятість',
  'повний робочий день',
  'vollzeit',
  'pełny etat',
] as const

export const PART_TIME_PHRASES = [
  'part time',
  'parttime',
  'неповн*',
  'парт тайм',
  'teilzeit',
  'niepełny etat',
  'część etatu',
] as const

export const B2B_PHRASES = ['b2b', 'b 2 b', 'фоп', 'jdg', 'sole proprietor*'] as const

export const CONTRACTOR_PHRASES = [
  'contractor',
  'freelanc*',
  'self employed',
  '1099',
  'договір підряду',
  'contract',
] as const

export const EMPLOYEE_PHRASES = [
  'employment contract',
  'contract of employment',
  'permanent employ*',
  'employee',
  'w2',
  'w 2',
  'трудовий договір',
  'umowa o pracę',
  'arbeitsvertrag',
] as const

export const FIXED_TERM_PHRASES = [
  'fixed term',
  'temporary',
  'терміновий договір',
  'строковий договір',
  'befristet',
] as const

export const PROJECT_PHRASES = [
  'project based',
  'project basis',
  'one off project',
  'проєктн*',
  'проектн*',
] as const

export const PERMANENT_PHRASES = ['permanent', 'indefinite', 'безстроков*', 'unbefristet'] as const

/** Nouns an agency statement is built around. */
export const AGENCY_NOUNS = ['agency', 'agencies', 'recruiters', 'vendors'] as const

export const AGENCY_PROHIBIT_AFTER = [
  'need not',
  'should not',
  'do not',
  "don't",
  'please do not',
  'not',
] as const

export const AGENCY_PROHIBIT_PHRASES = [
  'no third party',
  'без посередників',
  'без агенцій',
  'без рекрутингових агенцій',
  'без посредников',
] as const

export const AGENCY_ACCEPT_AFTER = ['welcome', 'accepted', 'encouraged'] as const

export const AGENCY_ACCEPT_PHRASES = [
  'open to agencies',
  'open to agency',
  'open to recruitment agencies',
  'open to recruitment agency',
  'work with agency',
  'work with agencies',
  'work with recruitment agencies',
  'work with staffing agencies',
  'partner with agencies',
  'partner with agency',
  'partner with recruitment agencies',
  'partner with staffing agencies',
] as const

export const ROLE_FAMILIES = [
  [
    'DEVOPS',
    [
      'devops',
      'sre',
      'site reliability',
      'platform engineer',
      'infrastructure engineer',
      'cloud engineer',
    ],
  ],
  [
    'DATA',
    [
      'data scientist',
      'data engineer',
      'data analyst',
      'machine learning',
      'ml engineer',
      'ai engineer',
    ],
  ],
  ['QA', ['qa', 'quality assurance', 'sdet', 'test engineer', 'tester']],
  ['DESIGN', ['designer', 'ux', 'ui']],
  [
    'PRODUCT',
    ['product manager', 'product owner', 'project manager', 'scrum master', 'delivery manager'],
  ],
  [
    'SOFTWARE',
    [
      'developer',
      'engineer',
      'programmer',
      'software',
      'frontend',
      'front end',
      'backend',
      'back end',
      'fullstack',
      'full stack',
      'розробник',
      'програміст',
      'разработчик',
      'entwickler',
    ],
  ],
  ['OTHER', ['recruiter', 'sales', 'marketing', 'accountant', 'support', 'hr', 'legal']],
] as const

export const LEAD_PHRASES = [
  'lead',
  'teamlead',
  'head of',
  'engineering manager',
  'development manager',
  'тімлід',
  'тимлид',
  'тім лід',
  'тех лід',
] as const

/** Level phrases, lowest to highest. Staff / principal are senior EXPERTISE, never leadership. */
export const LEVEL_PHRASES = [
  ['INTERN', 'LEVEL_INTERN', ['intern', 'internship', 'trainee', 'стажер*', 'стажист*']],
  ['JUNIOR', 'LEVEL_JUNIOR', ['junior', 'jr', 'entry level', 'джуніор', 'джуниор']],
  ['MIDDLE', 'LEVEL_MIDDLE', ['middle', 'mid', 'мідл', 'миддл']],
  ['SENIOR', 'LEVEL_SENIOR', ['senior', 'sr', 'сеніор', 'сеньор', 'синьор']],
  ['SENIOR', 'LEVEL_STAFF_PRINCIPAL', ['staff', 'principal', 'distinguished']],
  ['LEAD', 'LEVEL_LEAD', LEAD_PHRASES],
  [
    'EXECUTIVE',
    'LEVEL_EXECUTIVE',
    ['director', 'vp', 'vice president', 'cto', 'chief', 'директор'],
  ],
] as const

export const YEARS_UNITS = [
  'years',
  'year',
  'yrs',
  'yr',
  'роки',
  'років',
  'рік',
  'лет',
  'года',
  'jahre',
  'lat',
] as const

export const LEADS_BODY_PHRASES = [
  'people management',
  'manage a team of',
  'manage team of',
  'direct report*',
  'line manage*',
  'керувати командою',
  'управлять командой',
] as const

export const IC_BODY_PHRASES = ['individual contributor', 'ic role'] as const

/** Region code, then the phrases that name it. */
export const REGIONS = [
  ['EUROPE', ['europe', 'eu', 'emea', 'європа', 'європі', 'европа', 'европе']],
  ['US', ['usa', 'us', 'united states', 'сша']],
  ['UK', ['uk', 'united kingdom']],
  ['CANADA', ['canada']],
  ['LATAM', ['latam', 'latin america']],
  ['APAC', ['apac']],
] as const

export const AUTHORIZATION_VERBS = [
  'authorized',
  'authorised',
  'eligible',
  'legally entitled',
  'legal right',
] as const

/** Work-authorization statements that carry their own region (or none). */
export const AUTHORIZATION_PHRASES = [
  ['us work authorization', 'US'],
  ['us work authorisation', 'US'],
  ['us citizen*', 'US'],
  ['дозвіл на роботу в сша', 'US'],
  ['разрешение на работу в сша', 'US'],
  ['arbeitserlaubnis', null],
] as const
