import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadEnvQuietly } from './load-env-quietly'

/**
 * task-backlog-hygiene-batch (item 7/56, security-review rounds on #534):
 * proves `quiet: true` actually suppresses dotenv's console banner, rather
 * than asserting on the option object we pass it (which a mutant can flip
 * without changing observable behaviour — the exact class this repo's
 * mutation gate exists to catch, see scripts/devops/mutation-gate.mjs).
 *
 * dotenv only prints its banner via `console.log` when a load actually ran
 * (see node_modules/dotenv/lib/main.js `_log` / `configDotenv`), so this
 * seeds a REAL temp `.env` file rather than mocking the `dotenv` module —
 * mocking would prove the mock was called, not that the banner is gone.
 *
 * `loadEnvQuietly()` takes no arguments (round 2 of this review — see its
 * own doc comment for why), so every test here points dotenv's own default
 * `process.cwd()/.env` resolution at a fixture directory by mocking
 * `process.cwd()` — not a real `chdir()`, which Stryker's worker-pool test
 * runner rejects outright.
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
    writeFileSync(join(dir, '.env'), 'LOAD_ENV_QUIETLY_SPEC_KEY=1\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'cwd').mockReturnValue(dir)

    loadEnvQuietly()

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
    const marker = `spec-${Date.now()}`
    writeFileSync(join(dir, '.env'), `LOAD_ENV_QUIETLY_SPEC_VALUE=${marker}\n`)
    delete process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']
    vi.spyOn(process, 'cwd').mockReturnValue(dir)

    loadEnvQuietly()

    expect(process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']).toBe(marker)
    delete process.env['LOAD_ENV_QUIETLY_SPEC_VALUE']
  })
})
