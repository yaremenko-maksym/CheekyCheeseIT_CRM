import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import { describe, expect, it } from 'vitest'
import { assertModelAllowed, type GateAllowed } from './ai-input-gate'
import {
  buildExtractionPrompt,
  MAX_MODEL_INPUT_CHARS,
  MAX_NONCE_CHARS,
  MAX_PROMPT_CHARS,
} from './prompt-envelope'

const decision = assertModelAllowed('yes', { onUnspecified: 'block' })
if (decision !== 'ALLOWED') throw new Error('an explicit ai-input=yes must be allowed')
const GATE: GateAllowed = decision

describe('buildExtractionPrompt — fits the inference port input cut', () => {
  it('the local prompt bound is the package value (the port cuts the user message there)', () => {
    expect(MAX_PROMPT_CHARS).toBe(MAX_EXTRACTION_INPUT_CHARS)
    expect(MAX_PROMPT_CHARS).toBe(50_000)
  })

  it.each([49_900, 50_000, 60_000])(
    'a %i-char page: the whole prompt fits, so the port cut keeps the closing delimiter',
    (length) => {
      const prompt = buildExtractionPrompt(GATE, 'a'.repeat(length))
      expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
      const asSent = prompt.user.slice(0, MAX_EXTRACTION_INPUT_CHARS)
      expect(asSent.endsWith(`\n${prompt.delimiter}>>>`)).toBe(true)
      expect(prompt.truncated).toBe(true)
    },
  )

  it('a page exactly at the data cap is sent whole and fills the bound exactly', () => {
    const prompt = buildExtractionPrompt(GATE, 'a'.repeat(MAX_MODEL_INPUT_CHARS))
    expect(prompt.truncated).toBe(false)
    expect(prompt.user).toContain(`\n${'a'.repeat(MAX_MODEL_INPUT_CHARS)}\n`)
    // The real nonce has the maximum length, so the cap leaves no slack.
    expect(prompt.system.length + prompt.user.length).toBe(MAX_PROMPT_CHARS)
  })

  it('a nonce longer than the framing allows is refused; one at the limit is used', () => {
    expect(MAX_NONCE_CHARS).toBe(32)
    expect(() => buildExtractionPrompt(GATE, 'page', () => 'f'.repeat(33))).toThrow(/delimiter/i)
    expect(buildExtractionPrompt(GATE, 'page', () => 'f'.repeat(32)).delimiter).toBe(
      `PAGE-DATA-${'f'.repeat(32)}`,
    )
  })
})
