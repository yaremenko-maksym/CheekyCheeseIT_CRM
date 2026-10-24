import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  fixtureFiles,
  fixtureProviders,
  provenanceFiles,
  readFixtureText,
  readProvenance,
  sha256OfFixture,
} from '../../../test/fixture-provenance'

/**
 * Provenance for EVERY committed fixture, whatever provider it belongs to, found by walking
 * `__fixtures__` rather than by a list. `fixture-provenance.spec.ts` (Task 3.1) enumerates its four
 * providers by name and checks a stricter shape; this file exists because only a walk sees the
 * ones nobody added to a list (the RSS captures of Task 3.6 had no hash check before it), and
 * because Task 3.7 builds its manifest from every `*.provenance.json`, not from a chosen few.
 *
 * Layer 1 is the loose contract for all providers. Layer 2 is the stricter rules of the ATS A
 * captures (Greenhouse, Lever, Ashby): a not-found fixture records HTTP 404 (the 404 IS the
 * fixture), and a body stored exactly as received (Ashby's plain-text 404) has equal raw and file
 * hashes.
 */

const providers = fixtureProviders()
const all = providers.flatMap((p) => fixtureFiles(p))

describe('every committed fixture has a provenance file that describes its bytes', () => {
  it('walks the providers it is meant to protect, so the walk cannot pass by finding nothing', () => {
    for (const expected of ['greenhouse', 'lever', 'ashby', 'wwr', 'djinni', 'euremotejobs']) {
      expect(providers).toContain(expected)
    }
    for (const p of providers)
      expect(fixtureFiles(p).length, `${p} has fixtures`).toBeGreaterThan(0)
  })

  it.each(all.map((f) => [`${f.provider}/${f.file}`, f] as const))(
    '%s: provenance parses, fileSha256 matches the committed bytes, and no byte cut was used',
    (_label, f) => {
      const p = readProvenance(f.provider, f.provenanceFile)
      expect(sha256OfFixture(f.provider, f.file)).toBe(p.fileSha256)
      expect(p.trimmedBy).not.toMatch(/head -c/)
    },
  )

  it('has no provenance file without a fixture beside it', () => {
    for (const p of providers) {
      const expected = new Set(fixtureFiles(p).map((f) => f.provenanceFile))
      expect(
        provenanceFiles(p).filter((pf) => !expected.has(pf)),
        `${p} orphans`,
      ).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Layer 2: the ATS A captures
// ---------------------------------------------------------------------------------------------

const ATS_HOSTS: Record<string, string[]> = {
  greenhouse: ['boards-api.greenhouse.io'],
  lever: ['api.lever.co', 'api.eu.lever.co'],
  ashby: ['api.ashbyhq.com'],
}
const NOT_FOUND = new Set(['board-not-found'])
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
const atsFixtures = Object.keys(ATS_HOSTS).flatMap((p) => fixtureFiles(p))
const atsLabel = (f: { provider: string; file: string }) => `${f.provider}/${f.file}`
const stem = (file: string) => file.slice(0, file.lastIndexOf('.'))

describe('ATS A fixture provenance', () => {
  it('covers all three providers with the 14 captured files', () => {
    expect(new Set(atsFixtures.map((f) => f.provider))).toEqual(new Set(Object.keys(ATS_HOSTS)))
    expect(atsFixtures).toHaveLength(14)
  })

  it.each(atsFixtures.map((f) => [atsLabel(f), f] as const))(
    '%s: ISO instants with milliseconds, the right status, host and permission, and a robots verdict',
    (_label, f) => {
      const p = readProvenance(f.provider, f.provenanceFile)
      expect(instant.safeParse(p.fetchedAt).success).toBe(true)
      expect(instant.safeParse(p.termsCheckedAt).success).toBe(true)
      // Equal exactly when nothing was done to the body (a plain-text 404 stored as received).
      expect(p.rawSha256 === p.fileSha256).toBe(p.trimmedBy.startsWith('none:'))
      expect(p.httpStatus).toBe(NOT_FOUND.has(stem(f.file)) ? 404 : 200)
      // Task 3.7 reads this structured field, not the notes: Ashby's host gives no robots verdict.
      expect(p.permission).toBe(f.provider === 'ashby' ? 'UNCLEAR' : 'PUBLIC_API_DOCUMENTED')
      expect(ATS_HOSTS[f.provider]).toContain(new URL(p.url).host)
      // A robots verdict is part of the record, even when the verdict is "none exists".
      expect(p.notes).toMatch(/robots/i)
    },
  )

  it('every captured board states how its ownership was verified, with its strength; the not-found, empty and past-the-end ones have nothing to verify', () => {
    const noOwner = new Set([
      'greenhouse/board-not-found.json',
      'lever/board-not-found.json',
      'ashby/board-not-found.txt',
      'ashby/deel-empty-board.json',
      'lever/spotify-page3-empty.json',
    ])
    const stating = atsFixtures
      .filter((f) => /OWNERSHIP/.test(readProvenance(f.provider, f.provenanceFile).notes))
      .map(atsLabel)
    expect(stating).toEqual(atsFixtures.map(atsLabel).filter((l) => !noOwner.has(l)))
  })

  it('states the STRENGTH of each ownership claim in a form Task 3.7 can read: payload field, full text, or partial text', () => {
    const strengths = Object.fromEntries(
      atsFixtures
        .filter((f) => /OWNERSHIP/.test(readProvenance(f.provider, f.provenanceFile).notes))
        .map((f) => [
          atsLabel(f),
          /EVIDENCE: (PAYLOAD_FIELD|TEXT_FULL|TEXT_PARTIAL)/.exec(
            readProvenance(f.provider, f.provenanceFile).notes,
          )?.[1],
        ]),
    )
    expect(strengths).toEqual({
      'greenhouse/airbnb-board.json': 'PAYLOAD_FIELD',
      'greenhouse/cloudflare-board.json': 'PAYLOAD_FIELD',
      'greenhouse/stripe-board.json': 'PAYLOAD_FIELD',
      'lever/spotify-page1.json': 'TEXT_PARTIAL',
      'lever/spotify-page2.json': undefined,
      'lever/siteimprove-eu-board.json': 'TEXT_FULL',
      'lever/quantco-trailing-hyphen-board.json': 'TEXT_FULL',
      'ashby/linear-board.json': 'TEXT_FULL',
      'ashby/supabase-board.json': 'TEXT_FULL',
    })
  })

  it('characterises the Spotify postings that do not name Spotify, and marks the uncaptured palantir read as unverified', () => {
    const notes = readProvenance('lever', 'spotify-page1.provenance.json').notes
    expect(notes).toContain('87 of the 90')
    expect(notes).toContain('The 3 that name it nowhere')
    expect(notes).toMatch(/palantir[^.]*UNCAPTURED/)
  })

  it('leaves no e-mail address in any ATS fixture except the redaction placeholder', () => {
    for (const f of atsFixtures) {
      const text = readFixtureText(f.provider, f.file)
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
      expect(emails.filter((e) => e !== 'redacted@example.invalid')).toEqual([])
    }
  })

  it('records the Ashby API host as having NO robots verdict (401), not as permission', () => {
    const p = readProvenance('ashby', 'linear-board.provenance.json')
    expect(p.notes).toContain('answers HTTP 401')
    expect(p.permission).toBe('UNCLEAR')
  })

  it('every Ashby file, not only one, carries the UNCLEAR permission and says why', () => {
    const ashby = fixtureFiles('ashby')
    expect(ashby).toHaveLength(4)
    for (const f of ashby) {
      const p = readProvenance('ashby', f.provenanceFile)
      expect([p.permission, p.notes.startsWith('PERMISSION IS UNCLEAR')]).toEqual(['UNCLEAR', true])
    }
  })

  it("records Lever's Crawl-delay: 1, which is longer than the proposed 500 ms gap", () => {
    expect(readProvenance('lever', 'spotify-page1.provenance.json').notes).toContain(
      'Crawl-delay: 1',
    )
  })
})
