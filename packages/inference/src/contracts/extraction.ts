import type { z } from 'zod'
import type { InferenceErrorCode } from './errors'

export const MAX_EXTRACTION_INPUT_CHARS = 50000

export type ExtractionRequest<T> = {
  input: string
  schema: z.ZodType<T>
  instruction?: string
}

export type ExtractionResult<T> =
  { ok: true; data: T; usage?: { totalTokens?: number } } | { ok: false; code: InferenceErrorCode }

export interface ExtractionPort {
  extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>>
}
