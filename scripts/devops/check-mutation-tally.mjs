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

function walk(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.name.endsWith('.report.json')) continue
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

const sweep = (process.env.SWEEP_RESULT || 'success').trim()
const killed = counts.Killed + counts.Timeout

let result
let detail

if (sweep === 'cancelled' || sweep === 'skipped') {
  result = 'cancelled'
  detail = `sweep was ${sweep} — not a finding`
} else if (sweep !== 'success') {
  result = 'failure'
  detail = `sweep did not complete (result=${sweep}) — nothing was verified`
} else if (unreadable > 0) {
  result = 'failure'
  detail = `${unreadable} mutation report(s) could not be parsed — the sweep's own output is unreadable, so the night is unverified`
} else if (reportFiles === 0) {
  result = 'failure'
  detail = `every sweep leg reported success but produced NO report files in '${root}' — nothing was actually measured`
} else if (counts.Survived > 0) {
  result = 'failure'
  detail =
    `${counts.Survived} surviving mutant(s) across ${reportFiles} report(s); ` +
    `${killed} killed, ${counts.NoCoverage} never executed, ${counts.Ignored} suppressed`
} else {
  result = 'success'
  detail =
    `no surviving mutants across ${reportFiles} report(s); ` +
    `${killed} killed, ${counts.NoCoverage} never executed, ${counts.Ignored} suppressed`
}

console.log(`result=${result}`)
console.log(`detail=${detail}`)
