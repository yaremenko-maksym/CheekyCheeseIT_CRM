import { config as loadDotenv } from 'dotenv'

/**
 * Load a `.env`-shaped file into `process.env`, without dotenv's own console
 * banner.
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
 * `load-env-quietly.spec.ts` for the behavioural proof (BOTH branches below
 * are exercised there — the no-argument branch via a mocked `process.cwd()`,
 * since Stryker's own worker-pool test runner rejects a real `chdir`).
 *
 * The ternary — rather than always spreading `{ path, quiet: true }` — is
 * required by `exactOptionalPropertyTypes: true` (tsconfig): `DotenvConfigOptions.path`
 * does not accept an explicit `undefined` value, only the key being absent.
 *
 * The ternary's CONDITION itself (`path === undefined`) is an equivalent
 * mutant when forced to a literal `false` — not an undertested branch. Both
 * outcome branches ARE independently exercised in load-env-quietly.spec.ts;
 * verified by reading node_modules/dotenv/lib/main.js@17.4.2 `configDotenv`,
 * which guards on `if (options && options.path)` — `false` for BOTH
 * `path: undefined` and "no path key at all" — so a forced-`false` condition
 * still produces `{ path: undefined, quiet: true }` on the no-argument call,
 * byte-identical dotenv behaviour to `{ quiet: true }`. See the suppression
 * directive on the line below.
 */
export function loadEnvQuietly(path?: string): void {
  // Stryker disable next-line ConditionalExpression: equivalent mutant — see the JSDoc above this function for the full proof
  loadDotenv(path === undefined ? { quiet: true } : { path, quiet: true })
}
