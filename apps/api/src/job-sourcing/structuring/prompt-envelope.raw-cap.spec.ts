import { describe, expect, it } from 'vitest'
import { expectScaling, SCALING_TEST_TIMEOUT_MS } from './__test-helpers__/scaling'
import { assertModelAllowed } from './ai-input-gate'
import { CONTACT_TOKEN } from './contact-strip'
import {
  buildExtractionPrompt,
  MAX_MODEL_INPUT_CHARS,
  MAX_RAW_INPUT_CHARS,
  RAW_CUT_TAIL_DROP,
} from './prompt-envelope'

const GATE = assertModelAllowed('yes', { onUnspecified: 'block' })
if (GATE !== 'ALLOWED') throw new Error('an explicit ai-input=yes must be allowed')

const CAP = MAX_MODEL_INPUT_CHARS
const RAW = MAX_RAW_INPUT_CHARS
const ZWSP = '​'

function data(page: string): { text: string; truncated: boolean } {
  const prompt = buildExtractionPrompt(GATE, page)
  const open = `<<<${prompt.delimiter}\n`
  const start = prompt.user.indexOf(open) + open.length
  const end = prompt.user.lastIndexOf(`\n${prompt.delimiter}>>>`)
  return { text: prompt.user.slice(start, end), truncated: prompt.truncated }
}

describe('buildExtractionPrompt — raw input cap (before NFKC)', () => {
  it('the raw cap is 4x the model input cap and the tail drop covers a whole contact', () => {
    expect(RAW).toBe(4 * CAP)
    expect(RAW_CUT_TAIL_DROP).toBe(2_048)
  })

  it(
    '1M chars that NFKC expands 18x stay bounded in time and length',
    () => {
      const page = 'ﷺ'.repeat(1_000_000)
      const fourTimes = 'ﷺ'.repeat(4_000_000)
      // Cut before NFKC, so 4x the input costs about the same, never 4x (factor 3 tells them apart).
      expectScaling(
        () => data(page),
        () => data(fourTimes),
        3,
      )
      const out = data(page)
      expect(out.truncated).toBe(true)
      expect(out.text.length).toBeLessThanOrEqual(CAP)
      expect(out.text.length).toBeGreaterThan(CAP - 100)
    },
    SCALING_TEST_TIMEOUT_MS,
  )

  it('raw text exactly at the raw cap is not raw-cut', () => {
    const out = data(ZWSP.repeat(RAW - 16) + 'jane@example.com')
    expect(out).toEqual({ text: CONTACT_TOKEN, truncated: false })
  })

  it('a contact split by the raw cut never leaks its first half', () => {
    // The cut keeps `jane@exa`: not an address any more, so only the tail drop protects it.
    const out = data(ZWSP.repeat(RAW - 8) + 'jane@example.com')
    expect(out.truncated).toBe(true)
    expect(out.text).not.toContain('jane')
    expect(out.text).toBe('')
  })

  it('after a raw cut that shrinks below the model cap, exactly the tail drop is withheld', () => {
    const out = data(ZWSP.repeat(RAW - 3_000) + 'b'.repeat(3_001))
    expect(out).toEqual({
      text: 'b'.repeat(3_000 - RAW_CUT_TAIL_DROP - CONTACT_TOKEN.length),
      truncated: true,
    })
  })

  it('a split contact longer than the kept text leaves nothing, not the text minus a count from the end', () => {
    // 2 050 chars survive the raw cut: 2 050 - 2 048 - 9 < 0 must keep 0 chars, never `slice(0, -7)`.
    const out = data(ZWSP.repeat(RAW - 2_050) + 'c'.repeat(2_200))
    expect(out).toEqual({ text: '', truncated: true })
  })

  it('after a raw cut that stays above the model cap, the model cap decides', () => {
    const out = data('a'.repeat(RAW + 1))
    expect(out).toEqual({ text: 'a'.repeat(CAP - CONTACT_TOKEN.length), truncated: true })
  })
})
