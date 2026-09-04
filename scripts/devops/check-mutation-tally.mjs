#!/usr/bin/env node
/**
 * check-mutation-tally.mjs — turns a night's mutation reports into one verdict
 * (task-mutation-gate, 2026-08-11).
 *
 * Called by the `alert` job of .github/workflows/mutation-nightly.yml after the
 * three sweep legs have uploaded their StrykerJS JSON reports. Writes
 * `result=` / `detail=` in GitHub-Actions output format on stdout; the workflow
 * appends that straight to $GITHUB_OUTPUT and hands it to
 * scripts/devops/post-merge-alert.sh (KIND=mutation).
 *
 * ITS RED IS A STDOUT CONTRACT, NOT AN EXIT CODE — deliberately, and the same
 * shape as scripts/devops/check-backup-freshness.sh: the caller needs the
 * verdict AND the human-readable detail as data, and a script that exits
 * non-zero cannot hand a workflow step anything useful. `result=failure` on exit
 * 0 is its failure signal, which is why its test uses `assert_red_signal`.
 *
 * THE RULE THAT MATTERS MOST is the last one:
 *
 *   sweep cancelled/skipped   → cancelled   (a run the next merge superseded is
 *                               not a finding; post-merge-alert.sh no-ops)
 *   sweep leg failed          → failure     (nothing was verified — loudest)
 *   sweep green, 0 reports    → failure     ← this one
 *   survivors > 0             → failure
 *   survivors == 0            → success     (any open alert issue is closed)
 *
 * "All legs green and no evidence produced" must never read as a clean night.
 * That is the precise shape of every defect this whole task exists to fix: a
 * check that reports success because it did not actually run. If the upload
 * broke, the artifact expired, or the reports landed somewhere else, the honest
 * verdict is "I do not know", and around here "I do not know" is red.
 *
 * Usage:
 *   scripts/devops/check-mutation-tally.mjs <dir-with-*.report.json>
 *
 * Env:
 *   SWEEP_RESULT   the `needs.sweep.result` of the matrix job (success |
 *                  failure | cancelled | skipped). Absent → treated as success,
 *                  so the script is usable by hand on a directory of reports.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: check-mutation-tally.mjs <dir-with-report-json>')
  process.exit(2)
}

const counts = { Survived: 0, Killed: 0, Timeout: 0, NoCoverage: 0, Ignored: 0 }
let reportFiles = 0
let unreadable = 0

/**
 * The three packages mutation-nightly.yml's matrix runs, by the exact report
 * BASENAME `mutation-gate.mjs`'s `writeConfig()` writes for each
 * (`pkg.name.replace(/[^a-z0-9]+/gi, '-')` — kept as a literal list here
 * rather than imported, because this script runs against DOWNLOADED
 * artifacts, never against a checkout with that module on its path). Used
 * ONLY to name which leg(s) produced no evidence at all when the sweep did
 * not complete — see `missingPackages` below. If a fourth package is ever
 * added to `PACKAGES` in mutation-gate.mjs, add it here too.
 */
const EXPECTED_REPORTS = new Map([
  ['-crm-shared.report.json', '@crm/shared'],
  ['-crm-api.report.json', '@crm/api'],
  ['-crm-web.report.json', '@crm/web'],
])
const seenReportBasenames = new Set()

function walk(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.name.endsWith('.report.json')) continue
    seenReportBasenames.add(entry.name)
    let report
    try {
      report = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      // A truncated report is not "no survivors" — it is a report we cannot
      // read, and it has to push the verdict towards red, not away from it.
      unreadable++
      continue
    }
    reportFiles++
    for (const entry2 of Object.values(report.files ?? {})) {
      for (const mutant of entry2.mutants ?? []) {
        if (mutant.status in counts) counts[mutant.status]++
      }
    }
  }
}

walk(root)

// Display names of packages with NO report at all (the leg failed before
// `mutation-gate.mjs` ever wrote one — e.g. the initial dry run was red, or
// an earlier step like `Gate self-check` failed first) — task-mutation-gate
// nightly-alert-fidelity, 2026-09-03. Only meaningful, and only computed, for
// the messaging below: it does not change `result`/`detail`/`reason`, which
// were already correctly red for exactly this case before this existed.
const missingPackages = [...EXPECTED_REPORTS.entries()]
  .filter(([basename]) => !seenReportBasenames.has(basename))
  .map(([, name]) => name)

const sweep = (process.env.SWEEP_RESULT || 'success').trim()
const killed = counts.Killed + counts.Timeout

let result
let detail
// `reason` — task-mutation-gate nightly-alert-fidelity, 2026-09-03. A SECOND,
// coarser signal alongside `result`/`detail`, added so post-merge-alert.sh
// can pick alert TEXT without parsing this script's prose `detail` string.
// Before this existed, every KIND=mutation alert used the SAME body
// ("выжившие мутанты — вот что делать"), regardless of WHICH of the four
// `failure` branches below produced it — so a sweep that never ran at all
// (this branch, `sweep !== 'success'`) read, for 20+ consecutive nights, as
// ordinary accumulated mutant debt instead of "the check itself is down".
// Deliberately only TWO failure buckets, not four: `incomplete` covers the
// three branches where NOTHING was reliably verified (leg failed, a report
// could not be parsed, or no reports appeared at all) — the distinction
// between those three is real and stays in `detail`, but for "which alert
// TEXT to show", all three need the SAME text ("the run itself is broken"),
// and `survivors` is the one case where the sweep actually completed and
// found something. `cancelled`/`clean` never reach post-merge-alert.sh's
// failure path at all (see its RESULT dispatch), so they are not consumed
// there, but are still named here for anyone reading this script's output
// directly.
let reason

if (sweep === 'cancelled' || sweep === 'skipped') {
  result = 'cancelled'
  detail = `sweep was ${sweep} — not a finding`
  reason = 'cancelled'
} else if (sweep !== 'success') {
  result = 'failure'
  detail = `sweep did not complete (result=${sweep}) — nothing was verified`
  reason = 'incomplete'
} else if (unreadable > 0) {
  result = 'failure'
  detail = `${unreadable} mutation report(s) could not be parsed — the sweep's own output is unreadable, so the night is unverified`
  reason = 'incomplete'
} else if (reportFiles === 0) {
  result = 'failure'
  detail = `every sweep leg reported success but produced NO report files in '${root}' — nothing was actually measured`
  reason = 'incomplete'
} else if (counts.Survived > 0) {
  result = 'failure'
  detail =
    `${counts.Survived} surviving mutant(s) across ${reportFiles} report(s); ` +
    `${killed} killed, ${counts.NoCoverage} never executed, ${counts.Ignored} suppressed`
  reason = 'survivors'
} else {
  result = 'success'
  detail =
    `no surviving mutants across ${reportFiles} report(s); ` +
    `${killed} killed, ${counts.NoCoverage} never executed, ${counts.Ignored} suppressed`
  reason = 'clean'
}

console.log(`result=${result}`)
console.log(`detail=${detail}`)
console.log(`reason=${reason}`)
// Human-readable, comma-joined; empty string (never omitted — a missing
// GITHUB_OUTPUT key and an explicitly empty one are NOT the same to a
// workflow `env:` expression) when every expected package reported, which is
// the common case and must not print a stray "()" in the alert body.
console.log(`missing_packages=${missingPackages.join(', ')}`)
