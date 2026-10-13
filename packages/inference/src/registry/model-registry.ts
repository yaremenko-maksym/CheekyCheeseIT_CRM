import type { BoundedResult } from '../http/bounded-request'
import type { ExtractionModelGuardrails } from '../contracts/config'

export type OpenRouterModel = {
  id: string
  promptPriceUsdPerMTok: number
  contextTokens: number
}

const MARKER_SCAN_CHARS = 2000

function passesGuardrails(model: OpenRouterModel, g: ExtractionModelGuardrails): boolean {
  return (
    model.promptPriceUsdPerMTok <= g.maxPromptPriceUsdPerMTok &&
    model.contextTokens >= g.minContextTokens
  )
}

function compareCheapestThenId(a: OpenRouterModel, b: OpenRouterModel): number {
  if (a.promptPriceUsdPerMTok !== b.promptPriceUsdPerMTok) {
    return a.promptPriceUsdPerMTok - b.promptPriceUsdPerMTok
  }
  if (a.id < b.id) return -1
  return a.id > b.id ? 1 : 0
}

/**
 * Picks a model passing BOTH guardrails (price ceiling and minimum context):
 * the first `preferredModelIds` entry present among qualifiers, else the cheapest
 * qualifier (tie -> lexicographic id). No qualifier -> null; a model failing a
 * guardrail is never returned.
 */
export function selectModel(
  catalog: OpenRouterModel[],
  guardrails: ExtractionModelGuardrails,
): OpenRouterModel | null {
  const qualifying = catalog.filter((m) => passesGuardrails(m, guardrails))
  for (const id of guardrails.preferredModelIds ?? []) {
    const preferred = qualifying.find((m) => m.id === id)
    if (preferred !== undefined) return preferred
  }
  return [...qualifying].sort(compareCheapestThenId)[0] ?? null
}

/** True only when the provider says the requested model is gone (404, or 400 naming a missing model). */
export function isModelUnavailable(result: Extract<BoundedResult, { kind: 'transport' }>): boolean {
  if (result.status === 404) return true
  if (result.status !== 400 || result.text === undefined) return false
  // Bounded slice: the marker regexes never run over an unbounded provider-controlled string.
  const slice = result.text.slice(0, MARKER_SCAN_CHARS)
  return /model/i.test(slice) && /(not found|not a valid|no endpoints|unavailable)/i.test(slice)
}
