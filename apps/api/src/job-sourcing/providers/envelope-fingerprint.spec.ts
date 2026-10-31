import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { xmlPort } from '../xml'
import { jsonEnvelopeFingerprint, xmlEnvelopeFingerprint } from './envelope-fingerprint'

const xml = (text: string) => xmlPort.parseDocument(new TextEncoder().encode(text)).root

describe('envelope fingerprint (U2 AC 4)', () => {
  it('is the sha256 of the sorted, de-duplicated field names (hand-computed)', () => {
    const expected = createHash('sha256').update('["a","b","c"]').digest('hex')
    expect(jsonEnvelopeFingerprint({ b: 1, a: [{ c: 2 }, { c: 3, b: 4 }] })).toBe(expected)
  })

  it('the same names in another order give the same fingerprint', () => {
    const one = jsonEnvelopeFingerprint({ jobs: [{ id: 1, title: 'x' }], total: 1 })
    const two = jsonEnvelopeFingerprint({ total: 9, jobs: [{ title: 'y', id: 2 }] })
    expect(one).toBe(two)
  })

  it('differing field names give different fingerprints', () => {
    const one = jsonEnvelopeFingerprint({ jobs: [{ id: 1, title: 'x' }] })
    const renamed = jsonEnvelopeFingerprint({ jobs: [{ id: 1, name: 'x' }] })
    const added = jsonEnvelopeFingerprint({ jobs: [{ id: 1, title: 'x', salary: 3 }] })
    expect(new Set([one, renamed, added]).size).toBe(3)
  })

  it('values and array positions are not names: a scalar or an array root has no names', () => {
    const empty = createHash('sha256').update('[]').digest('hex')
    expect(jsonEnvelopeFingerprint([1, 2, 3])).toBe(empty)
    expect(jsonEnvelopeFingerprint('text')).toBe(empty)
    expect(jsonEnvelopeFingerprint(null)).toBe(empty)
  })

  it('a key that looks like a separator cannot collide with two keys', () => {
    expect(jsonEnvelopeFingerprint({ 'a","b': 1 })).not.toBe(
      jsonEnvelopeFingerprint({ a: 1, b: 2 }),
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
