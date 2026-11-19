import { describe, expect, it } from 'vitest'
import { canonicalFields, type MemberSnapshot } from './canonical-plan'

/**
 * What the canonical employer is when one member's source withholds it.
 *
 * The decided rule (owner, 2026-11-19): a DISCLOSED employer always wins over a withheld one, and
 * an opportunity whose only claim is withheld says so EXPLICITLY — "withheld at the source" is not
 * the same fact as "the sources disagreed", and the two must not collapse into a bare NULL.
 */
function member(over: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return {
    recordId: 'r1',
    revisionId: 'v1',
    receivedSeq: 1,
    receivedAt: new Date('2026-11-19T00:00:00Z'),
    provider: 'REMOTIVE_API',
    namespace: 'ns',
    nativeId: '1',
    title: 'Rust Developer',
    companyName: 'Acme',
    location: 'Remote',
    sourceUrl: 'https://fixture.test/jobs/1',
    applicationUrl: null,
    descriptionSha256: null,
    publishedAt: null,
    tags: [],
    ...over,
  }
}

/** A Djinni-shaped member: no employer, and the emptiness is declared, not accidental. */
const withheld = (over: Partial<MemberSnapshot> = {}) =>
  member({
    recordId: 'r-djinni',
    revisionId: 'v-djinni',
    provider: 'DJINNI_RSS',
    companyName: '',
    employerWithheldAtSource: true,
    sourceUrl: 'https://djinni.co/jobs/853129-rust-developer',
    ...over,
  })

describe('an opportunity whose only employer claim is withheld', () => {
  it('stores no employer name or key: nothing is invented', () => {
    const c = canonicalFields([withheld()], null)
    expect(c.employerName).toBeNull()
    expect(c.employerKey).toBeNull()
  })

  it('records WITHHELD_AT_SOURCE, so a reader can tell it from a disagreement', () => {
    const c = canonicalFields([withheld()], null)
    expect(c.fieldRevisions['employerName']).toEqual({
      status: 'UNKNOWN',
      reason: 'WITHHELD_AT_SOURCE',
      candidates: [],
    })
  })

  it('keeps every other field canonical as usual', () => {
    const c = canonicalFields([withheld()], null)
    expect(c.title).toBe('Rust Developer')
    expect(c.location).toBe('Remote')
  })
})

describe('dedup: a disclosed employer wins over a withheld one', () => {
  it('takes the named employer when another source discloses it', () => {
    const c = canonicalFields([withheld(), member({ recordId: 'r2', revisionId: 'v2' })], null)
    expect(c.employerName).toBe('Acme')
    expect(c.employerKey).not.toBeNull()
  })

  it('does not mark the employer withheld once some source disclosed it', () => {
    const c = canonicalFields([withheld(), member({ recordId: 'r2', revisionId: 'v2' })], null)
    expect(c.fieldRevisions['employerName']).toBe('v2')
  })

  it('wins regardless of which member arrived first or last', () => {
    const disclosedFirst = canonicalFields(
      [member({ recordId: 'r2', revisionId: 'v2', receivedSeq: 1 }), withheld({ receivedSeq: 2 })],
      null,
    )
    expect(disclosedFirst.employerName).toBe('Acme')
  })
})

describe('withheld is not a disagreement, and a disagreement is not withheld', () => {
  it('keeps EQUAL_AUTHORITY_CONFLICT when two sources name different employers', () => {
    const c = canonicalFields(
      [
        member({ recordId: 'r1', revisionId: 'v1', companyName: 'Acme' }),
        member({ recordId: 'r2', revisionId: 'v2', companyName: 'Globex' }),
      ],
      null,
    )
    expect(c.employerName).toBeNull()
    expect(c.fieldRevisions['employerName']).toMatchObject({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
    })
  })

  it('reports a conflict, not a withholding, when a withheld member sits beside two that disagree', () => {
    const c = canonicalFields(
      [
        withheld(),
        member({ recordId: 'r1', revisionId: 'v1', companyName: 'Acme' }),
        member({ recordId: 'r2', revisionId: 'v2', companyName: 'Globex' }),
      ],
      null,
    )
    expect(c.fieldRevisions['employerName']).toMatchObject({
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
    })
  })

  it('reports NO_CLAIMS, not a withholding, when a company-less member never declared one', () => {
    // A member with an empty company and NO declaration is the old, undeclared emptiness. It must
    // not acquire the new state by accident.
    const c = canonicalFields([member({ companyName: '' })], null)
    expect(c.fieldRevisions['employerName']).toMatchObject({
      status: 'UNKNOWN',
      reason: 'NO_CLAIMS',
    })
  })
})
