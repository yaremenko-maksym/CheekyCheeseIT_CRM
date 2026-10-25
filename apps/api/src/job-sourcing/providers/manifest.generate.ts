/**
 * CLI: writes the generated seed delta.
 *
 *   pnpm --filter @crm/api job-sources:manifest:generate
 *
 * `manifest.drift.spec.ts` fails when the committed file differs from what this produces, so running
 * it is part of any change to the manifest definitions, the fixtures' provenance or an adapter's
 * status constant. It writes where the file already is: `manual/`, where DevOps moved it when the
 * deploy was wired (backlog 337); `manual-staged/` only for a root that holds no wired copy.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import {
  generateHostKeyDelta,
  generateSeedDelta,
  hostKeyDeltaLocations,
  seedDeltaLocations,
} from './manifest.seed-sql'

const build = () =>
  buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })

/** Writes `body` to `manual/` when the file is already there, else to `manual-staged/`. */
function writeWhereItIs(where: { manual: string; staged: string }, body: string): string {
  const target = existsSync(where.manual) ? where.manual : where.staged
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  return target
}

/** Writes the delta under `drizzleRoot` and returns the path it wrote. */
export function writeSeedDelta(drizzleRoot: string): string {
  return writeWhereItIs(seedDeltaLocations(drizzleRoot), generateSeedDelta(build()))
}

/** Task 2.5 T8: writes the host-key delta under `drizzleRoot` and returns the path it wrote. */
export function writeHostKeyDelta(drizzleRoot: string): string {
  return writeWhereItIs(hostKeyDeltaLocations(drizzleRoot), generateHostKeyDelta(build()))
}

// Stryker disable next-line all: the command-line entry. It cannot run under a test (it would execute on import and rewrite the committed file); `writeSeedDelta`, the whole of what it does, is tested directly, and the generate script's wiring is asserted by manifest.drift.spec.ts
if (require.main === module) {
  // Stryker disable next-line all: the status line and the drizzle root of the command-line entry above; same reason
  const root = join(__dirname, '..', '..', '..', 'drizzle')
  // Stryker disable next-line all: same — the command-line entry
  process.stdout.write(`wrote ${writeSeedDelta(root)}\nwrote ${writeHostKeyDelta(root)}\n`)
}
