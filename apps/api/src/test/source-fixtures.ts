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

/**
 * The pre-sources-04 SmartRecruiters bounds, kept for the specs whose subject is the PAGED loop.
 *
 * Task sources-04 cut the PRODUCTION bounds (`SMARTRECRUITERS_BOUNDS`) to one posting a run,
 * because the per-host budget allows two requests a minute and a posting costs two (a list request
 * and a detail one). Three specs still need multi-page figures to exercise the loop at all, so they
 * share THIS one definition rather than each carrying a copy that can drift (CR-L-5). The
 * production shape is asserted where `SMARTRECRUITERS_BOUNDS` itself is pinned - never here.
 *
 * Typed structurally, not as `SmartRecruitersBounds`, so that `src/test/` keeps importing nothing
 * from the adapter it builds inputs for.
 */
export const SMARTRECRUITERS_PAGED_BOUNDS: {
  readonly maxListPages: number
  readonly maxRequests: number
  readonly pageSize: number
} = { maxListPages: 20, maxRequests: 400, pageSize: 100 }
