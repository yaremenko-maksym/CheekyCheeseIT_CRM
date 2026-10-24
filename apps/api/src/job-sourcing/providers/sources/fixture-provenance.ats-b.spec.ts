import { describe, expect, it } from 'vitest'
import { AT_FORMS, addressHits, PLACEHOLDER } from '../../../test/address-tokens'
import { fixtureFiles, readFixtureText, readProvenance } from '../../../test/fixture-provenance'

/**
 * Layer 2 for the ATS B captures (Task 3.4), on top of the walk in `fixture-provenance.all.spec.ts`
 * (which proves every fixture has a provenance file whose hash matches its bytes). What is asserted
 * here is what Task 3.7 reads from the structured fields: the host a capture came from, its status,
 * its permission, and that a robots verdict is part of every record.
 */

const HOSTS: Record<string, RegExp> = {
  workable: /^apply\.workable\.com$/,
  recruitee: /^[a-z0-9-]+\.recruitee\.com$/,
  personio: /^[a-z0-9-]+\.jobs\.personio\.(de|com)$/,
  smartrecruiters: /^api\.smartrecruiters\.com$/,
}
const NOT_FOUND = new Set(['account-not-found', 'offers-not-found', 'tenant-not-found'])
const stem = (file: string) => file.slice(0, file.lastIndexOf('.'))
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const all = Object.keys(HOSTS).flatMap((p) => fixtureFiles(p))
const label = (f: { provider: string; file: string }) => `${f.provider}/${f.file}`

/**
 * An address-shaped run that is allowed to stay, by file, exact value and reason. The captures hold
 * nothing but the placeholder; the two entries are the npm scope of the XML parser named in
 * `trimmedBy`, found by the scan itself.
 */
const ALLOWED_ADDRESS_SPANS: readonly { file: string; value: string; reason: string }[] = [
  {
    file: 'personio/westwing-de.provenance.json',
    value: '@rgrove',
    reason: 'npm scope of @rgrove/parse-xml in the trimmedBy description, not a person',
  },
  {
    file: 'personio/westwing-en.provenance.json',
    value: '@rgrove',
    reason: 'npm scope of @rgrove/parse-xml in the trimmedBy description, not a person',
  },
]

describe('ATS B fixture provenance', () => {
  it('covers the four providers with exactly the 12 committed files', () => {
    expect(all.map(label)).toEqual([
      'workable/account-not-found.txt',
      'workable/hirefellows-account.json',
      'workable/hotjar-empty-account.json',
      'workable/huggingface-account.json',
      'recruitee/bunq-offers.json',
      'recruitee/offers-not-found.json',
      'recruitee/tellent-empty-offers.json',
      'personio/personio-en.xml',
      'personio/tenant-not-found.txt',
      'personio/westwing-de.xml',
      'personio/westwing-en.xml',
      'smartrecruiters/api-robots.txt',
    ])
  })

  it.each(all.map((f) => [label(f), f] as const))(
    '%s: ISO instants, the right status, host and permission, and a robots verdict',
    (_label, f) => {
      const p = readProvenance(f.provider, f.provenanceFile)
      expect(p.fetchedAt).toMatch(instant)
      expect(p.termsCheckedAt).toMatch(instant)
      expect(p.rawSha256 === p.fileSha256).toBe(p.trimmedBy.startsWith('none:'))
      expect(p.httpStatus).toBe(NOT_FOUND.has(stem(f.file)) ? 404 : 200)
      expect(new URL(p.url).host).toMatch(HOSTS[f.provider] as RegExp)
      expect(p.permission).toBe(
        f.provider === 'smartrecruiters' ? 'UNCLEAR' : 'PUBLIC_API_DOCUMENTED',
      )
      expect(p.notes).toMatch(/robots/i)
    },
  )

  it('leaves no address-shaped token in any ATS B fixture or provenance file, in any spelling of "@"', () => {
    const unexpected: string[] = []
    for (const f of all) {
      for (const name of [f.file, f.provenanceFile]) {
        for (const hit of addressHits(readFixtureText(f.provider, name))) {
          const allowed = ALLOWED_ADDRESS_SPANS.some(
            (a) => a.file === `${f.provider}/${name}` && a.value === hit.span,
          )
          if (!allowed) unexpected.push(`${f.provider}/${name} [${hit.form}] ${hit.span}`)
        }
      }
    }
    expect(unexpected).toEqual([])
  })

  it('the redaction ran: bunq carries the placeholder once per offer and nothing else that looks like an address', () => {
    const text = readFixtureText('recruitee', 'bunq-offers.json')
    expect(text.split(PLACEHOLDER).length - 1).toBe(3)
  })

  it('SmartRecruiters: the only capture is the robots.txt that disallows this collector, and it says UNCLEAR first', () => {
    const p = readProvenance('smartrecruiters', 'api-robots.provenance.json')
    expect(p.url).toBe('https://api.smartrecruiters.com/robots.txt')
    expect(p.notes.startsWith('PERMISSION IS UNCLEAR')).toBe(true)
    expect(p.notes).toContain('DISALLOWED for every other agent')
    expect(p.notes).toContain(
      'no GET was sent to api.smartrecruiters.com other than this robots.txt',
    )
  })

  it('Recruitee: every record carries the token evidence, the deadline and why a third party can never hold the token', () => {
    for (const name of ['bunq-offers', 'tellent-empty-offers', 'offers-not-found']) {
      const { notes } = readProvenance('recruitee', `${name}.provenance.json`)
      expect(notes).toContain('X-Careers-Sites-Token')
      expect(notes).toContain('10 February 2027')
      expect(notes).toContain('401 Unauthorized')
      expect(notes).toContain("USER OF THE EMPLOYER'S OWN Recruitee account")
      expect(notes).toContain('KEY_REQUIRED')
    }
  })

  it('Workable: every record names the redirect, the final address and the unused authorised API', () => {
    for (const f of fixtureFiles('workable')) {
      const { notes } = readProvenance('workable', f.provenanceFile)
      expect(notes).toContain('HTTP 302')
      expect(notes).toContain('/api/v1/widget/accounts/')
      expect(notes).toContain('/spi/v3/')
      expect(notes).toContain('was not called')
    }
  })

  it('Personio: every record says the .de and .com hosts are one data set, and that no posting URL is in the feed', () => {
    for (const f of fixtureFiles('personio')) {
      const { notes } = readProvenance('personio', f.provenanceFile)
      expect(notes).toContain('byte-identical')
      expect(notes).toContain('NO POSTING URL IS IN THE FEED')
    }
  })

  it('the captured Westwing documents are the same 5 / 2 ids in two languages (the ids are what the language fixture proves)', () => {
    const ids = (name: string) =>
      [...readFixtureText('personio', name).matchAll(/<id>(\d+)<\/id>/g)].map((m) => m[1])
    expect(ids('westwing-en.xml')).toEqual(['2630474', '2703051', '2435528', '1968758', '2702093'])
    expect(ids('westwing-de.xml')).toEqual(['2630474', '2702093'])
  })
})

describe('the address scan sees every spelling of "@", each with its own positive control', () => {
  const CONTROLS: readonly (readonly [string, string])[] = [
    ['literal @', '@'],
    ['fullwidth @', '\uFF20'],
    ['percent-encoded', '%40'],
    ['double percent-encoded', '%2540'],
    ['decimal entity', '&#64;'],
    ['decimal entity', '&#0064;'],
    ['hex entity', '&#x40;'],
    ['hex entity', '&#X0040;'],
    ['named entity', '&commat;'],
    ['[at]', '[at]'],
    ['(at)', '(AT)'],
  ]

  it('knows exactly these forms, so deleting one from the scan fails here', () => {
    expect(AT_FORMS.map((f) => f.name)).toEqual([
      'literal @',
      'fullwidth @',
      'percent-encoded',
      'double percent-encoded',
      'decimal entity',
      'hex entity',
      'named entity',
      '[at]',
      '(at)',
    ])
  })

  it.each(CONTROLS)('%s: %s is found inside an address, whole', (form, token) => {
    const hits = addressHits(`write to jane.tan${token}example.invalid today`)
    expect(hits.map((h) => [h.form, h.span])).toEqual([[form, `jane.tan${token}example.invalid`]])
  })

  it('the placeholder is matched WHOLE: only the exact literal passes', () => {
    expect(addressHits(PLACEHOLDER)).toEqual([])
    expect(addressHits(`"${PLACEHOLDER}"`)).toEqual([])
    for (const near of [
      'Jane.Tan%40example.invalid',
      'redacted%40example.invalid',
      'xredacted@example.invalid',
      'redacted@example.invalid.evil',
      'redacted@example.invalidx',
      'Redacted@example.invalid',
    ]) {
      expect(addressHits(near).length, near).toBeGreaterThan(0)
    }
  })

  it('a bare @ and plain text', () => {
    expect(addressHits('@')).toEqual([{ form: 'literal @', span: '@' }])
    expect(addressHits('no address here, 40 percent and 64 entities')).toEqual([])
  })
})
