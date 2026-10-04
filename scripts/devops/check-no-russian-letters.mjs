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

if (violations.length > 0) {
  console.error(`Russian-only letters (ы э ъ ё) found in ${violations.length} place(s):`)
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    '\nProduct text must be Ukrainian/English via the i18n catalogs. Russian is allowed in comments only.',
  )
  if (!report) process.exit(1)
  console.error('(--report: not failing)')
} else {
  console.log(
    `OK, 0 Russian-letter literals (${tsFiles} api .ts files, ${catalogs} catalogs scanned)`,
  )
}
