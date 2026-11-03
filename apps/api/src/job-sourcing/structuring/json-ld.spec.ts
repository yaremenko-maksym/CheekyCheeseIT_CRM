import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JSON_LD_LIMITS,
  extractJobPostings,
  selectByIdentity,
  type JsonLdJobPosting,
  type JsonLdLimits,
} from './json-ld'

const NOW = new Date('2026-11-03T00:00:00Z')
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', 'json-ld', name), 'utf8')
const run = (html: string, limits?: Partial<JsonLdLimits>) =>
  extractJobPostings(html, { now: NOW, limits })
const ld = (json: string): string => `<script type="application/ld+json">${json}</script>`
const posting = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ '@type': 'JobPosting', ...extra })
const one = (html: string, limits?: Partial<JsonLdLimits>): JsonLdJobPosting => {
  const r = run(html, limits)
  expect(r.postings).toHaveLength(1)
  return r.postings[0]
}

describe('extractJobPostings: structure', () => {
  const r = run(fixture('graph-multi.html'))

  it('finds postings across scripts, @graph and type arrays, skipping non-postings', () => {
    expect(r.postings.map((p) => p.identifier)).toEqual(['J-1', '2002'])
    expect(r.failures).toEqual({})
    expect(r.scanned.jsonLdScripts).toBe(3)
    expect(r.scanned.parsedScripts).toBe(3)
    expect(r.conflicts).toEqual([])
  })

  it('surfaces every field of a full posting', () => {
    const p = r.postings[0]
    expect(p).toMatchObject({
      identifier: 'J-1',
      url: 'https://example.invalid/jobs/1',
      title: 'Backend Engineer',
      hiringOrganization: 'Acme Synthetic',
      description: 'Build things.',
      jobLocationType: 'TELECOMMUTE',
      jobLocations: ['Kyiv, UA'],
      applicantLocationRequirements: ['Ukraine', 'Poland'],
      employmentType: ['FULL_TIME', 'CONTRACTOR'],
      skills: ['TypeScript'],
      expired: false,
    })
    expect(p.datePosted).toMatchObject({
      raw: '2026-10-01T09:00:00Z',
      status: 'OK',
      value: new Date('2026-10-01T09:00:00Z'),
    })
    expect(p.validThrough).toMatchObject({ raw: '2026-12-01T00:00:00Z', status: 'OK' })
  })

  it('reads employer from a plain string, and flags an expired posting', () => {
    const p = r.postings[1]
    expect(p.hiringOrganization).toBe('Plain String Co')
    expect(p.expired).toBe(true)
    expect(p.jobLocations).toEqual([])
    expect(p.datePosted).toBeNull()
  })

  it('accepts an IRI @type, rejects a near-miss type', () => {
    expect(run(ld(posting({ '@type': 'https://schema.org/JobPosting' }))).postings).toHaveLength(1)
    expect(run(ld('{"@type":"NotJobPosting"}')).postings).toHaveLength(0)
    expect(run(ld('{"@type":"JobPostings"}')).postings).toHaveLength(0)
    expect(run(ld('{"@type":7}')).postings).toHaveLength(0)
  })

  it('finds postings nested in arrays and plain objects, in document order', () => {
    const json = JSON.stringify([
      { a: { '@type': 'JobPosting', identifier: 'A' } },
      [{ '@type': 'JobPosting', identifier: 'B' }],
      { '@type': 'JobPosting', identifier: 'C' },
    ])
    expect(run(ld(json)).postings.map((p) => p.identifier)).toEqual(['A', 'B', 'C'])
  })

  it('does not descend into a posting', () => {
    const json = posting({
      identifier: 'OUTER',
      nested: { '@type': 'JobPosting', identifier: 'IN' },
    })
    expect(run(ld(json)).postings.map((p) => p.identifier)).toEqual(['OUTER'])
  })

  it('ignores @context entirely (no fetch, no resolution)', () => {
    const p = one(ld(posting({ '@context': 'https://evil.invalid/ctx.jsonld', identifier: 'X' })))
    expect(p.identifier).toBe('X')
  })

  it('only the ld+json type counts, in any quoting and case', () => {
    const body = posting({ identifier: 'T' })
    for (const attrs of [
      'type="application/ld+json"',
      "type='application/ld+json'",
      'type=application/ld+json',
      'id="a" TYPE="Application/LD+JSON" defer',
      'type = "application/ld+json"',
    ]) {
      expect(run(`<script ${attrs}>${body}</script>`).postings, attrs).toHaveLength(1)
    }
    for (const attrs of [
      'type="application/json"',
      'type="text/javascript"',
      'data-type="application/ld+json"',
      'type="application/ld+jsonx"',
      'type=application/ld+jsonx',
      '',
    ]) {
      expect(run(`<script ${attrs}>${body}</script>`).postings, attrs).toHaveLength(0)
    }
  })

  it('handles a script tag with no attributes before a ld+json one, and </script > closers', () => {
    const body = posting({ identifier: 'T' })
    expect(
      run(`<script>1</script><script type="application/ld+json">${body}</script >`).postings,
    ).toHaveLength(1)
    expect(
      run(`<scripts>x</scripts><script type="application/ld+json">${body}</script>`).postings,
    ).toHaveLength(1)
    expect(run(`<script/type="application/ld+json">${body}</script>`).postings).toHaveLength(1)
  })
})

describe('extractJobPostings: field evidence', () => {
  it('employer: string, {name}, and absent are all handled; posting still returned', () => {
    expect(one(ld(posting({ hiringOrganization: ' Acme ' }))).hiringOrganization).toBe('Acme')
    expect(one(ld(posting({ hiringOrganization: { name: 'Beta' } }))).hiringOrganization).toBe(
      'Beta',
    )
    const p = one(fixture('no-employer.html'))
    expect(p.hiringOrganization).toBeNull()
    expect(p.title).toBe('Anonymous role')
    expect(one(ld(posting({ hiringOrganization: '   ' }))).hiringOrganization).toBeNull()
    expect(one(ld(posting({ hiringOrganization: 5 }))).hiringOrganization).toBeNull()
    expect(one(ld(posting())).hiringOrganization).toBeNull()
  })

  it('identifier: string, number, PropertyValue', () => {
    expect(one(ld(posting({ identifier: 'S1' }))).identifier).toBe('S1')
    expect(one(ld(posting({ identifier: 42 }))).identifier).toBe('42')
    expect(one(ld(posting({ identifier: { value: 'V1' } }))).identifier).toBe('V1')
    expect(one(ld(posting({ identifier: { value: 7 } }))).identifier).toBe('7')
    expect(one(ld(posting({ identifier: true }))).identifier).toBeNull()
  })

  it('title falls back to name', () => {
    expect(one(ld(posting({ title: 'T', name: 'N' }))).title).toBe('T')
    expect(one(ld(posting({ name: 'N' }))).title).toBe('N')
  })

  it('locations: country as string, address as string, region, skipped when empty', () => {
    const p = one(
      ld(
        posting({
          jobLocation: [
            {
              address: {
                addressLocality: 'Lviv',
                addressRegion: 'Lviv Oblast',
                addressCountry: 'UA',
              },
            },
            { address: 'Remote, EU' },
            { address: {} },
            { address: 5 },
            'plain',
          ],
        }),
      ),
    )
    expect(p.jobLocations).toEqual(['Lviv, Lviv Oblast, UA', 'Remote, EU'])
  })

  it('lists: single value, empty strings dropped, non-strings dropped', () => {
    const p = one(ld(posting({ employmentType: 'PART_TIME', skills: ['a', '', 3, ' b '] })))
    expect(p.employmentType).toEqual(['PART_TIME'])
    expect(p.skills).toEqual(['a', 'b'])
    expect(one(ld(posting())).skills).toEqual([])
    expect(one(ld(posting({ skills: null }))).skills).toEqual([])
  })

  it('dates keep the raw value and status; unusable validThrough gives expired null', () => {
    const p = one(ld(posting({ datePosted: '10/01/2026', validThrough: 'not a date' })))
    expect(p.datePosted).toMatchObject({ raw: '10/01/2026', status: 'INVALID', value: null })
    expect(p.validThrough).toMatchObject({ status: 'INVALID' })
    expect(p.expired).toBeNull()
    expect(one(ld(posting({ validThrough: 20261201 }))).validThrough).toBeNull()
    expect(one(ld(posting({ validThrough: '2026-11-02T23:59:59Z' }))).expired).toBe(true)
    expect(one(ld(posting({ validThrough: '2026-11-03T00:00:00Z' }))).expired).toBe(false)
  })

  it('a far-future datePosted is flagged, not trusted', () => {
    expect(one(ld(posting({ datePosted: '2026-12-31T00:00:00Z' }))).datePosted?.status).toBe(
      'FUTURE',
    )
  })
})

describe('extractJobPostings: conflicts and failures', () => {
  it('reports a stale conflict (same id, different data) without merging', () => {
    const r = run(fixture('conflict.html'))
    expect(r.postings.map((p) => p.title)).toEqual(['Old title', 'New title'])
    expect(r.conflicts).toEqual(['DUP'])
  })

  it('identical duplicates and id-less postings are not conflicts', () => {
    const same = ld(posting({ identifier: 'S', title: 't' }))
    expect(run(same + same).conflicts).toEqual([])
    expect(run(ld(posting({ title: 'a' })) + ld(posting({ title: 'b' }))).conflicts).toEqual([])
    expect(
      run(
        ld(posting({ identifier: 'A', title: 'a' })) + ld(posting({ identifier: 'B', title: 'b' })),
      ).conflicts,
    ).toEqual([])
  })

  it('a literal </script> in a string ends the element: counted malformed, neighbours unaffected', () => {
    const r = run(fixture('literal-terminator.html'))
    expect(r.failures).toEqual({ MALFORMED_JSON: 1 })
    expect(r.postings.map((p) => p.identifier)).toEqual(['GOOD'])
    expect(r.scanned.jsonLdScripts).toBe(2)
    expect(r.scanned.parsedScripts).toBe(1)
  })

  it('escaped terminators are decoded after the parse', () => {
    const r = run(fixture('escaped-terminator.html'))
    expect(r.failures).toEqual({})
    expect(r.postings[0].title).toBe('a</script>b <script>')
  })

  it('no JSON-LD is an empty result, not an error', () => {
    const r = run(fixture('no-jsonld.html'))
    expect(r).toEqual({
      postings: [],
      failures: {},
      scanned: { jsonLdScripts: 0, parsedScripts: 0, nodes: 0 },
      conflicts: [],
    })
    expect(run('').postings).toEqual([])
  })

  it('invalid JSON is counted per script and other scripts still work', () => {
    const r = run(`${ld('{nope')}${ld('')}${ld(posting({ identifier: 'OK' }))}`)
    expect(r.failures).toEqual({ MALFORMED_JSON: 2 })
    expect(r.postings.map((p) => p.identifier)).toEqual(['OK'])
  })

  it('depth bomb is refused (TOO_DEEP), bounded by the limit exactly', () => {
    const nest = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`
    expect(run(ld(nest(5000))).failures).toEqual({ TOO_DEEP: 1 })
    expect(run(ld(nest(2)), { maxDepth: 3 }).failures).toEqual({})
    expect(run(ld(nest(3)), { maxDepth: 3 }).failures).toEqual({ TOO_DEEP: 1 })
  })

  it('oversized script is refused; the next script is unaffected', () => {
    const big = ld(posting({ title: 'x'.repeat(200) }))
    const r = run(big + ld(posting({ identifier: 'S' })), { maxScriptBytes: 100 })
    expect(r.failures).toEqual({ SCRIPT_TOO_LARGE: 1 })
    expect(r.postings.map((p) => p.identifier)).toEqual(['S'])
  })

  it('per-script node cap', () => {
    const r = run(ld('[1,2,3,4]'), { maxNodes: 3 })
    expect(r.failures).toEqual({ TOO_MANY_NODES: 1 })
    expect(run(ld('[1,2,3]'), { maxNodes: 4 }).failures).toEqual({})
  })

  it('oversized page is refused before scanning, exactly at the limit', () => {
    const html = ld(posting({ identifier: 'P' }))
    const bytes = Buffer.byteLength(html)
    expect(run(html, { maxHtmlBytes: bytes }).postings).toHaveLength(1)
    const r = run(html, { maxHtmlBytes: bytes - 1 })
    expect(r.failures).toEqual({ HTML_TOO_LARGE: 1 })
    expect(r.postings).toEqual([])
    expect(r.scanned.jsonLdScripts).toBe(0)
    expect(run('é', { maxHtmlBytes: 1 }).failures).toEqual({ HTML_TOO_LARGE: 1 })
  })

  it('script count is capped: first N processed, one failure counted, rest not scanned', () => {
    const html = ['a', 'b', 'c'].map((id) => ld(posting({ identifier: id }))).join('')
    const r = run(html, { maxScripts: 2 })
    expect(r.postings.map((p) => p.identifier)).toEqual(['a', 'b'])
    expect(r.failures).toEqual({ TOO_MANY_SCRIPTS: 1 })
    expect(r.scanned.jsonLdScripts).toBe(2)
    expect(run(html, { maxScripts: 3 }).failures).toEqual({})
  })

  it('non-ld scripts do not consume the script budget', () => {
    const html = `${'<script>1</script>'.repeat(30)}${ld(posting({ identifier: 'A' }))}`
    expect(run(html, { maxScripts: 1 }).postings).toHaveLength(1)
  })

  it('total node cap stops the walk and is counted once', () => {
    const html = ld('[{"a":1},{"a":1}]') + ld(posting({ identifier: 'LATE' }))
    const r = run(html, { maxTotalNodes: 3 })
    expect(r.failures).toEqual({ TOTAL_NODES_EXCEEDED: 1 })
    expect(r.postings).toEqual([])
    expect(r.scanned.nodes).toBe(4)
    expect(run(ld('[1,2]'), { maxTotalNodes: 3 }).failures).toEqual({})
  })

  it('an unterminated ld+json script is counted; an unterminated plain script is not', () => {
    expect(run(`<script type="application/ld+json">{"a":1}`).failures).toEqual({
      UNTERMINATED_SCRIPT: 1,
    })
    expect(run('<script>var a').failures).toEqual({})
    expect(run('<script type="application/ld+json"').failures).toEqual({})
    expect(
      run(`${ld(posting({ identifier: 'K' }))}<script type="application/ld+json">{`).postings,
    ).toHaveLength(1)
  })

  it('long fields are dropped and counted, at exactly the cap', () => {
    const ok = one(ld(posting({ title: 'x'.repeat(10) })), { maxFieldChars: 10 })
    expect(ok.title).toHaveLength(10)
    const r = run(ld(posting({ title: 'x'.repeat(11), hiringOrganization: 'y'.repeat(11) })), {
      maxFieldChars: 10,
    })
    expect(r.postings[0].title).toBeNull()
    expect(r.postings[0].hiringOrganization).toBeNull()
    expect(r.failures).toEqual({ FIELD_TOO_LONG: 2 })
  })

  it('description has its own, larger cap', () => {
    const lim = { maxFieldChars: 5, maxDescriptionChars: 20 }
    expect(one(ld(posting({ description: 'd'.repeat(20) })), lim).description).toHaveLength(20)
    const r = run(ld(posting({ description: 'd'.repeat(21) })), lim)
    expect(r.postings[0].description).toBeNull()
    expect(r.failures).toEqual({ FIELD_TOO_LONG: 1 })
  })

  it('defaults are bounded and finite', () => {
    expect(DEFAULT_JSON_LD_LIMITS).toEqual({
      maxHtmlBytes: 2097152,
      maxScripts: 20,
      maxScriptBytes: 524288,
      maxDepth: 32,
      maxNodes: 20000,
      maxTotalNodes: 50000,
      maxFieldChars: 1000,
      maxDescriptionChars: 100000,
    })
  })
})

describe('selectByIdentity', () => {
  const postings = run(fixture('graph-multi.html')).postings

  it('selects by identifier or by url', () => {
    expect(selectByIdentity(postings, { identifier: '2002' })).toEqual({
      kind: 'match',
      posting: postings[1],
    })
    expect(selectByIdentity(postings, { url: 'https://example.invalid/jobs/1' })).toEqual({
      kind: 'match',
      posting: postings[0],
    })
  })

  it('all supplied criteria must match', () => {
    expect(
      selectByIdentity(postings, { identifier: 'J-1', url: 'https://example.invalid/jobs/2' }),
    ).toEqual({
      kind: 'none',
    })
    expect(
      selectByIdentity(postings, { identifier: 'J-1', url: 'https://example.invalid/jobs/1' }).kind,
    ).toBe('match')
  })

  it('no match or no criteria is none, never the first posting', () => {
    expect(selectByIdentity(postings, { identifier: 'nope' })).toEqual({ kind: 'none' })
    expect(selectByIdentity(postings, { url: 'nope' })).toEqual({ kind: 'none' })
    expect(selectByIdentity(postings, {})).toEqual({ kind: 'none' })
    expect(selectByIdentity(postings, { identifier: '', url: '' })).toEqual({ kind: 'none' })
    expect(selectByIdentity([], { identifier: 'J-1' })).toEqual({ kind: 'none' })
  })

  it('a conflicting page is ambiguous, not resolved by position', () => {
    const dup = run(fixture('conflict.html')).postings
    expect(selectByIdentity(dup, { identifier: 'DUP' })).toEqual({ kind: 'ambiguous', count: 2 })
  })
})
