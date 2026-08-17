#!/usr/bin/env node
/**
 * fake-pnpm-audit.mjs — deterministic, offline stand-in for `pnpm audit
 * --json`, used ONLY by test-check-pnpm-audit.sh's registry-unreachable
 * cases (security-review PR #536 round 3, MED-B).
 *
 * check-pnpm-audit.mjs's real invocation is a network call to the package
 * registry — not something a fast, deterministic, offline test can drive
 * directly. This script lets the test simulate "the registry is down N
 * times, then recovers" or "the registry never comes back" without any real
 * network access, by being pointed at via the `PNPM_AUDIT_CMD` env var the
 * guard already reads for exactly this purpose.
 *
 * Each retry attempt from check-pnpm-audit.mjs is a FRESH child process, so
 * "how many times has this been invoked" has to live in a file, not in
 * memory — that file is the one piece of state this script owns.
 *
 * Usage:
 *   node fake-pnpm-audit.mjs --state-file <path> --fail-count <N>
 *     Fails (empty stdout, exit 1) on invocations 1..N, then succeeds with
 *     `{"advisories": {}}` (exit 0) on invocation N+1 onward. `--fail-count 0`
 *     succeeds immediately — used to prove retries are NOT wasted on a
 *     healthy registry.
 *
 *   node fake-pnpm-audit.mjs --state-file <path> --always-fail
 *     Never succeeds — simulates a registry that is genuinely, persistently
 *     down (proves the guard gives up after its retry budget instead of
 *     hanging or retrying forever).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const stateFile = argValue('--state-file')
const alwaysFail = args.includes('--always-fail')
const failCount = Number(argValue('--fail-count') ?? '0')

let invocation = 1
try {
  invocation = Number(readFileSync(stateFile, 'utf8')) + 1
} catch {
  // First invocation — no state file yet.
}
writeFileSync(stateFile, String(invocation))

if (alwaysFail || invocation <= failCount) {
  // Simulate a registry that produced nothing usable: no JSON, non-zero
  // exit. Real network failures look like this (empty stdout, ENOTFOUND on
  // stderr) far more often than a malformed-but-parseable JSON body.
  process.stderr.write('fake-pnpm-audit: simulated registry failure\n')
  process.exit(1)
}

process.stdout.write(JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }))
process.exit(0)
