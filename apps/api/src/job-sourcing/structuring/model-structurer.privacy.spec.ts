import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '@crm/inference'
import { describe, expect, it } from 'vitest'
import type { HtmlStructurerRequest } from './html-structurer.port'
import { InMemoryModelBudget } from './model-budget.port'
import { ModelStructurer } from './model-structurer'

const SENTINEL = 'PAGE-SENTINEL-9f2c'
const QUOTE = 'Senior Go Engineer'

const GOOD: ExtractionResult<unknown> = {
  ok: true,
  data: {
    extractionVersion: 'v',
    records: [{ title: QUOTE, uncertainty: 0.1, evidence: [{ field: 'title', quote: QUOTE }] }],
  },
}

const request: HtmlStructurerRequest = {
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records: [
    { id: 'a', url: 'https://jobs.example.com/vacancy/a', text: `${QUOTE} ${SENTINEL}` },
    { id: 'b', url: 'https://jobs.example.com/vacancy/b', text: QUOTE },
  ],
  extractionVersion: 'html-v1',
}

function structurerWith(onSentinelPage: () => Promise<ExtractionResult<unknown>>) {
  const port: ExtractionPort = {
    extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      const reply = req.input.includes(SENTINEL) ? onSentinelPage() : Promise.resolve(GOOD)
      return reply as Promise<ExtractionResult<T>>
    },
  }
  return new ModelStructurer({ port, budget: new InMemoryModelBudget(5) })
}

describe('ModelStructurer: what an outcome carries (AC5)', () => {
  it.each([
    'INVALID_OUTPUT',
    'TIMEOUT',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'NOT_CONFIGURED',
  ] as const)('a %s reply: the outcome has codes and ids, never the page text', async (code) => {
    const outcome = await structurerWith(() => Promise.resolve({ ok: false, code })).structure(
      request,
    )
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL)
  })

  it('a port that throws with the page text in its message leaks nothing', async () => {
    const outcome = await structurerWith(() =>
      Promise.reject(new Error(`boom ${SENTINEL} Bearer sk-abc`)),
    ).structure(request)
    const text = JSON.stringify(outcome)
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain('Bearer')
  })

  it('a reply of the wrong shape, echoing the page, is dropped with its text', async () => {
    const outcome = await structurerWith(() =>
      Promise.resolve({ ok: true, data: { echoed: SENTINEL } }),
    ).structure(request)
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL)
  })
})
