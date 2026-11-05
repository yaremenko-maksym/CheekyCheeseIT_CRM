import { describe, expect, it } from 'vitest'
import { MAX_EXTRACTION_INPUT_CHARS } from '../contracts/extraction'
import { DEFAULT_EXTRACTION_INSTRUCTION } from '../internal/chat-completions'
import {
  CORRECTION_RESERVE_CHARS,
  estimateTokens,
  MESSAGE_OVERHEAD_TOKENS,
  promptFits,
  routerInputCeilingChars,
} from './fit'

const route = { contextTokens: 4096, maxAnswerTokens: 600 }

describe('fit (ADR §5.1 PROMPT_TOO_LARGE, §2.1 input ceiling)', () => {
  it('estimates two characters per token, rounded up', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(4)).toBe(2)
    expect(estimateTokens(5)).toBe(3)
  })

  it('reserves the correction prefix plus the 500-character hint', () => {
    expect(CORRECTION_RESERVE_CHARS).toBe('Your previous answer was rejected. '.length + 500)
    expect(MESSAGE_OVERHEAD_TOKENS).toBe(32)
  })

  it('the ceiling is exactly the largest input that fits (hand-computed for a 4096 window)', () => {
    // (4096 - 600 - 32) * 2 - instruction - correction reserve
    const expected = 3464 * 2 - DEFAULT_EXTRACTION_INSTRUCTION.length - CORRECTION_RESERVE_CHARS
    const ceiling = routerInputCeilingChars(route)
    expect(ceiling).toBe(expected)
    expect(promptFits(route, undefined, ceiling)).toBe(true)
    expect(promptFits(route, undefined, ceiling + 1)).toBe(false)
  })

  it('a longer instruction lowers the ceiling by its length', () => {
    const instruction = 'x'.repeat(1000)
    expect(routerInputCeilingChars(route, instruction)).toBe(
      3464 * 2 - 1000 - CORRECTION_RESERVE_CHARS,
    )
    expect(promptFits(route, instruction, routerInputCeilingChars(route, instruction))).toBe(true)
  })

  it('an instruction longer than the send cut counts only up to the cut', () => {
    expect(routerInputCeilingChars(route, 'x'.repeat(9000))).toBe(
      routerInputCeilingChars(route, 'x'.repeat(4000)),
    )
  })

  it('never exceeds MAX_EXTRACTION_INPUT_CHARS and never goes negative', () => {
    expect(routerInputCeilingChars({ contextTokens: 1_000_000, maxAnswerTokens: 600 })).toBe(
      MAX_EXTRACTION_INPUT_CHARS,
    )
    expect(routerInputCeilingChars({ contextTokens: 100, maxAnswerTokens: 600 })).toBe(0)
  })

  it('a window equal to the answer reserve fits nothing', () => {
    expect(promptFits({ contextTokens: 600, maxAnswerTokens: 600 }, undefined, 0)).toBe(false)
  })

  it('an input beyond the send cut is counted at the cut', () => {
    const huge = { contextTokens: 1_000_000, maxAnswerTokens: 600 }
    expect(promptFits(huge, undefined, MAX_EXTRACTION_INPUT_CHARS * 10)).toBe(true)
  })
})

describe('the ceiling over a small-dose table (ADR §5.5 item 4)', () => {
  type Group = { instruction: string; maxAnswerTokens: number }
  const instruction = 'the envelope'
  const groupFits = (group: Group, chars: number, base = instruction) =>
    promptFits(
      { contextTokens: route.contextTokens, maxAnswerTokens: group.maxAnswerTokens },
      `${base}\n\n${group.instruction}`,
      chars,
    )
  const SMALL = { instruction: 'a small ask', maxAnswerTokens: 32 }
  const BIG_ANSWER = { instruction: 'a short ask', maxAnswerTokens: 1_200 }
  const LONG_ASK = { instruction: 'x'.repeat(3_000), maxAnswerTokens: 32 }

  it.each<[string, Group[]]>([
    ['the largest answer', [SMALL, BIG_ANSWER]],
    ['the largest answer, listed first', [BIG_ANSWER, SMALL]],
    ['the longest instruction', [SMALL, LONG_ASK, BIG_ANSWER]],
  ])('a page cut to it fits every group, the tightest being %s', (_name, groups) => {
    const ceiling = routerInputCeilingChars(route, instruction, groups)
    for (const group of groups) expect(groupFits(group, ceiling)).toBe(true)
    expect(groups.some((group) => !groupFits(group, ceiling + 1))).toBe(true)
  })

  it('the route alone would overflow a group with a larger answer', () => {
    const alone = routerInputCeilingChars(route, instruction)
    expect(groupFits(BIG_ANSWER, alone)).toBe(false)
  })

  it('still holds for the route when its own answer is the largest', () => {
    const wide = { contextTokens: route.contextTokens, maxAnswerTokens: 3_000 }
    expect(routerInputCeilingChars(wide, instruction, [SMALL])).toBe(
      routerInputCeilingChars(wide, instruction),
    )
  })

  it('no instruction means the default one, in the groups too', () => {
    const ceiling = routerInputCeilingChars(route, undefined, [BIG_ANSWER])
    expect(groupFits(BIG_ANSWER, ceiling, DEFAULT_EXTRACTION_INSTRUCTION)).toBe(true)
    expect(groupFits(BIG_ANSWER, ceiling + 1, DEFAULT_EXTRACTION_INSTRUCTION)).toBe(false)
  })

  it('an empty table changes nothing', () => {
    expect(routerInputCeilingChars(route, instruction, [])).toBe(
      routerInputCeilingChars(route, instruction),
    )
  })

  it('never exceeds MAX_EXTRACTION_INPUT_CHARS and never goes negative', () => {
    const huge = { contextTokens: 1_000_000, maxAnswerTokens: 600 }
    expect(routerInputCeilingChars(huge, instruction, [BIG_ANSWER])).toBe(
      MAX_EXTRACTION_INPUT_CHARS,
    )
    const tiny = { contextTokens: 1_000, maxAnswerTokens: 10 }
    expect(routerInputCeilingChars(tiny, instruction, [BIG_ANSWER])).toBe(0)
  })
})
