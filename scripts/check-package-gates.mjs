#!/usr/bin/env node
/**
 * check-package-gates — fail the build if a workspace package can skip the gates.
 *
 * WHY (task-lint-teeth, 2026-08-08): `packages/shared` and `apps/e2e` had no
 * `lint` script, and `apps/e2e` had no `typecheck` either. `turbo lint` and
 * `turbo typecheck` do not treat a missing script as an error — they just skip
 * that package, silently, with a green exit code. So the single source of truth
 * for every Zod schema shared between the frontend and the backend, and all 110
 * Playwright specs, were checked by nothing at all. Nobody noticed for months
 * because every gate stayed green the whole time.
 *
 * Nothing stops that recurring the next time a package is added — hence this
 * check. It asserts a property of the WORKSPACE, not of any one package: every
 * package that pnpm-workspace.yaml pulls in must declare both `lint` and
 * `typecheck`.
 *
 * ── Self-verification ──────────────────────────────────────────────────────
 * This script checks itself before it checks the repo. On every run it first
 * points its own detector at `__fixtures__/package-gates/`, which contains
 * deliberately broken packages, and confirms it still reports exactly those.
 * Only then does it look at the real workspace.
 *
 * That is not ceremony. A guard whose only evidence is "the current tree is
 * clean" proves nothing — it passes identically whether it works or has rotted
 * into a no-op (a typo'd glob, a renamed field, a refactor that returns early).
 * That failure mode is the exact disease this script was written to prevent, so
 * the script must not be vulnerable to it. If the self-check stops detecting the
 * broken fixtures, this exits non-zero and says so, rather than reporting a
 * clean workspace it never actually examined.
 *
 * Usage:
 *   node scripts/check-package-gates.mjs             # self-check, then the repo
 *   node scripts/check-package-gates.mjs --demo-failure
 *       # run the detector against the broken fixtures and REPORT them as if
 *       # they were the real workspace — i.e. show the red output this gate
 *       # produces, without having to break a real package to see it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_SCRIPTS = ['lint', 'typecheck']

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const fixturesRoot = join(here, '__fixtures__', 'package-gates')

// ── Core detector ───────────────────────────────────────────────────────────

/**
 * Read pnpm-workspace.yaml and return its package globs.
 *
 * Deliberately NOT tolerant: an unreadable file or a shape this parser does not
 * understand throws. Returning an empty list instead would make every later
 * check pass while examining zero packages — a green run that verified nothing,
 * which is the failure this whole script exists to prevent.
 */
function readWorkspaceGlobs(root) {
  const file = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(file)) {
    throw new Error(`pnpm-workspace.yaml not found at ${file}`)
  }
  const globs = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/))
    .filter(Boolean)
    .map((m) => m[1])

  if (globs.length === 0) {
    throw new Error(
      `Parsed 0 package globs from ${file}. Either the file changed shape or this ` +
        `parser is broken — refusing to report a clean workspace on the strength of ` +
        `a glob list that would match nothing.`,
    )
  }
  return globs
}

/** Expand the small subset of glob syntax pnpm-workspace.yaml actually uses. */
function expandGlob(root, glob) {
  if (!glob.endsWith('/*')) {
    const dir = join(root, glob)
    return existsSync(dir) && statSync(dir).isDirectory() ? [dir] : []
  }
  const parent = join(root, glob.slice(0, -2))
  if (!existsSync(parent)) return []
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(parent, e.name))
}

/**
 * @returns {Array<{ dir: string, name: string, missing: string[] }>}
 *   One entry per package missing at least one required script.
 */
export function findUnguardedPackages(root, globs = readWorkspaceGlobs(root)) {
  const offenders = []

  for (const glob of globs) {
    for (const dir of expandGlob(root, glob)) {
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue

      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const scripts = pkg.scripts ?? {}
      const missing = REQUIRED_SCRIPTS.filter(
        (name) => typeof scripts[name] !== 'string' || scripts[name].trim() === '',
      )

      if (missing.length > 0) {
        offenders.push({ dir: relative(root, dir), name: pkg.name ?? relative(root, dir), missing })
      }
    }
  }

  return offenders.sort((a, b) => a.dir.localeCompare(b.dir))
}

// ── Reporting ───────────────────────────────────────────────────────────────

function report(offenders, { scope }) {
  console.error(`\n[31m✖ ${offenders.length} package(s) can skip the gates[39m (${scope})\n`)
  for (const { name, dir, missing } of offenders) {
    console.error(`  ${name}  (${dir})`)
    for (const script of missing) {
      console.error(`      missing "${script}" script`)
    }
  }
  console.error(
    [
      '',
      'Every workspace package must declare BOTH scripts. `turbo lint` and',
      '`turbo typecheck` SKIP a package that does not have them — silently, and',
      'with a green exit code — so a package without them is not "unchecked for',
      'now", it is invisible to every gate we have.',
      '',
      "Add to the package's package.json:",
      '    "lint": "eslint <src-dir>",',
      '    "typecheck": "tsc --noEmit"',
      '',
      "and give it an eslint.config.mjs (copy the closest sibling package's).",
      '',
    ].join('\n'),
  )
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Prove the detector still detects. Returns nothing; throws if it has rotted.
 */
function selfCheck() {
  const expected = ['missing-both', 'missing-lint', 'missing-typecheck']
  const found = findUnguardedPackages(fixturesRoot, ['packages/*'])
  const foundNames = found.map((o) => o.dir.replace(/^packages\//, '')).sort()

  if (JSON.stringify(foundNames) !== JSON.stringify(expected)) {
    throw new Error(
      `Self-check FAILED: the detector was pointed at deliberately broken fixture ` +
        `packages and did not report them correctly.\n` +
        `  expected offenders: ${expected.join(', ')}\n` +
        `  actually reported:  ${foundNames.join(', ') || '(none)'}\n\n` +
        `This means the check itself is broken, so a clean result on the real ` +
        `workspace would be meaningless. Fix the detector before trusting any run.`,
    )
  }

  // The compliant fixture must NOT be reported — a detector that flags
  // everything is as useless as one that flags nothing.
  if (foundNames.includes('ok')) {
    throw new Error('Self-check FAILED: the detector flagged the compliant fixture package.')
  }
}

function main() {
  const demoFailure = process.argv.includes('--demo-failure')

  try {
    selfCheck()
  } catch (err) {
    console.error(`\n[31m✖ check-package-gates self-check failed[39m\n`)
    console.error(err instanceof Error ? err.message : String(err))
    console.error('')
    process.exit(2)
  }

  if (demoFailure) {
    // Show what a violation looks like, using the fixtures as the "workspace".
    const offenders = findUnguardedPackages(fixturesRoot, ['packages/*'])
    report(offenders, { scope: 'fixture workspace — scripts/__fixtures__/package-gates' })
    console.error('(--demo-failure: this is the intended red output, not a real repo problem)\n')
    process.exit(1)
  }

  const offenders = findUnguardedPackages(repoRoot)
  if (offenders.length > 0) {
    report(offenders, { scope: 'this workspace' })
    process.exit(1)
  }

  console.log('✔ every workspace package declares both `lint` and `typecheck`')
}

// Only run when executed directly, so the detector stays importable/testable.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
