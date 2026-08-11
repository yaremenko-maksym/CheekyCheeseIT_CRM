#!/usr/bin/env node
/**
 * check-mutation-suppressions.mjs — a mutation suppression must say WHY
 * (task-mutation-gate, 2026-08-11).
 *
 * WHY THIS EXISTS
 * ---------------
 * The mutation gate (scripts/devops/mutation-gate.mjs) fails a PR when a mutant
 * survives in changed code. That pressure has to have a legitimate release
 * valve, because EQUIVALENT mutants are real: this repo contains one —
 * `img: () => null` mutated to `img: () => undefined` renders identically in
 * React, so no assertion can distinguish them. Without a suppression mechanism
 * the first equivalent mutant makes someone disable the whole gate.
 *
 * But a suppression with no stated reason IS the disease, one level up: it is a
 * check switched off silently. StrykerJS makes the reason OPTIONAL — write
 * `// Stryker disable next-line ArrowFunction` with nothing after it and the
 * mutant is ignored, no complaint. Worse for anyone trying to detect that
 * afterwards: Stryker fills the empty reason in with its own placeholder string
 * `'Ignored using a comment'` (@stryker-mutator/instrumenter,
 * directive-bookkeeper.js `DEFAULT_REASON`), which is 22 alphanumerics long and
 * therefore sails straight through a naive "the reason must be at least N
 * characters" test. That is not hypothetical: the first version of the gate's
 * report-side check had exactly that bug and passed a reasonless suppression.
 * Both this guard and the gate now reject that exact string by value.
 *
 * WHAT IT REQUIRES
 * ----------------
 *   1. Every `// Stryker disable …` comment carries `: <reason>` with at least
 *      12 letters/digits of actual prose.
 *   2. The reason is not Stryker's placeholder.
 *   3. No FILE-SCOPED disable (`// Stryker disable …` without `next-line`).
 *      A file-scoped directive silently switches the gate off for everything
 *      below it, forever, including code written years later by someone who
 *      never saw the comment. `next-line` is the only granularity where the
 *      reason a reviewer reads is actually attached to the thing it excuses.
 *      Files that genuinely should not be mutated at all (generated code, DI
 *      wiring, the Drizzle schema) are excluded by path in mutation-gate.mjs,
 *      where the exclusion is visible in one list instead of scattered.
 *
 * `// Stryker restore …` needs no reason — it turns mutation back ON.
 *
 * RELATIONSHIP TO THE GATE: overlapping on purpose. The gate only sees mutants
 * it actually generated, i.e. inside the CHANGED lines of one PR; this guard
 * reads the whole repository on every CI run, so a suppression that drifts into
 * untouched code is still caught. Neither one alone covers the other's blind
 * spot.
 *
 * Usage:
 *   scripts/devops/check-mutation-suppressions.mjs            # this repo
 *   scripts/devops/check-mutation-suppressions.mjs <root>     # a fixture tree
 *
 * The one-argument form exists ONLY so this guard's own test can point it at
 * fabricated files. It changes what is inspected, never how strictly.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SELF_DIR, '../..')

const SCAN_ROOT = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT
const USING_FIXTURE = Boolean(process.argv[2])

const SOURCE_EXT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', '.stryker-tmp'])

const MIN_REASON_LENGTH = 12
const STRYKER_DEFAULT_IGNORE_REASON = 'Ignored using a comment'

/**
 * Mirrors @stryker-mutator/instrumenter's own directive regex, applied to a
 * whole source line rather than to a parsed comment body. Deliberately a
 * superset: it also matches a directive written inside a `/* *\/` block or after
 * code on the same line — forms Stryker itself may or may not honour. Flagging a
 * malformed directive that does nothing is a cheap false positive; missing a
 * real one is not.
 */
const DIRECTIVE_RE = /Stryker\s+(disable|restore)(\s+next-line)?\s+([a-zA-Z, ]+?)\s*(?::(.*))?$/

function listFiles(root) {
  if (!USING_FIXTURE) {
    // Tracked files only — the repo's own convention, and it keeps the scan off
    // build output and other people's scratch files.
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return out
      .split('\0')
      .filter((f) => f && SOURCE_EXT.test(f))
      .map((f) => path.join(root, f))
  }
  const acc = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SOURCE_EXT.test(entry)) acc.push(full)
    }
  }
  walk(root)
  return acc
}

const problems = []
let directiveCount = 0
let fileCount = 0

for (const file of listFiles(SCAN_ROOT)) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!content.includes('Stryker ')) continue
  fileCount++

  content.split('\n').forEach((line, index) => {
    const match = DIRECTIVE_RE.exec(line)
    if (!match) return
    const [, kind, nextLine, mutators, rawReason] = match
    if (kind === 'restore') return

    directiveCount++
    const where = `${path.relative(SCAN_ROOT, file)}:${index + 1}`
    const reason = (rawReason ?? '').trim()

    if (!nextLine) {
      problems.push({
        where,
        why: `file-scoped \`Stryker disable ${mutators.trim()}\` — use \`Stryker disable next-line ${mutators.trim()}: <why>\` so the reason is attached to the one mutant it excuses`,
      })
      return
    }
    if (reason === '') {
      problems.push({
        where,
        why: `suppression with no reason. Write \`// Stryker disable next-line ${mutators.trim()}: <why this mutant cannot be killed>\``,
      })
      return
    }
    if (reason === STRYKER_DEFAULT_IGNORE_REASON) {
      problems.push({
        where,
        why: `the reason is Stryker's own placeholder for "no reason given" — write a real one`,
      })
      return
    }
    if (reason.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_REASON_LENGTH) {
      problems.push({
        where,
        why: `reason too short to mean anything: "${reason}"`,
      })
    }
  })
}

console.log('== check-mutation-suppressions.mjs ==')
console.log(`   root: ${SCAN_ROOT}`)
console.log(`   ${directiveCount} suppression(s) across ${fileCount} file(s)`)

if (problems.length === 0) {
  console.log('\nOK: every mutation suppression is line-scoped and states a reason.')
  process.exit(0)
}

console.log('')
for (const p of problems) {
  console.log(`::error file=${p.where.split(':')[0]},line=${p.where.split(':')[1]}::${p.why}`)
  console.log(`FAIL  ${p.where}`)
  console.log(`      ${p.why}`)
}
console.log('')
console.log(
  'Rule: a mutation suppression is a check switched off. Switching one off without\n' +
    'saying why — in the diff, where a reviewer reads it — is the exact defect the\n' +
    'mutation gate exists to catch, applied to the gate itself.',
)
process.exit(1)
