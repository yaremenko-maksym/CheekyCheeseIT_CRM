import { describe, expect, it } from 'vitest'
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

  it('leaves no e-mail address in any ATS B fixture except the redaction placeholder', () => {
    for (const f of all) {
      const emails =
        readFixtureText(f.provider, f.file).match(
          /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        ) ?? []
      expect(emails.filter((e) => e !== 'redacted@example.invalid')).toEqual([])
    }
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
