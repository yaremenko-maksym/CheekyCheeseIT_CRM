import { describe, expect, it } from 'vitest'
import { buildSourceObservation, type RawObservationFields } from './observation'

/** Description and tag limits, content-hash inputs, and the INVALID_RECORD quarantine. */

const NOW = new Date('2026-10-20T12:00:00Z')

const base: RawObservationFields = {
  provider: 'REED_API',
  namespace: 'reed-uk',
  nativeId: '555',
  url: 'https://www.reed.co.uk/jobs/dev/555',
  title: 'Backend Developer',
  companyName: 'Acme Ltd',
  description: '<p>Build APIs</p>',
  tags: ['node', 'postgres'],
  adapterVersion: 'reed@1',
}
const build = (over: Partial<RawObservationFields> = {}) =>
  buildSourceObservation({ ...base, ...over }, { now: NOW })
const ok = (over: Partial<RawObservationFields> = {}) => {
  const r = build(over)
  if (!r.ok) throw new Error(`expected an observation, got quarantine ${r.reason}`)
  return r.observation
}
const desc = (over: Partial<RawObservationFields>) => ok(over).originalFields.description

describe('description: displayTruncated is decided per kind', () => {
  it('text: NUL beyond the ceiling does not count; real length does', () => {
    const withNul = desc({
      description: `${'d'.repeat(20_000)}${'\u0000'.repeat(10)}`,
      descriptionKind: 'text',
    })
    expect(withNul.displayTruncated).toBe(false)
    expect(
      desc({ description: 'd'.repeat(20_001), descriptionKind: 'text' }).displayTruncated,
    ).toBe(true)
  })

  it('text: surrounding whitespace is trimmed before measuring', () => {
    const padded = `${'d'.repeat(20_000)}     `
    expect(desc({ description: padded, descriptionKind: 'text' }).displayTruncated).toBe(false)
  })

  it('text kind reaches the normalizer: markup is escaped, not converted', () => {
    expect(
      ok({ description: '<b>bold</b>', descriptionKind: 'text' }).normalized.descriptionMd,
    ).toBe('\\<b>bold\\</b>')
    expect(ok({ description: '<b>bold</b>' }).normalized.descriptionMd).toBe('**bold**')
  })

  it('html: markup that converts to short markdown is not truncated however long the raw is', () => {
    const markup = desc({ description: '<i></i>'.repeat(4_000) }) // 28 000 raw chars, empty markdown
    expect(markup.displayTruncated).toBe(false)
    expect(markup.truncated).toBe(false)
  })

  it('html: markdown at the 20 000 ceiling is whole, one over is flagged', () => {
    expect(desc({ description: 'd'.repeat(20_000) }).displayTruncated).toBe(false)
    expect(desc({ description: 'd'.repeat(20_001) }).displayTruncated).toBe(true)
  })

  it('html: a raw input beyond 4x the ceiling is flagged even if its markdown is short', () => {
    expect(desc({ description: ' '.repeat(80_000) }).displayTruncated).toBe(false)
    expect(desc({ description: ' '.repeat(80_001) }).displayTruncated).toBe(true)
  })

  it('retention cap 100 000: whole at the cap, truncated one over, independent of the display flag', () => {
    const whole = desc({ description: ' '.repeat(100_000) })
    expect(whole).toMatchObject({ truncated: false, originalLength: 100_000 })
    expect(whole.value).toHaveLength(100_000)
    const cut = desc({ description: ' '.repeat(100_001) })
    expect(cut.truncated).toBe(true)
    expect(cut.value).toHaveLength(100_000)
  })

  it('records description display truncation as evidence only when it happened', () => {
    expect(ok({ description: 'd'.repeat(20_001) }).evidence).toEqual([
      { field: 'description', kind: 'DISPLAY_TRUNCATED', detail: 'exceeds display limit' },
    ])
    expect(ok({ description: 'd'.repeat(20_000) }).evidence).toEqual([])
  })
})

describe('tags: retained originals and both flags', () => {
  const tagsOf = (tags: unknown) => ok({ tags: tags as string[] }).originalFields.tags
  const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)

  it('keeps the values as received when nothing is cut', () => {
    expect(tagsOf(['node', 'postgres'])).toEqual({
      values: ['node', 'postgres'],
      originalCount: 2,
      truncated: false,
      displayTruncated: false,
    })
  })

  it('absent or non-array tags are an empty list', () => {
    for (const t of [undefined, 'node,postgres', 7]) {
      expect(tagsOf(t), String(t)).toEqual({
        values: [],
        originalCount: 0,
        truncated: false,
        displayTruncated: false,
      })
    }
  })

  it('non-string members are dropped before counting', () => {
    expect(tagsOf([1, null, 'x', {}])).toMatchObject({ values: ['x'], originalCount: 1 })
  })

  it('strips NUL from retained tag values', () => {
    expect(tagsOf(['a\u0000b']).values).toEqual(['ab'])
  })

  it('count cap 200: 200 retained whole, 201 cut to 200 and flagged', () => {
    const at = tagsOf(many(200))
    expect(at).toMatchObject({ originalCount: 200, truncated: false })
    expect(at.values).toHaveLength(200)
    const over = tagsOf(many(201))
    expect(over).toMatchObject({ originalCount: 201, truncated: true })
    expect(over.values).toHaveLength(200)
    expect(tagsOf(many(250)).values).toHaveLength(200)
  })

  it('length cap 200: a 200-char tag is whole, a 201-char tag is cut and flags, even among short ones', () => {
    expect(tagsOf(['x'.repeat(200)])).toMatchObject({ truncated: false })
    const among = tagsOf(['a', 'x'.repeat(201), 'b'])
    expect(among.truncated).toBe(true)
    expect(among.values.map((v) => v.length)).toEqual([1, 200, 1])
  })

  it('display flag: one over-long tag among short ones is enough; 60 chars is not', () => {
    expect(tagsOf(['a', 'x'.repeat(61), 'b']).displayTruncated).toBe(true)
    expect(tagsOf(['a', 'x'.repeat(60), 'b']).displayTruncated).toBe(false)
  })

  it('records tag display truncation as evidence; a clean tag list adds none', () => {
    expect(ok({ tags: many(51) }).evidence).toEqual([
      { field: 'tags', kind: 'DISPLAY_TRUNCATED', detail: 'exceeds display limit' },
    ])
    expect(ok({ tags: many(50) }).evidence).toEqual([])
  })
})

describe('content hash reacts to every hashed field', () => {
  const h = (over: Partial<RawObservationFields> = {}) => ok(over).contentHash

  it('remote, employment type, seniority and tags each change the hash', () => {
    const ref = h()
    expect(h({ remote: true })).not.toBe(ref)
    expect(h({ remote: true })).not.toBe(h({ remote: false }))
    expect(h({ employmentType: 'Full-time' })).not.toBe(ref)
    expect(h({ seniorityHint: 'Senior' })).not.toBe(ref)
    expect(h({ tags: ['node'] })).not.toBe(ref)
    expect(h({ tags: [] })).not.toBe(ref)
  })

  it('the same inputs hash the same (the hash is a function of the content, not of the call)', () => {
    expect(h({ remote: true, tags: ['a', 'b'] })).toBe(h({ remote: true, tags: ['b', 'a'] }))
  })
})

describe('INVALID_RECORD quarantine', () => {
  it('a link whose canonical form outgrows the stored limit is quarantined, not stored cut', () => {
    // Still quarantined, now one step EARLIER and under a different reason. 700 `é` serialise to
    // 4200 percent-encoded characters, so the link policy itself refuses the URL (SR-M-1: the cap
    // is measured on the stored `href`, not the raw text) instead of the normalizer rejecting the
    // record further down. The property this test exists for — never stored cut — is unchanged.
    const url = `https://www.reed.co.uk/jobs/${'é'.repeat(700)}`
    expect(build({ url })).toEqual({ ok: false, reason: 'UNSAFE_URL' })
  })
})
