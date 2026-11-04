import { MAX_EXTRACTION_INPUT_CHARS } from '../contracts/extraction'
import {
  CORRECTION_PREFIX,
  DEFAULT_EXTRACTION_INSTRUCTION,
  MAX_EXTRACTION_INSTRUCTION_CHARS,
} from '../internal/chat-completions'
import { MAX_CORRECTION_CHARS } from '../internal/extraction-pipeline'

/**
 * Conservative characters per token. Cyrillic tokenises at roughly two characters per token or
 * worse, so the estimate never undercounts our text; MP-04 compares it with the runtime's reported
 * prompt tokens and tunes it (ADR §8.4).
 */
export const CHARS_PER_TOKEN = 2
/** Chat-template overhead per request: role markers of up to three messages, rounded up. */
export const MESSAGE_OVERHEAD_TOKENS = 32
/** The correction retry's worst case (§5.1): its prefix plus the longest hint. */
export const CORRECTION_RESERVE_CHARS = CORRECTION_PREFIX.length + MAX_CORRECTION_CHARS

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export type FitWindow = { contextTokens: number; maxAnswerTokens: number }

function instructionChars(instruction: string | undefined): number {
  return Math.min((instruction ?? DEFAULT_EXTRACTION_INSTRUCTION).length, MAX_EXTRACTION_INSTRUCTION_CHARS)
}

/**
 * Whether one request fits the route's window (VCF `promptFits`, ADR §5.1 `PROMPT_TOO_LARGE`): the
 * prompt, the answer reserve and the correction reserve. The correction is reserved on the first
 * request too, so a request that fits never overflows on its retry.
 */
export function promptFits(route: FitWindow, instruction: string | undefined, inputChars: number): boolean {
  const promptChars =
    instructionChars(instruction) + Math.min(inputChars, MAX_EXTRACTION_INPUT_CHARS) + CORRECTION_RESERVE_CHARS
  return estimateTokens(promptChars) + MESSAGE_OVERHEAD_TOKENS + route.maxAnswerTokens <= route.contextTokens
}

/**
 * The largest page text the configured local route accepts (ADR §2.1 input ceiling), from the
 * route's configured window, never a runtime default; below `MAX_EXTRACTION_INPUT_CHARS`, never
 * negative. Its consumer cuts the page text itself and reports `truncated`.
 */
export function routerInputCeilingChars(route: FitWindow, instruction?: string): number {
  const tokens = route.contextTokens - route.maxAnswerTokens - MESSAGE_OVERHEAD_TOKENS
  const chars = tokens * CHARS_PER_TOKEN - instructionChars(instruction) - CORRECTION_RESERVE_CHARS
  return Math.max(0, Math.min(chars, MAX_EXTRACTION_INPUT_CHARS))
}
