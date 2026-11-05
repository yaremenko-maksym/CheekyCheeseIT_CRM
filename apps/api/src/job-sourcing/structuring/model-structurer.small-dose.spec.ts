import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '@crm/inference'
import { describe, expect, it } from 'vitest'
import { modelReplySchema } from './extraction-result-guard'
import type { DiscoveredRecord, HtmlStructurerRequest } from './html-structurer.port'
import { InMemoryModelBudget } from './model-budget.port'
import { ModelStructurer } from './model-structurer'

const PAGE = 'Senior Go Engineer at Acme, Kyiv. Details: https://jobs.example.com/vacancy/1'

const GOOD: ExtractionResult<unknown> = {
  ok: true,
  data: {
    extractionVersion: 'model-says-v9',
    records: [
      {
        title: 'Senior Go Engineer',
        uncertainty: 0.1,
        evidence: [{ field: 'title', quote: 'Senior Go Engineer' }],
      },
    ],
  },
}

function fakePort(reply: (req: ExtractionRequest<unknown>) => ExtractionResult<unknown>) {
  const calls: ExtractionRequest<unknown>[] = []
  const port: ExtractionPort = {
    extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      calls.push(req as ExtractionRequest<unknown>)
      return Promise.resolve(reply(req as ExtractionRequest<unknown>)) as Promise<
        ExtractionResult<T>
      >
    },
  }
  return { port, calls }
}

const rec = (id: string, over: Partial<DiscoveredRecord> = {}): DiscoveredRecord => ({
  id,
  url: `https://jobs.example.com/vacancy/${id}`,
  text: PAGE,
  ...over,
})

const request = (records: DiscoveredRecord[]): HtmlStructurerRequest => ({
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records,
  extractionVersion: 'html-v1',
})

const asked = (req: ExtractionRequest<unknown> | undefined) =>
  req?.smallDose?.groups.map(({ name }) => name)

describe('ModelStructurer: the small dose it supplies (ADR 5.4, 6.1)', () => {
  it('always supplies smallDose and the record-composed reply schema', async () => {
    const { port, calls } = fakePort(() => GOOD)
    const budget = new InMemoryModelBudget()
    await new ModelStructurer({ port, budget }).structure(request([rec('a'), rec('b')]))
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.schema).toBe(modelReplySchema)
      expect(call.smallDose).toBeDefined()
    }
  })

  it('a record with no `missing` asks the whole table', async () => {
    const { port, calls } = fakePort(() => GOOD)
    await new ModelStructurer({ port, budget: new InMemoryModelBudget() }).structure(
      request([rec('a')]),
    )
    expect(asked(calls[0])).toEqual(['identity', 'place', 'terms', 'description'])
  })

  it('narrows the floor to what Stage B left empty, per record', async () => {
    const { port, calls } = fakePort(() => GOOD)
    await new ModelStructurer({ port, budget: new InMemoryModelBudget() }).structure(
      request([rec('a', { missing: ['employmentType'] }), rec('b', { missing: [] })]),
    )
    expect(asked(calls[0])).toEqual(['identity', 'terms'])
    expect(asked(calls[1])).toEqual(['identity'])
  })

  it('each call has its own signal, not aborted on a normal run', async () => {
    const { port, calls } = fakePort(() => GOOD)
    await new ModelStructurer({ port, budget: new InMemoryModelBudget() }).structure(
      request([rec('a'), rec('b')]),
    )
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.signal).not.toBe(calls[1]?.signal)
    expect(calls[0]?.signal?.aborted).toBe(false)
  })

  it('postingsOnPage 2 ends in a per-record INVALID_OUTPUT issue: no record, not "no postings"', async () => {
    // What the router does with a refused merge: the public code is INVALID_OUTPUT.
    const { port } = fakePort((req) => {
      const merged = req.smallDose?.merge({ identity: { postingsOnPage: 2 } })
      return merged?.ok === true
        ? { ok: true, data: merged.data }
        : { ok: false, code: 'INVALID_OUTPUT' }
    })
    const outcome = await new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(),
    }).structure(request([rec('a')]))
    expect(outcome).toEqual({
      kind: 'EXTRACTOR_FAILED',
      code: 'INVALID_OUTPUT',
      remainingIds: [],
      perRecordIssues: [
        {
          id: 'a',
          failure: 'INVALID_OUTPUT',
          droppedRecords: 0,
          nulledUrls: 0,
          droppedEvidence: 0,
          nulledFacts: 0,
        },
      ],
    })
  })

  it('a merged floor record carries the discovered id', async () => {
    const { port } = fakePort((req) => {
      const merged = req.smallDose?.merge({
        identity: { postingsOnPage: 1 },
        place: { location: 'Kyiv', locationQuote: 'Acme, Kyiv', remote: null },
        terms: { employmentType: null, employmentTypeQuote: null },
        description: { description: null, descriptionQuote: null },
      })
      if (merged?.ok !== true) throw new Error('expected a merged record')
      return { ok: true, data: merged.data }
    })
    const outcome = await new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(),
    }).structure(request([rec('a')]))
    expect(outcome).toMatchObject({
      kind: 'EXTRACTED',
      extractionVersion: 'html-v1',
      records: [{ sourceId: 'a', location: 'Kyiv' }],
      perRecordIssues: [],
    })
  })

  it('a hosted reply with two records is refused by the schema the port receives', () => {
    const record = (GOOD as { data: { records: unknown[] } }).data.records[0]
    expect(
      modelReplySchema.safeParse({ extractionVersion: 'v', records: [record, record] }).success,
    ).toBe(false)
  })

  it('the guard still drops one bad URL per field behind the port', async () => {
    const { port } = fakePort(() => ({
      ok: true,
      data: {
        extractionVersion: 'v',
        records: [
          {
            title: 'Senior Go Engineer',
            uncertainty: 0.1,
            postingUrl: 'https://evil.example/not-on-the-page',
            applyUrl: 'https://jobs.example.com/vacancy/1',
            evidence: [{ field: 'title', quote: 'Senior Go Engineer' }],
          },
        ],
      },
    }))
    const outcome = await new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(),
    }).structure(request([rec('a')]))
    expect(outcome).toMatchObject({
      kind: 'EXTRACTED',
      records: [{ postingUrl: null, applyUrl: 'https://jobs.example.com/vacancy/1' }],
      perRecordIssues: [{ id: 'a', failure: null, nulledUrls: 1 }],
    })
  })

  it('counts a nulled fact as an issue of its own', async () => {
    const { port } = fakePort(() => ({
      ok: true,
      data: {
        extractionVersion: 'v',
        records: [
          {
            title: 'Senior Go Engineer',
            location: 'Atlantis',
            uncertainty: 0.1,
            evidence: [{ field: 'title', quote: 'Senior Go Engineer' }],
          },
        ],
      },
    }))
    const outcome = await new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(),
    }).structure(request([rec('a')]))
    expect(outcome).toMatchObject({
      records: [{ location: null }],
      perRecordIssues: [
        { id: 'a', failure: null, nulledFacts: 1, droppedRecords: 0, droppedEvidence: 0 },
      ],
    })
  })
})

describe('ModelStructurer: local time reaches the budget (ADR 5.5.6)', () => {
  const twoRecordsAfter = async (first: ExtractionResult<unknown>) => {
    const { port, calls } = fakePort(() => first)
    const outcome = await new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(20, 100),
    }).structure(request([rec('a'), rec('b')]))
    return { outcome, calls }
  }

  it('a success spending the limit stops the next record with CYCLE_LIMIT', async () => {
    const { outcome, calls } = await twoRecordsAfter({ ...GOOD, usage: { localMs: 100 } })
    expect(calls).toHaveLength(1)
    expect(outcome).toMatchObject({
      kind: 'PARTIAL',
      remainingIds: ['b'],
      stoppedBy: { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' },
    })
  })

  it('a failure spending the limit stops the next record too', async () => {
    const { outcome, calls } = await twoRecordsAfter({
      ok: false,
      code: 'INVALID_OUTPUT',
      usage: { localMs: 100 },
    })
    expect(calls).toHaveLength(1)
    expect(outcome).toMatchObject({
      kind: 'PARTIAL',
      remainingIds: ['b'],
      stoppedBy: { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' },
    })
  })

  it('under the limit both records run', async () => {
    const { outcome, calls } = await twoRecordsAfter({ ...GOOD, usage: { localMs: 99 } })
    expect(calls).toHaveLength(2)
    expect(outcome).toMatchObject({ kind: 'EXTRACTED' })
  })
})
