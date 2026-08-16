import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadEnvQuietly } from './load-env-quietly'

/**
 * task-backlog-hygiene-batch (item 7/56, security-review round on #534):
 * proves `quiet: true` actually suppresses dotenv's console banner, rather
 * than asserting on the option object we pass it (which a mutant can flip
 * without changing observable behaviour — the exact class this repo's
 * mutation gate exists to catch, see scripts/devops/mutation-gate.mjs).
 *
 * dotenv only prints its banner via `console.log` when a load actually ran
 * (see node_modules/dotenv/lib/main.js `_log` / `configDotenv`), so this
 * seeds a REAL temp `.env` file rather than mocking the `dotenv` module —
 * mocking would prove the mock was called, not that the banner is gone.
 */
describe('loadEnvQuietly', () => {
  let dir: string | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('loads a real .env file WITHOUT printing dotenv\'s "tip" banner to console.log', () => {
    dir = mkdtempSync(join(tmpdir(), 'load-env-quietly-'))
    const envPath = join(dir, '.env')
    writeFileSync(envPath, 'LOAD_ENV_QUIETLY_SPEC_KEY=1\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    loadEnvQuietly(envPath)

    // The behaviour this file exists to pin: NOT what options object we
    // built, but that nothing reached stdout. Flip `quiet` to `false`, or
    // drop it from the options object entirely, and dotenv prints
    // `injected env (N) from ... // tip: ...` — this assertion catches
    // both (verified by hand: reverting `quiet: true` in
    // load-env-quietly.ts turns this red).
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('still actually loads the file into process.env (quiet does not mean no-op)', () => {
    dir = mkdtempSync(join(tmpdir(), 'load-env-quietly-'))
    const envPath = join(dir, '.env')
    const marker = `spec-${Date.now()}`
    writeFileSync(envPath, `LOAD_ENV_QUIETLY_SPEC_VALUE=${marker}\n`)
    delete process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']

    loadEnvQuietly(envPath)

    expect(process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']).toBe(marker)
    delete process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']
  })

  // Covers the OTHER branch of the `path === undefined` ternary — the exact
  // call `seed.ts` makes (no argument). dotenv itself resolves the default
  // path via `path.resolve(process.cwd(), '.env')` (node_modules/dotenv/lib
  // /main.js), so mocking `process.cwd()` reaches the real dotenv codepath
  // without an actual `chdir` — which Stryker's worker-pool test runner
  // rejects outright (`process.chdir() is not supported in workers`, unlike
  // our own vitest.config.mts `pool: 'forks'`). Mocking dotenv ITSELF would
  // prove nothing about the real banner — see file header.
  it("no-argument call (seed.ts's actual usage) ALSO suppresses the banner", () => {
    dir = mkdtempSync(join(tmpdir(), 'load-env-quietly-'))
    writeFileSync(join(dir, '.env'), 'LOAD_ENV_QUIETLY_SPEC_KEY=1\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'cwd').mockReturnValue(dir)

    loadEnvQuietly()

    expect(logSpy).not.toHaveBeenCalled()
  })
})
