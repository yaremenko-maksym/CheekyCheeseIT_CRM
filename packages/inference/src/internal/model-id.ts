/**
 * The checked-in Gemini family pattern (ADR §3.4, SR-H-1); version and variant are captures.
 * Anchored and narrower than the common id shape of §3.4 in its alphabet, but the version digits
 * have no upper bound, so a match alone does not bound the length: `isValidModelId` still applies.
 */
export const GEMINI_MODEL_PATTERN =
  /^gemini-([0-9]+(?:\.[0-9]+)?)-(flash|flash-lite|pro)(?:-preview(?:-[0-9]{2}-[0-9]{4})?)?$/

/** The checked-in Groq family pattern (ADR §3.4, SR-H-1): the two production strict-schema models. */
export const GROQ_MODEL_PATTERN = /^openai\/gpt-oss-(20b|120b)$/

/**
 * The Cloudflare Workers AI catalogue shape `@cf/<vendor>/<name>`: lower-case segments that start with a
 * letter or digit. Anchored; `isValidCloudflareModelId` adds the length cap and refuses `..`.
 */
export const CLOUDFLARE_MODEL_PATTERN = /^@cf\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/
const CLOUDFLARE_MODEL_MAX_CHARS = 128

/**
 * OpenRouter free ids (ADR §3.5 check 1): exactly `<author>/<model>:free`, lower-case segments that
 * start with a letter or digit, one `/`, and the literal `:free` suffix. Every other suffix
 * (`:online`, `:nitro`, ...) and no suffix fall outside it; `isValidOpenRouterModelId` adds the length
 * cap, `..` and the `openrouter` author (meta-routers that pick the upstream themselves).
 */
export const OPENROUTER_FREE_MODEL_PATTERN = /^([a-z0-9][a-z0-9._-]*)\/[a-z0-9][a-z0-9._-]*:free$/
const OPENROUTER_MODEL_MAX_CHARS = 128

/** The hosted provider names a model id belongs to. */
export type ModelProvider = 'gemini' | 'groq' | 'cloudflare' | 'openrouter'

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

function isValidCloudflareModelId(id: string): boolean {
  return (
    id.length <= CLOUDFLARE_MODEL_MAX_CHARS &&
    !id.includes('..') &&
    CLOUDFLARE_MODEL_PATTERN.test(id)
  )
}

function isValidOpenRouterModelId(id: string): boolean {
  const m = OPENROUTER_FREE_MODEL_PATTERN.exec(id)
  return (
    m !== null &&
    id.length <= OPENROUTER_MODEL_MAX_CHARS &&
    !id.includes('..') &&
    m[1] !== 'openrouter'
  )
}

/**
 * One validator per provider. The record is typed by `ModelProvider`, so a provider added there
 * without its own rule fails to compile instead of falling into another provider's (SR-L-4).
 */
const PROVIDER_MODEL_ID_RULES: { readonly [P in ModelProvider]: (id: string) => boolean } = {
  gemini: (id) => isValidModelId(id) && GEMINI_MODEL_PATTERN.test(id),
  groq: (id) => GROQ_MODEL_PATTERN.test(id),
  cloudflare: isValidCloudflareModelId,
  openrouter: isValidOpenRouterModelId,
}

/** A model id of `provider`, validated by its provider's family. */
export function isValidProviderModelId(provider: ModelProvider, id: string): boolean {
  return PROVIDER_MODEL_ID_RULES[provider](id)
}

/** Whether a pair may receive image parts (vision routes research): Gemini family only. */
export function isVisionCapable(provider: ModelProvider, id: string): boolean {
  return provider === 'gemini' && GEMINI_MODEL_PATTERN.test(id)
}

export type GeminiModelId = { id: string; version: string; variant: string }

/** A provider-supplied Gemini id, `models/` prefix stripped, validated by the family pattern; else null. */
export function parseGeminiModelId(raw: string): GeminiModelId | null {
  const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  if (!isValidModelId(id)) return null
  const m = GEMINI_MODEL_PATTERN.exec(id)
  return m === null ? null : { id, version: m[1]!, variant: m[2]! }
}
