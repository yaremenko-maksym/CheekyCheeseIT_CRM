import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads the authentic captures of the phase-3 source adapters
 * (`job-sourcing/providers/sources/__fixtures__/<provider>/<name>.json`). Lives in `src/test/`
 * beside `xml-corpus.ts` for the same reason: it builds inputs, and its mutants say nothing about
 * whether an adapter is tested.
 */
const ROOT = join(__dirname, '..', 'job-sourcing', 'providers', 'sources', '__fixtures__')

export function sourceFixtureText(provider: string, name: string): string {
  return readFileSync(join(ROOT, provider, `${name}.json`), 'utf8')
}

export function sourceFixture(provider: string, name: string): unknown {
  return JSON.parse(sourceFixtureText(provider, name))
}

export function sourceProvenance(provider: string, name: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8'))
}
