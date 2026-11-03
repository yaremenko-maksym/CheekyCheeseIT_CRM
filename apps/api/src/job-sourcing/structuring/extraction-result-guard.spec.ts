import { describe, expect, it } from 'vitest'
import { guardExtractionResult, MAX_MODEL_OUTPUT_BYTES } from './extraction-result-guard'

const EVIDENCE = `Senior Rust Engineer at Acme, Lviv (remote friendly).
Salary 6 000 - 7 500 USD.
Details: https://jobs.example.com/vacancy/12345?ref=board.
Apply: https://apply.example.com/form/12345, or see (https://acme.example.org/careers).`

const CTX = { evidenceText: EVIDENCE, verifiedUrls: ['https://jobs.example.com/vacancy/12345'] }

const FULL_RECORD = {
  externalId: '12345',
  title: 'Senior Rust Engineer',
  company: 'Acme',
  location: 'Lviv',
  remote: true,
  employmentType: null,
  salary: '6 000 - 7 500 USD',
  description: null,
  postedAt: null,
  postingUrl: 'https://jobs.example.com/vacancy/12345?ref=board',
  applyUrl: 'https://apply.example.com/form/12345',
  evidence: [{ field: 'title', quote: 'Senior Rust Engineer' }],
  uncertainty: 0.1,
}

function output(records: unknown[], extractionVersion: unknown = 'html-v1'): string {
  return JSON.stringify({ extractionVersion, records })
}

function okResult(raw: string, ctx = CTX) {
  const result = guardExtractionResult(raw, ctx)
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

describe('guardExtractionResult — valid output', () => {
  it('keeps a fully evidenced record as is', () => {
    const result = okResult(output([FULL_RECORD]))
    expect(result.extractionVersion).toBe('html-v1')
    expect(result.records).toEqual([FULL_RECORD])
    expect(result.droppedRecords).toBe(0)
    expect(result.nulledUrls).toBe(0)
    expect(result.droppedEvidence).toBe(0)
  })

  it('missing facts become null, never a guess', () => {
    const result = okResult(output([{ uncertainty: 0.9 }]))
    expect(result.records).toEqual([
      {
        externalId: null,
        title: null,
        company: null,
        location: null,
        remote: null,
        employmentType: null,
        salary: null,
        description: null,
        postedAt: null,
        postingUrl: null,
        applyUrl: null,
        evidence: [],
        uncertainty: 0.9,
      },
    ])
  })

  it('an empty record list is a valid answer (no posting on the page)', () => {
    const result = okResult(output([]))
    expect(result.records).toEqual([])
  })

  it('drops keys the schema does not know', () => {
    const result = okResult(output([{ ...FULL_RECORD, secretNote: 'x', __proto__x: 1 }]))
    expect(result.records[0]).toEqual(FULL_RECORD)
  })
})

describe('guardExtractionResult — URLs', () => {
  it('an invented same-host link is nulled; the rest of the record survives', () => {
    const result = okResult(
      output([{ ...FULL_RECORD, applyUrl: 'https://jobs.example.com/vacancy/12345/apply' }]),
    )
    expect(result.records[0]?.applyUrl).toBeNull()
    expect(result.records[0]?.title).toBe('Senior Rust Engineer')
    expect(result.records[0]?.postingUrl).toBe(FULL_RECORD.postingUrl)
    expect(result.nulledUrls).toBe(1)
  })

  it('a prefix of a real evidence URL is not evidence', () => {
    const result = okResult(
      output([{ ...FULL_RECORD, postingUrl: 'https://jobs.example.com/vacancy/1' }]),
    )
    expect(result.records[0]?.postingUrl).toBeNull()
  })

  it('a URL in the evidence is kept even next to punctuation and brackets', () => {
    const result = okResult(
      output([{ ...FULL_RECORD, applyUrl: 'https://acme.example.org/careers' }]),
    )
    expect(result.records[0]?.applyUrl).toBe('https://acme.example.org/careers')
    expect(result.nulledUrls).toBe(0)
  })

  it('a verified identity URL is kept though the evidence text never shows it whole', () => {
    const result = okResult(
      output([{ ...FULL_RECORD, postingUrl: 'https://jobs.example.com/vacancy/12345' }]),
    )
    expect(result.records[0]?.postingUrl).toBe('https://jobs.example.com/vacancy/12345')
  })

  it('a non-https URL is nulled even when the evidence shows it', () => {
    const ctx = {
      evidenceText: 'see http://jobs.example.com/x and javascript:alert(1)',
      verifiedUrls: [],
    }
    const result = okResult(
      output([
        {
          ...FULL_RECORD,
          postingUrl: 'http://jobs.example.com/x',
          applyUrl: 'javascript:alert(1)',
        },
      ]),
      ctx,
    )
    expect(result.records[0]?.postingUrl).toBeNull()
    expect(result.records[0]?.applyUrl).toBeNull()
    expect(result.nulledUrls).toBe(2)
  })

  it('an https URL with credentials is nulled even when it is a verified URL', () => {
    const url = 'https://user:pw@jobs.example.com/x'
    const result = okResult(output([{ ...FULL_RECORD, postingUrl: url }]), {
      evidenceText: url,
      verifiedUrls: [url],
    })
    expect(result.records[0]?.postingUrl).toBeNull()
  })

  it('a URL of the wrong type is nulled, not fatal for the record', () => {
    const result = okResult(output([{ ...FULL_RECORD, applyUrl: 42 }]))
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.applyUrl).toBeNull()
    expect(result.nulledUrls).toBe(1)
  })
})

describe('guardExtractionResult — evidence spans', () => {
  it('a quote that does not occur in the evidence is dropped, real quotes kept', () => {
    const result = okResult(
      output([
        {
          ...FULL_RECORD,
          evidence: [
            { field: 'title', quote: 'Senior Rust Engineer' },
            { field: 'salary', quote: '9 000 USD' },
          ],
        },
      ]),
    )
    expect(result.records[0]?.evidence).toEqual([{ field: 'title', quote: 'Senior Rust Engineer' }])
    expect(result.droppedEvidence).toBe(1)
  })
})

describe('guardExtractionResult — record isolation', () => {
  it('one invalid record is dropped, the others kept', () => {
    const bad = { ...FULL_RECORD, title: { nested: true } }
    const result = okResult(output([FULL_RECORD, bad, { ...FULL_RECORD, externalId: '2' }]))
    expect(result.records.map((r) => r.externalId)).toEqual(['12345', '2'])
    expect(result.droppedRecords).toBe(1)
  })

  it.each([
    ['uncertainty missing', { ...FULL_RECORD, uncertainty: undefined }],
    ['uncertainty above 1', { ...FULL_RECORD, uncertainty: 1.01 }],
    ['uncertainty below 0', { ...FULL_RECORD, uncertainty: -0.01 }],
    ['remote not boolean', { ...FULL_RECORD, remote: 'yes' }],
    ['title too long', { ...FULL_RECORD, title: 'x'.repeat(501) }],
    ['evidence field unknown', { ...FULL_RECORD, evidence: [{ field: 'salaryy', quote: 'Acme' }] }],
    ['evidence quote empty', { ...FULL_RECORD, evidence: [{ field: 'title', quote: '' }] }],
    ['record not an object', 'Senior Rust Engineer'],
    ['record null', null],
  ])('%s → that record is dropped', (_name, bad) => {
    const result = okResult(output([FULL_RECORD, bad]))
    expect(result.records).toHaveLength(1)
    expect(result.droppedRecords).toBe(1)
  })

  it('boundary values are valid', () => {
    const result = okResult(
      output([
        { ...FULL_RECORD, uncertainty: 0, title: 'x'.repeat(500) },
        { ...FULL_RECORD, uncertainty: 1 },
      ]),
    )
    expect(result.droppedRecords).toBe(0)
  })

  it('every record invalid ⇒ extractor failure', () => {
    expect(guardExtractionResult(output([{ title: 1 }, null]), CTX)).toEqual({
      ok: false,
      reason: 'NO_VALID_RECORD',
    })
  })
})

describe('guardExtractionResult — whole-output failures', () => {
  it.each([
    ['plain prose', 'Here is the job: Senior Rust Engineer'],
    ['fenced JSON', '```json\n' + output([FULL_RECORD]) + '\n```'],
    ['fenced without language', '```\n' + output([FULL_RECORD]) + '\n```'],
    ['truncated JSON', output([FULL_RECORD]).slice(0, -5)],
    ['empty', ''],
  ])('%s is NOT_JSON', (_name, raw) => {
    expect(guardExtractionResult(raw, CTX)).toEqual({ ok: false, reason: 'NOT_JSON' })
  })

  it.each([
    [
      'a JSON string holding fenced JSON',
      JSON.stringify('```json\n' + output([FULL_RECORD]) + '\n```'),
    ],
    ['an array', JSON.stringify([FULL_RECORD])],
    ['null', 'null'],
    ['no extractionVersion', JSON.stringify({ records: [FULL_RECORD] })],
    ['empty extractionVersion', output([FULL_RECORD], '')],
    ['overlong extractionVersion', output([FULL_RECORD], 'v'.repeat(65))],
    ['records not an array', JSON.stringify({ extractionVersion: 'v', records: {} })],
    ['too many records', output(Array.from({ length: 101 }, () => FULL_RECORD))],
  ])('%s is SCHEMA_INVALID', (_name, raw) => {
    expect(guardExtractionResult(raw, CTX)).toEqual({ ok: false, reason: 'SCHEMA_INVALID' })
  })

  it('100 records and a 64-char version are within bounds', () => {
    const result = okResult(
      output(
        Array.from({ length: 100 }, () => FULL_RECORD),
        'v'.repeat(64),
      ),
    )
    expect(result.records).toHaveLength(100)
  })

  it('output over 2 MiB is refused before parsing', () => {
    const raw = ' '.repeat(MAX_MODEL_OUTPUT_BYTES + 1)
    expect(guardExtractionResult(raw, CTX)).toEqual({ ok: false, reason: 'OUTPUT_TOO_LARGE' })
  })

  it('the cap counts UTF-8 bytes, not characters', () => {
    const raw = 'é'.repeat(MAX_MODEL_OUTPUT_BYTES / 2 + 1)
    expect(raw.length).toBeLessThan(MAX_MODEL_OUTPUT_BYTES)
    expect(guardExtractionResult(raw, CTX)).toEqual({ ok: false, reason: 'OUTPUT_TOO_LARGE' })
  })

  it('output of exactly 2 MiB is parsed', () => {
    const json = output([FULL_RECORD])
    const raw = json + ' '.repeat(MAX_MODEL_OUTPUT_BYTES - json.length)
    expect(MAX_MODEL_OUTPUT_BYTES).toBe(2 * 1024 * 1024)
    expect(okResult(raw).records).toHaveLength(1)
  })
})

describe('guardExtractionResult — counters and URL tokens', () => {
  it('model-supplied nulls and absent keys are not counted as nulled URLs or dropped evidence', () => {
    const absent = okResult(output([{ uncertainty: 0.5 }]))
    expect(absent.nulledUrls).toBe(0)
    expect(absent.droppedEvidence).toBe(0)
    const explicit = okResult(output([{ ...FULL_RECORD, postingUrl: null, applyUrl: null }]))
    expect(explicit.nulledUrls).toBe(0)
  })

  it('an https URL embedded in an http link is not evidence of its own', () => {
    const ctx = {
      evidenceText: 'Track: http://tracker.example.com/r?u=https://other.example.com/job',
      verifiedUrls: [],
    }
    const result = okResult(
      output([{ ...FULL_RECORD, applyUrl: 'https://other.example.com/job' }]),
      ctx,
    )
    expect(result.records[0]?.applyUrl).toBeNull()
  })

  it('a run of trailing punctuation after an evidence URL is not part of it', () => {
    const ctx = { evidenceText: 'Apply at https://apply.example.com/x?!.', verifiedUrls: [] }
    const result = okResult(
      output([{ ...FULL_RECORD, applyUrl: 'https://apply.example.com/x' }]),
      ctx,
    )
    expect(result.records[0]?.applyUrl).toBe('https://apply.example.com/x')
  })
})
