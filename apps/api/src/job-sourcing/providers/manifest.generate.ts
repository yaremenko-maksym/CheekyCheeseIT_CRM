/**
 * CLI: writes the generated seed delta.
 *
 *   pnpm --filter @crm/api job-sources:manifest:generate
 *
 * `manifest.drift.spec.ts` fails when the committed file differs from what this produces, so running
 * it is part of any change to the manifest definitions, the fixtures' provenance or an adapter's
 * status constant. It writes where the file already is (`manual/` once DevOps has moved it,
 * `manual-staged/` before).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { generateSeedDelta, seedDeltaLocations } from './manifest.seed-sql'

/** Writes the delta under `drizzleRoot` and returns the path it wrote. */
export function writeSeedDelta(drizzleRoot: string): string {
  const manifest = buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
  const { manual, staged } = seedDeltaLocations(drizzleRoot)
  const target = existsSync(manual) ? manual : staged
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, generateSeedDelta(manifest))
  return target
}

// Stryker disable next-line all: the command-line entry. It cannot run under a test (it would execute on import and rewrite the committed file); `writeSeedDelta`, the whole of what it does, is tested directly, and the generate script's wiring is asserted by manifest.drift.spec.ts
if (require.main === module) {
  // Stryker disable next-line all: the status line and the drizzle root of the command-line entry above; same reason
  process.stdout.write(`wrote ${writeSeedDelta(join(__dirname, '..', '..', '..', 'drizzle'))}\n`)
}
