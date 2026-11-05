import type { AiInputSignal, ModelInputPolicy } from './ai-input-gate'
import type { ExtractionRecord } from './extraction-result-guard'

declare const untrustedUrlBrand: unique symbol
/**
 * A URL a model named. It passed the result guard (https, occurs in the page or is the verified
 * identity) but is still model output: nothing in `structuring/` fetches it, and a consumer must
 * treat it as navigation-only (SSRF).
 */
export type UntrustedUrl = string & { readonly [untrustedUrlBrand]: true }

/** The fields Stage C may fill when Stage B left them empty. */
export const MODEL_FILLABLE_FIELDS = [
  'description',
  'location',
  'employmentType',
  'remote',
] as const

export type ModelFillableField = (typeof MODEL_FILLABLE_FIELDS)[number]

/** One record found by deterministic discovery; the model never adds or renames records. */
export interface DiscoveredRecord {
  /** The source-side id from discovery. */
  readonly id: string
  /** The verified posting URL: the record's identity, which the model may name without quoting. */
  readonly url: string
  /** The already-fetched page text of this record (its detail page, or its bounded chunk). */
  readonly text: string
  /** What Stage B left empty: the local floor is asked only this. Absent means all of them. */
  readonly missing?: readonly ModelFillableField[]
}

export interface HtmlStructurerRequest {
  readonly aiInput: AiInputSignal
  /** Required: what an `unspecified` source means is the caller's explicit choice. */
  readonly policy: ModelInputPolicy
  /** Each record is one chunk and one model call, in this order. */
  readonly records: readonly DiscoveredRecord[]
  /** Stamped on the outcome; the version the model writes back is not trusted. */
  readonly extractionVersion: string
  /** Abort stops before the next call and abandons the call in flight. */
  readonly signal?: AbortSignal
}

export type StructuredRecord = Omit<ExtractionRecord, 'postingUrl' | 'applyUrl'> & {
  /** The discovered record this was extracted from. */
  readonly sourceId: string
  readonly postingUrl: UntrustedUrl | null
  readonly applyUrl: UntrustedUrl | null
}

/** Failures of one record's call that end that record only; the next record is still tried. */
export type RecordFailureCode =
  'INVALID_OUTPUT' | 'OUTPUT_TOO_LARGE' | 'NOT_JSON' | 'SCHEMA_INVALID' | 'NO_VALID_RECORD'

/** Failures that stop the run: the endpoint, not the record, is the problem. */
export type ExtractorStopCode = 'TIMEOUT' | 'PORT_THREW' | 'UNKNOWN_CODE' | 'CANCELLED'

export type ExtractorFailureCode = RecordFailureCode | ExtractorStopCode

/** A processed record that lost something: the call failed, or the guard dropped parts of the reply. */
export interface RecordIssue {
  readonly id: string
  readonly failure: RecordFailureCode | null
  readonly droppedRecords: number
  readonly nulledUrls: number
  readonly droppedEvidence: number
  /** String facts nulled for having no surviving quote (D10). */
  readonly nulledFacts: number
}

/** Why a run stopped early. Classified from `InferenceErrorCode` only, never from page text. */
export type StructurerStop =
  | { readonly kind: 'BUDGET_EXHAUSTED'; readonly cause: 'CYCLE_LIMIT' | 'RATE_LIMITED' }
  | { readonly kind: 'MODEL_UNAVAILABLE'; readonly code: 'NOT_CONFIGURED' | 'PROVIDER_ERROR' }
  | { readonly kind: 'EXTRACTOR_FAILED'; readonly code: ExtractorFailureCode }

/**
 * `remainingIds`: the records not processed, in request order, for the caller to persist and resume.
 * A stop before any record was processed returns the stop itself; after one, PARTIAL. When every
 * record failed, EXTRACTOR_FAILED carries their issues (`perRecordIssues` names the failed ids).
 */
export type StructurerOutcome =
  | {
      readonly kind: 'EXTRACTED'
      readonly extractionVersion: string
      readonly records: readonly StructuredRecord[]
      readonly perRecordIssues: readonly RecordIssue[]
    }
  | { readonly kind: 'SKIPPED_AI_INPUT_NO' }
  /** `ai-input` unspecified and the caller's policy says block. */
  | { readonly kind: 'SKIPPED_AI_INPUT_UNSPECIFIED' }
  | (StructurerStop & {
      readonly remainingIds: readonly string[]
      readonly perRecordIssues: readonly RecordIssue[]
    })
  | {
      readonly kind: 'PARTIAL'
      readonly extractionVersion: string
      readonly records: readonly StructuredRecord[]
      readonly perRecordIssues: readonly RecordIssue[]
      readonly remainingIds: readonly string[]
      readonly stoppedBy: StructurerStop
    }

export interface HtmlStructurer {
  structure(request: HtmlStructurerRequest): Promise<StructurerOutcome>
}
