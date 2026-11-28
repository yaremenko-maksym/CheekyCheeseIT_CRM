#!/usr/bin/env node
// check-owner-approval.mjs — the `Owner Verdict` required check (job in .github/workflows/flow-gate.yml)
// and the auto-merge decision (.github/workflows/owner-verdict-merge.yml).
//
// WHY: CODEOWNERS opens apps/web, apps/landing, apps/e2e and docs so a manager can merge there
// without the owner (design §7, the manager role; plan PR 11). CODEOWNERS restricts files, not
// behaviour, and agents share the owner's GitHub account. So a PR by anyone but the owner that
// (a) touches a critical zone (owner-verdict-zones.json — contracts.md §2.1 + pipeline + web
// auth/finance), or (b) in an unowned file, reaches the DB / the API / a finance module or adds a
// controller, stays red until the owner posts a review whose first line is `Owner Verdict: APPROVE`
// and which carries `Commit: <head sha>`.
//
// (b) IS FAIL-CLOSED, NOT A REGEX SCAN: every non-removed unowned file is either on the inert
// allowlist (INERT_EXT) or parsed with the TypeScript compiler API from its FULL head content
// (fetched through the REST API as data, never checked out). Every module specifier from the AST
// is resolved (relative paths against the file's directory; tsconfig `paths` of the owning package,
// read from the BASE branch; `@crm/<pkg>` workspace names) and then matched. Anything the scanner
// cannot pin to a literal module — a computed loader argument, `require` used as a value,
// createRequire, module.require, import.meta.glob*, eval, new Function, `.constructor(...)`, an
// unresolved alias, a non-code non-inert file type — is itself a trigger. A trigger is not a
// verdict of malice; it means "the owner looks".
//
// VERDICT: the owner's (login OWNER) latest review whose first non-empty line is
// `Owner Verdict: APPROVE|BLOCK` decides; DISMISSED reviews do not count. APPROVE needs state
// COMMENTED or APPROVED and a `Commit: <sha>` line (>= 7 hex) that prefixes the head — a push after
// the verdict makes it stale. A label is not used: any write-role user can set one.
//
// Usage:
//   --codeowners <path> --files <files.json> --fetch-plan          # unowned code files to fetch
//   --codeowners <path> --zones <zones.json> --tsconfig-root <dir> --pr <pr.json> --files <files.json> \
//     --contents <contents.json> --owner <login> [--summary <path>] [--json]
//   --codeowners <path> --owner-of <path>                          # owners or "(unowned)"
//   --codeowners <path> --check-paths <repo>                       # every pattern names a path
// pr.json:       {headSha, author, counts: {changedFiles}, reviews: [{author, state, body}]}
// files.json:    [{filename, previous_filename, status}]   (REST pulls/{n}/files)
// contents.json: [{filename, content} | {filename, unavailable: true}]
// TypeScript: `typescript` resolved from this file, or the path in OWNER_GATE_TS.
// Exit: 0 pass, 1 refused, 2 usage / input error.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'

const requireHere = createRequire(import.meta.url)
let tsModule
function ts() {
  tsModule ??= requireHere(process.env.OWNER_GATE_TS || 'typescript')
  return tsModule
}

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
  if (pattern.startsWith('**/')) {
    const base = pattern.slice(3)
    if (!base || base.includes('/')) bad()
    return {
      pattern,
      kind: 'basename',
      re: new RegExp(`^${base.split('*').map(escapeRe).join('[^/]*')}$`),
    }
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
  if (rule.kind === 'all') return true
  if (rule.kind === 'dir') return path.startsWith(rule.dir)
  if (rule.kind === 'file') return path === rule.file
  return rule.re.test(posix.basename(path))
}

export function ownersOf(rules, path) {
  let owners = null
  for (const r of rules) if (matches(r, path)) owners = r.owners
  return owners ?? []
}

// ── critical zones ───────────────────────────────────────────────────────────────────────
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) ((re += '(?:.*/)?'), (i += 3))
    else if (glob.startsWith('**', i)) ((re += '.*'), (i += 2))
    else if (glob[i] === '*') ((re += '[^/]*'), (i += 1))
    else ((re += escapeRe(glob[i])), (i += 1))
  }
  return new RegExp(`^${re}$`)
}

export function compileZones(json) {
  if (!Array.isArray(json?.zones) || json.zones.length === 0)
    throw new Error('zones file has no zones')
  return json.zones.map((z) => ({ ...z, re: globToRegExp(z.glob) }))
}

export function zoneHits(zones, files) {
  const hits = []
  for (const f of files) {
    for (const name of [f.filename, f.previous_filename].filter(Boolean)) {
      const z = zones.find((zz) => zz.re.test(name))
      if (z) hits.push({ kind: `zone:${z.zone}`, file: name, detail: z.glob })
    }
  }
  return hits
}

// ── file classification ──────────────────────────────────────────────────────────────────
const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
// Content that no runtime here executes or resolves modules from.
const INERT_EXT =
  /\.(md|txt|png|jpe?g|gif|svg|webp|avif|ico|bmp|css|po|snap|woff2?|ttf|otf|eot|pdf|mp4|webm|mp3|wav|csv|json)$/i
// JSON that configures module resolution / transpilation is NOT inert.
const CONFIG_JSON =
  /(^|\/)(jsconfig[^/]*|tsconfig[^/]*|\.babelrc[^/]*|babel\.config[^/]*|\.swcrc|package)\.json$/

export function classify(filename) {
  if (CODE_EXT.test(filename)) return 'code'
  if (CONFIG_JSON.test(filename)) return 'other'
  if (INERT_EXT.test(filename)) return 'inert'
  return 'other'
}

// ── specifier resolution ─────────────────────────────────────────────────────────────────
const PACKAGE_ROOTS = ['apps/web', 'apps/landing', 'apps/e2e']

function readTsconfigPaths(root, pkg) {
  // tsconfig files are JSONC; follow `extends` (relative only) and keep the nearest `paths`.
  let rel = `${pkg}/tsconfig.json`
  for (let depth = 0; depth < 5 && existsSync(`${root}/${rel}`); depth++) {
    const parsed = ts().parseConfigFileTextToJson(rel, readFileSync(`${root}/${rel}`, 'utf8'))
    if (parsed.error) throw new Error(`cannot parse ${rel}`)
    const co = parsed.config?.compilerOptions ?? {}
    const dir = posix.dirname(rel)
    if (co.paths)
      return { base: posix.normalize(posix.join(dir, co.baseUrl ?? '.')), paths: co.paths }
    if (typeof parsed.config?.extends !== 'string' || !parsed.config.extends.startsWith('.')) break
    rel = posix.normalize(posix.join(dir, parsed.config.extends))
  }
  return { base: pkg, paths: {} }
}

export function loadAliases(root) {
  const out = {}
  for (const pkg of PACKAGE_ROOTS)
    out[pkg] = root ? readTsconfigPaths(root, pkg) : { base: pkg, paths: {} }
  return out
}

function owningPackage(filename) {
  return PACKAGE_ROOTS.find((p) => filename.startsWith(`${p}/`))
}

// Returns {path} (repo-relative, for local / aliased modules), {pkg} (a bare package), or {unresolved}.
export function resolveSpecifier(filename, spec, aliases) {
  if (/^node:[a-z_/]+$/.test(spec)) return { pkg: spec }
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { path: posix.normalize(posix.join(posix.dirname(filename), spec)) }
  }
  const pkgRoot = owningPackage(filename)
  const { base, paths } = (pkgRoot && aliases[pkgRoot]) || { base: '', paths: {} }
  for (const [key, targets] of Object.entries(paths)) {
    const star = key.endsWith('*')
    const prefix = star ? key.slice(0, -1) : key
    if (star ? spec.startsWith(prefix) : spec === key) {
      const rest = star ? spec.slice(prefix.length) : ''
      const target = String(targets?.[0] ?? '')
      return { path: posix.normalize(posix.join(base, target.replace('*', rest))) }
    }
  }
  const ws = spec.match(/^@crm\/([^/]+)(\/.*)?$/)
  if (ws) {
    const dir = ['api', 'web', 'landing', 'e2e'].includes(ws[1]) ? 'apps' : 'packages'
    return { path: posix.normalize(`${dir}/${ws[1]}${ws[2] ?? ''}`), pkg: spec }
  }
  // A valid bare npm name: `name` or `@scope/name`, lower-case, no protocol, no leading `~` / `#` / `/`.
  if (/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[^\s:\\]*)?$/.test(spec))
    return { pkg: spec }
  return { unresolved: true }
}

const DB_PKG =
  /^(pg|pg-pool|pg-native|postgres|drizzle-orm|drizzle-kit|@neondatabase\/serverless|kysely|knex|typeorm|@prisma\/client|prisma|mysql2?|better-sqlite3|sqlite3|sequelize|mongodb|mongoose|redis|ioredis)(\/|$)/
const FINANCE_WORD =
  /(financ|transaction|payout|company-account|wallet|salary|ledger|requisite|invoice|dividend)/i

export function classifySpecifier(filename, spec, aliases) {
  const r = resolveSpecifier(filename, spec, aliases)
  if (r.unresolved) return { kind: 'unresolved-specifier', detail: spec }
  if (r.pkg && DB_PKG.test(r.pkg)) return { kind: 'db-client', detail: spec }
  if (!r.path) return null
  const via = `${spec} -> ${r.path}`
  if (r.path.startsWith('..') || r.path.startsWith('/'))
    return { kind: 'unresolved-specifier', detail: via }
  if (r.path === 'apps/api' || r.path.startsWith('apps/api/'))
    return { kind: 'api-source', detail: via }
  if (/(^|\/)(database|drizzle|db)(\/|\.|$)/.test(r.path)) return { kind: 'db-client', detail: via }
  if (FINANCE_WORD.test(r.path) && /\.(service|repository)(\.[cm]?[jt]s)?$/.test(r.path)) {
    return { kind: 'finance', detail: via }
  }
  return null
}

// ── AST scan ─────────────────────────────────────────────────────────────────────────────
const META_OK = new Set(['env', 'url', 'hot', 'dirname', 'filename', 'main'])

function scriptKind(filename) {
  const k = ts().ScriptKind
  if (/\.tsx$/.test(filename)) return k.TSX
  if (/\.jsx$/.test(filename)) return k.JSX
  if (/\.(ts|mts|cts)$/.test(filename)) return k.TS
  return k.JS
}

export function scanCode(filename, content, aliases) {
  const T = ts()
  const SK = T.SyntaxKind
  const sf = T.createSourceFile(
    filename,
    content,
    T.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  )
  const out = []
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const push = (kind, node, detail) =>
    out.push({ kind, file: filename, detail: `${detail} (line ${at(node)})` })
  const literal = (n) => n && (T.isStringLiteral(n) || T.isNoSubstitutionTemplateLiteral(n))
  const spec = (node, text) => {
    const c = classifySpecifier(filename, text, aliases)
    if (c) push(c.kind, node, c.detail)
  }
  if (sf.parseDiagnostics?.length)
    out.push({
      kind: 'unparseable',
      file: filename,
      detail: `${sf.parseDiagnostics.length} syntax error(s)`,
    })

  const visit = (node) => {
    if ((T.isImportDeclaration(node) || T.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (literal(node.moduleSpecifier)) spec(node, node.moduleSpecifier.text)
      else push('dynamic-specifier', node, 'non-literal module specifier')
    } else if (
      T.isImportEqualsDeclaration(node) &&
      T.isExternalModuleReference(node.moduleReference)
    ) {
      const e = node.moduleReference.expression
      if (literal(e)) spec(node, e.text)
      else push('dynamic-specifier', node, 'import = require(<non-literal>)')
    } else if (T.isImportTypeNode(node)) {
      const a = node.argument
      if (T.isLiteralTypeNode(a) && literal(a.literal)) spec(node, a.literal.text)
    } else if (T.isCallExpression(node)) {
      const callee = node.expression
      const isImport = callee.kind === SK.ImportKeyword
      const isRequire = T.isIdentifier(callee) && callee.text === 'require'
      if (isImport || isRequire) {
        const a = node.arguments[0]
        if (literal(a)) spec(node, a.text)
        else push('dynamic-specifier', node, `${isImport ? 'import' : 'require'}(<non-literal>)`)
      }
      if (T.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) {
        push('eval', node, `${callee.text}(...)`)
      }
      const name = T.isPropertyAccessExpression(callee)
        ? callee.name.text
        : T.isElementAccessExpression(callee) && literal(callee.argumentExpression)
          ? callee.argumentExpression.text
          : null
      if (name === 'constructor') push('eval', node, '.constructor(...)')
      if (T.isIdentifier(callee) && callee.text === 'Controller' && T.isDecorator(node.parent)) {
        push('controller', node, '@Controller(...)')
      }
    } else if (
      T.isNewExpression(node) &&
      T.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      push('eval', node, 'new Function(...)')
    } else if (T.isIdentifier(node)) {
      const p = node.parent
      const isCallee = T.isCallExpression(p) && p.expression === node
      if (node.text === 'require' && !isCallee)
        push('loader-alias', node, '`require` used as a value')
      if (node.text === 'createRequire') push('loader-alias', node, 'createRequire')
      if (node.text === 'eval' && !isCallee) push('eval', node, '`eval` used as a value')
    } else if (T.isPropertyAccessExpression(node) && T.isMetaProperty(node.expression)) {
      if (node.expression.keywordToken === SK.ImportKeyword && !META_OK.has(node.name.text)) {
        push('loader-alias', node, `import.meta.${node.name.text}`)
      }
    } else if (T.isElementAccessExpression(node) && T.isMetaProperty(node.expression)) {
      push('loader-alias', node, 'import.meta[...]')
    }
    T.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── per-file findings (unowned files only) ───────────────────────────────────────────────
const CONTROLLER_FILE = /\.controller\.(c|m)?[jt]sx?$/

export function findingsForFile(file, content, rules, aliases) {
  const out = []
  const name = file.filename
  if (file.status === 'removed') return out
  if (['renamed', 'copied'].includes(file.status) && file.previous_filename) {
    if (ownersOf(rules, file.previous_filename).length > 0) {
      out.push({ kind: 'moved-from-owned', file: name, detail: `from ${file.previous_filename}` })
    }
  }
  if (CONTROLLER_FILE.test(name) && file.status !== 'modified') {
    out.push({ kind: 'controller', file: name, detail: 'new controller file' })
  }
  const cls = classify(name)
  if (cls === 'inert') return out
  if (cls === 'other') {
    out.push({
      kind: 'non-inert-file-type',
      file: name,
      detail: 'neither inert nor parsed as code',
    })
    return out
  }
  if (typeof content !== 'string') {
    out.push({ kind: 'uninspectable', file: name, detail: 'head content was not fetched' })
    return out
  }
  out.push(...scanCode(name, content, aliases))
  return out
}

export function unownedFiles(rules, files) {
  return files.filter((f) => ownersOf(rules, f.filename).length === 0)
}

export function fetchPlan(rules, files) {
  return unownedFiles(rules, files)
    .filter(
      (f) =>
        f.status !== 'removed' && classify(f.filename) === 'code' && !f.filename.includes('\n'),
    )
    .map((f) => f.filename)
}

// ── verdict ──────────────────────────────────────────────────────────────────────────────
export function latestVerdict(reviews, owner) {
  let latest = null
  for (const r of reviews) {
    if (String(r.author).toLowerCase() !== owner.toLowerCase() || r.state === 'DISMISSED') continue
    const body = String(r.body ?? '')
    const first =
      body
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? ''
    const m = first.match(/^Owner Verdict:\s*(APPROVE|BLOCK)\s*$/)
    if (!m) continue
    const c = body.match(/^\s*Commit:\s*`?([0-9a-f]{7,40})`?\s*$/m)
    latest = { verdict: m[1], commit: c ? c[1] : null, state: r.state }
  }
  return latest
}

export function verdictStatus(reviews, owner, headSha) {
  const v = latestVerdict(reviews, owner)
  if (!v) return { status: 'missing', reason: `no \`Owner Verdict:\` review by @${owner}` }
  if (v.verdict === 'BLOCK')
    return { status: 'blocked', reason: `@${owner} posted \`Owner Verdict: BLOCK\`` }
  if (!['COMMENTED', 'APPROVED'].includes(v.state)) {
    return {
      status: 'missing',
      reason: `the APPROVE verdict sits in a ${v.state} review (needs COMMENT or APPROVE)`,
    }
  }
  if (!v.commit)
    return { status: 'stale', reason: 'the APPROVE verdict has no `Commit: <sha>` line' }
  if (!headSha.startsWith(v.commit)) {
    return {
      status: 'stale',
      reason: `the APPROVE verdict is for ${v.commit.slice(0, 7)}, head is ${headSha.slice(0, 7)}`,
    }
  }
  return {
    status: 'approved',
    reason: `@${owner} posted \`Owner Verdict: APPROVE\` for head ${headSha.slice(0, 7)}`,
  }
}

export function evaluate({ pr, files, contents, rules, zones, aliases, owner }) {
  const fail = (reason) => ({ ok: false, status: 'error', reason, findings: [] })
  if (!Array.isArray(files) || files.length === 0)
    return fail('the PR file list is empty — refusing to read silence as clean')
  const expected = pr?.counts?.changedFiles
  if (typeof expected !== 'number' || files.length !== expected) {
    return fail(`listed ${files.length} files, the PR reports ${expected} — incomplete list`)
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headSha ?? '')) return fail('no head sha in the PR data')
  if (!pr.author) return fail('no PR author in the PR data')
  const byName = new Map(
    (Array.isArray(contents) ? contents : []).map((c) => [c.filename, c.content]),
  )
  const unowned = unownedFiles(rules, files)
  let detections
  try {
    detections = unowned.flatMap((f) => findingsForFile(f, byName.get(f.filename), rules, aliases))
  } catch (e) {
    return fail(`the scanner failed: ${e.message}`)
  }
  const findings = [...zoneHits(zones, files), ...detections]
  const base = { scanned: unowned.length, findings }
  if (findings.length === 0) {
    return {
      ok: true,
      status: 'not-required',
      ...base,
      reason: 'no critical zone, no trigger in the unowned files',
    }
  }
  if (String(pr.author).toLowerCase() === owner.toLowerCase()) {
    return {
      ok: true,
      status: 'owner-authored',
      ...base,
      reason: `the PR is authored by the owner @${owner}`,
    }
  }
  const v = verdictStatus(pr.reviews ?? [], owner, pr.headSha)
  return { ok: v.status === 'approved', ...base, status: v.status, reason: v.reason }
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
    console.error(`owner-verdict: cannot read ${path}: ${e.message}`)
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
    console.error(`owner-verdict: ${e.message}`)
    process.exit(2)
  }
  // A re-protect line on a renamed / deleted path silently stops protecting anything.
  const root = arg('--check-paths')
  if (root !== undefined) {
    const miss = rules.filter(
      (r) => (r.kind === 'dir' || r.kind === 'file') && !existsSync(`${root}/${r.file ?? r.dir}`),
    )
    for (const r of miss)
      console.error(`owner-verdict: CODEOWNERS pattern names no existing path: ${r.pattern}`)
    console.log(`owner-verdict: patterns=${rules.length} missing=${miss.length}`)
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
    console.error('owner-verdict: --files is required')
    process.exit(2)
  }
  const files = readJson(filesPath)
  if (process.argv.includes('--fetch-plan')) {
    if (!Array.isArray(files)) process.exit(2)
    for (const f of fetchPlan(rules, files)) console.log(f)
    return
  }
  const [prPath, contentsPath, zonesPath, owner] = ['--pr', '--contents', '--zones', '--owner'].map(
    arg,
  )
  if (!prPath || !contentsPath || !zonesPath || !owner) {
    console.error(
      'usage: --codeowners --zones --pr --files --contents --owner [--tsconfig-root] [--summary] [--json]',
    )
    process.exit(2)
  }
  let zones, aliases
  try {
    zones = compileZones(readJson(zonesPath))
    aliases = loadAliases(arg('--tsconfig-root'))
  } catch (e) {
    console.error(`owner-verdict: ${e.message}`)
    process.exit(2)
  }
  const res = evaluate({
    pr: readJson(prPath),
    files,
    contents: readJson(contentsPath),
    rules,
    zones,
    aliases,
    owner,
  })
  if (process.argv.includes('--json'))
    console.log(JSON.stringify({ ok: res.ok, status: res.status, reason: res.reason }))
  const lines = [
    `owner-verdict: ${res.ok ? 'PASS' : 'FAIL'} [${res.status}] — ${res.reason}`,
    `owner-verdict: files=${Array.isArray(files) ? files.length : 0} unowned-scanned=${res.scanned ?? 0} triggers=${res.findings.length}`,
    ...res.findings.map((f) => `  ${f.kind}: ${f.file} — ${f.detail}`),
  ]
  for (const l of lines) console.error(l)
  const summary = arg('--summary')
  if (summary)
    appendFileSync(summary, `\n### Owner Verdict\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
  process.exit(res.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
