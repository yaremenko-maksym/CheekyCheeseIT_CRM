#!/usr/bin/env node
/**
 * mutation-gate.mjs — a test has to prove it can fail (task-mutation-gate, 2026-08-11).
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-07/08 the same defect was found EIGHT times in this repo, every time
 * in a place that was considered covered: a check that cannot go red. Three of its
 * shapes are invisible to every linter, because the syntax is flawless:
 *
 *   1. the assertion compares a value against the very constant it should be
 *      pinning  — raise the constant and the bar rises with it;
 *   2. the expected value is derived from the actual one through a ternary;
 *   3. a value is compared with itself via a default-substitution (`?? actual`).
 *
 * Add to that the two that DID have real assertions but read the wrong DOM tree
 * (a dialog renders through a portal; the test queried `container`), and the
 * common property is the same: deleting the behaviour under test changes nothing.
 * That is exactly what mutation testing measures — it deletes the behaviour for
 * you and reports whether anything went red.
 *
 * The reference case ships with the repo:
 * apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt is a
 * verbatim copy of the pre-fix JobSuggestionDialog test. Every one of its tests
 * passes against the CURRENT, hardened component, and it kills ZERO of the five
 * mutants in that component's XSS defence — including the mutant that empties
 * `MARKDOWN_COMPONENTS` outright. `scripts/devops/mutation-gate-vacuum-proof.sh`
 * reproduces that A/B on demand.
 *
 * WHAT IT DOES
 * ------------
 *   --changed   (PR gate)   mutate ONLY the lines this branch changed vs its base.
 *                           A SURVIVING mutant in changed code fails the build.
 *   --full      (nightly)   mutate whole packages on `main`; the survivor
 *                           inventory is what accumulated before the gate existed.
 *
 * WHY LINE-SCOPED AND NOT FILE-SCOPED: mutating whole changed FILES is not
 * proportional to the diff and would be unusable today — a single 386-line
 * component in this repo carries 162 mutants and its (good, real) test file
 * leaves 57 of them alive. Scoping to changed LINES is what makes "one survivor
 * = red" affordable; the backlog is the nightly's job, not the PR's.
 *
 * HOW STRYKER INTERPRETS A LINE RANGE (measured, not assumed — see
 * @stryker-mutator/instrumenter `locationIncluded`): a mutant is generated only
 * when the mutated AST node lies ENTIRELY inside the range. Editing one line in
 * the middle of a 30-line JSX block therefore mutates the expressions on THAT
 * line, not the whole block. That is the intended granularity ("did you test what
 * you changed"), and it is also a real limit: the enclosing block's own mutants
 * are only ever reached by the nightly full run.
 *
 * VERDICT RULES
 * -------------
 *   Survived      → RED, UNLESS Stryker's own report says zero tests ran for
 *                   that specific mutant (`testsCompleted === 0`) — see
 *                   "TOOL FAILURE vs a surviving mutant" below. A genuine
 *                   survivor (tests ran, none failed) is still red, and still
 *                   not a percentage: the eight findings above were single
 *                   mutants each, and any percentage threshold would have
 *                   passed them.
 *   Ignored       → allowed ONLY with a reason (`// Stryker disable next-line
 *                   <mutator>: <why>`). The reason is read back out of Stryker's
 *                   own report, so a suppression without one is red HERE too, not
 *                   only in check-mutation-suppressions.mjs. Equivalent mutants
 *                   are real (this repo has one — `img: () => null` mutated to
 *                   `() => undefined` renders identically), so a suppression
 *                   mechanism is not optional: without one, the gate gets
 *                   switched off wholesale. A suppression with no stated reason,
 *                   though, is a silent bypass — the same disease one level up.
 *   NoCoverage    → WARNING, not red, and printed loudly. "Changed lines must be
 *                   covered" is a coverage threshold, which task-mutation-gate
 *                   explicitly leaves to a separate task. Flip with
 *                   MUTATION_NO_COVERAGE_IS_RED=1 when that task lands.
 *   CompileError / RuntimeError → not red per se (Stryker could not build that
 *                   mutant); counted and printed.
 *   Timeout       → counted as killed, which is Stryker's own convention. Note
 *                   the direction of the risk: a too-TIGHT timeout turns
 *                   survivors into false "killed", i.e. a false GREEN. That is
 *                   why timeoutMS below is generous rather than tight. This
 *                   verdict is unchanged, but the COUNT is no longer hidden
 *                   inside "killed": both places that print a killed figure
 *                   show it as `N (M timeout)` when M > 0, and every timeout
 *                   mutant is also listed in its own, non-blocking report
 *                   section — see "Zero survivors with timeouts" in
 *                   mutation-gate-runbook.md for why that count matters even
 *                   though it never fails the build.
 *
 * TOOL FAILURE vs A SURVIVING MUTANT
 * -----------------------------------
 * @stryker-mutator/api's own toMutantRunResult() (run-result-helpers.js) has
 * exactly one rule for a completed mutant run: no failing test → Survived.
 * It does not ask HOW MANY tests ran first — a run that executed zero tests
 * and a run that executed the whole suite both read as "no failure", so both
 * come back Survived. The one field that tells them apart is written into
 * Stryker's own JSON report for every Survived mutant regardless
 * (mutation-test-report-helper.js: `testsCompleted: result.nrOfTests`), and
 * this gate was not reading it. A mutant the runner never actually exercised
 * was therefore reported, and blocked, exactly like one real tests looked at
 * and missed — accusing the CODE of a gap that was actually the TOOL's.
 *
 * This is not hypothetical: reproduced live on this repo, 2026-08-25 — a
 * `@crm/web` diff (task 5/6, cascade edit-preview) generated 33 mutants,
 * Stryker's own clear-text reporter printed "Ran 0.00 tests per mutant on
 * average", and all 33 carried `testsCompleted: 0` in the JSON report despite
 * real, passing unit specs existing for that code. See
 * scripts/devops/mutation-gate-runbook.md "Tool failure vs a surviving
 * mutant" for the reproduction and for why the mechanism (believed to be
 * `vitest.related` test-file resolution not surviving Stryker's per-mutant
 * sandbox path) is named but deliberately NOT fixed here — that is separate,
 * harder work, and this task's job is the gate's honesty, not the runner's
 * behavior.
 *
 * The fix here is a per-mutant reclassification, nothing coarser: a
 * `Survived` mutant with `testsCompleted === 0` is read into `toolFailures`
 * instead of `survivors` — reported loudly (its own report section, its own
 * counted total) but NEVER counted toward the exit code. A `Survived` mutant
 * on the very same line with `testsCompleted > 0` is a real survivor and
 * blocks exactly as before; nothing here raises the bar for genuine coverage,
 * it only stops the gate from inventing a defect out of its own inability to
 * run a test.
 *
 * TIME BUDGET
 * -----------
 * The run is killed at MUTATION_BUDGET_SECONDS and the gate goes RED with an
 * explicit message naming the budget, what had been mutated so far, and how to
 * raise it. It must never degrade to "skipped because it was slow": a gate that
 * quietly passes under load reproduces precisely the failure this task is about.
 *
 * ENV
 * ---
 *   MUTATION_BASE_SHA          explicit diff base (wins over everything)
 *   MUTATION_BASE_REF          fallback ref for merge-base (default: origin/main)
 *   MUTATION_BUDGET_SECONDS    wall-clock budget for the whole gate (default:
 *                              900 for --changed, 14400 for --full)
 *   MUTATION_CONCURRENCY       Stryker workers (default: min(4, cpus-1))
 *   MUTATION_PACKAGES          comma list to restrict packages (default: all)
 *   MUTATION_ONLY_FILES        comma list of `path[:from-to]` NARROWING filters,
 *                              INTERSECTED with the changed ranges — it can only
 *                              ever shrink the scope, never add to it, so a run
 *                              that is green with it set is not evidence of
 *                              anything and a run that is red with it set is
 *                              genuinely red. For local iteration ("re-check just
 *                              this file") and for mutation-gate-vacuum-proof.sh.
 *                              Never set in the PR gate.
 *   MUTATION_NO_COVERAGE_IS_RED  1 → NoCoverage mutants fail the build too
 *   MUTATION_SURVIVOR_BUDGET   allowed survivors before going red (default 0;
 *                              the nightly workflow sets this deliberately)
 *
 * EXIT CODES
 * ----------
 *   0  gate passed (possibly with warnings, possibly nothing to mutate)
 *   1  survivors / reasonless suppressions — the gate did its job
 *   2  the gate could not run (bad base ref, Stryker crash, budget exceeded).
 *      Deliberately NOT 0: "we could not check" is not "it is fine".
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SELF_DIR, '../..')

const STRYKER_BIN = path.join(REPO_ROOT, 'node_modules/@stryker-mutator/core/bin/stryker.js')
const VITEST_RUNNER_PLUGIN = path.join(
  REPO_ROOT,
  'node_modules/@stryker-mutator/vitest-runner/dist/src/index.js',
)
const REPORT_DIR = path.join(REPO_ROOT, 'reports/mutation')

/**
 * The three Vitest-run packages. `apps/e2e` is deliberately absent: every mutant
 * there would cost a full browser run, which is not a gate, it is a night.
 * `apps/landing` is absent for a smaller reason — it has no unit specs of its own
 * worth mutating yet; add it here the day it does.
 *
 * `exclude` mirrors the coverage `exclude` lists already living in each package's
 * vitest config, plus generated files. Everything excluded here is excluded
 * because a UNIT suite structurally cannot kill mutants in it (DI wiring, the
 * Drizzle schema, generated route trees), not because it is unimportant — those
 * paths are guarded by the integration suite, the prod-DDL guard and E2E.
 */
const PACKAGES = [
  {
    name: '@crm/shared',
    dir: 'packages/shared',
    globs: ['src/**/*.ts'],
    exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/**/*.d.ts'],
  },
  {
    name: '@crm/api',
    dir: 'apps/api',
    globs: ['src/**/*.ts'],
    exclude: [
      'src/**/*.spec.ts',
      'src/**/*.test.ts',
      'src/**/*.d.ts',
      'src/main.ts',
      'src/**/*.module.ts',
      'src/test/**',
      'src/db/**',
    ],
  },
  {
    name: '@crm/web',
    dir: 'apps/web',
    globs: ['app/**/*.ts', 'app/**/*.tsx'],
    exclude: [
      'app/**/*.spec.ts',
      'app/**/*.spec.tsx',
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'app/**/__tests__/**',
      'app/**/*.d.ts',
      'app/routeTree.gen.ts',
      'app/client.tsx',
      'app/test/**',
    ],
  },
]

// ── tiny helpers ──────────────────────────────────────────────────────────────

/** Minimal glob → RegExp (`**`, `*`, `?`). Enough for the patterns above. */
function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows the slash so `a/**/b` also matches `a/b`
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

function matchesAny(relPath, globs) {
  return globs.some((g) => globToRegExp(g).test(relPath))
}

function git(args, { allowFail = false } = {}) {
  const res = spawnSyncCapture('git', args)
  if (res.code !== 0 && !allowFail) {
    fail(`git ${args.join(' ')} failed (exit ${res.code}):\n${res.output}`)
  }
  return res
}

/** Runs a command to completion, returning its exit code AND its output. */
function spawnSyncCapture(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`,
    }
  }
}

function fail(message) {
  console.error(`::error::mutation-gate: ${message}`)
  process.exit(2)
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  try {
    appendFileSync(file, lines.join('\n') + '\n')
  } catch {
    /* a summary that cannot be written must not fail the gate */
  }
}

// ── diff → changed line ranges ────────────────────────────────────────────────

/**
 * Resolve the commit to diff against. Order matters and every branch is loud:
 * "I could not work out what changed" must never look like "nothing changed".
 *
 *  1. MUTATION_BASE_SHA — what CI passes explicitly.
 *  2. HEAD^1 when HEAD is a merge commit. On a `pull_request` event GitHub
 *     checks out the merge commit, so HEAD^1 is the base branch tip and
 *     HEAD^1..HEAD is exactly the PR's net change — available with the
 *     fetch-depth: 2 that ci.yml already uses.
 *  3. merge-base with MUTATION_BASE_REF (default origin/main) — the local case.
 */
function resolveBase() {
  const explicit = process.env.MUTATION_BASE_SHA?.trim()
  if (explicit) {
    const check = git(['cat-file', '-e', `${explicit}^{commit}`], { allowFail: true })
    if (check.code !== 0) {
      fail(
        `MUTATION_BASE_SHA=${explicit} is not a commit in this checkout. ` +
          `Fetch it first (git fetch --depth=1 origin <sha>) — refusing to guess a base, ` +
          `because guessing wrong means mutating nothing and reporting green.`,
      )
    }
    return { sha: explicit, how: 'MUTATION_BASE_SHA' }
  }

  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).output.trim().split(/\s+/)
  if (parents.length === 3) {
    return { sha: parents[1], how: 'HEAD^1 (merge commit — PR merge ref)' }
  }

  const ref = process.env.MUTATION_BASE_REF?.trim() || 'origin/main'
  const mb = git(['merge-base', ref, 'HEAD'], { allowFail: true })
  if (mb.code !== 0 || !mb.output.trim()) {
    fail(
      `cannot resolve a diff base: no merge-base between '${ref}' and HEAD. ` +
        `Fetch the base branch (git fetch origin main) or pass MUTATION_BASE_SHA.`,
    )
  }
  return { sha: mb.output.trim(), how: `merge-base with ${ref}` }
}

/**
 * Changed line ranges per file, from `git diff --unified=0`.
 * Only ADDED/modified lines on the new side count — a hunk that only deletes
 * lines has nothing left to mutate.
 */
function changedRanges(baseSha) {
  const res = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha], {
    allowFail: true,
  })
  if (res.code !== 0) {
    // Almost always one thing in CI: a shallow checkout that has the base
    // COMMIT but not its tree. Worth naming, because the raw git message
    // ("bad object" / "could not read") sends people looking at the gate
    // instead of at `fetch-depth`.
    fail(
      `git diff against ${baseSha.slice(0, 12)} failed. If this is CI, the checkout is ` +
        `probably too shallow to hold that commit's tree — raise \`fetch-depth\` on the ` +
        `actions/checkout step (2 is enough for a pull_request merge ref, since the base ` +
        `is HEAD^1). Refusing to continue: an unreadable base is not an empty diff.\n${res.output}`,
    )
  }
  const diff = res.output
  const byFile = new Map()
  let current = null
  let sawOldFileHeader = false

  for (const line of diff.split('\n')) {
    // `+++ ` is only a file header when it directly follows `--- `. Without that
    // pairing an ADDED content line that happens to start with "+++ " (this very
    // file's docblock could contain one) would be read as a header and silently
    // redirect every following hunk to a made-up path.
    if (line.startsWith('--- ')) {
      sawOldFileHeader = true
      continue
    }
    if (sawOldFileHeader && line.startsWith('+++ ')) {
      sawOldFileHeader = false
      const p = line.slice(4).trim()
      current = p === '/dev/null' ? null : p.replace(/^b\//, '')
      if (current && !byFile.has(current)) byFile.set(current, [])
      continue
    }
    sawOldFileHeader = false
    if (!current || !line.startsWith('@@')) continue
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count === 0) continue // pure deletion
    byFile.get(current).push([start, start + count - 1])
  }

  for (const [file, ranges] of byFile) {
    if (ranges.length === 0) {
      byFile.delete(file)
      continue
    }
    ranges.sort((a, b) => a[0] - b[0])
    const merged = [ranges[0]]
    for (const r of ranges.slice(1)) {
      const last = merged[merged.length - 1]
      // Merge touching/adjacent ranges — fewer, wider patterns cost Stryker less
      // to match and read better in the log.
      if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else merged.push(r)
    }
    byFile.set(file, merged)
  }
  return byFile
}

/**
 * Parse MUTATION_ONLY_FILES into `path → ranges | null` (null = whole file).
 * Applied as an INTERSECTION with what the diff says changed, never as a
 * replacement — see the env docs at the top for why that distinction matters.
 */
function parseOnlyFiles() {
  const raw = (process.env.MUTATION_ONLY_FILES || '').trim()
  if (!raw) return null
  const map = new Map()
  for (const item of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(.*?):(\d+)-(\d+)$/.exec(item)
    if (m) {
      const list = map.get(m[1]) ?? []
      list.push([Number(m[2]), Number(m[3])])
      map.set(m[1], list)
    } else {
      map.set(item, null)
    }
  }
  return map
}

function intersectRanges(changed, filter) {
  if (filter === null) return changed
  const out = []
  for (const [cFrom, cTo] of changed) {
    for (const [fFrom, fTo] of filter) {
      const from = Math.max(cFrom, fFrom)
      const to = Math.min(cTo, fTo)
      if (from <= to) out.push([from, to])
    }
  }
  return out
}

/** Group changed files into per-package Stryker `mutate` patterns. */
function planChanged(baseSha) {
  const ranges = changedRanges(baseSha)
  const onlyFiles = parseOnlyFiles()
  if (onlyFiles) {
    for (const file of [...ranges.keys()]) {
      if (!onlyFiles.has(file)) {
        ranges.delete(file)
        continue
      }
      const narrowed = intersectRanges(ranges.get(file), onlyFiles.get(file))
      if (narrowed.length === 0) ranges.delete(file)
      else ranges.set(file, narrowed)
    }
    console.log(
      `mutation-gate: MUTATION_ONLY_FILES narrowed the scope to ${ranges.size} file(s) — ` +
        `this run is NOT a full check of the diff.`,
    )
  }
  const plan = []
  const skipped = []

  for (const pkg of PACKAGES) {
    const patterns = []
    let files = 0
    let lines = 0
    for (const [repoPath, fileRanges] of ranges) {
      if (!repoPath.startsWith(pkg.dir + '/')) continue
      const rel = repoPath.slice(pkg.dir.length + 1)
      if (!matchesAny(rel, pkg.globs)) continue
      if (matchesAny(rel, pkg.exclude)) {
        skipped.push(`${repoPath} (excluded from mutation — see PACKAGES in mutation-gate.mjs)`)
        continue
      }
      if (!existsSync(path.join(REPO_ROOT, repoPath))) continue // deleted file
      files++
      for (const [from, to] of fileRanges) {
        patterns.push(`${rel}:${from}-${to}`)
        lines += to - from + 1
      }
    }
    if (patterns.length > 0) plan.push({ pkg, patterns, files, lines })
  }
  return { plan, skipped }
}

/** Whole-package plan for the nightly run. */
function planFull() {
  return {
    plan: PACKAGES.map((pkg) => ({
      pkg,
      patterns: [...pkg.globs, ...pkg.exclude.map((e) => `!${e}`)],
      files: -1,
      lines: -1,
    })),
    skipped: [],
  }
}

// ── running Stryker ───────────────────────────────────────────────────────────

function writeConfig(pkg, patterns, reportPath, concurrency) {
  const cfg = {
    testRunner: 'vitest',
    // Absolute path rather than the bare name: Stryker resolves bare plugin
    // names from the CWD, and the CWD here is the package being mutated, which
    // (pnpm workspace, no hoisting) has no @stryker-mutator/* of its own.
    plugins: [VITEST_RUNNER_PLUGIN],
    coverageAnalysis: 'perTest',
    reporters: ['json', 'clear-text'],
    jsonReporter: { fileName: reportPath },
    concurrency,
    // Our own verdict is computed from the JSON report (Stryker's break
    // threshold cannot tell Survived from NoCoverage, and this gate must).
    thresholds: { high: 100, low: 100, break: null },
    // An empty match is a legitimate outcome here (a diff that touches only
    // comments); it is reported as such instead of crashing the run.
    allowEmpty: true,
    // Generous on purpose: Stryker counts a timeout as KILLED, so a tight
    // timeout silently converts survivors into false greens.
    timeoutMS: 20000,
    timeoutFactor: 2,
    mutate: patterns,
    // No ANSI in either the reporter or Stryker's own logger: this output is
    // pasted into PR bodies and read out of CI logs as evidence.
    allowConsoleColors: false,
    clearTextReporter: { allowColor: false, maxTestsToLog: 2 },
  }
  const file = path.join(REPORT_DIR, `stryker-${pkg.name.replace(/[^a-z0-9]+/gi, '-')}.json`)
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  return file
}

function runStryker(pkg, configFile, remainingMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STRYKER_BIN, 'run', configFile], {
      cwd: path.join(REPO_ROOT, pkg.dir),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → we can kill Stryker's children too
    })

    let out = ''
    const capture = (chunk) => {
      const s = chunk.toString()
      out += s
      process.stdout.write(s)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, remainingMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        // Stryker cleans its own sandbox on a normal exit but never gets the
        // chance when we SIGKILL it. Left behind, `.stryker-tmp` is a full copy
        // of the package (gitignored, but it confuses the next `pnpm test` run
        // and can be gigabytes on a repeated timeout).
        rmSync(path.join(REPO_ROOT, pkg.dir, '.stryker-tmp'), { recursive: true, force: true })
      }
      resolve({ code: code ?? 1, out, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, out: out + String(err), timedOut })
    })
  })
}

// ── report → verdict ──────────────────────────────────────────────────────────

const MIN_REASON_LENGTH = 12

/**
 * Stryker's own placeholder when a `// Stryker disable` comment carries NO
 * reason (@stryker-mutator/instrumenter, directive-bookkeeper.js:
 * `const DEFAULT_REASON = 'Ignored using a comment'`). It has to be rejected by
 * exact value, not by length: it is 22 alphanumerics long, so a plain
 * "the reason must be at least N characters" check passes it happily. That was
 * not a hypothetical — the first version of this file had exactly that check,
 * and a reasonless `// Stryker disable next-line ArrowFunction` sailed through
 * it green. A suppression guard that accepts a reasonless suppression is the
 * very disease this gate exists to treat, reproduced inside the gate.
 */
const STRYKER_DEFAULT_IGNORE_REASON = 'Ignored using a comment'

function readReport(reportPath, pkg) {
  if (!existsSync(reportPath)) return null
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const counts = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    // A Stryker STATUS is never "ToolFailure" — this bucket is OURS, carved
    // out of Survived per-mutant (see the module header, "TOOL FAILURE vs a
    // surviving mutant"), never out of Killed/Timeout/NoCoverage/etc. It
    // exists so the per-package table below can show a total that still adds
    // up: Killed+Timeout+Survived+ToolFailure+NoCoverage+Ignored+errors is
    // every mutant Stryker generated, same as before this bucket existed.
    ToolFailure: 0,
    NoCoverage: 0,
    Ignored: 0,
    CompileError: 0,
    RuntimeError: 0,
  }
  const survivors = []
  // Same shape as `survivors` ({ where, mutator, replacement }) — deliberately,
  // so every place that already knows how to print a survivor (the PR-body
  // list, the ::error/::warning annotation) can print one of these with the
  // same code, just a different label and a different verb ("NOT VERIFIED",
  // not "SURVIVED").
  const toolFailures = []
  // Same shape again, collected for the same reason: task-mutation-gate-
  // timeout-visibility. Stryker counts a Timeout as Killed for the exit code
  // (module header, "VERDICT RULES") — that does not change here — but until
  // this list existed, the number of timeouts was added into "killed" at BOTH
  // places that print it (the per-package table and the console summary) and
  // never printed on its own anywhere. A run with 16 of 34 mutants timing out
  // read as a plain, undifferentiated "killed 34" — indistinguishable from 34
  // mutants an assertion actually caught.
  const timeouts = []
  const uncovered = []
  const badSuppressions = []
  // EVERY Ignored mutant, not just the reasonless ones — this is what AC2 of
  // task-mutation-gate-mechanical needs: the actual per-directive COUNT, read
  // back out of Stryker's own report rather than reasoned about from the diff.
  // See groupSuppressions() below for why "line × mutator" is the right key.
  const suppressed = []

  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      const where = `${pkg.dir}/${file}:${mutant.location?.start?.line ?? '?'}`

      // Reclassify BEFORE the generic tally below, and PER MUTANT — never by
      // file, package, or "this run looked suspicious": Stryker's own
      // `testsCompleted` (mutation-test-report-helper.js:
      // `testsCompleted: result.nrOfTests`, written for every Survived
      // mutant) is the one fact that tells "the runner executed zero tests"
      // apart from "tests ran and missed it". A mutant on the SAME line
      // that a test DID execute stays a real survivor two lines down.
      if (mutant.status === 'Survived' && (mutant.testsCompleted ?? 0) === 0) {
        counts.ToolFailure++
        toolFailures.push({ where, mutator: mutant.mutatorName, replacement: mutant.replacement })
        continue
      }

      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
      if (mutant.status === 'Survived') {
        survivors.push({ where, mutator: mutant.mutatorName, replacement: mutant.replacement })
      } else if (mutant.status === 'Timeout') {
        timeouts.push({ where, mutator: mutant.mutatorName, replacement: mutant.replacement })
      } else if (mutant.status === 'NoCoverage') {
        uncovered.push({ where, mutator: mutant.mutatorName })
      } else if (mutant.status === 'Ignored') {
        const reason = (mutant.statusReason ?? '').trim()
        const written =
          reason !== STRYKER_DEFAULT_IGNORE_REASON &&
          reason.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_REASON_LENGTH
        suppressed.push({ where, mutator: mutant.mutatorName, reason })
        if (!written) badSuppressions.push({ where, mutator: mutant.mutatorName, reason })
      }
    }
  }
  return { counts, survivors, toolFailures, timeouts, uncovered, badSuppressions, suppressed }
}

/**
 * Formats the "killed" figure so a timeout is visible without being counted
 * separately — task-mutation-gate-timeout-visibility. `killedCount` already
 * includes `timeoutCount` (Stryker's own convention: Timeout counts as Killed
 * for the exit code, and that is NOT changed here — see the module header,
 * "VERDICT RULES"). This only changes what is PRINTED: `killed N (M timeout)`
 * when there were any, plain `killed N` when there were none, so a run with
 * zero timeouts reads exactly as it did before this task and does not grow a
 * "(0 timeout)" nobody asked for.
 */
function formatKilled(killedCount, timeoutCount) {
  return timeoutCount > 0 ? `${killedCount} (${timeoutCount} timeout)` : `${killedCount}`
}

/**
 * Groups Ignored mutants by (file:line, mutator) — task-mutation-gate-mechanical
 * AC2. That pair is the actual unit a `// Stryker disable next-line <mutator>`
 * directive silences, and it is NOT the same thing as "the one mutant the author
 * was looking at": the same mutator can rewrite several distinct AST nodes on one
 * line (e.g. two comparisons in one `if`), and every one of them goes quiet under
 * a single comment. Measured three times on this repo, always higher than the
 * author expected: #531 (eight silenced, two intended — six were already killed
 * by tests that existed), #554 (four silenced, one intended, author already knew
 * the rule and still miscounted). The fix is not a sharper memory of the rule —
 * it is printing the number Stryker itself recorded, so nobody has to reason
 * about it by reading the diff.
 */
function groupSuppressions(suppressed) {
  const map = new Map()
  for (const s of suppressed) {
    const key = `${s.where} ${s.mutator}`
    let g = map.get(key)
    if (!g) {
      g = { where: s.where, mutator: s.mutator, count: 0, reasons: new Set() }
      map.set(key, g)
    }
    g.count++
    if (s.reason) g.reasons.add(s.reason)
  }
  // Worst offenders (most silenced mutants under one directive) first — that is
  // the ordering a reviewer needs, not file order.
  return [...map.values()].sort((a, b) => b.count - a.count)
}

/**
 * Generic names that would make the integration-spec heuristic below noise
 * rather than signal: almost every package has an `index.ts`, and "utils" or
 * "types" says nothing about which ONE file's coverage is in question. Treated
 * as "no hint either way", not as "definitely not integration-only" — the
 * heuristic can only ever ADD confidence, never subtract it.
 */
const INTEGRATION_HINT_STOPLIST = new Set([
  'index',
  'types',
  'type',
  'utils',
  'util',
  'helpers',
  'helper',
  'constants',
  'common',
  'base',
  'main',
  'module',
  'config',
])

const _integrationCorpusCache = new Map()

/**
 * The combined text of every `*.integration.spec.ts` in the given root, read
 * once and cached per root — task-mutation-gate-mechanical AC3/AC4. Backing for
 * looksIntegrationOnly() below. `root` defaults to REPO_ROOT but is an explicit
 * parameter so the test for this function can point it at a throwaway fixture
 * tree instead of grep-ing the real repository (same discipline the guard tests
 * in scripts/devops/tests/ already hold themselves to: exercise the real code,
 * against a FAKE root, never the repo being verified).
 */
function integrationSpecCorpus(root = REPO_ROOT) {
  if (_integrationCorpusCache.has(root)) return _integrationCorpusCache.get(root)
  let text = ''
  const res = spawnSyncCapture('git', ['-C', root, 'ls-files', '--', '*.integration.spec.ts'])
  if (res.code === 0) {
    for (const rel of res.output.split('\n').filter(Boolean)) {
      try {
        text += readFileSync(path.join(root, rel), 'utf8') + '\n'
      } catch {
        /* an unreadable spec file just contributes nothing to the corpus */
      }
    }
  }
  _integrationCorpusCache.set(root, text)
  return text
}

/**
 * HEURISTIC, not proof (task-mutation-gate-mechanical AC3): true when a source
 * file's basename shows up somewhere in the text of the integration-spec corpus,
 * as a whole word. That is a much weaker claim than "this file is imported ONLY
 * by an integration spec" — it does not parse imports, it cannot tell a real
 * reference from a coincidental name collision, and it says nothing about
 * whether a UNIT test also covers the same line. What it is good for: triage.
 * A `NoCoverage` entry the gate cannot execute (the whole reason this gate runs
 * only the unit suite — vitest.config.mts structurally excludes
 * `*.integration.spec.ts` from a non-integration run, see
 * .claude/rules/common/mutation-gate-integration-specs.md) is unsurprising when
 * its file is also mentioned in an integration spec; it is worth a first, closer
 * look when it is not.
 */
function looksIntegrationOnly(repoRelPath, root = REPO_ROOT) {
  const base = path.basename(repoRelPath).replace(/\.(ts|tsx)$/, '')
  if (!base || INTEGRATION_HINT_STOPLIST.has(base.toLowerCase())) return false
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(integrationSpecCorpus(root))
}

/** Splits a list of `{ where, mutator }` NoCoverage entries by the heuristic above. */
function splitUncoveredByIntegrationHint(uncovered, root = REPO_ROOT) {
  const likely = []
  const real = []
  for (const u of uncovered) {
    const file = u.where.slice(0, u.where.lastIndexOf(':'))
    ;(looksIntegrationOnly(file, root) ? likely : real).push(u)
  }
  return { likely, real }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const mode = args.includes('--full') ? 'full' : 'changed'
  if (!args.includes('--full') && !args.includes('--changed')) {
    fail('pass --changed (PR gate) or --full (nightly). Refusing to guess.')
  }

  const budgetSeconds = Number(
    process.env.MUTATION_BUDGET_SECONDS || (mode === 'full' ? 14400 : 900),
  )
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    fail(
      `MUTATION_BUDGET_SECONDS must be a positive number, got '${process.env.MUTATION_BUDGET_SECONDS}'`,
    )
  }
  const concurrency = Number(
    process.env.MUTATION_CONCURRENCY || Math.max(1, Math.min(4, cpus().length - 1)),
  )
  const survivorBudget = Number(process.env.MUTATION_SURVIVOR_BUDGET || 0)
  const noCoverageIsRed = process.env.MUTATION_NO_COVERAGE_IS_RED === '1'
  const only = (process.env.MUTATION_PACKAGES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  rmSync(REPORT_DIR, { recursive: true, force: true })
  mkdirSync(REPORT_DIR, { recursive: true })

  let planned
  let baseInfo = null
  if (mode === 'changed') {
    baseInfo = resolveBase()
    console.log(`mutation-gate: diff base ${baseInfo.sha.slice(0, 12)} (${baseInfo.how})`)
    planned = planChanged(baseInfo.sha)
  } else {
    planned = planFull()
  }

  let { plan } = planned
  const { skipped } = planned
  if (only.length > 0) plan = plan.filter((p) => only.includes(p.pkg.name))

  for (const s of skipped) console.log(`mutation-gate: skipping ${s}`)

  if (plan.length === 0) {
    const note =
      mode === 'changed'
        ? 'no mutable source lines changed vs the base — nothing to mutate.'
        : 'no packages selected.'
    console.log(`mutation-gate: ${note}`)
    summary(['### Mutation gate', '', `\`${mode}\` — ${note}`])
    return 0
  }

  // Checked HERE, not before the two early-returns above (task-mutation-gate-
  // mechanical, AC1/AC5). Stryker is only actually needed once there is at least
  // one mutant to generate: a docs-only push, or one that only touches excluded
  // paths, must be able to say "nothing to mutate" without requiring Stryker to
  // be installed at all. The pre-push hook (.claude/hooks/pre-bash-mutation-
  // gate.sh) relies on exactly this ordering to distinguish "nothing changed"
  // (fast, infra-independent) from "Stryker missing" (a real, separate SKIP
  // reason) — checking this first would have collapsed both into one message.
  if (!existsSync(STRYKER_BIN)) {
    fail(`StrykerJS is not installed (${STRYKER_BIN} missing). Run pnpm install first.`)
  }

  const startedAt = Date.now()
  const totals = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    ToolFailure: 0,
    NoCoverage: 0,
    Ignored: 0,
    CompileError: 0,
    RuntimeError: 0,
  }
  const allSurvivors = []
  const allToolFailures = []
  const allTimeouts = []
  const allUncovered = []
  const allBadSuppressions = []
  const allSuppressed = []
  const perPackage = []

  for (const { pkg, patterns, files, lines } of plan) {
    const elapsed = Date.now() - startedAt
    const remainingMs = budgetSeconds * 1000 - elapsed
    if (remainingMs <= 0) {
      budgetExceeded(pkg, budgetSeconds, elapsed, perPackage)
    }

    const scope =
      mode === 'changed' ? `${files} file(s), ${lines} changed line(s)` : 'whole package'
    console.log(`\n=== mutation-gate: ${pkg.name} — ${scope} ===`)
    if (mode === 'changed') for (const p of patterns) console.log(`    mutate ${p}`)

    const reportPath = path.join(REPORT_DIR, `${pkg.name.replace(/[^a-z0-9]+/gi, '-')}.report.json`)
    const configFile = writeConfig(pkg, patterns, reportPath, concurrency)
    const pkgStarted = Date.now()
    const res = await runStryker(pkg, configFile, remainingMs)
    const pkgSeconds = ((Date.now() - pkgStarted) / 1000).toFixed(1)

    if (res.timedOut) {
      budgetExceeded(pkg, budgetSeconds, Date.now() - startedAt, perPackage)
    }

    const parsed = readReport(reportPath, pkg)
    if (!parsed) {
      console.error(res.out.split('\n').slice(-40).join('\n'))
      // Stryker refuses to mutate anything when the UNMUTATED suite is already
      // red, and says so in one specific sentence. Worth naming explicitly:
      // otherwise this reads as "the mutation gate is broken" when what actually
      // happened is that a test failed — most likely a flaky one, since the same
      // suite ran green in the `pnpm test` step a few minutes earlier. Sending
      // someone to debug the gate instead of their test costs an afternoon.
      if (res.out.includes('failed tests in the initial test run')) {
        fail(
          `${pkg.name}: the test suite itself is red BEFORE any mutation is applied, so ` +
            `Stryker refused to start (see the failing test named above). This is not a ` +
            `surviving mutant — fix or de-flake that test. Mutation testing re-runs the ` +
            `suite many times, so a timing-sensitive test that passes once and fails once ` +
            `will stop the gate here.`,
        )
      }
      fail(
        `Stryker produced no report for ${pkg.name} (exit ${res.code}). The run did not ` +
          `complete, so nothing was verified. Full output above.`,
      )
    }

    for (const k of Object.keys(totals)) totals[k] += parsed.counts[k] ?? 0
    allSurvivors.push(...parsed.survivors)
    allToolFailures.push(...parsed.toolFailures)
    allTimeouts.push(...parsed.timeouts)
    allUncovered.push(...parsed.uncovered)
    allBadSuppressions.push(...parsed.badSuppressions)
    allSuppressed.push(...parsed.suppressed)
    perPackage.push({ name: pkg.name, seconds: pkgSeconds, counts: parsed.counts, scope })
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const mutantTotal = Object.values(totals).reduce((a, b) => a + b, 0)

  const lines = []
  lines.push(`### Mutation gate — \`${mode}\``)
  lines.push('')
  if (baseInfo) lines.push(`Base: \`${baseInfo.sha.slice(0, 12)}\` (${baseInfo.how})`)
  lines.push(`Budget: ${budgetSeconds}s · used ${totalSeconds}s · ${mutantTotal} mutant(s)`)
  lines.push('')
  // "survived" here is the REAL count (testsCompleted > 0) — a mutant the
  // runner never actually executed is in "tool" instead, never both, so this
  // row and the ToolFailure section below always add up to what Stryker
  // generated (see readReport()'s reclassification, module header "TOOL
  // FAILURE vs a surviving mutant").
  lines.push('| package | scope | killed | survived | tool | no cov | ignored | errors | time |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const p of perPackage) {
    lines.push(
      `| ${p.name} | ${p.scope} | ${formatKilled(
        (p.counts.Killed ?? 0) + (p.counts.Timeout ?? 0),
        p.counts.Timeout ?? 0,
      )} | ` +
        `${p.counts.Survived ?? 0} | ${p.counts.ToolFailure ?? 0} | ${p.counts.NoCoverage ?? 0} | ` +
        `${p.counts.Ignored ?? 0} | ${(p.counts.CompileError ?? 0) + (p.counts.RuntimeError ?? 0)} | ` +
        `${p.seconds}s |`,
    )
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log(
    `mutation-gate: ${mutantTotal} mutant(s) in ${totalSeconds}s — ` +
      `killed ${formatKilled(totals.Killed + totals.Timeout, totals.Timeout)}, ` +
      `survived ${totals.Survived}, ` +
      `tool-failure ${totals.ToolFailure}, no-coverage ${totals.NoCoverage}, ignored ${totals.Ignored}`,
  )

  let exitCode = 0

  // ── tool failures (Survived mutants the runner executed ZERO tests for) ────
  //
  // Printed FIRST, ahead of every other section, and never folded into the
  // Survived list below — see the module header ("TOOL FAILURE vs a surviving
  // mutant") for the mechanism. Loud on purpose: this run verified NOTHING
  // for these mutants, which is worse than an ordinary NoCoverage entry (that
  // one at least means "expected — an integration-only path", see
  // mutation-gate-integration-specs.md); a ToolFailure entry means the gate
  // itself could not do its job on code that DOES have tests. Not red,
  // though — see the "does not block" reasoning in the module header: the
  // defect is in the runner's per-mutant test-file resolution, not in the
  // changed code, and reds belong to the code.
  if (allToolFailures.length > 0) {
    lines.push(
      '',
      `#### ⚠️ ${allToolFailures.length} mutant(s) NOT VERIFIED — the test runner executed ZERO tests for them`,
    )
    lines.push(
      '',
      `This is a TOOL FAILURE, not a code defect and NOT a surviving mutant — Stryker's own ` +
        `report says \`testsCompleted: 0\` for every one of these, meaning the run completed ` +
        `having tried no test at all. "Ran to completion with no failure" is exactly what ` +
        `Stryker calls Survived whether zero tests ran or a hundred did (see ` +
        `@stryker-mutator/api's \`toMutantRunResult()\`); without this split every entry here ` +
        `would read as a real survivor and block on code nobody actually tested. Does **NOT** ` +
        `fail the build — see \`scripts/devops/mutation-gate-runbook.md\` "Tool failure vs a ` +
        `surviving mutant" for the reproduction and the mechanism (believed to be ` +
        `\`vitest.related\` test-file resolution, not fixed here on purpose).`,
    )
    const shownTF = allToolFailures.slice(0, 100)
    if (shownTF.length < allToolFailures.length) {
      console.log(
        `::notice::showing the first ${shownTF.length} of ${allToolFailures.length} tool-failure mutants; the full list is in reports/mutation/*.report.json`,
      )
    }
    console.log('')
    for (const t of shownTF) {
      const replacement = (t.replacement ?? '').replace(/\s+/g, ' ').slice(0, 160)
      const msg =
        `mutant NOT VERIFIED (${t.mutator}) — the test runner executed ZERO tests for it ` +
        `(testsCompleted: 0). This is a TOOL FAILURE, not a passing check and not a surviving ` +
        `mutant; it does not fail the build. Replacement: ${replacement}`
      console.log(`::warning file=${t.where.split(':')[0]},line=${t.where.split(':')[1]}::${msg}`)
      lines.push(`- \`${t.where}\` — **${t.mutator}** → \`${replacement}\``)
    }
    console.log(
      `::warning::${allToolFailures.length} mutant(s) could not be verified — the test runner ` +
        `ran ZERO tests for each of them. NOT failing the build (see ` +
        `mutation-gate-runbook.md), but NOTHING was checked for this code either — read the ` +
        `list above before trusting a clean exit code on this diff.`,
    )
  }

  // ── timeouts (task-mutation-gate-timeout-visibility) ───────────────────────
  //
  // Same treatment as the tool-failure section above, for a DIFFERENT reason:
  // these mutants WERE executed, and Stryker's own convention counts a Timeout
  // as Killed for the exit code (module header, "VERDICT RULES") — that verdict
  // is unchanged here, on purpose. What changed is visibility: before this
  // section (and before formatKilled() above), a Timeout was invisible inside
  // "killed" at both places that print it, so a run where roughly half the
  // "killed" total was actually a timeout read as an ordinary clean pass. See
  // `scripts/devops/mutation-gate-runbook.md` "Zero survivors with timeouts"
  // for why a HIGH timeout count on an otherwise-clean run is itself worth a
  // second look (observed live on this repo: the same code, same commit, gave
  // 7 survivors on a loaded host and 0 on an idle one).
  if (allTimeouts.length > 0) {
    lines.push(
      '',
      `#### ⏱ ${allTimeouts.length} mutant(s) TIMED OUT — counted as killed by Stryker's own convention`,
    )
    lines.push(
      '',
      `Stryker treats Timeout the same as Killed for the exit code (module header, "VERDICT ` +
        `RULES") — a mutant that made the suite hang, or simply run long enough to trip ` +
        `\`timeoutMS\`/\`timeoutFactor\`, is not told apart from one an assertion actually caught. ` +
        `\`timeoutMS\` is deliberately generous rather than tight for exactly this reason: a TIGHT ` +
        `timeout would turn real survivors into a false green. This section does **NOT** fail the ` +
        `build and does not change the verdict — it exists so a clean exit code is not mistaken for ` +
        `"every one of these mutants was actually caught by an assertion". A large count here on an ` +
        `otherwise-clean run is a reason to re-run on an idle machine before trusting it — see ` +
        `\`scripts/devops/mutation-gate-runbook.md\` "Zero survivors with timeouts".`,
    )
    const shownTO = allTimeouts.slice(0, 100)
    if (shownTO.length < allTimeouts.length) {
      console.log(
        `::notice::showing the first ${shownTO.length} of ${allTimeouts.length} timeout mutants; the full list is in reports/mutation/*.report.json`,
      )
    }
    console.log('')
    for (const t of shownTO) {
      const replacement = (t.replacement ?? '').replace(/\s+/g, ' ').slice(0, 160)
      const msg =
        `mutant TIMED OUT (${t.mutator}) — counted as killed by Stryker's own convention, not ` +
        `caught by a failing assertion. Replacement: ${replacement}`
      console.log(`::notice file=${t.where.split(':')[0]},line=${t.where.split(':')[1]}::${msg}`)
      lines.push(`- \`${t.where}\` — **${t.mutator}** → \`${replacement}\``)
    }
    console.log(
      `::notice::${allTimeouts.length} mutant(s) timed out and were counted as killed. Not failing ` +
        `the build — but a notable count here, especially alongside zero survivors, is a reason to ` +
        `re-run on an idle machine before trusting the pass (mutation-gate-runbook.md "Zero ` +
        `survivors with timeouts").`,
    )
  }

  if (allBadSuppressions.length > 0) {
    exitCode = 1
    lines.push('', '#### Suppressions without a reason')
    console.log('')
    for (const s of allBadSuppressions) {
      const msg =
        `suppressed mutant without a usable reason at ${s.where} (${s.mutator}): ` +
        `"${s.reason}". Write it as ` +
        `\`// Stryker disable next-line ${s.mutator}: <why this mutant cannot be killed>\`.`
      console.log(`::error file=${s.where.split(':')[0]},line=${s.where.split(':')[1]}::${msg}`)
      lines.push(`- \`${s.where}\` — ${s.mutator}: "${s.reason}"`)
    }
  }

  // ── suppression counts (task-mutation-gate-mechanical AC2) ─────────────────
  //
  // Printed for EVERY suppression, not only the reasonless ones above: a
  // directive with a written reason can still be silencing more mutants than
  // its author looked at. The count comes from groupSuppressions(), which reads
  // it back out of Stryker's own report — see that function's header for the
  // three times this went wrong when the number lived only in someone's head.
  if (allSuppressed.length > 0) {
    const groups = groupSuppressions(allSuppressed)
    const multi = groups.filter((g) => g.count > 1)
    lines.push(
      '',
      `#### Suppressed (${groups.length} directive(s), ${allSuppressed.length} mutant(s) total)`,
    )
    console.log('')
    for (const g of groups) {
      const flag = g.count > 1 ? ' — COVERS MORE THAN ONE MUTANT, verify each is intended' : ''
      const line = `suppression at ${g.where} (${g.mutator}) silences ${g.count} mutant(s)${flag}`
      console.log(g.count > 1 ? `::warning::${line}` : `mutation-gate: ${line}`)
      lines.push(
        `- \`${g.where}\` — **${g.mutator}**: ${g.count} mutant(s)${
          g.count > 1 ? ' **(more than one — check each)**' : ''
        }`,
      )
    }
    if (multi.length > 0) {
      console.log(
        `::warning::${multi.length} suppression directive(s) cover MORE THAN ONE mutant each. ` +
          `A single "// Stryker disable next-line <mutator>" silences EVERY mutant that mutator ` +
          `produces on that line, not just the one you were looking at. This has under-counted ` +
          `by a factor of 4-8x on this repo before (see groupSuppressions() in mutation-gate.mjs) ` +
          `— the number above is read from Stryker's report, not reasoned about.`,
      )
    }
  }

  // ── NoCoverage vs Survived (task-mutation-gate-mechanical AC3) ─────────────
  //
  // These are different diagnoses and conflating them is expensive (backlog
  // #104): Survived means a test DID run the mutated line and still passed —
  // the suite executed the code and noticed nothing. NoCoverage means no test
  // ran the line AT ALL, which is the more serious of the two in general: zero
  // verification happened, not "verification that missed something". It is not
  // automatically a gap here, though — this gate only ever runs the UNIT suite,
  // and vitest.config.mts structurally excludes every `*.integration.spec.ts`
  // from a non-integration run (see
  // .claude/rules/common/mutation-gate-integration-specs.md). A NoCoverage
  // entry in a file that is ALSO referenced by an integration spec is expected,
  // not a hole — PR #564 spent a full turn re-deriving exactly this by hand
  // for 8 entries that turned out to be exactly that case.
  if (allUncovered.length > 0) {
    const { likely, real } = splitUncoveredByIntegrationHint(allUncovered)
    lines.push('', `#### No coverage (${allUncovered.length})`)
    lines.push(
      '',
      `NoCoverage means the line was never EXECUTED by the unit suite this gate runs — ` +
        `by itself a MORE serious diagnosis than Survived (Survived = a test ran the line and ` +
        `still missed the change; NoCoverage = no test ran it at all). Not automatically a gap: ` +
        `${likely.length} of these also appear in a \`*.integration.spec.ts\` (heuristic — a ` +
        `filename match, not a proof) and are commonly EXPECTED, because this gate cannot execute ` +
        `the integration suite (see mutation-gate-integration-specs.md). The other ${real.length} ` +
        `do not match that heuristic and are the ones worth checking first.`,
    )
    if (real.length > 0) {
      lines.push('', `##### No integration-spec hint (${real.length}) — check these first`)
      for (const u of real.slice(0, 50)) lines.push(`- \`${u.where}\` — ${u.mutator}`)
    }
    if (likely.length > 0) {
      lines.push(
        '',
        `##### Filename also seen in an integration spec (${likely.length}) — likely expected, verify before treating as a gap`,
      )
      for (const u of likely.slice(0, 50)) lines.push(`- \`${u.where}\` — ${u.mutator}`)
    }
    const msg =
      `${allUncovered.length} mutant(s) in changed code are not executed by any test ` +
      `(${real.length} with no integration-spec hint, ${likely.length} likely covered only by ` +
      `an integration spec — see .claude/rules/common/mutation-gate-integration-specs.md). ` +
      `Not failing the build: a coverage threshold on changed lines is a separate task ` +
      `(task-mutation-gate "Границы"). Set MUTATION_NO_COVERAGE_IS_RED=1 to make it red.`
    console.log(noCoverageIsRed ? `::error::${msg}` : `::warning::${msg}`)
    if (noCoverageIsRed) exitCode = 1
  }

  if (allSurvivors.length > survivorBudget) {
    exitCode = 1
    lines.push('', `#### Survived (${allSurvivors.length})`)
    console.log('')
    // GitHub only renders the first handful of annotations anyway; the cap keeps
    // a nightly full run from writing thousands of ::error:: lines into the log.
    const shown = allSurvivors.slice(0, 100)
    if (shown.length < allSurvivors.length) {
      console.log(
        `::notice::showing the first ${shown.length} of ${allSurvivors.length} survivors; the full list is in reports/mutation/*.report.json`,
      )
    }
    for (const s of shown) {
      const [file, line] = [s.where.slice(0, s.where.lastIndexOf(':')), s.where.split(':').pop()]
      const replacement = (s.replacement ?? '').replace(/\s+/g, ' ').slice(0, 160)
      const msg =
        `mutant SURVIVED (${s.mutator}) — the tests pass with this change applied: ` +
        `${replacement}`
      console.log(`::error file=${file},line=${line}::${msg}`)
    }
    for (const s of allSurvivors) {
      const replacement = (s.replacement ?? '').replace(/\s+/g, ' ').slice(0, 160)
      lines.push(`- \`${s.where}\` — **${s.mutator}** → \`${replacement}\``)
    }
    console.log(
      `::error::${allSurvivors.length} surviving mutant(s) in changed code (budget ${survivorBudget}). ` +
        `Each one is a change to your code that every test still accepts. Either add an ` +
        `assertion that fails on it, or — if it genuinely cannot be observed — suppress it ` +
        `WITH a written reason: // Stryker disable next-line <mutator>: <why>`,
    )
  } else if (allSurvivors.length > 0) {
    lines.push('', `#### Survived (${allSurvivors.length}, within budget ${survivorBudget})`)
    for (const s of allSurvivors.slice(0, 200)) lines.push(`- \`${s.where}\` — ${s.mutator}`)
  }

  if (exitCode === 0) console.log('mutation-gate: PASS')
  summary(lines)
  return exitCode
}

function budgetExceeded(pkg, budgetSeconds, elapsedMs, perPackage) {
  const done = perPackage.map((p) => `${p.name} (${p.seconds}s)`).join(', ') || 'none'
  summary([
    '### Mutation gate — BUDGET EXCEEDED',
    '',
    `Budget ${budgetSeconds}s exhausted after ${(elapsedMs / 1000).toFixed(1)}s while mutating \`${pkg.name}\`.`,
    `Completed before the cut-off: ${done}.`,
  ])
  fail(
    `time budget of ${budgetSeconds}s exhausted after ${(elapsedMs / 1000).toFixed(1)}s while ` +
      `mutating ${pkg.name}. Completed before the cut-off: ${done}. NOTHING was verified for ` +
      `the remaining packages — this is red on purpose rather than a silent skip. Either cut ` +
      `the diff, or raise MUTATION_BUDGET_SECONDS in the workflow with a reason.`,
  )
}

// Guarded so scripts/devops/tests/test-mutation-gate-reporting.sh can `import`
// groupSuppressions() / looksIntegrationOnly() / splitUncoveredByIntegrationHint()
// (task-mutation-gate-mechanical AC2/AC3/AC6) / formatKilled() (task-mutation-
// gate-timeout-visibility) without triggering a real Stryker run —
// `node mutation-gate.mjs --changed` is unaffected, since argv[1] there IS this
// file.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => fail(`unexpected failure: ${err?.stack ?? err}`),
  )
}

export {
  groupSuppressions,
  looksIntegrationOnly,
  splitUncoveredByIntegrationHint,
  readReport,
  formatKilled,
}
