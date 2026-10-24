import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The provenance contract (`phase3-common.md`) for the ATS A fixtures. Same shape as
 * `fixture-provenance.spec.ts`, which enumerates the 3.1 providers by name and so does not see
 * these; kept separate so the two tasks never edit one list. Differences, each deliberate:
 * a not-found fixture records HTTP 404 (the 404 IS the fixture), and a body stored exactly as
 * received (Ashby's plain-text 404) has equal raw and file hashes.
 */

const ROOT = join(__dirname, '__fixtures__')
const HOSTS: Record<string, string[]> = {
  greenhouse: ['boards-api.greenhouse.io'],
  lever: ['api.lever.co', 'api.eu.lever.co'],
  ashby: ['api.ashbyhq.com'],
}
const NOT_FOUND = new Set(['board-not-found'])

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
const provenanceSchema = z
  .object({
    url: z.string().url(),
    fetchedAt: instant,
    httpStatus: z.number().int(),
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trimmedBy: z.string().min(1),
    termsUrl: z.string().url(),
    termsCheckedAt: instant,
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

const fixtures = Object.keys(HOSTS).flatMap((provider) =>
  readdirSync(join(ROOT, provider))
    .filter((f) => /\.(json|txt)$/.test(f) && !f.endsWith('.provenance.json'))
    .map((file) => ({ provider, file, name: file.replace(/\.(json|txt)$/, '') })),
)
const load = (provider: string, name: string) =>
  provenanceSchema.parse(
    JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8')),
  )

describe('ATS A fixture provenance', () => {
  it('covers all three providers with the 14 captured files', () => {
    expect(new Set(fixtures.map((f) => f.provider))).toEqual(new Set(Object.keys(HOSTS)))
    expect(fixtures).toHaveLength(14)
  })

  it.each(fixtures.map((f) => [`${f.provider}/${f.file}`, f] as const))(
    '%s has a provenance file of exactly the contract shape whose hashes describe the committed bytes',
    (_label, { provider, file, name }) => {
      const p = load(provider, name)
      const committed = readFileSync(join(ROOT, provider, file))
      expect(createHash('sha256').update(committed).digest('hex')).toBe(p.fileSha256)
      expect(p.trimmedBy).not.toMatch(/head -c/)
      // Equal exactly when nothing was done to the body (a plain-text 404 stored as received).
      expect(p.rawSha256 === p.fileSha256).toBe(p.trimmedBy.startsWith('none:'))
      expect(p.httpStatus).toBe(NOT_FOUND.has(name) ? 404 : 200)
      expect(p.permission).toBe('PUBLIC_API_DOCUMENTED')
      expect(HOSTS[provider]).toContain(new URL(p.url).host)
      // A robots verdict is part of the record, even when the verdict is "none exists".
      expect(p.notes).toMatch(/robots/i)
    },
  )

  it('every captured board states how its ownership was verified; the not-found, empty and past-the-end ones have nothing to verify', () => {
    const noOwner = new Set([
      'greenhouse/board-not-found',
      'lever/board-not-found',
      'ashby/board-not-found',
      'ashby/deel-empty-board',
      'lever/spotify-page3-empty',
    ])
    const labels = fixtures.map((f) => `${f.provider}/${f.name}`)
    const stating = fixtures
      .filter((f) => /OWNERSHIP/.test(load(f.provider, f.name).notes))
      .map((f) => `${f.provider}/${f.name}`)
    expect(stating).toEqual(labels.filter((l) => !noOwner.has(l)))
  })

  it('leaves no e-mail address in any fixture except the redaction placeholder', () => {
    for (const { provider, file } of fixtures) {
      const text = readFileSync(join(ROOT, provider, file), 'utf8')
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
      expect(emails.filter((e) => e !== 'redacted@example.invalid')).toEqual([])
    }
  })

  it('records the Ashby API host as having NO robots verdict (401), not as permission', () => {
    expect(load('ashby', 'linear-board').notes).toContain('answers HTTP 401')
  })

  it("records Lever's Crawl-delay: 1, which is longer than the proposed 500 ms gap", () => {
    expect(load('lever', 'spotify-page1').notes).toContain('Crawl-delay: 1')
  })
})
