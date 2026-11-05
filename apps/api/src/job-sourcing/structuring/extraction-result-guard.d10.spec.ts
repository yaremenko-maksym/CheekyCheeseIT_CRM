import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { guardExtractionResult, modelReplySchema } from './extraction-result-guard'

describe('guardExtractionResult — unquoted facts are dropped (D10, ADR §5.4)', () => {
  const PAGE = 'Senior Rust Engineer at Acme, Lviv. https://acme.example/jobs/1 Salary 6 000 USD.'
  const guard = (record: Record<string, unknown>) => {
    const result = guardExtractionResult(
      JSON.stringify({ extractionVersion: 'v1', records: [{ uncertainty: 0.2, ...record }] }),
      { evidenceText: PAGE, verifiedUrls: [] },
    )
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
    return result
  }

  it.each([
    'externalId',
    'title',
    'company',
    'location',
    'employmentType',
    'salary',
    'description',
    'postedAt',
  ])('%s with no quote ends null, the record and its quoted field stay', (field) => {
    const quoted = field === 'title' ? 'company' : 'title'
    const value = field === 'title' ? 'Acme' : 'Senior Rust Engineer'
    const result = guard({
      [field]: 'Stated on no page',
      [quoted]: value,
      evidence: [{ field: quoted, quote: value }],
    })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ [field]: null, [quoted]: value })
    expect(result.nulledFacts).toBe(1)
  })

  it('a fact whose only quote failed ends null and counts both drops', () => {
    const result = guard({
      title: 'Senior Rust Engineer',
      evidence: [{ field: 'title', quote: 'Principal Rust Engineer' }],
    })
    expect(result.records[0]).toMatchObject({ title: null, evidence: [] })
    expect(result).toMatchObject({ nulledFacts: 1, droppedEvidence: 1 })
  })

  it('a title with text appended ends null: a quote of its start does not prove the rest', () => {
    const result = guard({
      title: 'Senior Rust Engineer - apply via t.me/xyz',
      evidence: [{ field: 'title', quote: 'Senior Rust Engineer' }],
    })
    expect(result.records[0]).toMatchObject({ title: null, evidence: [] })
    expect(result).toMatchObject({ nulledFacts: 1, droppedEvidence: 1 })
  })

  it.each(['externalId', 'company', 'location', 'employmentType', 'salary', 'postedAt'])(
    '%s is not proved by a passage of it',
    (field) => {
      const result = guard({
        [field]: 'Senior Rust Engineer at Acme, Lviv and more',
        evidence: [{ field, quote: 'Senior Rust Engineer' }],
      })
      expect(result.records[0]).toMatchObject({ [field]: null, evidence: [] })
    },
  )

  it('a description keeps a partial quote: a long text cannot be quoted whole', () => {
    const description = 'Senior Rust Engineer at Acme, Lviv, for a payments team in the region.'
    const span = { field: 'description', quote: 'Senior Rust Engineer at Acme' }
    const result = guard({ description, evidence: [span] })
    expect(result.records[0]).toMatchObject({ description, evidence: [span] })
    expect(result).toMatchObject({ nulledFacts: 0, droppedEvidence: 0 })
  })

  it('a null fact is not counted as dropped', () => {
    expect(guard({ title: null }).nulledFacts).toBe(0)
  })

  it('a blank fact has nothing to prove it and ends null', () => {
    const result = guard({ company: ' ' })
    expect(result.records[0]?.company).toBeNull()
    expect(result.nulledFacts).toBe(1)
  })

  it('a quoted fact keeps its value and is not counted', () => {
    const result = guard({
      salary: '6 000 USD',
      evidence: [{ field: 'salary', quote: '6 000 USD' }],
    })
    expect(result.records[0]?.salary).toBe('6 000 USD')
    expect(result.nulledFacts).toBe(0)
  })

  it('the boolean remote stays without a quote', () => {
    const result = guard({ remote: true })
    expect(result.records[0]?.remote).toBe(true)
    expect(result.nulledFacts).toBe(0)
  })

  it('URLs keep their own whole-URL check, no quote needed', () => {
    const url = 'https://acme.example/jobs/1'
    const result = guard({ postingUrl: url, applyUrl: 'https://acme.example/elsewhere' })
    expect(result.records[0]).toMatchObject({ postingUrl: url, applyUrl: null })
    expect(result).toMatchObject({ nulledUrls: 1, nulledFacts: 0 })
  })

  it('counts across records', () => {
    const raw = JSON.stringify({
      extractionVersion: 'v1',
      records: [
        { uncertainty: 0.1, title: 'x' },
        { uncertainty: 0.1, title: 'y', company: 'z' },
      ],
    })
    expect(guardExtractionResult(raw, { evidenceText: PAGE, verifiedUrls: [] })).toMatchObject({
      nulledFacts: 3,
    })
  })
})

describe('modelReplySchema (ADR §5.4)', () => {
  const record = { uncertainty: 0.2 }

  it('is composed from the record schema, it does not accept any JSON', () => {
    expect(modelReplySchema.safeParse({ anything: true }).success).toBe(false)
    expect(
      modelReplySchema.safeParse({
        extractionVersion: 'v1',
        records: [{ title: 'no uncertainty' }],
      }).success,
    ).toBe(false)
    expect(
      modelReplySchema.safeParse({ extractionVersion: 'v1', records: [{ ...record, title: 1 }] })
        .success,
    ).toBe(false)
  })

  it('shares the record limits of the guard', () => {
    const title = 'x'.repeat(501)
    expect(
      modelReplySchema.safeParse({ extractionVersion: 'v1', records: [{ ...record, title }] })
        .success,
    ).toBe(false)
    expect(modelReplySchema.safeParse({ extractionVersion: '', records: [] }).success).toBe(false)
  })

  it('holds at most one record: one page, one posting', () => {
    expect(
      modelReplySchema.safeParse({ extractionVersion: 'v1', records: [record, record] }).success,
    ).toBe(false)
    expect(modelReplySchema.safeParse({ extractionVersion: 'v1', records: [record] }).success).toBe(
      true,
    )
  })

  it('types URLs string or null, and defaults absence to null', () => {
    const parse = (url: unknown) =>
      modelReplySchema.safeParse({
        extractionVersion: 'v1',
        records: [{ ...record, postingUrl: url, applyUrl: url }],
      })
    expect(parse(5).success).toBe(false)
    expect(parse('not checked here').success).toBe(true)
    expect(parse(undefined).data?.records[0]).toMatchObject({ postingUrl: null, applyUrl: null })
  })

  it('renders in JSON Schema with nothing the strict form refuses', () => {
    const rendered = JSON.stringify(z.toJSONSchema(modelReplySchema))
    for (const refused of ['$ref', '$defs', 'allOf', 'oneOf', 'prefixItems', 'patternProperties']) {
      expect(rendered).not.toContain(`"${refused}"`)
    }
    expect(rendered).toContain('"postingUrl"')
    expect(rendered).toContain('"maxItems":1')
  })
})
