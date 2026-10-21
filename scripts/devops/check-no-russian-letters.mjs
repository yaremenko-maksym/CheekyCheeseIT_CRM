#!/usr/bin/env node
/**
 * check-no-russian-letters.mjs — mechanical backstop against Russian text
 * regressing into apps/api string literals and the uk/en i18n catalogs
 * (i18n stage-6B, Wave 6).
 *
 * WHY THIS EXISTS
 * ----------------
 * Lingui's `no-unlocalized-strings` covers only apps/web + packages/shared.
 * apps/api was cleaned of Russian by hand in waves 1-5 and had no automatic
 * guard, so the first new Russian error message would have gone in unnoticed.
 * The letters ы Ы э Э ъ Ъ ё Ё exist in Russian but NOT in Ukrainian, so their
 * presence in a product string (or in the uk/en catalogs) is a reliable signal
 * of Russian — e.g. the "зарплаты" incident would be caught instantly.
 *
 * CODEPOINT-AWARE, NOT BYTE-GREP (the point of this file being .mjs)
 * ------------------------------------------------------------------
 * Do NOT port this to `grep '[ыэъё]'` in bash. Without a UTF-8 locale grep
 * matches BYTES, and the lead byte 0xD1 of many Ukrainian letters equals that
 * of ы/ъ/ё, so "обліковий", "Команда", "Київ" light up as false positives
 * (verified). Here the regex runs with the `u` flag on decoded JS strings.
 *
 * COMMENT-PROOF BY CONSTRUCTION
 * ------------------------------
 * .ts files are parsed with the TypeScript compiler and only string-literal
 * nodes (StringLiteral, NoSubstitutionTemplateLiteral, template head/middle/
 * tail) are inspected. Comments are not nodes of those kinds, so Russian
 * comments stay legal. .po catalogs are data, scanned line by line (comment
 * lines starting with `#` — source references — are skipped).
 *
 * TWO SCANS, TWO DETECTORS (the second added 2026-10-21, backlog 259)
 * ---------------------------------------------------------------------
 *   1. the PRODUCT: apps/api/src string literals + the uk/en catalogs, matching
 *      ы э ъ ё only — because the product legitimately ships Ukrainian.
 *   2. `.claude/hooks/**`, matching ANY Cyrillic, comments included — because
 *      everything an agent reads is English
 *      (.claude/rules/common/russian-language.md).
 *
 * The second scan exists because nothing scanned the hooks at all, which is how
 * Russian refusal text got there and stayed. The detector had to differ rather
 * than the path list simply being widened: measured first, the product detector
 * saw only 140 of the 258 Cyrillic lines there (54%), so reusing it would have
 * reported OK while letting nearly half the Russian back in.
 *
 * AGENT_EXCEPTIONS below is a ratchet for the hooks not yet converted; it fails
 * when an excepted file becomes clean, so it cannot outlive its reason.
 *
 * EXCLUDED apps/api/src paths (unmigrated / data-by-design, handled separately)
 * -----------------------------------------------------------------------------
 * contracts/, contact/, resumes/, job-sourcing/, assets/, test/,
 * database/seed* (files) , database/seed-templates/, database/seed-fixtures/,
 * and every *.spec.ts (incl. *.integration.spec.ts).
 *
 * USAGE
 * -----
 *   node scripts/devops/check-no-russian-letters.mjs            # strict: exit 1 on any hit (CI)
 *   node scripts/devops/check-no-russian-letters.mjs --report   # print hits, always exit 0
 *   node scripts/devops/check-no-russian-letters.mjs --root <dir>   # scan another tree (guard test)
 *
 * `typescript` is resolved from the repo that holds this script, never from
 * `--root`, so the guard test can point --root at a fabricated tree.
 */
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUSSIAN_ONLY = /[ыэъёЫЭЪЁ]/u

/**
 * A SECOND SCAN WITH A DIFFERENT DETECTOR, AND THE DIFFERENCE IS THE POINT.
 *
 * The product scan above looks for ы э ъ ё only, because the product legitimately
 * ships Ukrainian and full-Cyrillic matching would be a false positive on every
 * "Київ". For `.claude/**` the policy is different and stricter: everything an
 * agent reads or writes is English (.claude/rules/common/russian-language.md),
 * so NO Cyrillic belongs there at all — including in comments, which the product
 * scan deliberately permits.
 *
 * Measured before choosing: of the 258 Cyrillic lines under .claude/hooks, the
 * product detector saw only 140 — 54%. Reusing it here would have let 46% of the
 * Russian back in while reporting success, so the path list could not simply be
 * widened; the rule had to be a second one.
 */
// U+0400–04FF is Cyrillic, U+0500–052F Cyrillic Supplement, U+2DE0–2DFF and
// U+A640–A69F the two Extended-A/B blocks. The first version stopped at 04FF and
// so missed the supplement — cheap to get right, and a detector that covers
// "most" of an alphabet is the kind of near-miss this whole guard exists to catch.
const ANY_CYRILLIC = /[Ѐ-ԯⷠ-ⷿꙀ-ꚟ]/u

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const report = args.includes('--report')
const rootIdx = args.indexOf('--root')
const ROOT = resolve(rootIdx !== -1 ? args[rootIdx + 1] : join(SELF_DIR, '..', '..'))

const require = createRequire(join(SELF_DIR, '..', '..', 'package.json'))
const ts = require('typescript')

const API_SRC = join(ROOT, 'apps', 'api', 'src')
const CATALOGS = ['uk', 'en'].map((l) =>
  join(ROOT, 'packages', 'shared', 'src', 'i18n', 'locales', l, 'messages.po'),
)

const EXCLUDED_DIRS = new Set(['contracts', 'contact', 'resumes', 'job-sourcing', 'assets', 'test'])

const AGENT_ROOT = join(ROOT, '.claude', 'hooks')

/**
 * Hooks not yet converted to English: file -> the EXACT number of Cyrillic lines
 * it is still allowed to have. A RATCHET, not a carve-out.
 *
 * Why the list exists: the conversion that widened this guard covered the three
 * `pre:bash:*` launcher/safety hooks and `lib/cmdscan.py` (85 refusal-text lines).
 * The other eight files hold 172 more, and converting all eleven in one PR would
 * have buried a security-surface text change under three times its own volume.
 * Without the list the guard could not be turned on at all, which is the state
 * that let Russian in here in the first place — nothing scanned these files.
 *
 * WHY A COUNT AND NOT A NAME (CR-M-1). The first version was a Set, which
 * constrained the LIST but not the CONTENTS: three Russian lines added to an
 * already-excepted hook and the guard printed OK — most of the risk the list
 * exists to bound. A number means a file on this list may only ever shrink.
 *
 * It ratchets in THREE directions, and the count is checked for EQUALITY so none
 * of them can be silent:
 *   - grew   -> red. The exemption is a ceiling, not a licence.
 *   - shrank -> red, asking for the number to be lowered. Bookkeeping, yes, but
 *               an un-lowered ceiling is an exemption nobody is using and nobody
 *               notices, which is how the old Set rotted.
 *   - gone   -> red (see `agentStrict`): a deleted or renamed file leaves its
 *               entry standing, and a recreated file of the same name would
 *               INHERIT the exemption.
 * A NEW hook is not on the list at all, so it is covered from its first line.
 *
 * Closing condition: this map is empty and this comment goes with it.
 */
const AGENT_EXCEPTIONS = new Map([
  ['pre-agent-dispatch-isolation.sh', 29],
  ['pre-bash-coder-push-gate.sh', 12],
  ['pre-bash-cross-agent-blast.sh', 62],
  ['pre-bash-mutation-gate.sh', 2],
  ['pre-bash-prettier-gate.sh', 18],
  ['pre-bash-unbounded-wait.sh', 32],
  ['pre-edit-write-zone-of-write.sh', 14],
  ['tests/cross-agent-hooks-smoke.sh', 3],
])

/**
 * Whether to report an AGENT_EXCEPTIONS entry whose file is absent.
 *
 * On by default, off under `--root`, because `--root` points at FABRICATED trees
 * (that is how this guard is tested) where absence is normal and reporting it
 * would make every test case red. `--agent-strict` forces it on so the check
 * itself can be tested — without that, "gone -> red" would be another promise
 * with no test behind it.
 */
const agentStrict = rootIdx === -1 || args.includes('--agent-strict')

/** @param {string} relPath path relative to apps/api/src, '/'-separated */
function isExcluded(relPath) {
  const parts = relPath.split('/')
  if (EXCLUDED_DIRS.has(parts[0])) return true
  if (parts[0] === 'database') {
    const next = parts[1] ?? ''
    if (next.startsWith('seed')) return true // seed*.ts files, seed-templates/, seed-fixtures/
  }
  const file = parts[parts.length - 1]
  return file.endsWith('.spec.ts')
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

/** Every file under .claude/hooks, whatever its extension — these are shell and
 *  python, so there is no AST step and no comment exemption. */
function* walkAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkAll(full)
    else if (entry.isFile() && !entry.name.endsWith('.pyc') && entry.name !== '.gitignore')
      yield full
  }
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
])

const violations = []
const snippet = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s).replace(/\s+/g, ' ')

let tsFiles = 0
if (existsSync(API_SRC)) {
  for (const file of walk(API_SRC)) {
    const rel = relative(API_SRC, file).split(sep).join('/')
    if (isExcluded(rel)) continue
    tsFiles += 1
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (LITERAL_KINDS.has(node.kind) && RUSSIAN_ONLY.test(node.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        violations.push(`${relative(ROOT, file)}:${line + 1}: ${snippet(node.text)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
} else {
  console.error(`WARN: ${API_SRC} not found - apps/api not scanned`)
}

let catalogs = 0
for (const po of CATALOGS) {
  if (!existsSync(po)) continue
  catalogs += 1
  readFileSync(po, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (text.startsWith('#')) return // references / translator comments
      if (RUSSIAN_ONLY.test(text))
        violations.push(`${relative(ROOT, po)}:${i + 1}: ${snippet(text)}`)
    })
}

// ── .claude/hooks: no Cyrillic at all, comments included ─────────────────────
const agentViolations = []
const staleExceptions = []
let agentFiles = 0
if (existsSync(AGENT_ROOT)) {
  const seen = new Set()
  for (const file of walkAll(AGENT_ROOT)) {
    const rel = relative(AGENT_ROOT, file).split(sep).join('/')
    const lines = readFileSync(file, 'utf8').split('\n')
    const hits = []
    lines.forEach((text, i) => {
      if (ANY_CYRILLIC.test(text)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${snippet(text)}`)
    })
    if (AGENT_EXCEPTIONS.has(rel)) {
      seen.add(rel)
      const allowed = AGENT_EXCEPTIONS.get(rel)
      if (hits.length > allowed)
        staleExceptions.push(
          `${rel}: ${hits.length} Cyrillic lines, but only ${allowed} are allowed — an` +
            ` excepted file may only SHRINK. Convert the new lines, do not raise the number.`,
        )
      else if (hits.length < allowed)
        staleExceptions.push(
          `${rel}: ${hits.length} Cyrillic lines, ceiling still ${allowed} — lower the` +
            ` number in AGENT_EXCEPTIONS (0 means delete the entry).`,
        )
      continue
    }
    agentFiles += 1
    agentViolations.push(...hits)
  }
  if (agentStrict)
    for (const rel of AGENT_EXCEPTIONS.keys())
      if (!seen.has(rel))
        staleExceptions.push(
          `${rel}: no such file — delete the entry. A recreated file of this name would` +
            ` otherwise inherit the exemption.`,
        )
} else {
  console.error(`WARN: ${AGENT_ROOT} not found - .claude/hooks not scanned`)
}

if (agentViolations.length > 0) {
  console.error(`Cyrillic found in .claude/hooks in ${agentViolations.length} place(s):`)
  for (const v of agentViolations) console.error(`  ${v}`)
  console.error(
    '\nFiles under .claude/hooks are English, comments included' +
      ' (.claude/rules/common/russian-language.md). Russian lives only in the owner chat.' +
      '\n(This scan covers .claude/hooks only — the rest of .claude/** is policy, not yet gated.)',
  )
}
if (staleExceptions.length > 0) {
  console.error(`AGENT_EXCEPTIONS is stale in ${staleExceptions.length} place(s):`)
  for (const v of staleExceptions) console.error(`  ${v}`)
  console.error('\nEach line says what to change. An exemption may only ever shrink.')
}
const agentFailed = agentViolations.length > 0 || staleExceptions.length > 0

if (violations.length > 0) {
  console.error(`Russian-only letters (ы э ъ ё) found in ${violations.length} place(s):`)
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    '\nProduct text must be Ukrainian/English via the i18n catalogs. Russian is allowed in comments only.',
  )
  if (!report) process.exit(1)
  console.error('(--report: not failing)')
} else if (agentFailed) {
  if (!report) process.exit(1)
  console.error('(--report: not failing)')
} else {
  console.log(
    `OK, 0 Russian-letter literals (${tsFiles} api .ts files, ${catalogs} catalogs,` +
      ` ${agentFiles} .claude/hooks files scanned; ${AGENT_EXCEPTIONS.size} hooks still excepted)`,
  )
}
