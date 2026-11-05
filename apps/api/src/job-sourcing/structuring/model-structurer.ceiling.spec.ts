import {
  routerInputCeilingChars,
  type ExtractionPort,
  type ExtractionRequest,
  type ExtractionResult,
} from '@crm/inference'
import { describe, expect, it } from 'vitest'
import type { HtmlStructurerRequest, StructurerOutcome } from './html-structurer.port'
import { InMemoryModelBudget } from './model-budget.port'
import { ModelStructurer } from './model-structurer'
import {
  buildExtractionPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  MAX_MODEL_INPUT_CHARS,
} from './prompt-envelope'
import { smallDoseFor } from './small-dose-table'

const GATE = 'ALLOWED' as Parameters<typeof buildExtractionPrompt>[0]
const QUOTE = 'Senior Go Engineer'
const CEILING = 2_000

const good: ExtractionResult<unknown> = {
  ok: true,
  data: {
    extractionVersion: 'v',
    records: [{ title: QUOTE, uncertainty: 0.1, evidence: [{ field: 'title', quote: QUOTE }] }],
  },
}

function structurerOver(inputCeilingChars?: number) {
  const inputs: string[] = []
  const port: ExtractionPort = {
    extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      inputs.push(req.input)
      const answer = inputs.length === 1 && req.input.includes('BAD') ? badReply : good
      return Promise.resolve(answer) as Promise<ExtractionResult<T>>
    },
  }
  const structurer = new ModelStructurer({
    port,
    budget: new InMemoryModelBudget(10),
    ...(inputCeilingChars !== undefined && { inputCeilingChars }),
  })
  return { structurer, inputs }
}
const badReply: ExtractionResult<unknown> = { ok: false, code: 'INVALID_OUTPUT' }

const request = (...texts: [string, string][]): HtmlStructurerRequest => ({
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records: texts.map(([id, text]) => ({
    id,
    url: `https://jobs.example.com/vacancy/${id}`,
    text,
  })),
  extractionVersion: 'html-v1',
})

const issuesOf = (outcome: StructurerOutcome) =>
  'perRecordIssues' in outcome ? outcome.perRecordIssues : []

describe('buildExtractionPrompt: the input ceiling (ADR 2.1)', () => {
  it('cuts the page so the whole user message stays within the ceiling, and says so', () => {
    const prompt = buildExtractionPrompt(GATE, 'a'.repeat(5_000), undefined, CEILING)
    expect(prompt.truncated).toBe(true)
    expect(prompt.user.length).toBeLessThanOrEqual(CEILING)
    expect(prompt.user.length).toBeGreaterThan(CEILING / 2)
    expect(prompt.user.endsWith(`\n${prompt.delimiter}>>>`)).toBe(true)
  })

  it('a page under the ceiling is sent whole', () => {
    const page = 'a'.repeat(100)
    const prompt = buildExtractionPrompt(GATE, page, undefined, CEILING)
    expect(prompt.truncated).toBe(false)
    expect(prompt.user).toContain(`\n${page}\n`)
  })

  it('never widens the data cap: a ceiling above it changes nothing', () => {
    const page = 'a'.repeat(MAX_MODEL_INPUT_CHARS + 1)
    const wide = buildExtractionPrompt(GATE, page, undefined, 10 * MAX_MODEL_INPUT_CHARS)
    expect(wide.truncated).toBe(true)
    expect(wide.user.length).toBe(buildExtractionPrompt(GATE, page).user.length)
  })

  it('a ceiling smaller than the framing sends no page text rather than the tail', () => {
    const prompt = buildExtractionPrompt(GATE, 'TAIL-OF-PAGE', undefined, 1)
    expect(prompt.truncated).toBe(true)
    expect(prompt.user).not.toContain('TAIL-OF-PAGE')
  })
})

describe('routerInputCeilingChars over the real small-dose table (ADR 5.5 item 4)', () => {
  // The route's own answer budget is below the description group's: the case the route alone misses.
  const window = { contextTokens: 8_192, maxAnswerTokens: 600 }

  it('a page cut to it fits every group of the whole table', () => {
    const { groups } = smallDoseFor()
    const ceiling = routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT, groups)
    expect(ceiling).toBeGreaterThan(0)
    expect(ceiling).toBeLessThan(routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT))
    for (const { instruction, maxAnswerTokens } of groups) {
      const asked = `${EXTRACTION_SYSTEM_PROMPT}\n\n${instruction}`
      expect(ceiling).toBeLessThanOrEqual(
        routerInputCeilingChars({ contextTokens: window.contextTokens, maxAnswerTokens }, asked),
      )
    }
  })
})

describe('ModelStructurer: inputCeilingChars at construction', () => {
  it.each([0, -1, NaN, Infinity, -Infinity])('%s is refused', (inputCeilingChars) => {
    expect(() => structurerOver(inputCeilingChars)).toThrow(/inputCeilingChars/)
  })

  it('a positive ceiling and no ceiling are accepted', () => {
    expect(() => structurerOver(1)).not.toThrow()
    expect(() => structurerOver()).not.toThrow()
  })
})

describe('ModelStructurer: a page over the ceiling (ADR 6.1)', () => {
  const LONG = `${QUOTE} ${'a'.repeat(5_000)}`

  it('is cut, reports `truncated`, and does not stop the records behind it', async () => {
    const { structurer, inputs } = structurerOver(CEILING)
    const outcome = await structurer.structure(request(['long', LONG], ['short', QUOTE]))
    expect(outcome.kind).toBe('EXTRACTED')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]!.length).toBeLessThanOrEqual(CEILING)
    expect(issuesOf(outcome)).toEqual([
      {
        id: 'long',
        failure: null,
        droppedRecords: 0,
        nulledUrls: 0,
        droppedEvidence: 0,
        nulledFacts: 0,
        truncated: true,
      },
    ])
  })

  it('a record that failed on a cut page reports both', async () => {
    const { structurer } = structurerOver(CEILING)
    const outcome = await structurer.structure(request(['long', `BAD ${LONG}`], ['short', QUOTE]))
    expect(issuesOf(outcome)).toEqual([
      expect.objectContaining({ id: 'long', failure: 'INVALID_OUTPUT', truncated: true }),
    ])
  })

  it('an uncut page carries no flag, and with no ceiling set nothing is cut', async () => {
    const { structurer, inputs } = structurerOver()
    const outcome = await structurer.structure(request(['long', LONG]))
    expect(inputs[0]).toContain(LONG)
    expect(issuesOf(outcome)).toEqual([])
    const bad = structurerOver()
    const failed = await bad.structurer.structure(request(['a', 'BAD'], ['b', QUOTE]))
    expect(issuesOf(failed)[0]).not.toHaveProperty('truncated')
  })
})
