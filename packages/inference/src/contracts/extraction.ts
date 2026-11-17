import type { z } from 'zod'
import type { InferenceErrorCode } from './errors'

export const MAX_EXTRACTION_INPUT_CHARS = 50000
/** The most base64 image chars one request may carry: the inline request cap of the vision research. */
export const MAX_IMAGE_REQUEST_CHARS = 20_000_000

export type ExtractionRequest<T> = {
  input: string
  schema: z.ZodType<T>
  instruction?: string
  /** Aborting stops the call: no further request, in-flight cancelled, sleeps woken (§5.5 item 3). */
  signal?: AbortSignal
  /** `largest`: hosted models tried by parameter count, largest first, rotation off (R15). */
  modelPreference?: 'largest'
  /**
   * Base64 PNG pages sent as image parts after the input. A request with images goes only to
   * vision-capable pairs: with none healthy it fails.
   */
  images?: readonly string[]
}

/** The provider's own token count, the only cost the free tiers report (ADR §6.2). */
export type ExtractionUsage = { totalTokens?: number }

export type ExtractionResult<T> =
  { ok: true; data: T; usage?: ExtractionUsage } | { ok: false; code: InferenceErrorCode }

export interface ExtractionPort {
  extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>>
}
