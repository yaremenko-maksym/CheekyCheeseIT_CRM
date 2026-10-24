import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The provenance contract (`phase3-common.md`) for the Task 3.5b fixtures. Separate from
 * `fixture-provenance.spec.ts` because that one belongs to Task 3.1 and asserts "200 and a raw hash
 * different from the file's" for every fixture it lists - two things that are false, on purpose,
 * for a unit example nobody captured. Task 3.7 builds the manifest from these files, so the shape
 * is a contract; the two kinds of fixture are told apart here by what they must and must not say.
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
const DOC_EXAMPLES = ['jooble', 'jsearch', 'theirstack', 'reed'] as const

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

describe('the unit examples of the keyed sources', () => {
  it.each(DOC_EXAMPLES)(
    '%s/doc-example: exact shape and hash of the committed bytes',
    (provider) => {
      const p = provenance(provider, 'doc-example')
      expect(sha(read(provider, 'doc-example', '.json'))).toBe(p.fileSha256)
    },
  )

  it.each(DOC_EXAMPLES)(
    '%s/doc-example says, in the fields a manifest reads, that nothing was captured',
    (provider) => {
      const p = provenance(provider, 'doc-example')
      expect(p.httpStatus).toBe(0)
      expect(p.rawSha256).toBe(SHA256_OF_NOTHING)
      expect(p.permission).toBe('KEY_REQUIRED')
      expect(p.trimmedBy.startsWith('none: written by hand from ')).toBe(true)
      expect(p.notes).toContain('UNIT EXAMPLE ONLY, NOT A CAPTURE')
      expect(p.notes).toContain('Every value in the file is invented')
      expect(p.notes).toContain('BLOCKED until the owner runs a controlled authenticated smoke')
    },
  )

  it.each(DOC_EXAMPLES)('%s/doc-example holds no real-looking contact data', (provider) => {
    const text = read(provider, 'doc-example', '.json').toString('utf8')
    expect(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).toEqual([])
  })

  it.each(DOC_EXAMPLES)(
    "%s/doc-example uses only reserved example hosts apart from the provider's own",
    (provider) => {
      const hosts = new Set(
        [
          ...read(provider, 'doc-example', '.json')
            .toString('utf8')
            .matchAll(/https?:\/\/([^/"?#]+)/g),
        ].map((m) => m[1]),
      )
      const own = new Set(['jooble.org', 'www.reed.co.uk'])
      for (const host of hosts) {
        expect(own.has(host as string) || (host as string).endsWith('.test')).toBe(true)
      }
    },
  )

  it('each unit example sits alone in its directory with its provenance', () => {
    for (const provider of DOC_EXAMPLES) {
      expect(readdirSync(join(ROOT, provider)).sort()).toEqual([
        'doc-example.json',
        'doc-example.provenance.json',
      ])
    }
  })
})
