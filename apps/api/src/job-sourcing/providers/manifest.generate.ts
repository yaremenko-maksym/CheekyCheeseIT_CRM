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

const DRIZZLE_ROOT = join(__dirname, '..', '..', '..', 'drizzle')

function main(): void {
  const manifest = buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
  const { manual, staged } = seedDeltaLocations(DRIZZLE_ROOT)
  const target = existsSync(manual) ? manual : staged
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, generateSeedDelta(manifest), 'utf8')
  process.stdout.write(`wrote ${target}\n`)
}

main()
