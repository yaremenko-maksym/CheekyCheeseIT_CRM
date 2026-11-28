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
// WHAT TRIPS IT, per added line of an unowned code file (the PR's diff, read as data):
//   db-client   — an import of a DB driver / ORM (pg, postgres, drizzle-orm, ...) or of a `database` module
//   api-source  — an import reaching into the API (`apps/api/`, `api/src/`, `@crm/api`)
//   finance     — an import of a finance service / repository (finance word + `.service` / `.repository`)
//   controller  — a new `*.controller.*` file, or an added `@Controller(` decorator
//   uninspectable — a code file whose patch GitHub did not return (too large / binary): fail closed
//
// WHAT "APPROVED" MEANS: the owner's latest decisive review (APPROVED / CHANGES_REQUESTED) on the
// PR's head commit is APPROVED. A label is not used: any write-role user can set one, and
// `auto-merge-on-label.yml` does not check who set `merge-approved`. A review is bound to a login
// and to a commit (`commit_id`), so a later push invalidates it. Reviews re-run the Flow Gate
// through flow-gate-recheck.yml.
//
// Fail closed: a file list shorter than the PR's `changed_files`, or a CODEOWNERS line in a shape
// this matcher does not model, is a failure, never a pass.
//
// Usage:
//   node check-owner-approval.mjs --pr <pr-data.json> --files <files.json> --codeowners <path> \
//     --owner <login> [--summary <path>]
//   node check-owner-approval.mjs --owner-of <path> --codeowners <path>   # prints owners or "(unowned)"
// pr-data.json: {headSha, counts: {changedFiles}, reviews: [{author, state, commit_id}]} (Flow Gate's file)
// files.json:   [{filename, previous_filename, status, changes, patch}] (REST pulls/{n}/files)
// Exit: 0 pass, 1 refused, 2 usage / input error.
import { appendFileSync, readFileSync } from 'node:fs'

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
  const p = pattern.replace(/^\//, '')
  const bad = () => {
    throw new Error(
      `CODEOWNERS line ${lineNo}: pattern "${pattern}" is outside the supported shapes (*, a/b/, a/b/**, a/b/c.ext)`,
    )
  }
  if (!p.includes('/') || /[?[\]!\\]/.test(p)) bad()
  if (p.endsWith('/**')) {
    const dir = p.slice(0, -2)
    if (dir.includes('*')) bad()
    return { pattern, kind: 'dir', dir }
  }
  if (p.includes('*')) bad()
  if (p.endsWith('/')) return { pattern, kind: 'dir', dir: p }
  return { pattern, kind: 'file', file: p }
}

export function ownersOf(rules, path) {
  let owners = null
  for (const r of rules) {
    if (
      r.kind === 'all' ||
      (r.kind === 'dir' && path.startsWith(r.dir)) ||
      (r.kind === 'file' && path === r.file)
    ) {
      owners = r.owners
    }
  }
  return owners ?? []
}

const CODE_FILE = /\.(c|m)?[jt]sx?$/
const SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s*)(['"`])([^'"`]+)\1/g
const DB_CLIENT =
  /^(pg|pg-pool|postgres|drizzle-orm|drizzle-kit|@neondatabase\/serverless|kysely|knex|typeorm|@prisma\/client|mysql2|better-sqlite3|sqlite3)(\/|$)|(^|\/)database(\/|\.|$)/
const API_SOURCE = /(^|\/)apps\/api(\/|$)|(^|\/)api\/src(\/|$)|^@crm\/api(\/|$)/
const FINANCE =
  /(financ|transaction|payout|company-account|wallet|salary|ledger|requisite|invoice|dividend)/i
const SERVICE = /\.(service|repository)(\.[cm]?[jt]s)?$/
const CONTROLLER_FILE = /\.controller\.(c|m)?[jt]sx?$/
const CONTROLLER_DECORATOR = /@Controller\s*\(/

export function addedLines(patch) {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

export function findingsForFile(file) {
  const out = []
  const name = file.filename
  if (file.status === 'removed') return out
  if (CONTROLLER_FILE.test(name) && ['added', 'renamed', 'copied'].includes(file.status)) {
    out.push({ kind: 'controller', file: name, detail: 'new controller file' })
  }
  if (!CODE_FILE.test(name)) return out
  if (typeof file.patch !== 'string') {
    const pureMove = file.status === 'renamed' && file.changes === 0
    if (!pureMove)
      out.push({ kind: 'uninspectable', file: name, detail: 'GitHub returned no patch' })
    return out
  }
  for (const line of addedLines(file.patch)) {
    if (CONTROLLER_DECORATOR.test(line))
      out.push({ kind: 'controller', file: name, detail: line.trim() })
    for (const m of line.matchAll(SPEC)) {
      const spec = m[2]
      if (DB_CLIENT.test(spec)) out.push({ kind: 'db-client', file: name, detail: spec })
      else if (API_SOURCE.test(spec)) out.push({ kind: 'api-source', file: name, detail: spec })
      else if (FINANCE.test(spec) && SERVICE.test(spec))
        out.push({ kind: 'finance', file: name, detail: spec })
    }
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

export function evaluate({ pr, files, rules, owner }) {
  if (!Array.isArray(files) || files.length === 0)
    return { ok: false, reason: 'the PR file list is empty — refusing to read silence as clean' }
  const expected = pr?.counts?.changedFiles
  if (typeof expected !== 'number' || files.length !== expected) {
    return {
      ok: false,
      reason: `listed ${files.length} files, the PR reports ${expected} — incomplete list`,
    }
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headSha ?? ''))
    return { ok: false, reason: 'no head sha in the PR data' }
  const unowned = files.filter((f) => ownersOf(rules, f.filename).length === 0)
  const findings = unowned.flatMap(findingsForFile)
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

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
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
  const ownerOf = arg('--owner-of')
  if (ownerOf !== undefined) {
    const o = ownersOf(rules, ownerOf)
    console.log(o.length ? o.join(' ') : '(unowned)')
    return
  }
  const prPath = arg('--pr')
  const filesPath = arg('--files')
  const owner = arg('--owner')
  if (!prPath || !filesPath || !owner) {
    console.error(
      'usage: --pr <json> --files <json> --codeowners <path> --owner <login> [--summary <path>]',
    )
    process.exit(2)
  }
  let pr, files
  try {
    pr = JSON.parse(readFileSync(prPath, 'utf8'))
    files = JSON.parse(readFileSync(filesPath, 'utf8'))
  } catch (e) {
    console.error(`owner-approval: cannot read input: ${e.message}`)
    process.exit(2)
  }
  const res = evaluate({ pr, files, rules, owner })
  const lines = [
    `owner-approval: ${res.ok ? 'PASS' : 'FAIL'} — ${res.reason}`,
    `owner-approval: files=${files.length ?? 0} unowned-scanned=${res.scanned ?? 0} triggers=${res.findings?.length ?? 0}`,
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

if (import.meta.url === `file://${process.argv[1]}`) main()
