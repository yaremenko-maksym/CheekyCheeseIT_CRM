import { config as loadDotenv } from 'dotenv'

/**
 * Load `.env` (dotenv's own default path resolution, `process.cwd()/.env`)
 * into `process.env`, without dotenv's own console banner.
 *
 * task-backlog-hygiene-batch (item 7/56): dotenv >=17 prints an unsolicited
 * "tip" line to stdout on every successful load (`injected env (N) from
 * .env // tip: ...`) — text formatted as an instruction and read by every
 * agent that inspects tool output. `quiet: true` suppresses it; it does NOT
 * change what gets loaded into `process.env`, so this is a no-op for every
 * caller except stdout.
 *
 * Extracted out of `seed.ts` specifically so this one line is unit-testable:
 * `seed.ts` calls `main().catch(...)` unconditionally at module top level
 * (it opens a real DB pool), so importing it in a test runs the whole seed —
 * the exact reason the `quiet: true` flag there had zero test coverage and
 * survived mutation testing (security-review round on #534). See
 * `load-env-quietly.spec.ts`, which mocks `process.cwd()` (dotenv's own
 * default-path input) rather than a real `chdir` — Stryker's worker-pool
 * test runner rejects `process.chdir()` outright.
 *
 * Deliberately NO `path` parameter (round 2 of the same security review):
 * `seed.ts` — the only caller — never passes one, so a `path?: string`
 * parameter existed purely to let the spec inject a fixture path, which
 * required a `path === undefined ? {...} : {...}` ternary (`exactOptionalPropertyTypes`
 * forbids passing `path: undefined` directly). Stryker's `ConditionalExpression`
 * mutator always emits BOTH a forced-true and a forced-false mutant for one
 * ternary, attributed to the SAME line — so a `// Stryker disable` there
 * unavoidably suppressed a genuinely-catchable mutant (forced-true, which
 * silently drops a caller's real path) alongside the actually-equivalent one
 * (forced-false). There is no way to split a single ternary's two
 * `ConditionalExpression` variants onto separate lines — the fix is to not
 * need the ternary: this function does exactly what its one real caller
 * needs, and the spec proves it via `process.cwd()`, not via a parameter.
 */
export function loadEnvQuietly(): void {
  loadDotenv({ quiet: true })
}
