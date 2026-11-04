/**
 * The checked-in Gemini family pattern (ADR §3.4, SR-H-1); version and variant are captures.
 * Anchored and narrower than the common id shape of §3.4 (letters, digits, `. _ - /`, ≤ 128), so
 * an id that matches it is already a valid id.
 */
export const GEMINI_MODEL_PATTERN =
  /^gemini-([0-9]+(?:\.[0-9]+)?)-(flash|flash-lite|pro)(?:-preview(?:-[0-9]{2}-[0-9]{4})?)?$/

export type GeminiModelId = { id: string; version: string; variant: string }

/** A provider-supplied Gemini id, `models/` prefix stripped, validated by the family pattern; else null. */
export function parseGeminiModelId(raw: string): GeminiModelId | null {
  const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  const m = GEMINI_MODEL_PATTERN.exec(id)
  return m === null ? null : { id, version: m[1]!, variant: m[2]! }
}
