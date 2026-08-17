#!/usr/bin/env node
/**
 * check-pnpm-audit.mjs — pnpm audit gate with a reasoned exception list
 * (task-prod-runtime-vulns, 2026-08-16).
 *
 * WHY THIS EXISTS
 * ----------------
 * Before this guard there was NO automated dependency-vulnerability check at
 * all. `pnpm audit` on `main` had quietly accumulated 21 high-severity findings
 * — nobody was looking, because nothing ran it and nothing would have told
 * anyone if it went red. This guard runs `pnpm audit` on every CI run and
 * fails when a NEW finding at or above `audit_level` (see
 * scripts/devops/pnpm-audit-exceptions.json) is not covered by an explicit,
 * reasoned exception.
 *
 * WHAT "COVERED" MEANS
 * ---------------------
 * Exceptions are keyed by exact GHSA id (github_advisory_id), grouped by
 * package for readability, in scripts/devops/pnpm-audit-exceptions.json. A
 * group is a list of GHSA ids sharing one `reason`. This is deliberately NOT
 * "the package name is in the list" — a package having ONE previously-accepted
 * advisory does not blanket-cover a DIFFERENT, newly-published advisory for the
 * same package. Each GHSA id must be individually listed, so a new CVE in an
 * already-excepted package still gates CI red until someone consciously
 * triages it.
 *
 * "Исключение без написанной причины не принимается" (task AC6) is enforced
 * mechanically, not just by convention: every exception group's `reason` must
 * contain at least MIN_REASON_LENGTH letters/digits (`_comment` and
 * empty/placeholder strings do not count). A group that fails this check is
 * NOT treated as an accepted exception at all — its advisories fall straight
 * through to the severity-threshold check below, exactly as if the group
 * did not exist. This mirrors check-mutation-suppressions.mjs's "a
 * suppression with no reason is not a suppression" rule, applied to security
 * exceptions instead of mutation exceptions.
 *
 * THRESHOLD
 * ---------
 * `audit_level` in the exceptions JSON (default "moderate" if absent) mirrors
 * `pnpm audit --audit-level`: any advisory whose severity rank is AT OR ABOVE
 * that level, and is not covered by a valid exception, fails the gate. Findings
 * below the threshold are printed for visibility but never gate CI — this
 * keeps the exception list from having to carry every low-severity, low-signal
 * finding just to stay green.
 *
 * STALE EXCEPTIONS
 * -----------------
 * A GHSA id listed in the exceptions file that no longer appears in the live
 * `pnpm audit` output (the underlying package was bumped past it) is reported
 * as a WARNING, not a failure — the same "ghost allowlist" treatment
 * check-prod-ddl-wiring.py gives KNOWN_NOT_WIRED entries that no longer exist
 * on disk. It keeps the file naturally prunable without turning "we fixed
 * something" into a required follow-up edit.
 *
 * USAGE
 * -----
 *   scripts/devops/check-pnpm-audit.mjs                    # runs the real
 *                                                           # `pnpm audit --json`
 *                                                           # against this repo
 *   scripts/devops/check-pnpm-audit.mjs <audit.json>        # reads a
 *                                                           # pre-computed audit
 *                                                           # report instead (this
 *                                                           # guard's own test
 *                                                           # fixtures use this —
 *                                                           # `pnpm audit` needs
 *                                                           # network + the real
 *                                                           # lockfile, neither of
 *                                                           # which a deterministic
 *                                                           # negative test can
 *                                                           # rely on)
 *   scripts/devops/check-pnpm-audit.mjs <audit.json> <exceptions.json>
 *                                                           # also override the
 *                                                           # exceptions file (test
 *                                                           # fixtures only)
 *
 * The optional arguments exist ONLY so this guard's own test can point it at
 * fabricated input. They change what is inspected, never how strictly.
 *
 * FAIL LOUD ON UNRECOGNIZED SHAPE (security-review PR #536 round 2, MED-2/
 * MED-3) — "не смог проверить" не равно "ничего не нашёл":
 *   - If the parsed JSON has no `advisories` object at all (pnpm changes its
 *     output schema, or the command produced something else entirely), the
 *     OLD code defaulted to `{}` via `??` and reported a silent, false "OK —
 *     0 advisories". That is indistinguishable from a genuinely clean audit.
 *     Now: a missing/malformed `advisories` key is a hard failure with its
 *     own distinct message, never a green run.
 *   - If an advisory's `severity` string is not one of the five known ranks
 *     (`info`/`low`/`moderate`/`high`/`critical`), the OLD code defaulted its
 *     rank to `0` via `?? 0` — the LOWEST rank, i.e. an unrecognized severity
 *     silently never gated, even if pnpm/GHSA introduce a NEW tier for
 *     something worse than "critical". Now: an unrecognized severity string
 *     is collected separately and fails the gate regardless of threshold —
 *     unknown is treated as "could be anything", not as "harmless".
 * Both were reproduced by the reviewer with fixtures before this fix; both
 * have their own negative case in the test file below (a fixture with a
 * missing `advisories` key, and one with a fabricated unknown severity
 * string), proving the OLD code went green on them and the NEW code goes red.
 *
 * REGISTRY UNREACHABLE vs. OUTPUT SHAPE UNRECOGNIZED (security-review PR #536
 * round 3, MED-B) — two DIFFERENT failure modes, now with two DIFFERENT
 * messages, not one generic "could not verify":
 *   - `pnpm audit` is a network call, and this guard sits on the required
 *     merge path — a single registry blip used to fail the WHOLE repo's CI on
 *     the first hiccup, with a message ("output shape unrecognized") that
 *     diagnoses the wrong problem for the far more likely cause. Now
 *     `runRealAudit()` retries up to AUDIT_MAX_ATTEMPTS times (with a fixed
 *     delay) before giving up, and ONLY treats an attempt as a genuine
 *     network/registry failure — not as "got JSON, shape is wrong" — when the
 *     command produced no parseable JSON at all (empty stdout, a timeout, a
 *     non-JSON error page, etc.). A `pnpm audit` invocation that legitimately
 *     exits non-zero BECAUSE it found vulnerabilities still returns
 *     immediately on the first attempt — that is real data, not a failure to
 *     retry away.
 *   - If every attempt is exhausted without ever getting parseable JSON, the
 *     message says "could not reach" — a transient/network problem — never
 *     the MED-2 "shape unrecognized" wording, which is reserved for the case
 *     where a `pnpm audit` invocation DID succeed and DID return JSON, but
 *     that JSON does not have the `advisories` shape this guard expects.
 *
 * The real command is configurable via `PNPM_AUDIT_CMD` (space-separated,
 * default `pnpm audit --json`) ONLY so this guard's own test can point the
 * retry loop at a fake, deterministic, offline script instead of a real
 * network call — see test-check-pnpm-audit.sh's "registry unreachable" cases.
 *
 * Tests: scripts/devops/tests/test-check-pnpm-audit.sh (positive AND negative
 * cases, including a deliberately-vulnerable unlisted package and a
 * deliberately-reasonless exception entry — task AC7: "внесена заведомо
 * уязвимая версия -> гейт краснеет; убрана -> зеленеет").
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SELF_DIR, '../..')
const DEFAULT_EXCEPTIONS_PATH = path.join(SELF_DIR, 'pnpm-audit-exceptions.json')

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }
const DEFAULT_AUDIT_LEVEL = 'moderate'
const MIN_REASON_LENGTH = 20

// MED-B: retry budget for the network call. 3 attempts with a 5s delay is
// enough to ride out a short registry blip without turning a required merge
// check into a multi-minute wait on a genuinely dead registry. The delay is
// env-overridable ONLY so this guard's own test can shrink it from seconds to
// milliseconds — the retry COUNT and the failure classification are what the
// test verifies, not real wall-clock backoff timing.
const AUDIT_MAX_ATTEMPTS = 3
const AUDIT_RETRY_DELAY_MS = Number(process.env.PNPM_AUDIT_RETRY_DELAY_MS ?? 5_000)
const AUDIT_TIMEOUT_MS = 60_000

const AUDIT_FIXTURE_ARG = process.argv[2]
const EXCEPTIONS_FIXTURE_ARG = process.argv[3]

// Marker so `loadAuditJson()` can tell "every retry attempt produced nothing
// parseable" apart from any other kind of thrown error.
const AUDIT_UNREACHABLE = Symbol('pnpm-audit-unreachable')

function looksLikeJson(str) {
  if (typeof str !== 'string' || str.trim() === '') return false
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

// Synchronous sleep — execFileSync is already synchronous top-to-bottom, and
// this script has no event loop work to yield to in between retries. The
// SharedArrayBuffer + Atomics.wait idiom is the standard way to block
// synchronously in Node without a busy-wait loop.
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function attemptRealAudit() {
  const [cmd, ...args] = (process.env.PNPM_AUDIT_CMD ?? 'pnpm audit --json').split(' ')
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: AUDIT_TIMEOUT_MS,
  })
}

function runRealAudit() {
  for (let attempt = 1; attempt <= AUDIT_MAX_ATTEMPTS; attempt++) {
    try {
      return attemptRealAudit()
    } catch (err) {
      // `pnpm audit` exits non-zero whenever it finds ANY vulnerability at or
      // above ITS OWN default threshold — that is expected, not a failure,
      // and it still writes the full JSON report to stdout. That is real
      // data: return it immediately, no retry needed.
      if (looksLikeJson(err.stdout)) return err.stdout

      // Anything else (empty stdout, a timeout, a non-JSON error page from a
      // registry proxy, connection refused, ...) is treated as a possibly-
      // transient network/registry problem — retry before giving up.
      const reason = err.signal
        ? `killed by ${err.signal} (timeout after ${AUDIT_TIMEOUT_MS}ms)`
        : (err.message ?? String(err))
      if (attempt < AUDIT_MAX_ATTEMPTS) {
        console.log(
          `   pnpm audit attempt ${attempt}/${AUDIT_MAX_ATTEMPTS} produced no usable output (${reason}) — retrying in ${AUDIT_RETRY_DELAY_MS}ms...`,
        )
        sleepSync(AUDIT_RETRY_DELAY_MS)
      }
    }
  }
  const err = new Error('pnpm audit did not produce parseable output after all retries')
  err[AUDIT_UNREACHABLE] = true
  throw err
}

function loadAuditJson() {
  if (AUDIT_FIXTURE_ARG) {
    return JSON.parse(readFileSync(AUDIT_FIXTURE_ARG, 'utf8'))
  }
  let raw
  try {
    raw = runRealAudit()
  } catch (err) {
    if (err[AUDIT_UNREACHABLE]) {
      console.log('== check-pnpm-audit.mjs ==')
      console.log('')
      console.log(`FAIL: could not reach the package registry after ${AUDIT_MAX_ATTEMPTS} attempts.`)
      console.log(
        '`pnpm audit` never produced parseable output — this looks like a transient network or',
      )
      console.log(
        'registry problem, NOT an unrecognized output shape (that is a different, separate',
      )
      console.log(
        'failure — see this guard\'s other message for it). Re-run the job; if this persists,',
      )
      console.log('check registry status before assuming the dependency tree itself is at fault.')
      process.exit(1)
    }
    throw err
  }
  return JSON.parse(raw)
}

function meaningfulLength(str) {
  return typeof str === 'string' ? str.replace(/[^\p{L}\p{N}]/gu, '').length : 0
}

/**
 * Returns { auditLevel, byGhsa: Map<ghsaId, {reason, valid, module, tier}>,
 * invalidGroups: [{module, reason}] }.
 */
function loadExceptions() {
  const exceptionsPath = EXCEPTIONS_FIXTURE_ARG ?? DEFAULT_EXCEPTIONS_PATH
  const raw = readFileSync(exceptionsPath, 'utf8')
  const parsed = JSON.parse(raw)
  const auditLevel = parsed.audit_level ?? DEFAULT_AUDIT_LEVEL

  const byGhsa = new Map()
  const invalidGroups = []

  for (const group of parsed.exceptions ?? []) {
    const reason = group.reason ?? ''
    const valid = meaningfulLength(reason) >= MIN_REASON_LENGTH
    if (!valid) {
      invalidGroups.push({ module: group.module ?? '(unknown module)', reason })
    }
    for (const ghsa of group.ghsa_ids ?? []) {
      byGhsa.set(ghsa, { reason, valid, module: group.module, tier: group.tier })
    }
  }

  return { auditLevel, byGhsa, invalidGroups }
}

function main() {
  const audit = loadAuditJson()
  const { auditLevel, byGhsa, invalidGroups } = loadExceptions()
  const thresholdRank = SEVERITY_RANK[auditLevel] ?? SEVERITY_RANK[DEFAULT_AUDIT_LEVEL]

  // MED-2 (security-review PR #536 round 2): the `advisories` key must
  // actually be present and be an object. A missing/malformed key means
  // `pnpm audit`'s output shape changed (or the command produced something
  // unexpected) — NOT "zero vulnerabilities". Failing loud here, with its
  // own message, is the whole point: the old `audit.advisories ?? {}`
  // silently produced an empty list indistinguishable from a clean run.
  if (
    typeof audit !== 'object' ||
    audit === null ||
    !('advisories' in audit) ||
    typeof audit.advisories !== 'object' ||
    audit.advisories === null ||
    Array.isArray(audit.advisories)
  ) {
    console.log('== check-pnpm-audit.mjs ==')
    console.log('')
    console.log(
      'FAIL: could not verify — the audit report has no `advisories` object at all.',
    )
    console.log(
      "This is NOT the same as \"0 vulnerabilities found\": either `pnpm audit`'s JSON output",
    )
    console.log(
      'shape changed, or the command produced something unexpected. Refusing to report a',
    )
    console.log('silent green on unrecognized input — inspect the raw `pnpm audit --json` output')
    console.log('by hand and update this guard\'s parsing if the shape genuinely changed.')
    process.exit(1)
  }

  const advisories = Object.values(audit.advisories)

  const gated = [] // fails the build
  const accepted = [] // covered by a valid exception
  const belowThreshold = [] // not covered, but below the gate's severity floor
  const unknownSeverity = [] // MED-3: severity string we don't recognize — never silently below-threshold
  const seenGhsa = new Set()

  for (const adv of advisories) {
    const ghsa = adv.github_advisory_id
    if (ghsa) seenGhsa.add(ghsa)
    const exc = ghsa ? byGhsa.get(ghsa) : undefined

    if (exc && exc.valid) {
      accepted.push({ adv, exc })
      continue
    }

    // MED-3 (security-review PR #536 round 2): an unrecognized severity
    // string used to fall through `SEVERITY_RANK[adv.severity] ?? 0` — rank
    // 0, the LOWEST possible, meaning it silently never gated regardless of
    // how bad it might actually be. A severity string outside our five known
    // ranks means we cannot judge it at all; treat that as worse than
    // unknown-but-harmless, not as "assume it's fine".
    if (!(adv.severity in SEVERITY_RANK)) {
      unknownSeverity.push(adv)
      continue
    }

    const rank = SEVERITY_RANK[adv.severity]
    if (rank >= thresholdRank) {
      gated.push(adv)
    } else {
      belowThreshold.push(adv)
    }
  }

  const staleExceptions = [...byGhsa.keys()].filter((ghsa) => !seenGhsa.has(ghsa))

  console.log('== check-pnpm-audit.mjs ==')
  console.log(`   audit_level (gate threshold): ${auditLevel}`)
  console.log(`   advisories reported: ${advisories.length}`)
  console.log(`   accepted (valid exception): ${accepted.length}`)
  console.log(`   below threshold (informational): ${belowThreshold.length}`)
  console.log(`   GATED (unaccepted, >= ${auditLevel}): ${gated.length}`)
  console.log('')

  if (belowThreshold.length > 0) {
    console.log(`-- below threshold, not gated --`)
    for (const adv of belowThreshold) {
      console.log(`   ${adv.severity.padEnd(8)} ${adv.module_name} (${adv.github_advisory_id})`)
    }
    console.log('')
  }

  if (accepted.length > 0) {
    console.log(`-- accepted exceptions --`)
    for (const { adv } of accepted) {
      console.log(`   ${adv.severity.padEnd(8)} ${adv.module_name} (${adv.github_advisory_id})`)
    }
    console.log('')
  }

  if (staleExceptions.length > 0) {
    console.log('WARNING: these exception GHSA ids are no longer reported by pnpm audit —')
    console.log('the underlying package was likely bumped past them. Consider pruning')
    console.log('scripts/devops/pnpm-audit-exceptions.json:')
    for (const ghsa of staleExceptions) {
      console.log(`   ${ghsa} (module: ${byGhsa.get(ghsa)?.module ?? '?'})`)
    }
    console.log('')
  }

  let failed = false

  if (unknownSeverity.length > 0) {
    failed = true
    console.log(
      `FAIL: ${unknownSeverity.length} advisory(ies) have a severity string this guard does`,
    )
    console.log(
      'not recognize (expected one of info/low/moderate/high/critical). Treating an unknown',
    )
    console.log('severity as harmless would be a silent false-green — refusing to guess:')
    for (const adv of unknownSeverity) {
      console.log(
        `   severity="${adv.severity}"  ${adv.module_name} (${adv.github_advisory_id ?? 'no GHSA id'})`,
      )
    }
    console.log('')
    console.log(
      'Fix: update SEVERITY_RANK in scripts/devops/check-pnpm-audit.mjs to include the new',
    )
    console.log('severity string at the correct rank, then re-run.')
    console.log('')
  }

  if (invalidGroups.length > 0) {
    failed = true
    console.log('FAIL: the following exception group(s) in')
    console.log('scripts/devops/pnpm-audit-exceptions.json have no (or too short a) reason.')
    console.log(
      'A reasonless exception is not an exception — its advisories are treated as UNACCEPTED',
    )
    console.log('and gate on severity like any other unlisted finding:')
    for (const g of invalidGroups) {
      console.log(`   module: ${g.module}  reason: ${JSON.stringify(g.reason)}`)
    }
    console.log('')
    console.log(
      `Fix: write a real reason (>= ${MIN_REASON_LENGTH} meaningful characters) explaining WHY this`,
    )
    console.log('advisory is accepted — reachability tier (prod-runtime / build / tests),')
    console.log('what actually reaches it, and (if applicable) the fix path deferred.')
    console.log('')
  }

  if (gated.length > 0) {
    failed = true
    console.log(`FAIL: ${gated.length} advisory(ies) at or above "${auditLevel}" are not covered`)
    console.log('by a valid exception in scripts/devops/pnpm-audit-exceptions.json:')
    for (const adv of gated) {
      console.log('')
      console.log(`   [${adv.severity}] ${adv.module_name} — ${adv.title}`)
      console.log(`   GHSA: ${adv.github_advisory_id}  (${adv.url ?? 'no url'})`)
      console.log(`   vulnerable: ${adv.vulnerable_versions}  patched: ${adv.patched_versions}`)
    }
    console.log('')
    console.log('Fix options:')
    console.log('  1. Bump the package (direct dep) or add/tighten a pnpm.overrides entry')
    console.log('     (root package.json) to a patched version — respecting')
    console.log('     .claude/rules/common/version-pins.md; never cross a hard pin silently.')
    console.log('  2. If it genuinely cannot reach production (build-tool-only or test-only')
    console.log('     dependency chain), add a reasoned group to')
    console.log('     scripts/devops/pnpm-audit-exceptions.json — reason must state the')
    console.log('     reachability tier and how you verified it (e.g. `pnpm why <pkg> -r`).')
    console.log('')
    console.log(
      'Rule: a vulnerability that reaches production is fixed or explained — never silent.',
    )
  }

  if (!failed) {
    console.log('OK: no unaccepted advisory at or above the gate threshold.')
  }

  process.exit(failed ? 1 : 0)
}

main()
