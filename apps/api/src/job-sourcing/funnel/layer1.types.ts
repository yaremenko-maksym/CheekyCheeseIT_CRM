import type { FieldEvidence, NormalizedVacancyFields } from '../normalize/observation'

/**
 * Layer 1 contract (Task 4.1). Pure: every input is a persisted-revision-shaped value, the clock
 * is a parameter, and the output is a plain structure that is `toEqual` across runs.
 */

/** Bumped whenever a rule changes in a way that should re-evaluate stored observations. */
export const RULE_VERSION = 'l1.1' as const
export type RuleVersion = typeof RULE_VERSION

export type Verdict = 'PASS' | 'WARN_UNKNOWN' | 'REJECT'

/** Where a piece of evidence came from. STRUCTURED and TITLE outrank BODY. */
export type EvidenceSource = 'STRUCTURED' | 'TITLE' | 'BODY' | 'POLICY'

export interface Layer1Evidence {
  source: EvidenceSource
  /** The persisted field the text was read from (`remote`, `title`, `descriptionMd`, ...). */
  field: string
  /** The matched sentence / value, bounded. Empty when the evidence is an absence. */
  excerpt: string
  /** Stable machine reason, e.g. `REMOTE_KEYWORD`, `NEGATED`. */
  code: string
  /** False when a higher-precedence tier overrode this signal or it was a loser of a conflict. */
  used: boolean
}

export interface Dimension<V> {
  value: V
  verdict: Verdict
  evidence: Layer1Evidence[]
  ruleVersion: RuleVersion
}

export type Workplace = 'REMOTE' | 'HYBRID' | 'ONSITE' | 'UNKNOWN'
/** `EITHER`: the posting accepts more than one form (e.g. "B2B or employment contract"). */
export type Basis = 'EMPLOYEE' | 'CONTRACTOR' | 'B2B' | 'EITHER' | 'UNKNOWN'
export type Schedule = 'FULL_TIME' | 'PART_TIME' | 'FLEXIBLE' | 'UNKNOWN'
export type Duration = 'PERMANENT' | 'FIXED_TERM' | 'PROJECT' | 'UNKNOWN'
export type AgencyAcceptance = 'ACCEPTED' | 'PROHIBITED' | 'UNKNOWN'
export type RoleFamily =
  'SOFTWARE' | 'DEVOPS' | 'DATA' | 'QA' | 'DESIGN' | 'PRODUCT' | 'OTHER' | 'UNKNOWN'
export type Seniority = 'INTERN' | 'JUNIOR' | 'MIDDLE' | 'SENIOR' | 'LEAD' | 'EXECUTIVE' | 'UNKNOWN'
export type Leadership = 'LEADS_PEOPLE' | 'INDIVIDUAL_CONTRIBUTOR' | 'UNKNOWN'
export type Geography = 'UNSTATED' | 'REGION_LIMITED' | 'WORK_AUTHORIZATION_REQUIRED'

export interface GeographyValue {
  kind: Geography
  /** Upper-case region / country codes as stated, sorted (`EUROPE`, `US`). */
  regions: string[]
}

export type SalaryState = 'UNKNOWN' | 'ABOVE_FLOOR' | 'BELOW_FLOOR' | 'UNCONVERTIBLE'

export interface SalaryValue {
  state: SalaryState
  /** Top of the stated range in monthly gross USD, when it could be computed. */
  monthlyUsd: number | null
}

export type FreshnessBucket = 'FRESH' | 'RECENT' | 'AGING' | 'OLD' | 'UNKNOWN'

export interface FreshnessValue {
  bucket: FreshnessBucket
  /** Whole days between the newest usable date and `evaluationTime`; null without a usable date. */
  ageDays: number | null
  /** Sort key: higher is fresher, 0 when unknown. A rank, never a closure criterion. */
  rank: number
}

export type SalaryPeriod = 'HOUR' | 'MONTH' | 'YEAR'

/** A stated figure as persisted with the observation; a range has both bounds. */
export interface SalaryObservation {
  min: number | null
  max: number | null
  /** ISO 4217, upper case. */
  currency: string
  period: SalaryPeriod
}

/** The conversion rate recorded WITH the observation, so a later rate change cannot re-rank it. */
export interface FxRateObservation {
  currency: string
  /** USD per one unit of `currency`. */
  usdPerUnit: number
  /** ISO instant the rate was recorded at. */
  recordedAt: string
}

export type Layer1Input = Pick<
  NormalizedVacancyFields,
  'title' | 'location' | 'descriptionMd' | 'remote' | 'employmentType' | 'seniorityHint' | 'tags'
> & {
  dates: NormalizedVacancyFields['dates']
  evidence?: readonly FieldEvidence[]
  salary?: SalaryObservation | null
  fxRate?: FxRateObservation | null
}

export interface Layer1Options {
  ruleVersion: RuleVersion
  /** The caller's clock reading; nothing in Layer 1 reads the system clock. */
  evaluationTime: Date
}

/** Layer-1 triage-relevant flags. Stack / identity / employer triage belongs to 4.2-4.4. */
export type Layer1Flag =
  | 'UNRESOLVED_CONTRADICTION'
  | 'SALARY_UNKNOWN'
  | 'SALARY_UNCONVERTIBLE'
  | 'DESCRIPTION_TRUNCATED'
  | 'FUTURE_DATE_IGNORED'
  | 'DATE_UNCERTAIN'

export interface Layer1Result {
  ruleVersion: RuleVersion
  /** ISO of the `evaluationTime` the result was computed for. */
  evaluatedAt: string
  workplace: Dimension<Workplace>
  basis: Dimension<Basis>
  schedule: Dimension<Schedule>
  duration: Dimension<Duration>
  agency: Dimension<AgencyAcceptance>
  roleFamily: Dimension<RoleFamily>
  seniority: Dimension<Seniority>
  leadership: Dimension<Leadership>
  geography: Dimension<GeographyValue>
  salary: Dimension<SalaryValue>
  freshness: Dimension<FreshnessValue>
  /** REJECT if any dimension rejects, else WARN_UNKNOWN if any warns, else PASS. */
  verdict: Verdict
  /** Names of dimensions whose verdict is REJECT, in a fixed order. */
  rejectedBy: string[]
  /** Names of dimensions whose verdict is WARN_UNKNOWN, in a fixed order. */
  unknown: string[]
  /** Sorted, de-duplicated. */
  flags: Layer1Flag[]
}
