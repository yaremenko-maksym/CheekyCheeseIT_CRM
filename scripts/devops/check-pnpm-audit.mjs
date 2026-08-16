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

const AUDIT_FIXTURE_ARG = process.argv[2]
const EXCEPTIONS_FIXTURE_ARG = process.argv[3]

function runRealAudit() {
  try {
    return execFileSync('pnpm', ['audit', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    // `pnpm audit` exits non-zero whenever it finds ANY vulnerability at or
    // above ITS OWN default threshold — that is expected, not a script
    // failure, and it still writes the full JSON report to stdout. Only a
    // missing stdout (pnpm itself failed to run) is a real error here.
    if (err.stdout) return err.stdout
    throw err
  }
}

function loadAuditJson() {
  const raw = AUDIT_FIXTURE_ARG ? readFileSync(AUDIT_FIXTURE_ARG, 'utf8') : runRealAudit()
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

  const advisories = Object.values(audit.advisories ?? {})

  const gated = [] // fails the build
  const accepted = [] // covered by a valid exception
  const belowThreshold = [] // not covered, but below the gate's severity floor
  const seenGhsa = new Set()

  for (const adv of advisories) {
    const ghsa = adv.github_advisory_id
    if (ghsa) seenGhsa.add(ghsa)
    const rank = SEVERITY_RANK[adv.severity] ?? 0
    const exc = ghsa ? byGhsa.get(ghsa) : undefined

    if (exc && exc.valid) {
      accepted.push({ adv, exc })
      continue
    }

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
