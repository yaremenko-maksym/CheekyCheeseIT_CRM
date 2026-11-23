import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { xmlPort } from '../xml'
import {
  fingerprintAlgorithm,
  jsonEnvelopeFingerprint,
  xmlEnvelopeFingerprint,
} from './envelope-fingerprint'

const xml = (text: string) => xmlPort.parseDocument(new TextEncoder().encode(text)).root

describe('envelope fingerprint (U2 AC 4)', () => {
  // Hand-computed: tag `feed0002` + the first 56 hex of sha256 over the sorted top-level key list.
  const tagged = (input: string) =>
    `feed0002${createHash('sha256').update(input).digest('hex').slice(0, 56)}`

  it('JSON: the tagged sha256 of the sorted TOP-LEVEL keys only (hand-computed)', () => {
    expect(jsonEnvelopeFingerprint({ b: 1, a: [{ c: 2 }, { c: 3, d: 4 }] })).toBe(
      tagged('["a","b"]'),
    )
    expect(jsonEnvelopeFingerprint({ b: 1, a: 2 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('JSON: items with different optional keys give the same fingerprint (HN_HIRING drift)', () => {
    const one = jsonEnvelopeFingerprint({ hits: [{ id: 1, title: 'x' }], nbHits: 1 })
    const two = jsonEnvelopeFingerprint({ nbHits: 9, hits: [{ id: 2, story_text: 'y', url: 'u' }] })
    expect(one).toBe(two)
  })

  it('JSON: a 1-item last page and a 50-item page give the same fingerprint (JOBICY_API resume)', () => {
    const item = (i: number) => (i % 2 ? { id: i, salaryMin: 1 } : { id: i, tags: ['a'] })
    const last = jsonEnvelopeFingerprint({ jobs: [item(0)], jobCount: 1 })
    const full = jsonEnvelopeFingerprint({ jobs: Array.from({ length: 50 }, (_, i) => item(i)), jobCount: 50 })
    expect(last).toBe(full)
  })

  it('JSON: a renamed or added top-level key gives a different fingerprint', () => {
    const one = jsonEnvelopeFingerprint({ jobs: [], total: 1 })
    const renamed = jsonEnvelopeFingerprint({ items: [], total: 1 })
    const added = jsonEnvelopeFingerprint({ jobs: [], total: 1, next: null })
    expect(new Set([one, renamed, added]).size).toBe(3)
  })

  it('JSON: a root array hashes a fixed marker, whatever its items (LEVER_ATS); array vs object differs', () => {
    const marker = tagged('array')
    expect(jsonEnvelopeFingerprint([{ id: 1, a: 1 }])).toBe(marker)
    expect(jsonEnvelopeFingerprint([{ id: 2, b: 2 }, { id: 3 }])).toBe(marker)
    expect(jsonEnvelopeFingerprint([])).toBe(marker)
    expect(jsonEnvelopeFingerprint({})).toBe(tagged('[]'))
    expect(jsonEnvelopeFingerprint({ array: 1 })).not.toBe(marker)
  })

  it('JSON: a scalar root has no keys', () => {
    expect(jsonEnvelopeFingerprint('text')).toBe(tagged('[]'))
    expect(jsonEnvelopeFingerprint(null)).toBe(tagged('[]'))
  })

  it('JSON: a key that looks like a separator cannot collide with two keys', () => {
    expect(jsonEnvelopeFingerprint({ 'a","b': 1 })).not.toBe(
      jsonEnvelopeFingerprint({ a: 1, b: 2 }),
    )
  })

  it('the algorithm is told apart: JSON fingerprints carry the tag, XML and legacy ones do not', () => {
    expect(fingerprintAlgorithm(jsonEnvelopeFingerprint({ a: 1 }))).toBe('json-top-level')
    expect(fingerprintAlgorithm(xmlEnvelopeFingerprint(xml('<a/>')))).toBe('legacy')
    expect(fingerprintAlgorithm(createHash('sha256').update('["a","b","c"]').digest('hex'))).toBe(
      'legacy',
    )
  })

  it('XML: element and attribute names, order-independent; a renamed element differs', () => {
    const one = xmlEnvelopeFingerprint(
      xml('<rss v="2"><item><title>a</title><link>b</link></item></rss>'),
    )
    const reordered = xmlEnvelopeFingerprint(
      xml(
        '<rss v="9"><item><link>x</link><title>y</title></item><item><title>z</title></item></rss>',
      ),
    )
    const renamed = xmlEnvelopeFingerprint(
      xml('<rss v="2"><item><name>a</name><link>b</link></item></rss>'),
    )
    expect(one).toBe(reordered)
    expect(one).not.toBe(renamed)
    expect(one).toBe(
      createHash('sha256').update('["@v","item","link","rss","title"]').digest('hex'),
    )
  })

  it('XML: an attribute is not the element of the same name', () => {
    expect(xmlEnvelopeFingerprint(xml('<a title="x"/>'))).not.toBe(
      xmlEnvelopeFingerprint(xml('<a><title>x</title></a>')),
    )
  })
})
