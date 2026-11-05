import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { guardExtractionResult, modelReplySchema, type ModelReply } from './extraction-result-guard'
import { MODEL_FILLABLE_FIELDS } from './html-structurer.port'
import { EXTRACTION_SYSTEM_PROMPT } from './prompt-envelope'
import { FLOOR_UNCERTAINTY, smallDoseFor } from './small-dose-table'

/** The package's limits, pinned by literal: `apps/api` must not import inference values for this. */
const MAX_SMALL_DOSE_GROUPS = 6
const MAX_EXTRACTION_INSTRUCTION_CHARS = 4_000

const ALL_NAMES = ['identity', 'place', 'terms', 'description']
const names = (dose: ReturnType<typeof smallDoseFor>) => dose.groups.map(({ name }) => name)

const PAGE = 'Go Engineer, Lviv, full-time. We build payment systems for the whole region.'
const ANSWERS = {
  identity: { postingsOnPage: 1 },
  place: { location: 'Lviv', locationQuote: 'Go Engineer, Lviv', remote: true },
  terms: { employmentType: 'full-time', employmentTypeQuote: 'Lviv, full-time' },
  description: {
    description: 'We build payment systems',
    descriptionQuote: 'We build payment systems',
  },
}

function merged(parts: Readonly<Record<string, unknown>> = ANSWERS, dose = smallDoseFor()) {
  const result = dose.merge(parts)
  if (!result.ok) throw new Error('expected the merge to succeed')
  return result.data
}

const only = (reply: ModelReply) => {
  expect(reply.records).toHaveLength(1)
  return reply.records[0] as ModelReply['records'][number]
}

describe('smallDoseFor: what the floor is asked (ADR 5.4)', () => {
  it('asks the whole table by default, identity first', () => {
    expect(names(smallDoseFor())).toEqual(ALL_NAMES)
    expect(names(smallDoseFor(MODEL_FILLABLE_FIELDS))).toEqual(ALL_NAMES)
  })

  it('never exceeds the group cap of the package', () => {
    expect(smallDoseFor().groups.length).toBeLessThanOrEqual(MAX_SMALL_DOSE_GROUPS)
  })

  it.each([
    [['description'], ['identity', 'description']],
    [['location'], ['identity', 'place']],
    // A group stays asked while any one of its fields is missing.
    [['remote'], ['identity', 'place']],
    [['employmentType'], ['identity', 'terms']],
    [
      ['remote', 'employmentType'],
      ['identity', 'place', 'terms'],
    ],
  ] as const)('a group with no missing field is not asked: %j', (missing, expected) => {
    expect(names(smallDoseFor(missing))).toEqual(expected)
  })

  it('the identity question is asked even when nothing else is', () => {
    expect(names(smallDoseFor([]))).toEqual(['identity'])
  })

  it('hands the router only the group contract, not its own bookkeeping', () => {
    for (const group of smallDoseFor().groups) {
      expect(Object.keys(group).sort()).toEqual([
        'instruction',
        'maxAnswerTokens',
        'name',
        'schema',
      ])
    }
  })

  it('every group says it answers about the main posting only', () => {
    for (const { instruction } of smallDoseFor().groups) {
      expect(instruction).toContain(
        'Answer about the main job posting of this page only; ignore postings in sidebars, lists or recommendations.',
      )
    }
  })

  it('each group asks its own question, and the fact groups ask for quotes', () => {
    const by = Object.fromEntries(smallDoseFor().groups.map((g) => [g.name, g.instruction]))
    expect(by['identity']).toContain('Count the separate job postings on this page.')
    expect(by['place']).toContain('State its location and whether the work is remote.')
    expect(by['terms']).toContain('State its employment type.')
    expect(by['description']).toContain('State its description.')
    for (const name of ['place', 'terms', 'description']) {
      expect(by[name]).toContain(
        'Use null when the page does not state it. Every value comes with a quote copied verbatim from the page.',
      )
    }
  })

  it('the longest combined instruction stays under the envelope cut', () => {
    for (const { instruction } of smallDoseFor().groups) {
      const combined = `${EXTRACTION_SYSTEM_PROMPT}\n\n${instruction}`
      expect(combined.length).toBeLessThan(MAX_EXTRACTION_INSTRUCTION_CHARS)
    }
  })

  it('pins each group answer bound', () => {
    expect(smallDoseFor().groups.map((g) => [g.name, g.maxAnswerTokens])).toEqual([
      ['identity', 32],
      ['place', 256],
      ['terms', 128],
      ['description', 1_200],
    ])
  })

  it('sub-schemas are flat objects the strict form accepts', () => {
    for (const { schema } of smallDoseFor().groups) {
      const rendered = z.toJSONSchema(schema) as {
        type: string
        properties: Record<string, { type?: unknown; anyOf?: { type?: string }[] }>
      }
      expect(rendered.type).toBe('object')
      for (const property of Object.values(rendered.properties)) {
        const types = property.anyOf?.map((o) => o.type) ?? [property.type]
        expect(types).not.toContain('array')
        expect(types).not.toContain('object')
      }
      const text = JSON.stringify(rendered)
      for (const refused of ['$ref', '$defs', 'allOf', 'oneOf']) {
        expect(text).not.toContain(`"${refused}"`)
      }
    }
  })
})

describe('smallDoseFor: merge (ADR 5.4)', () => {
  it('yields exactly one record that passes the full schema', () => {
    const reply = merged()
    expect(modelReplySchema.safeParse(reply).success).toBe(true)
    expect(only(reply)).toMatchObject({
      location: 'Lviv',
      remote: true,
      employmentType: 'full-time',
      description: 'We build payment systems',
    })
  })

  it('turns every quote into evidence that survives the guard (D10)', () => {
    const reply = merged()
    expect(only(reply).evidence).toEqual([
      { field: 'location', quote: 'Go Engineer, Lviv' },
      { field: 'employmentType', quote: 'Lviv, full-time' },
      { field: 'description', quote: 'We build payment systems' },
    ])
    const guarded = guardExtractionResult(JSON.stringify(reply), {
      evidenceText: PAGE,
      verifiedUrls: [],
    })
    expect(guarded).toMatchObject({ ok: true, nulledFacts: 0, droppedEvidence: 0 })
    if (!guarded.ok) throw new Error('unreachable')
    expect(guarded.records[0]).toMatchObject({ location: 'Lviv', remote: true })
  })

  it('sets the constant marking a floor answer', () => {
    expect(only(merged()).uncertainty).toBe(FLOOR_UNCERTAINTY)
    expect(FLOOR_UNCERTAINTY).toBe(0.5)
  })

  it('a fact the floor did not quote is dropped by the same guard as a hosted one', () => {
    const reply = merged({
      ...ANSWERS,
      terms: { employmentType: 'contract', employmentTypeQuote: null },
    })
    expect(only(reply).evidence.map(({ field }) => field)).not.toContain('employmentType')
    const guarded = guardExtractionResult(JSON.stringify(reply), {
      evidenceText: PAGE,
      verifiedUrls: [],
    })
    expect(guarded).toMatchObject({ ok: true, nulledFacts: 1 })
    if (!guarded.ok) throw new Error('unreachable')
    expect(guarded.records[0]?.employmentType).toBeNull()
  })

  it('a quote the page does not hold fails the same way: a fabricated fact never lands', () => {
    const reply = merged({
      ...ANSWERS,
      terms: { employmentType: 'contract', employmentTypeQuote: 'contract role here' },
    })
    expect(
      guardExtractionResult(JSON.stringify(reply), { evidenceText: PAGE, verifiedUrls: [] }),
    ).toMatchObject({ ok: true, nulledFacts: 1, droppedEvidence: 1 })
  })

  it('an empty quote proves nothing and does not fail the record', () => {
    const reply = merged({
      ...ANSWERS,
      terms: { employmentType: 'full-time', employmentTypeQuote: '' },
    })
    expect(only(reply).evidence.map(({ field }) => field)).toEqual(['location', 'description'])
  })

  it('a model null is an answer: the field stays null and a stray quote is not evidence', () => {
    const reply = merged({
      ...ANSWERS,
      place: { location: null, locationQuote: 'Go Engineer, Lviv', remote: null },
    })
    expect(only(reply)).toMatchObject({ location: null, remote: null })
    expect(only(reply).evidence.map(({ field }) => field)).toEqual([
      'employmentType',
      'description',
    ])
  })

  it('fields of groups not asked merge as null', () => {
    const dose = smallDoseFor(['employmentType'])
    const reply = merged({ identity: ANSWERS.identity, terms: ANSWERS.terms }, dose)
    expect(only(reply)).toMatchObject({
      employmentType: 'full-time',
      location: null,
      remote: null,
      description: null,
    })
  })

  it('an answer for a group not asked is ignored', () => {
    const dose = smallDoseFor(['employmentType'])
    const reply = merged(ANSWERS, dose)
    expect(only(reply).location).toBeNull()
    expect(only(reply).evidence.map(({ field }) => field)).toEqual(['employmentType'])
  })

  it('a page with one posting and no facts is still one record, never "no postings"', () => {
    const reply = merged(
      { identity: ANSWERS.identity, terms: { employmentType: null, employmentTypeQuote: null } },
      smallDoseFor(['employmentType']),
    )
    expect(only(reply).employmentType).toBeNull()
  })

  it.each([0, 2, 20])('postingsOnPage %i refuses the merge: no record', (postingsOnPage) => {
    expect(smallDoseFor().merge({ ...ANSWERS, identity: { postingsOnPage } })).toEqual({
      ok: false,
    })
  })

  it.each([
    ['a missing identity', { ...ANSWERS, identity: undefined }],
    ['an identity off its shape', { ...ANSWERS, identity: { postingsOnPage: 'one' } }],
    ['an identity out of bound', { ...ANSWERS, identity: { postingsOnPage: 21 } }],
    ['a missing asked part', { ...ANSWERS, terms: undefined }],
    ['a part off its shape', { ...ANSWERS, place: { location: 7 } }],
    [
      'a fact over the part limit',
      { ...ANSWERS, terms: { employmentType: 'x'.repeat(101), employmentTypeQuote: null } },
    ],
    [
      'a quote over the part limit',
      { ...ANSWERS, terms: { employmentType: 'x', employmentTypeQuote: 'q'.repeat(2_001) } },
    ],
  ])('%s refuses the merge', (_name, parts) => {
    expect(smallDoseFor().merge(parts)).toEqual({ ok: false })
  })

  it('values at the bounds of a part are accepted', () => {
    const atBound = {
      identity: { postingsOnPage: 1 },
      place: { location: 'l'.repeat(500), locationQuote: 'q'.repeat(2_000), remote: false },
      terms: { employmentType: 'e'.repeat(100), employmentTypeQuote: null },
      description: { description: 'd'.repeat(20_000), descriptionQuote: null },
    }
    expect(smallDoseFor().merge(atBound).ok).toBe(true)
  })
})
