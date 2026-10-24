import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * The provenance contract of the phase-3 fixtures (`phase3-common.md`), as ONE schema and one
 * reader, so a provider's captures are checked by what they say and not by whether somebody
 * remembered to add the provider to a list. Task 3.7 builds the manifest from every
 * `*.provenance.json`, so the shape is a contract. Lives in `src/test/` beside `source-fixtures.ts`
 * for the same reason: it builds inputs, and its mutants say nothing about whether an adapter is
 * tested.
 *
 * The schema is deliberately the LOOSEST shape every committed provenance file satisfies (timestamps
 * are non-empty strings here: the JSON captures write ISO instants with milliseconds, the RSS
 * captures write whole seconds or a bare date). A suite that wants a stricter rule layers it on top.
 */

export const FIXTURE_ROOT = join(
  __dirname,
  '..',
  'job-sourcing',
  'providers',
  'sources',
  '__fixtures__',
)

export const PERMISSIONS = [
  'PUBLIC_API_DOCUMENTED',
  'PUBLIC_FEED',
  'UNCLEAR',
  'PROHIBITED',
  'KEY_REQUIRED',
] as const

export const provenanceSchema = z
  .object({
    url: z.string().url(),
    fetchedAt: z.string().min(1),
    httpStatus: z.number().int(),
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trimmedBy: z.string().min(1),
    termsUrl: z.string().url(),
    termsCheckedAt: z.string().min(1),
    permission: z.enum(PERMISSIONS),
    notes: z.string().min(1),
  })
  .strict()
export type Provenance = z.infer<typeof provenanceSchema>

export interface FixtureFile {
  provider: string
  /** The file name, e.g. `airbnb-board.json`. */
  file: string
  /** The provenance file name that must sit beside it. */
  provenanceFile: string
}

const isProvenance = (f: string) => f.endsWith('.provenance.json')

/** Every provider directory under `__fixtures__` (a directory, not a loose script). */
export function fixtureProviders(): string[] {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Every non-provenance file of a provider, paired with the provenance file it must have. */
export function fixtureFiles(provider: string): FixtureFile[] {
  return readdirSync(join(FIXTURE_ROOT, provider))
    .filter((f) => !isProvenance(f))
    .sort()
    .map((file) => ({
      provider,
      file,
      provenanceFile: `${file.slice(0, file.lastIndexOf('.'))}.provenance.json`,
    }))
}

/** Every provenance file of a provider (to find one with no fixture beside it). */
export function provenanceFiles(provider: string): string[] {
  return readdirSync(join(FIXTURE_ROOT, provider)).filter(isProvenance).sort()
}

export function readProvenance(provider: string, provenanceFile: string): Provenance {
  return provenanceSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_ROOT, provider, provenanceFile), 'utf8')),
  )
}

export function sha256OfFixture(provider: string, file: string): string {
  return createHash('sha256')
    .update(readFileSync(join(FIXTURE_ROOT, provider, file)))
    .digest('hex')
}

export function readFixtureText(provider: string, file: string): string {
  return readFileSync(join(FIXTURE_ROOT, provider, file), 'utf8')
}
