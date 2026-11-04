/**
 * The checked-in Gemini family pattern (ADR §3.4, SR-H-1); version and variant are captures.
 * Anchored and narrower than the common id shape of §3.4 (letters, digits, `. _ - /`, ≤ 128), so
 * an id that matches it is already a valid id.
 */
export const GEMINI_MODEL_PATTERN =
  /^gemini-([0-9]+(?:\.[0-9]+)?)-(flash|flash-lite|pro)(?:-preview(?:-[0-9]{2}-[0-9]{4})?)?$/

/** The checked-in Groq family pattern (ADR §3.4, SR-H-1): the two production strict-schema models. */
export const GROQ_MODEL_PATTERN = /^openai\/gpt-oss-(20b|120b)$/

/**
 * The id shape common to every provider (ADR §3.4): letters, digits and `. _ - /`, at most one `:`,
 * at most 128 characters, no leading `/`, no `..`. Whitespace and control characters fall outside the
 * class; a URL scheme (`x://`) is refused because no `/` may follow the `:`.
 */
export function isValidModelId(id: string): boolean {
  return (
    /^[A-Za-z0-9._\-/]+(?::[A-Za-z0-9._-]+)?$/.test(id) &&
    id.length <= 128 &&
    !id.startsWith('/') &&
    !id.includes('..')
  )
}

/** A model id of `provider`, validated by the common shape and, for a hosted provider, its family. */
export function isValidProviderModelId(provider: 'gemini' | 'groq' | 'local', id: string): boolean {
  if (provider === 'gemini') return GEMINI_MODEL_PATTERN.test(id)
  if (provider === 'groq') return GROQ_MODEL_PATTERN.test(id)
  return isValidModelId(id)
}

export type GeminiModelId ={ id: string; version: string; variant: string }

/** A provider-supplied Gemini id, `models/` prefix stripped, validated by the family pattern; else null. */
export function parseGeminiModelId(raw: string): GeminiModelId | null {
  const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  const m = GEMINI_MODEL_PATTERN.exec(id)
  return m === null ? null : { id, version: m[1]!, variant: m[2]! }
}
