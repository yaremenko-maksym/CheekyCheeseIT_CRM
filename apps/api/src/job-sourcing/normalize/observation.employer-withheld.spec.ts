import { describe, expect, it } from 'vitest'
import { buildNormalizedPosting } from './build-posting'
import { withholdsEmployerByDesign } from './employer-disclosure'
import { buildSourceObservation, type RawObservationFields } from './observation'

/**
 * The third employer state: withheld at the source, by the source's design.
 *
 * Djinni is the declared case (`employer-disclosure.ts`). Reed stands in for every feed that IS
 * supposed to carry an employer: its missing employer stays a quarantine, which is the half of
 * this contract that must NOT move.
 */
const NOW = new Date('2026-11-19T12:00:00Z')

const djinni: RawObservationFields = {
  provider: 'DJINNI_RSS',
  namespace: 'djinni',
  nativeId: null,
  url: 'https://djinni.co/jobs/853129-rust-developer/',
  title: 'Rust Developer',
  companyName: null,
  description: '<p>At ZentixSoft we are hiring</p>',
  descriptionKind: 'html',
  tags: ['Rust'],
  dates: [{ raw: 'Fri, 23 Oct 2026 11:24:39 +0300', contract: 'RFC_2822', semantics: 'PUBLISHED' }],
  adapterVersion: 'djinni-1',
}

const reed: RawObservationFields = {
  provider: 'REED_API',
  namespace: 'reed-uk',
  nativeId: '555',
  url: 'https://www.reed.co.uk/jobs/dev/555',
  title: 'Backend Developer',
  companyName: 'Acme Ltd',
  adapterVersion: 'reed@1',
}

const build = (raw: RawObservationFields, over: Partial<RawObservationFields> = {}) =>
  buildSourceObservation({ ...raw, ...over }, { now: NOW })

const ok = (raw: RawObservationFields, over: Partial<RawObservationFields> = {}) => {
  const r = build(raw, over)
  if (!r.ok) throw new Error(`expected an observation, got quarantine ${r.reason}`)
  return r.observation
}

describe('the capability is declared per source type, not claimed per item', () => {
  it('names Djinni as withholding its employer by design', () => {
    expect(withholdsEmployerByDesign('DJINNI_RSS')).toBe(true)
  })

  it('does not name a feed that is supposed to carry an employer', () => {
    expect(withholdsEmployerByDesign('REED_API')).toBe(false)
    expect(withholdsEmployerByDesign('DOU_RSS')).toBe(false)
    expect(withholdsEmployerByDesign('GREENHOUSE_API')).toBe(false)
  })
})

describe('a source that withholds its employer by design', () => {
  it('stores the posting instead of quarantining it', () => {
    expect(build(djinni).ok).toBe(true)
  })

  it('marks the employer as withheld at the source, explicitly', () => {
    expect(ok(djinni).normalized.employerDisclosure).toBe('WITHHELD_AT_SOURCE')
  })

  it('never invents an employer: not the feed name, not a word from the title or description', () => {
    const o = ok(djinni)
    expect(o.normalized.companyName).toBe('')
    expect(o.normalized.companyNameNormalized).toBe('')
    // The brand in the description and the source's own name are both absent from the field.
    expect(JSON.stringify(o.normalized.companyName)).not.toMatch(/djinni|zentixsoft/i)
  })

  it('keeps the rest of the posting: title, link and published date are normalized as usual', () => {
    const o = ok(djinni)
    expect(o.normalized.title).toBe('Rust Developer')
    // The canonical form drops the trailing slash (`canonicalizePostingUrl`).
    expect(o.sourcePostingUrl).toBe('https://djinni.co/jobs/853129-rust-developer')
    expect(o.normalized.publishedAt?.toISOString()).toBe('2026-10-23T08:24:39.000Z')
  })

  it('still quarantines an item of that source with no title: the state covers the employer only', () => {
    expect(build(djinni, { title: '  ' })).toEqual({ ok: false, reason: 'MISSING_TITLE' })
  })

  it("still reports the source's own 'not an open vacancy' first", () => {
    expect(build(djinni, { notOpenVacancy: true })).toEqual({
      ok: false,
      reason: 'NOT_AN_OPEN_VACANCY',
    })
  })

  it('discloses the employer when the feed does carry one, with no marker', () => {
    const o = ok(djinni, { companyName: 'ZentixSoft' })
    expect(o.normalized.companyName).toBe('ZentixSoft')
    expect(o.normalized.employerDisclosure).toBeUndefined()
  })
})

describe('every other source still quarantines a missing employer', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ] as const)('quarantines MISSING_COMPANY when the employer is %s', (_n, companyName) => {
    expect(build(reed, { companyName })).toEqual({ ok: false, reason: 'MISSING_COMPANY' })
  })

  it('accepts the same record once the employer is there (the quarantine is not unconditional)', () => {
    expect(build(reed).ok).toBe(true)
  })
})

describe('the marker does not disturb a disclosed posting', () => {
  it('leaves the content hash of a disclosed posting byte-identical', () => {
    // The hash is the checkpoint key: changing it for postings we already store would re-revise
    // every stored record on the next prod run. This value was MEASURED on this record before the
    // withheld state existed (2026-11-19) and is pinned here so the change cannot move it.
    expect(ok(reed).contentHash).toBe(
      'acc92ebe819c25fc8297a6960cb6bcf6f331e2d1fa1176ecc4548dcdf1a29d7a',
    )
  })

  it('adds no disclosure field to a posting whose employer is present', () => {
    expect(ok(reed).normalized.employerDisclosure).toBeUndefined()
    expect(
      buildNormalizedPosting('REED_API', {
        url: 'https://www.reed.co.uk/jobs/dev/555',
        title: 'Backend Developer',
        companyName: 'Acme Ltd',
      })?.employerDisclosure,
    ).toBeUndefined()
  })
})
