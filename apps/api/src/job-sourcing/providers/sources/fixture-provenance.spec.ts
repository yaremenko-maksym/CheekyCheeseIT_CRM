import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The provenance contract of the phase-3 fixtures (`phase3-common.md`): Task 3.7 builds the
 * manifest from these files, so their shape is a contract, not a convention. Every fixture must
 * have a sibling provenance file, and the recorded hash must describe the bytes actually committed.
 */

const ROOT = join(__dirname, '__fixtures__')
const PROVIDERS = [
  'remoteok',
  'remotive',
  'himalayas',
  'jobicy',
  'arbeitnow',
  'jobgether',
  'hn-hiring',
]

const provenanceSchema = z
  .object({
    url: z.string().url(),
    fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    httpStatus: z.number().int(),
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trimmedBy: z.string().min(1),
    termsUrl: z.string().url(),
    termsCheckedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    permission: z.enum([
      'PUBLIC_API_DOCUMENTED',
      'PUBLIC_FEED',
      'UNCLEAR',
      'PROHIBITED',
      'KEY_REQUIRED',
    ]),
    notes: z.string().min(1),
  })
  .strict()

const fixtures = PROVIDERS.flatMap((provider) =>
  readdirSync(join(ROOT, provider))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.provenance.json'))
    .map((f) => ({ provider, name: f.slice(0, -'.json'.length) })),
)

describe('fixture provenance', () => {
  it('covers every provider with at least one fixture, and the 17 captured files (7 from 3.1, 10 from 3.2)', () => {
    expect(new Set(fixtures.map((f) => f.provider))).toEqual(new Set(PROVIDERS))
    expect(fixtures).toHaveLength(17)
  })

  it.each(fixtures.map((f) => [`${f.provider}/${f.name}`, f] as const))(
    '%s has a provenance file of exactly the contract shape whose fileSha256 matches the committed bytes',
    (_label, { provider, name }) => {
      const provenance = provenanceSchema.parse(
        JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8')),
      )
      const committed = readFileSync(join(ROOT, provider, `${name}.json`))
      expect(createHash('sha256').update(committed).digest('hex')).toBe(provenance.fileSha256)
      expect(provenance.rawSha256).not.toBe(provenance.fileSha256)
      expect(provenance.trimmedBy).not.toMatch(/head -c/)
      expect(provenance.httpStatus).toBe(200)
    },
  )

  it('records the Remotive robots.txt contradiction as UNCLEAR rather than as permission', () => {
    const p = provenanceSchema.parse(
      JSON.parse(readFileSync(join(ROOT, 'remotive', 'software-dev.provenance.json'), 'utf8')),
    )
    expect(p.permission).toBe('UNCLEAR')
  })

  it.each([
    ['arbeitnow', 'page-1', 'PUBLIC_API_DOCUMENTED'],
    ['arbeitnow', 'empty-page', 'PUBLIC_API_DOCUMENTED'],
    ['jobgether', 'page-1', 'UNCLEAR'],
    ['jobgether', 'page-10', 'UNCLEAR'],
    ['jobgether', 'no-results', 'UNCLEAR'],
    ['jobgether', 'deprecated-path', 'UNCLEAR'],
    ['hn-hiring', 'search', 'UNCLEAR'],
    ['hn-hiring', 'thread-2026-10', 'UNCLEAR'],
    ['hn-hiring', 'thread-2026-09', 'UNCLEAR'],
    ['hn-hiring', 'thread-2019-05', 'UNCLEAR'],
  ])('%s/%s records permission %s (the 3.2 verdicts)', (provider, name, permission) => {
    const p = provenanceSchema.parse(
      JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8')),
    )
    expect(p.permission).toBe(permission)
  })

  it('keeps no Working Nomads job data: its only artifact is the terms page, committed byte for byte', () => {
    const dir = join(ROOT, 'workingnomads')
    expect(readdirSync(dir).sort()).toEqual(['terms.html', 'terms.provenance.json'])
    const p = provenanceSchema.parse(
      JSON.parse(readFileSync(join(dir, 'terms.provenance.json'), 'utf8')),
    )
    const bytes = readFileSync(join(dir, 'terms.html'))
    const digest = createHash('sha256').update(bytes).digest('hex')
    expect(p.fileSha256).toBe(digest)
    expect(p.rawSha256).toBe(digest)
    expect(p.permission).toBe('UNCLEAR')
  })

  it('leaves no e-mail address in any fixture except the redaction placeholder', () => {
    for (const { provider, name } of fixtures) {
      const text = readFileSync(join(ROOT, provider, `${name}.json`), 'utf8')
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
      expect(emails.filter((e) => e !== 'redacted@example.invalid')).toEqual([])
    }
  })
})
