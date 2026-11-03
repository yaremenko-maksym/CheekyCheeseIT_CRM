import { describe, expect, it } from 'vitest'
import { expectScaling, SCALING_TEST_TIMEOUT_MS } from './__test-helpers__/scaling'
import { guardExtractionResult, MIN_EVIDENCE_QUOTE_CHARS } from './extraction-result-guard'

/** CR-M-3: a quote proves a field only if it is long enough to be specific, or is the field itself. */
const EVIDENCE = 'Senior Rust Engineer at Acme, Lviv. Remote: yes. Salary 6 000 USD.'
const CTX = { evidenceText: EVIDENCE, verifiedUrls: [] }

function guardQuotes(
  evidence: ReadonlyArray<{ field: string; quote: string }>,
  record: Record<string, unknown> = {},
  evidenceText = EVIDENCE,
) {
  const raw = JSON.stringify({
    extractionVersion: 'v1',
    records: [
      { title: 'Senior Rust Engineer', company: 'Acme', uncertainty: 0.2, ...record, evidence },
    ],
  })
  const result = guardExtractionResult(raw, { ...CTX, evidenceText })
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return { kept: result.records[0]?.evidence ?? [], dropped: result.droppedEvidence }
}

describe('guardExtractionResult — evidence quote length (CR-M-3)', () => {
  it('the floor is 8 non-whitespace characters', () => {
    expect(MIN_EVIDENCE_QUOTE_CHARS).toBe(8)
  })

  it.each([
    ['one char', 'a'],
    ['whitespace only', '   '],
    ['seven non-whitespace chars', 'Senior R'],
    ['seven chars padded with spaces', ' Lviv. R'],
  ])('%s is not evidence', (_name, quote) => {
    expect(guardQuotes([{ field: 'title', quote }])).toEqual({ kept: [], dropped: 1 })
  })

  it('eight non-whitespace chars occurring in the text are evidence', () => {
    const span = { field: 'title', quote: 'Senior Ru' }
    expect(guardQuotes([span])).toEqual({ kept: [span], dropped: 0 })
  })

  it('a short quote equal to the whole field value is evidence', () => {
    const span = { field: 'company', quote: 'Acme' }
    expect(guardQuotes([span])).toEqual({ kept: [span], dropped: 0 })
  })

  it('a short quote equal to the field after trimming is evidence', () => {
    const span = { field: 'company', quote: 'Acme' }
    expect(guardQuotes([span], { company: '  Acme ' })).toEqual({ kept: [span], dropped: 0 })
  })

  it('a short quote padded with spaces still matches its field', () => {
    const span = { field: 'company', quote: ' Acme' }
    expect(guardQuotes([span])).toEqual({ kept: [span], dropped: 0 })
  })

  it('a whitespace quote equal to a blank field is not evidence', () => {
    expect(guardQuotes([{ field: 'company', quote: ' ' }], { company: ' ' })).toEqual({
      kept: [],
      dropped: 1,
    })
  })

  it('a short quote equal to the field but absent from the text is not evidence', () => {
    expect(guardQuotes([{ field: 'company', quote: 'Acne' }], { company: 'Acne' })).toEqual({
      kept: [],
      dropped: 1,
    })
  })

  it('a short quote equal to a different field is not evidence for this one', () => {
    expect(guardQuotes([{ field: 'title', quote: 'Acme' }])).toEqual({ kept: [], dropped: 1 })
  })

  it('a short quote for a null field is not evidence', () => {
    expect(guardQuotes([{ field: 'location', quote: 'Lviv' }])).toEqual({ kept: [], dropped: 1 })
  })

  it('a boolean field never has evidence, short or long (SR-M-7)', () => {
    const long = { field: 'remote', quote: 'Remote: yes' }
    expect(guardQuotes([{ field: 'remote', quote: 'yes' }, long], { remote: true })).toEqual({
      kept: [],
      dropped: 2,
    })
  })

  it('a short quote equal to a URL field that was nulled is not evidence', () => {
    expect(guardQuotes([{ field: 'applyUrl', quote: 'x.io' }], { applyUrl: 'x.io' })).toEqual({
      kept: [],
      dropped: 1,
    })
  })

  it('a long quote that is not in the text is still not evidence', () => {
    expect(guardQuotes([{ field: 'title', quote: 'Principal Rust Engineer' }])).toEqual({
      kept: [],
      dropped: 1,
    })
  })
})

describe('guardExtractionResult — evidence must be about its field (SR-M-7)', () => {
  it('an unrelated 8+ char snippet from the page is not evidence', () => {
    expect(
      guardQuotes([{ field: 'salary', quote: 'Senior Rust' }], { salary: '6 000 USD' }),
    ).toEqual({ kept: [], dropped: 1 })
  })

  it('a quote containing the value is evidence', () => {
    const span = { field: 'salary', quote: 'Salary 6 000 USD' }
    expect(guardQuotes([span], { salary: '6 000 USD' })).toEqual({ kept: [span], dropped: 0 })
  })

  it('case and whitespace runs are ignored when relating quote and value', () => {
    const span = { field: 'title', quote: 'Senior Rust Engineer' }
    expect(guardQuotes([span], { title: ' senior  RUST\nengineer ' })).toEqual({
      kept: [span],
      dropped: 0,
    })
  })

  it('case is compared by full case folding: STRASSE quotes Straße', () => {
    const span = { field: 'company', quote: 'STRASSE GMBH' }
    const page = 'Employer: STRASSE GMBH, Berlin.'
    expect(guardQuotes([span], { company: 'Straße GmbH' }, page)).toEqual({
      kept: [span],
      dropped: 0,
    })
  })

  it('whitespace collapses to one space, never to nothing: words stay apart', () => {
    expect(
      guardQuotes([{ field: 'company', quote: 'Senior Rust' }], { company: 'SeniorRust' }),
    ).toEqual({ kept: [], dropped: 1 })
  })

  it('a passage of a long text value is evidence', () => {
    const span = { field: 'description', quote: 'Engineer at Acme' }
    const description = 'We hire a Senior Rust Engineer at Acme, Lviv, for a payments team.'
    expect(guardQuotes([span], { description })).toEqual({ kept: [span], dropped: 0 })
  })

  it('a short quote containing the value but not equal to it is not evidence', () => {
    expect(guardQuotes([{ field: 'company', quote: 'Acme,' }])).toEqual({ kept: [], dropped: 1 })
  })

  it('a long page quote for a blank field is not evidence', () => {
    expect(guardQuotes([{ field: 'company', quote: 'Senior Rust' }], { company: ' ' })).toEqual({
      kept: [],
      dropped: 1,
    })
  })
})

describe('guardExtractionResult — evidence cost (SR-M-9)', () => {
  // Each quote is a passage at the start of a long description. Normalising the value once per
  // record keeps the cost linear in the reply; once per quote it grows as quotes x value length.
  const QUOTE = 'We hire a Senior Rust Engineer'
  const ctx = { evidenceText: QUOTE, verifiedUrls: [] }

  function reply(valueChars: number, quotes: number): string {
    const description = QUOTE + ' x'.repeat(valueChars / 2)
    const evidence = Array.from({ length: quotes }, () => ({ field: 'description', quote: QUOTE }))
    const record = { title: 'Senior Rust Engineer', description, uncertainty: 0.1, evidence }
    return JSON.stringify({ extractionVersion: 'v1', records: Array(50).fill(record) })
  }

  it(
    '4x the value length and 4x the quotes cost about 4x, not 16x',
    () => {
      const small = reply(4_900, 25)
      const big = reply(19_900, 100)
      expect(guardExtractionResult(big, ctx)).toMatchObject({ ok: true, droppedEvidence: 0 })
      expectScaling(
        () => guardExtractionResult(small, ctx),
        () => guardExtractionResult(big, ctx),
        8,
      )
    },
    SCALING_TEST_TIMEOUT_MS,
  )
})

describe('guardExtractionResult — URL evidence (SR-M-7)', () => {
  const URL = 'https://acme.io/jobs/1'
  const ctx = { evidenceText: `Senior Rust Engineer. Apply: ${URL} today.`, verifiedUrls: [] }

  function guardUrlQuotes(evidence: ReadonlyArray<{ field: string; quote: string }>) {
    const raw = JSON.stringify({
      extractionVersion: 'v1',
      records: [
        {
          title: 'Senior Rust Engineer',
          postingUrl: URL,
          applyUrl: URL,
          uncertainty: 0.1,
          evidence,
        },
      ],
    })
    const result = guardExtractionResult(raw, ctx)
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
    return { kept: result.records[0]?.evidence ?? [], dropped: result.droppedEvidence }
  }

  it.each(['postingUrl', 'applyUrl'])(
    'a quote containing the whole URL is evidence for %s',
    (field) => {
      const span = { field, quote: `Apply: ${URL}` }
      expect(guardUrlQuotes([span])).toEqual({ kept: [span], dropped: 0 })
    },
  )

  it.each(['postingUrl', 'applyUrl'])('a part of the URL is not evidence for %s', (field) => {
    expect(guardUrlQuotes([{ field, quote: 'https://acme.io/jobs' }])).toEqual({
      kept: [],
      dropped: 1,
    })
  })

  it('an unrelated snippet is not evidence for a URL', () => {
    expect(guardUrlQuotes([{ field: 'applyUrl', quote: 'Senior Rust' }])).toEqual({
      kept: [],
      dropped: 1,
    })
  })
})
