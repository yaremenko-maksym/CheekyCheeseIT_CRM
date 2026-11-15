import type { z } from 'zod'
import type { InferenceErrorCode } from './errors'

export const MAX_EXTRACTION_INPUT_CHARS = 50000
/** The most groups a small-dose table may hold; a request over it sends nothing (ADR §5.5 item 1). */
export const MAX_SMALL_DOSE_GROUPS = 6
/** The most base64 image chars one request may carry: the inline request cap of the vision research. */
export const MAX_IMAGE_REQUEST_CHARS = 20_000_000

/** One small request on the local route: a checked-in instruction and a strict flat sub-schema (§5.4). */
export type SmallDoseGroup = {
  name: string
  /** Appended to the request's instruction, never a replacement for it. */
  instruction: string
  schema: z.ZodType<unknown>
  maxAnswerTokens: number
}

/**
 * The local route's plan for this request (§5.4): the ordered groups and a pure merge of their parsed
 * answers, keyed by group name. A refusal from `merge` is a failed call. No `smallDose` on a request
 * declares its schema already small.
 */
export type SmallDose<T> = {
  groups: readonly SmallDoseGroup[]
  merge(parts: Readonly<Record<string, unknown>>): { ok: true; data: T } | { ok: false }
}

export type ExtractionRequest<T> = {
  input: string
  schema: z.ZodType<T>
  instruction?: string
  /** Aborting stops the call: no further request, in-flight cancelled, sleeps woken (§5.5 item 3). */
  signal?: AbortSignal
  smallDose?: SmallDose<T>
  /** `largest`: hosted models tried by parameter count, largest first, rotation off (R15). */
  modelPreference?: 'largest'
  /**
   * Base64 PNG pages sent as image parts after the input. A request with images goes only to
   * vision-capable pairs and never to the local floor: with none healthy it fails.
   */
  images?: readonly string[]
}

/** `localMs` is the time spent on local requests, charged on failure too (§5.5 item 6). */
export type ExtractionUsage = { totalTokens?: number; localMs?: number }

export type ExtractionResult<T> =
  | { ok: true; data: T; usage?: ExtractionUsage }
  | { ok: false; code: InferenceErrorCode; usage?: { localMs: number } }

export interface ExtractionPort {
  extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>>
}
