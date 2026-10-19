import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The API-log alert's patterns, as the TESTS in this package see them — READ from the alert,
 * not copied from it.
 *
 * The owner is `scripts/devops/check-api-permission-denied.sh` (PR #1041). It PUBLISHES its
 * patterns through `--print-contract-pattern` and `--print-pattern` precisely so that this
 * package does not keep a copy, and names this file as the consumer. The alert runs them
 * through `grep -Ei`, so the RegExp here is case-insensitive too.
 *
 * Two tiers, which the tests must not blur:
 *   ALERT_CONTRACT_PATTERN  the CONTRACT: the pool-level line, anchored on the logger context.
 *   ALERT_PATTERN           everything that pages: the contract PLUS the English text of a
 *                           privilege error (`permission denied`, `must be owner|superuser`).
 *                           The text tier is SECONDARY: the alert reports it apart (`src=text`).
 *
 * Why this replaced a pair of copies: an earlier pair kept asserting a `(sqlstate|code)…42501`
 * branch the alert no longer had, and lacked the `i` flag, so they described a pattern that did
 * not exist while passing. Reading removes the possibility.
 */

const SCRIPT = join('scripts', 'devops', 'check-api-permission-denied.sh')

/**
 * The script, found by walking up from here. Not a fixed `../..`: Stryker runs the specs from a
 * sandbox several directories deeper than the source tree.
 */
function findScript(): string {
  let dir = __dirname
  for (;;) {
    const candidate = join(dir, SCRIPT)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`alert-patterns: ${SCRIPT} not found above ${__dirname}`)
    dir = parent
  }
}

/**
 * What a `--print-*` flag must emit: exactly ONE non-empty line, newline-terminated. Anything
 * else means the published interface changed shape, and that is a finding, not a case to work
 * around.
 */
export function parsePrinted(output: string): string {
  if (!/^[^\n]+\n$/.test(output)) {
    throw new Error(
      `alert-patterns: the alert printed an unexpected shape: ${JSON.stringify(output)}`,
    )
  }
  return output.slice(0, -1)
}

export function readAlertPattern(flag: '--print-pattern' | '--print-contract-pattern'): string {
  return parsePrinted(execFileSync('bash', [findScript(), flag], { encoding: 'utf8' }))
}

/** What the alert treats as THE contract: the pool-level line. */
export const ALERT_CONTRACT_PATTERN = new RegExp(readAlertPattern('--print-contract-pattern'), 'i')

/** Everything that pages: the contract, plus the English text of a privilege error. */
export const ALERT_PATTERN = new RegExp(readAlertPattern('--print-pattern'), 'i')
