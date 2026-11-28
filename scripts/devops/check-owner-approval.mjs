#!/usr/bin/env node
// check-owner-approval.mjs — the owner-approval step of the Flow Gate job (.github/workflows/flow-gate.yml).
//
// WHY: CODEOWNERS opens some zones (apps/web, apps/landing, apps/e2e, docs) so a manager can merge
// there without the owner. CODEOWNERS restricts files, not behaviour: code merged in an open zone
// that reaches the database, a finance table / service, or adds an HTTP controller runs in prod with
// full DB access. This check fails such a PR unless the owner approved it (design §7, the manager
// role; plan PR 11 AC 2).
//
// WHAT "UNOWNED" MEANS: a changed file whose LAST matching CODEOWNERS line has no owner — read from
// the base branch's .github/CODEOWNERS, so the open list has one source. Re-protected files already
// need the owner's review through CODEOWNERS and are not scanned.
//
// WHAT TRIPS IT, per unowned changed file — the FULL head content (fetched through the REST API as
// data, never checked out), so a multi-line import or an import the diff did not touch still counts:
//   db-client     — a specifier naming a DB driver / ORM (pg, postgres, drizzle-orm, ...) or a `database` module
//   api-source    — a specifier reaching into the API (`apps/api/`, `api/src/`, `@crm/api`)
//   finance       — a specifier naming a finance service / repository (finance word + `.service` / `.repository`)
//   Relative specifiers are resolved against the file's directory first (`../../api/src/x` from
//   `apps/web/a/b.ts` is `apps/api/src/x`), and both forms are matched.
//   dynamic-specifier — `import(` / `require(` whose argument is not a plain string literal
//   dep-alias     — `npm:` / `workspace:` aliases or JSON dependency keys naming @crm/api or a DB package
//   controller    — a new `*.controller.*` file, or a `@Controller(` decorator
//   moved-from-owned — a rename / copy whose source path is owned (moving protected code into an open zone)
//   uninspectable — an inspected file whose content could not be fetched: fail closed
//
// WHAT "APPROVED" MEANS: the owner's latest decisive review (APPROVED / CHANGES_REQUESTED) on the
// PR's head commit is APPROVED. A label is not used: any write-role user can set one, and
// `auto-merge-on-label.yml` does not check who set `merge-approved`. A review is bound to a login
// and to a commit (`commit_id`), so a later push invalidates it. Reviews re-run the Flow Gate
// through flow-gate-recheck.yml.
//
// Fail closed: a file list shorter than the PR's `changed_files`, a missing content, or a
// CODEOWNERS line in a shape this matcher does not model, is a failure, never a pass.
//
// Usage:
//   node check-owner-approval.mjs --codeowners <path> --files <files.json> --fetch-plan
//       # prints, one per line, the unowned files whose head content must be fetched
//   node check-owner-approval.mjs --codeowners <path> --pr <pr-data.json> --files <files.json> \
//       --contents <contents.json> --owner <login> [--summary <path>]
//   node check-owner-approval.mjs --codeowners <path> --owner-of <path>     # owners or "(unowned)"
//   node check-owner-approval.mjs --codeowners <path> --check-paths <repo>  # every pattern names a path
// pr-data.json:  {headSha, counts: {changedFiles}, reviews: [{author, state, commit_id}]} (Flow Gate's file)
// files.json:    [{filename, previous_filename, status}] (REST pulls/{n}/files)
// contents.json: [{filename, content} | {filename, unavailable: true}]
// Exit: 0 pass, 1 refused, 2 usage / input error.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── CODEOWNERS (subset of the gitignore syntax GitHub uses) ──────────────────────────────────
export function parseCodeowners(text) {
  const rules = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [pattern, ...owners] = line.split(/\s+/)
    rules.push({ ...compilePattern(pattern, i + 1), owners })
  })
  return rules
}

function compilePattern(pattern, lineNo) {
  if (pattern === '*') return { pattern, kind: 'all' }
  const bad = () => {
    throw new Error(
      `CODEOWNERS line ${lineNo}: pattern "${pattern}" is outside the supported shapes (*, a/b/, a/b/**, a/b/c.ext, **/name, **/na*me)`,
    )
  }
  if (/[?[\]!\\]/.test(pattern)) bad()
  // `**/<basename>` — that basename at any depth; `*` inside it matches within one segment.
  if (pattern.startsWith('**/')) {
    const base = pattern.slice(3)
    if (!base || base.includes('/')) bad()
    const re = new RegExp(`^${base.split('*').map(escapeRe).join('[^/]*')}$`)
    return { pattern, kind: 'basename', re }
  }
  const p = pattern.replace(/^\//, '')
  if (!p.includes('/')) bad()
  if (p.endsWith('/**')) {
    const dir = p.slice(0, -2)
    if (dir.includes('*')) bad()
    return { pattern, kind: 'dir', dir }
  }
  if (p.includes('*')) bad()
  if (p.endsWith('/')) return { pattern, kind: 'dir', dir: p }
  return { pattern, kind: 'file', file: p }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matches(rule, path) {
  switch (rule.kind) {
    case 'all':
      return true
    case 'dir':
      return path.startsWith(rule.dir)
    case 'file':
      return path === rule.file
    case 'basename':
      return rule.re.test(posix.basename(path))
  }
  return false
}

export function ownersOf(rules, path) {
  let owners = null
  for (const r of rules) if (matches(r, path)) owners = r.owners
  return owners ?? []
}

// ── detection ────────────────────────────────────────────────────────────────────────────
const CODE_FILE = /\.(c|m)?[jt]sx?$/
// Text files whose content can wire a dependency or a module alias.
const INSPECT_FILE = /(\.(c|m)?[jt]sx?|\.jsonc?|\.ya?ml|\.toml|\/\.npmrc|^\.npmrc)$/
const DB_PKG =
  '(?:pg|pg-pool|postgres|drizzle-orm|drizzle-kit|@neondatabase\\/serverless|kysely|knex|typeorm|@prisma\\/client|mysql2|better-sqlite3|sqlite3)'
const DB_CLIENT = new RegExp(`^${DB_PKG}(\\/|$)|(^|\\/)database(\\/|\\.|$)`)
const API_SOURCE = /(^|\/)apps\/api(\/|$)|(^|\/)api\/src(\/|$)|^@crm\/api(\/|$)/
const FINANCE =
  /(financ|transaction|payout|company-account|wallet|salary|ledger|requisite|invoice|dividend)/i
const SERVICE = /\.(service|repository)(\.[cm]?[jt]s)?$/
const CONTROLLER_FILE = /\.controller\.(c|m)?[jt]sx?$/
const CONTROLLER_DECORATOR = /@Controller\s*\(/g
// `from 'x'`, `import 'x'`, `import('x')`, `require('x')`, `export * from 'x'`; whitespace may span lines.
const SPEC = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]+)\1/g
// `import(` / `require(` NOT followed by a plain literal and `)` or `,` — a computed specifier.
const DYNAMIC = /\b(?:import|require)\s*\(\s*(?!(['"])[^'"\n]*\1\s*[,)])(?!`[^`$\n]*`\s*[,)])/g
const DEP_ALIAS = new RegExp(
  `(?:npm|workspace):(?:@crm\\/api|${DB_PKG})(?=[@/"'\\s,]|$)|["'](?:@crm\\/api|${DB_PKG})["']\\s*:`,
  'g',
)

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

export function specFindings(filename, content) {
  const out = []
  const dir = posix.dirname(filename)
  for (const m of content.matchAll(SPEC)) {
    const spec = m[2]
    const forms = spec.startsWith('.') ? [spec, posix.normalize(posix.join(dir, spec))] : [spec]
    const at = `${spec} (line ${lineOf(content, m.index)})`
    if (forms.some((s) => DB_CLIENT.test(s)))
      out.push({ kind: 'db-client', file: filename, detail: at })
    else if (forms.some((s) => API_SOURCE.test(s)))
      out.push({ kind: 'api-source', file: filename, detail: at })
    else if (FINANCE.test(spec) && SERVICE.test(spec))
      out.push({ kind: 'finance', file: filename, detail: at })
  }
  // Whole-line `//` comments only (line count kept): prose like "`await import(path)`" is common,
  // and a line that starts with `//` never executes. Block comments are NOT stripped — fail safe.
  const code = content.replace(/^[ \t]*\/\/.*$/gm, '')
  for (const m of code.matchAll(DYNAMIC)) {
    out.push({
      kind: 'dynamic-specifier',
      file: filename,
      detail: `${m[0].trim()}… (line ${lineOf(code, m.index)})`,
    })
  }
  for (const m of content.matchAll(CONTROLLER_DECORATOR)) {
    out.push({
      kind: 'controller',
      file: filename,
      detail: `@Controller( (line ${lineOf(content, m.index)})`,
    })
  }
  return out
}

export function needsContent(file) {
  return file.status !== 'removed' && INSPECT_FILE.test(file.filename)
}

export function findingsForFile(file, content, rules) {
  const out = []
  const name = file.filename
  if (file.status === 'removed') return out
  if (['renamed', 'copied'].includes(file.status) && file.previous_filename) {
    if (ownersOf(rules, file.previous_filename).length > 0) {
      out.push({ kind: 'moved-from-owned', file: name, detail: `from ${file.previous_filename}` })
    }
  }
  if (CONTROLLER_FILE.test(name) && ['added', 'renamed', 'copied'].includes(file.status)) {
    out.push({ kind: 'controller', file: name, detail: 'new controller file' })
  }
  if (!needsContent(file)) return out
  if (typeof content !== 'string') {
    out.push({ kind: 'uninspectable', file: name, detail: 'head content was not fetched' })
    return out
  }
  if (CODE_FILE.test(name)) out.push(...specFindings(name, content))
  for (const m of content.matchAll(DEP_ALIAS)) {
    out.push({
      kind: 'dep-alias',
      file: name,
      detail: `${m[0]} (line ${lineOf(content, m.index)})`,
    })
  }
  return out
}

export function ownerApproved(reviews, owner, headSha) {
  const decisive = reviews.filter(
    (r) =>
      String(r.author).toLowerCase() === owner.toLowerCase() &&
      r.commit_id === headSha &&
      (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'),
  )
  return decisive.length > 0 && decisive[decisive.length - 1].state === 'APPROVED'
}

export function unownedFiles(rules, files) {
  return files.filter((f) => ownersOf(rules, f.filename).length === 0)
}

export function evaluate({ pr, files, contents, rules, owner }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, reason: 'the PR file list is empty — refusing to read silence as clean' }
  }
  const expected = pr?.counts?.changedFiles
  if (typeof expected !== 'number' || files.length !== expected) {
    return {
      ok: false,
      reason: `listed ${files.length} files, the PR reports ${expected} — incomplete list`,
    }
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headSha ?? ''))
    return { ok: false, reason: 'no head sha in the PR data' }
  const byName = new Map(
    (Array.isArray(contents) ? contents : []).map((c) => [c.filename, c.content]),
  )
  const unowned = unownedFiles(rules, files)
  const findings = unowned.flatMap((f) => findingsForFile(f, byName.get(f.filename), rules))
  const scanned = unowned.length
  if (findings.length === 0)
    return { ok: true, scanned, findings, reason: 'no trigger in the unowned files' }
  if (ownerApproved(pr.reviews ?? [], owner, pr.headSha)) {
    return {
      ok: true,
      scanned,
      findings,
      reason: `owner @${owner} approved head ${pr.headSha.slice(0, 7)}`,
    }
  }
  return {
    ok: false,
    scanned,
    findings,
    reason: `needs an APPROVE review by @${owner} on head ${pr.headSha.slice(0, 7)} (a review on an older commit does not count)`,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`owner-approval: cannot read ${path}: ${e.message}`)
    process.exit(2)
  }
}

function main() {
  const coPath = arg('--codeowners')
  if (!coPath) {
    console.error('usage: see the header of check-owner-approval.mjs')
    process.exit(2)
  }
  let rules
  try {
    rules = parseCodeowners(readFileSync(coPath, 'utf8'))
  } catch (e) {
    console.error(`owner-approval: ${e.message}`)
    process.exit(2)
  }
  // A re-protect line on a renamed / deleted path silently stops protecting anything.
  const root = arg('--check-paths')
  if (root !== undefined) {
    const miss = rules.filter(
      (r) => (r.kind === 'dir' || r.kind === 'file') && !existsSync(`${root}/${r.file ?? r.dir}`),
    )
    for (const r of miss)
      console.error(`owner-approval: CODEOWNERS pattern names no existing path: ${r.pattern}`)
    console.log(`owner-approval: patterns=${rules.length} missing=${miss.length}`)
    process.exit(miss.length ? 1 : 0)
  }
  const ownerOf = arg('--owner-of')
  if (ownerOf !== undefined) {
    const o = ownersOf(rules, ownerOf)
    console.log(o.length ? o.join(' ') : '(unowned)')
    return
  }
  const filesPath = arg('--files')
  if (!filesPath) {
    console.error('owner-approval: --files is required')
    process.exit(2)
  }
  const files = readJson(filesPath)
  if (process.argv.includes('--fetch-plan')) {
    if (!Array.isArray(files)) process.exit(2)
    // A name with a line break cannot travel as one plan line; it stays unfetched -> uninspectable.
    for (const f of unownedFiles(rules, files))
      if (needsContent(f) && !f.filename.includes('\n')) console.log(f.filename)
    return
  }
  const prPath = arg('--pr')
  const contentsPath = arg('--contents')
  const owner = arg('--owner')
  if (!prPath || !contentsPath || !owner) {
    console.error(
      'usage: --codeowners <path> --pr <json> --files <json> --contents <json> --owner <login> [--summary <path>]',
    )
    process.exit(2)
  }
  const pr = readJson(prPath)
  const contents = readJson(contentsPath)
  const res = evaluate({ pr, files, contents, rules, owner })
  const lines = [
    `owner-approval: ${res.ok ? 'PASS' : 'FAIL'} — ${res.reason}`,
    `owner-approval: files=${Array.isArray(files) ? files.length : 0} unowned-scanned=${res.scanned ?? 0} triggers=${res.findings?.length ?? 0}`,
    ...(res.findings ?? []).map((f) => `  ${f.kind}: ${f.file} — ${f.detail}`),
  ]
  for (const l of lines) (res.ok ? console.log : console.error)(l)
  const summary = arg('--summary')
  if (summary)
    appendFileSync(
      summary,
      `\n### Owner approval (open CODEOWNERS zones)\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
    )
  process.exit(res.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
