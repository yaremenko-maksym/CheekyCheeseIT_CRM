import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The provenance contract (`phase3-common.md`) for the Task 3.5b fixtures. Separate from
 * `fixture-provenance.spec.ts` because that one belongs to Task 3.1 and asserts "200 and a raw hash
 * different from the file's" for every fixture it lists. Task 3.7 builds the manifest from these
 * files, so the shape is a contract. The keyed sources' hand-written unit examples were replaced by
 * the captures of the owner's controlled smoke (2026-11-16); the edge cases those examples held now
 * live, built, in each provider's own spec.
 */

const ROOT = join(__dirname, '__fixtures__')
const SHA256_OF_NOTHING = createHash('sha256').update('').digest('hex')
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const provenanceSchema = z
  .object({
    url: z.string().url(),
    fetchedAt: z.string().regex(ISO_MS),
    httpStatus: z.number().int(),
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trimmedBy: z.string().min(1),
    termsUrl: z.string().url(),
    termsCheckedAt: z.string().regex(ISO_MS),
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

const read = (provider: string, name: string, ext: string) =>
  readFileSync(join(ROOT, provider, `${name}${ext}`))
const provenance = (provider: string, name: string) =>
  provenanceSchema.parse(JSON.parse(read(provider, name, '.provenance.json').toString('utf8')))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const CAPTURES = [
  ['muse', 'seeded-page0', 200],
  ['muse', 'page-too-high', 400],
] as const
/** provider, fixture name, the Date header of the response (the provenance `fetchedAt`). */
const KEYED_CAPTURES = [
  ['jooble', 'search-smoke', '2026-11-16T21:55:10.000Z'],
  ['jsearch', 'search-v2-smoke', '2026-11-16T21:55:13.000Z'],
  ['reed', 'search-smoke', '2026-11-16T21:55:13.000Z'],
  ['theirstack', 'jobs-search-smoke', '2026-11-16T21:55:16.000Z'],
] as const

describe('The Muse captures', () => {
  it.each(CAPTURES)(
    '%s/%s: exact shape, hash of the committed bytes, the status it really had',
    (provider, name, status) => {
      const p = provenance(provider, name)
      expect(sha(read(provider, name, '.json'))).toBe(p.fileSha256)
      expect(p.httpStatus).toBe(status)
      expect(p.rawSha256).not.toBe(p.fileSha256)
      expect(p.trimmedBy).not.toMatch(/head -c/)
      expect(p.trimmedBy).toContain('never a byte cut')
      expect(p.permission).toBe('UNCLEAR')
      expect(p.url.startsWith('https://www.themuse.com/api/public/jobs?')).toBe(true)
    },
  )

  it('records when the terms were read and what they said about registration', () => {
    const p = provenance('muse', 'seeded-page0')
    expect(p.termsCheckedAt).toBe('2026-10-24T03:30:00.000Z')
    expect(p.notes).toContain('section 2.2 requires the app to be REGISTERED')
    expect(p.notes).toContain(
      'to the extent needed to format and display Muse Content through the Apps',
    )
  })

  it('the directory holds exactly the fixtures this spec knows about', () => {
    expect(readdirSync(join(ROOT, 'muse')).sort()).toEqual([
      'page-too-high.json',
      'page-too-high.provenance.json',
      'seeded-page0.json',
      'seeded-page0.provenance.json',
    ])
  })
})

describe('the smoke captures of the keyed sources (run 43964860057)', () => {
  it.each(KEYED_CAPTURES)(
    '%s/%s: exact shape, hash of the committed bytes, a 200 really received',
    (provider, name, fetchedAt) => {
      const p = provenance(provider, name)
      expect(sha(read(provider, name, '.json'))).toBe(p.fileSha256)
      expect(p.httpStatus).toBe(200)
      expect(p.fetchedAt).toBe(fetchedAt)
      // A trimmed capture is not the bytes received, and neither is a hash of nothing.
      expect(p.rawSha256).not.toBe(p.fileSha256)
      expect(p.rawSha256).not.toBe(SHA256_OF_NOTHING)
      expect(p.permission).toBe('KEY_REQUIRED')
      expect(p.trimmedBy.startsWith('node trim-keyed-captures.mjs ')).toBe(true)
      expect(p.trimmedBy).toContain('never a byte cut')
      expect(p.notes.startsWith('SENTINEL: ')).toBe(false)
      expect(p.notes).toContain('run 43964860057, ONE request per source')
    },
  )

  it.each(KEYED_CAPTURES)('%s/%s: the terms were read after the capture', (provider, name) => {
    const p = provenance(provider, name)
    expect(p.termsCheckedAt > p.fetchedAt).toBe(true)
    expect(p.termsCheckedAt.startsWith('2026-11-16T2')).toBe(true)
  })

  it.each(KEYED_CAPTURES)('%s/%s holds no e-mail address', (provider, name) => {
    const text = read(provider, name, '.json').toString('utf8')
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
    expect(emails.filter((e) => e !== 'redacted@example.invalid')).toEqual([])
  })

  it.each(KEYED_CAPTURES)('%s/%s links no personal profile', (provider, name) => {
    expect(read(provider, name, '.json').toString('utf8')).not.toMatch(/linkedin\.com\/in\//i)
  })

  it('the Jooble ids are JSON numbers written in full, not objects or rounded values', () => {
    const text = read('jooble', 'search-smoke', '.json').toString('utf8')
    expect(text).not.toContain('rawJSON')
    expect([...text.matchAll(/"id": (-?\d+)/g)].map((m) => m[1])).toEqual([
      '-5099382229872932738',
      '2083652208344264241',
      '989127253638554666',
      '1519120455502217169',
      '8634624336844439840',
    ])
  })

  it('each capture sits alone in its directory with its provenance', () => {
    for (const [provider, name] of KEYED_CAPTURES) {
      expect(readdirSync(join(ROOT, provider)).sort()).toEqual([
        `${name}.json`,
        `${name}.provenance.json`,
      ])
    }
  })
})
