import type { JobExclusionDto } from '@crm/shared'
import type { Layer1Input, Layer1Result } from './layer1'
import type { FirstSeenKind, RankWarning } from './rank'
import type { SeniorTechProfile, TechMatchView, TechMatchReadinessIssue } from './tech-match'

/**
 * Contract of `evaluate` (Task 4.4). Everything in an OUTPUT is plain JSON (strings, numbers,
 * arrays, objects; instants are ISO strings) so a persistence layer can store it unchanged.
 */

/** Stamped on every reason and trace entry that evaluate itself produces (layer 1 stamps its own). */
export const EVALUATE_RULE_VERSION = 'eval.1' as const

export type Availability = 'OPEN' | 'CLOSED' | 'EXPIRED' | 'UNKNOWN'

export type EvaluationStage =
  | 'REVISION'
  | 'CLASSIFICATION'
  | 'GLOBAL_RESTRICTIONS'
  | 'SCOPED_RESTRICTIONS'
  | 'SKILL_SIGNALS'
  | 'PROJECTIONS'
  | 'SCORE'

export interface TraceEntry {
  stage: EvaluationStage
  ruleVersion: string
}

/** A reason is never emitted without the evidence it rests on. */
export interface Reason {
  code: string
  evidence: [string, ...string[]]
  ruleVersion: string
}

/** The persisted canonical revision as the caller resolved it (identity resolution is upstream). */
export interface CanonicalRevision {
  opportunityId: string
  revisionId: string
  companyName: string
  url: string
  sourceType: string
  fields: Layer1Input
  availability: Availability
  firstSeenAt: Date
  firstSeenKind: FirstSeenKind
  trustedPublishedAt: Date | null
}

/** A loading step the CALLER could not finish: the record is retried, never filtered. */
export type UnavailableInput = 'ROSTER' | 'EXCLUSIONS' | 'TEAMS'

export interface EvaluateInput {
  recordKey: string
  evaluationTime: Date
  revision: CanonicalRevision | null
  rosterSeniorIds: readonly string[]
  profiles: readonly SeniorTechProfile[]
  exclusions: readonly JobExclusionDto[]
  /** Teams explicitly granted unknown-stack triage items. There is no global pool. */
  teamTriageGrants: readonly string[]
  unavailable?: readonly UnavailableInput[]
}

/** `SENIOR:<id>`, `TEAM:<id>` or `STUDIO`. */
export type ScopeKey = string

export type ProjectionStatus = 'LEAD' | 'TRIAGE'

export interface ScopeProjection {
  scope: ScopeKey
  status: ProjectionStatus
  /** Seniors of the scope with a CORE/OPTIONAL match. */
  matchCount: number
  /** Present only for a LEAD. */
  score: number | null
  rankWarnings: RankWarning[]
  reasons: Reason[]
  /** What the viewer may be shown: built from the scope's own seniors only. */
  tech: TechMatchView
}

export interface ExcludedEntry {
  /** `OPPORTUNITY` or `SENIOR:<id>`. */
  subject: string
  stage: EvaluationStage
  reasons: Reason[]
  /** The inputs the reasons rest on, JSON-safe. Staff-only. */
  inputs: Record<string, unknown>
}

/** Staff-only. Never contributes to a count, a rank or a viewer explanation. */
export interface EvaluationAudit {
  excluded: ExcludedEntry[]
  noTeamAccess: string[]
  ignoredExclusionIds: string[]
}

interface Base {
  recordKey: string
}

export interface Evaluated extends Base {
  kind: 'EVALUATED'
  opportunityId: string
  revisionId: string
  evaluatedAt: string
  /** The studio-level outcome. */
  status: ProjectionStatus | 'NO_MATCH'
  layer1: Layer1Result
  projections: ScopeProjection[]
  trace: TraceEntry[]
  audit: EvaluationAudit
}

export interface Excluded extends Base {
  kind: 'EXCLUDED'
  opportunityId: string
  revisionId: string
  evaluatedAt: string
  reasons: Reason[]
  trace: TraceEntry[]
  audit: EvaluationAudit
}

export type InvalidInputCode = 'MISSING_REVISION' | 'INVALID_REVISION' | 'INVALID_EVALUATION_TIME'

export interface InvalidInput extends Base {
  kind: 'INVALID_INPUT'
  code: InvalidInputCode
  trace: TraceEntry[]
}

export type RetryableCode = 'INPUT_UNAVAILABLE' | 'ROSTER_NOT_READY'

/** Not evaluated, not filtered: the caller retries. */
export interface Retryable extends Base {
  kind: 'RETRYABLE'
  code: RetryableCode
  unavailable: UnavailableInput[]
  readiness: TechMatchReadinessIssue['issues']
  trace: TraceEntry[]
}

export interface RecordFailed {
  kind: 'RECORD_FAILED'
  recordKey: string
  code: 'MALFORMED_RECORD' | 'EVALUATION_THREW'
}

export type EvaluationResult = Evaluated | Excluded | InvalidInput | Retryable
export type BatchEntry = EvaluationResult | RecordFailed

export type Viewer = { role: 'ADMIN' } | { role: 'HR'; teamId: string | null }
