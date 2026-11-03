import { describe, expect, it } from 'vitest'
import { guardExtractionResult, MIN_EVIDENCE_QUOTE_CHARS } from './extraction-result-guard'

/** CR-M-3: a quote proves a field only if it is long enough to be specific, or is the field itself. */
const EVIDENCE = 'Senior Rust Engineer at Acme, Lviv. Remote: yes. Salary 6 000 USD.'
const CTX = { evidenceText: EVIDENCE, verifiedUrls: [] }

function guardQuotes(
  evidence: ReadonlyArray<{ field: string; quote: string }>,
  record: Record<string, unknown> = {},
) {
  const raw = JSON.stringify({
    extractionVersion: 'v1',
    records: [
      { title: 'Senior Rust Engineer', company: 'Acme', uncertainty: 0.2, ...record, evidence },
    ],
  })
  const result = guardExtractionResult(raw, CTX)
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

  it('a short quote for a boolean field is not evidence; a long one is', () => {
    const long = { field: 'remote', quote: 'Remote: yes' }
    expect(guardQuotes([{ field: 'remote', quote: 'yes' }, long], { remote: true })).toEqual({
      kept: [long],
      dropped: 1,
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
