import type { ExtractionModelGuardrails } from '@crm/inference'

/**
 * Guardrails for the auto-selected OpenRouter extraction model: a cost ceiling (USD per 1M prompt
 * tokens), a minimum context window, and an optional preference list. These are TUNABLE constants —
 * they are set from the MP-03 measurement and the owner can widen them (raise the ceiling, add
 * preferred ids) with a code change. A model failing either guardrail is never selected.
 */
export const EXTRACTION_MODEL_GUARDRAILS: ExtractionModelGuardrails = {
  maxPromptPriceUsdPerMTok: 1,
  minContextTokens: 16000,
  preferredModelIds: [],
}
