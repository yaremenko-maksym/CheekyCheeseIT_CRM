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
// cannot pin to a literal module — any reference to require / module / process / exports / eval / Function /
// createRequire, a computed member of a global object, `.constructor(...)`, a node:* specifier, import.meta.glob*, an
// unresolved alias, a non-code non-inert file type — is itself a trigger. A trigger is not a
// verdict of malice; it means "the owner looks".
//
// VERDICT: the owner's (login OWNER) latest review whose first non-empty line is
// `Owner Verdict: APPROVE|BLOCK` decides; an edited owner review resets it (never approves); a
// DISMISSED APPROVE does not count, a dismissed BLOCK still blocks. APPROVE needs state
// COMMENTED or APPROVED and a `Commit: <sha>` line (full 40 hex) equal to the head, and the review's commit_id equal to the head — a push after
// the verdict makes it stale. A label is not used: any write-role user can set one.
//
// Usage:
//   --codeowners <path> --files <files.json> --fetch-plan          # unowned code files to fetch
//   --codeowners <path> --zones <zones.json> --tsconfig-root <dir> --pr <pr.json> --files <files.json> \
//     --contents <contents.json> --owner <login> [--summary <path>] [--json]
//   --codeowners <path> --owner-of <path>                          # owners or "(unowned)"
//   --codeowners <path> --check-paths <repo>                       # every pattern names a path
// pr.json:       {headSha, author, counts: {changedFiles}, reviews: [{author, state, body, commit_id, edited}]}
// files.json:    [{filename, previous_filename, status}]   (REST pulls/{n}/files)
// contents.json: [{filename, content} | {filename, unavailable: true}]
// TypeScript: `typescript` resolved from this file, or the path in OWNER_GATE_TS.
// Exit: 0 pass, 1 refused, 2 usage / input error.
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// shortcut: static analysis cannot prove absence of dynamic loading; owner review is the backstop
// Inverted (Master addendum 3): a static ESM import with a literal specifier is the only loader
// allowed without a verdict (a literal `import('x')` is resolved and judged the same way). Any
// reference to an identifier below — called, aliased, passed or shadowed — is a trigger.
// Node built-ins (isBuiltin, bare or node:) are triggers in browser code (apps/web, apps/landing,
// docs); apps/e2e may import only E2E_BUILTINS. Reflect.get/apply/construct and any computed
// member of a global object are triggers.
// Trade-off (Master addendum 4): a plain `window` / `globalThis` / `global` / `self` reference is
// NOT a trigger — browser code reads `window.location` everywhere, and flagging it would put every
// web PR behind the owner. Only a global object PASSED AS A VALUE (call / new argument, initializer,
// assignment right-hand side, spread, property value, array element, return) is a trigger: that is
// how a loader is reached without naming it (`Reflect.get(globalThis, k)`, `const g = self`).
const META_OK = new Set(['env', 'url', 'hot', 'dirname', 'filename', 'main'])
const LOADER_IDS = new Set([
  'require',
  'module',
  'process',
  'exports',
  '__non_webpack_require__',
  'createRequire',
  'eval',
  'Function',
])
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self'])
// Master addendum 5: a PROPERTY with one of these names reaches the global object from any
// receiver (`a.globalThis`, `window.self`, `document.defaultView`, `x.top`), so such an access is a
// global-object expression. Bare identifiers stay GLOBAL_OBJECTS only — a local `parent` / `top`
// is ordinary code. Trade-off: `node.parent` / `rect.top` passed as a value is flagged too.
const GLOBAL_PROPS = new Set([...GLOBAL_OBJECTS, 'parent', 'top', 'frames', 'defaultView'])
// A property with one of these names is a trigger whatever the receiver (`a.globalThis.process`,
// `x.getBuiltinModule`), dotted or a literal element access.
const LOADER_PROPS = new Set([...LOADER_IDS, 'getBuiltinModule'])
// What apps/e2e already imports (git grep 2026-11-28: crypto, path, fs; net / http / module are
// NOT allowed and trigger when a file using them is edited) plus url / os. Subpaths
// (fs/promises) follow their root.
export const E2E_BUILTINS = Object.freeze(['fs', 'path', 'url', 'os', 'crypto'])
const REFLECT_LOADERS = new Set(['get', 'apply', 'construct'])

export function builtinVerdict(filename, spec) {
  if (!spec.startsWith('node:') && !isBuiltin(spec)) return null
  const root = spec.replace(/^node:/, '').split('/')[0]
  if (filename.startsWith('apps/e2e/') && E2E_BUILTINS.includes(root) && isBuiltin(spec))
    return null
  return `Node built-in ${spec}`
}

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
    const b = builtinVerdict(filename, text)
    if (b) return push('node-builtin', node, b)
    if (text.startsWith('node:')) return
    const c = classifySpecifier(filename, text, aliases)
    if (c) push(c.kind, node, c.detail)
  }
  // A declaration's or property's own name is not a reference; a shorthand `{ process }` is.
  const isReference = (node) => {
    const p = node.parent
    if (!p || T.isShorthandPropertyAssignment(p)) return true
    if (T.isQualifiedName(p) && p.right === node) return false
    return !('name' in p && p.name === node)
  }
  // A global object in a value position, seen through parentheses / casts / ?: / ?? / || / && / ,.
  const WRAP_OPS = [
    SK.QuestionQuestionToken,
    SK.BarBarToken,
    SK.AmpersandAmpersandToken,
    SK.CommaToken,
  ]
  // `=`, `??=`, `||=`, `&&=`, `+=` …: an assignment's value is its right side.
  const isAssignOp = (k) => k >= SK.FirstAssignment && k <= SK.LastAssignment
  const LOGICAL_ASSIGN = [
    SK.QuestionQuestionEqualsToken,
    SK.BarBarEqualsToken,
    SK.AmpersandAmpersandEqualsToken,
  ]
  const passedAsValue = (node) => {
    let n = node
    for (let p = n.parent; p; n = p, p = p.parent) {
      const wrap =
        T.isParenthesizedExpression(p) ||
        T.isAsExpression(p) ||
        T.isNonNullExpression(p) ||
        T.isTypeAssertionExpression(p) ||
        T.isSatisfiesExpression(p) ||
        (T.isConditionalExpression(p) && p.condition !== n) ||
        (T.isBinaryExpression(p) && WRAP_OPS.includes(p.operatorToken.kind))
      if (!wrap) break
    }
    const p = n.parent
    if (!p) return false
    if ((T.isCallExpression(p) || T.isNewExpression(p)) && p.arguments?.includes(n)) return true
    if (
      T.isVariableDeclaration(p) ||
      T.isPropertyAssignment(p) ||
      T.isParameter(p) ||
      T.isBindingElement(p)
    ) {
      return p.initializer === n
    }
    if (T.isBinaryExpression(p)) return p.right === n && isAssignOp(p.operatorToken.kind)
    return (
      T.isSpreadElement(p) ||
      T.isSpreadAssignment(p) ||
      T.isShorthandPropertyAssignment(p) ||
      T.isArrayLiteralExpression(p) ||
      T.isReturnStatement(p) ||
      (T.isArrowFunction(p) && p.body === n) ||
      T.isExportAssignment(p)
    )
  }
  const unwrap = (n) => {
    while (
      T.isParenthesizedExpression(n) ||
      T.isAsExpression(n) ||
      T.isNonNullExpression(n) ||
      T.isTypeAssertionExpression(n) ||
      T.isSatisfiesExpression(n)
    )
      n = n.expression
    return n
  }
  // The expressions a value may come from: both sides of `,` / `??` / `||` / `&&`, both branches
  // of `?:` (the same wrappers passedAsValue sees through), the right side of `=`, both sides of
  // `??=` / `||=` / `&&=` (`(x ??= globalThis)[k]`).
  const sources = (n) => {
    n = unwrap(n)
    if (T.isBinaryExpression(n)) {
      const k = n.operatorToken.kind
      if (WRAP_OPS.includes(k) || LOGICAL_ASSIGN.includes(k))
        return [...sources(n.left), ...sources(n.right)]
      if (k === SK.EqualsToken) return sources(n.right)
    }
    if (T.isConditionalExpression(n)) return [...sources(n.whenTrue), ...sources(n.whenFalse)]
    return [n]
  }
  // `window`, `a.self`, `x['top']`, `(0, globalThis)`, `(x ?? window)`, `(c ? self : o)`.
  const isGlobalExpr = (n) => sources(n).some(isGlobalLeaf)
  const isGlobalLeaf = (n) => {
    if (T.isIdentifier(n)) return GLOBAL_OBJECTS.has(n.text)
    if (T.isPropertyAccessExpression(n)) return GLOBAL_PROPS.has(n.name.text)
    return (
      T.isElementAccessExpression(n) &&
      literal(n.argumentExpression) &&
      GLOBAL_PROPS.has(n.argumentExpression.text)
    )
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
      push('loader-alias', node, 'import = require(...)')
    } else if (T.isImportTypeNode(node)) {
      const a = node.argument
      if (T.isLiteralTypeNode(a) && literal(a.literal)) spec(node, a.literal.text)
    } else if (T.isCallExpression(node)) {
      const callee = node.expression
      if (callee.kind === SK.ImportKeyword) {
        const a = node.arguments[0]
        if (literal(a)) spec(node, a.text)
        else push('dynamic-specifier', node, 'import(<non-literal>)')
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
    } else if (T.isIdentifier(node)) {
      if (LOADER_IDS.has(node.text) && isReference(node)) {
        const k = node.text === 'eval' || node.text === 'Function' ? 'eval' : 'loader-alias'
        push(k, node, `reference to \`${node.text}\``)
      }
      if (GLOBAL_OBJECTS.has(node.text) && isReference(node) && passedAsValue(node)) {
        push('loader-alias', node, `\`${node.text}\` passed as a value`)
      }
    } else if (T.isPropertyAccessExpression(node)) {
      const obj = node.expression
      if (T.isMetaProperty(obj) && obj.keywordToken === SK.ImportKeyword) {
        if (!META_OK.has(node.name.text))
          push('loader-alias', node, `import.meta.${node.name.text}`)
      } else if (LOADER_PROPS.has(node.name.text)) {
        push('loader-alias', node, `${obj.getText(sf)}.${node.name.text}`)
      } else if (GLOBAL_PROPS.has(node.name.text) && passedAsValue(node)) {
        push('loader-alias', node, `\`${node.getText(sf)}\` (global object) passed as a value`)
      } else if (
        T.isIdentifier(obj) &&
        obj.text === 'Reflect' &&
        REFLECT_LOADERS.has(node.name.text)
      ) {
        push('loader-alias', node, `Reflect.${node.name.text}`)
      }
    } else if (T.isElementAccessExpression(node)) {
      const obj = node.expression
      const key = literal(node.argumentExpression) ? node.argumentExpression.text : null
      // `rows[0]`, `(await x)[1]`: a numeric index never names `constructor` or a loader.
      const numeric = T.isNumericLiteral(unwrap(node.argumentExpression))
      if (T.isMetaProperty(obj)) push('loader-alias', node, 'import.meta[...]')
      else if (isGlobalExpr(obj) || (T.isIdentifier(obj) && obj.text === 'Reflect')) {
        push('loader-alias', node, `${obj.getText(sf)}[...] (computed global member)`)
      } else if (key !== null && LOADER_PROPS.has(key)) {
        push('loader-alias', node, `${obj.getText(sf)}['${key}']`)
      } else if (key !== null && GLOBAL_PROPS.has(key) && passedAsValue(node)) {
        push('loader-alias', node, `\`${node.getText(sf)}\` (global object) passed as a value`)
      } else if (key === null && !numeric) {
        // Addendum 7d: any non-literal, non-numeric key triggers, whatever the receiver. Receiver
        // locality is not provable statically (members of locals, a computed key earlier in the
        // chain, mutation through a property or a call argument all reach `constructor`).
        push('loader-alias', node, `${obj.getText(sf)}[<non-literal>] (non-literal computed key)`)
      }
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
// An owner review edited after it was posted (SR-H-1: a write collaborator may be able to edit a
// review body; author and commit_id stay fixed) is a RESET, whatever its body says now: nothing
// approves until a newer, unedited verdict follows. Skipping it instead would revive an earlier
// APPROVE once the latest BLOCK is edited away. A review without a boolean `edited` (the old REST
// shape, which cannot tell) is treated as edited — fail closed.
// A DISMISSED review drops out only when it is an APPROVE; a dismissed BLOCK still blocks (SR-M-1).
export function latestVerdict(reviews, owner) {
  let latest = null
  for (const r of reviews) {
    if (String(r.author).toLowerCase() !== owner.toLowerCase()) continue
    if (r.edited !== false) {
      latest = { verdict: 'EDITED' }
      continue
    }
    const body = String(r.body ?? '')
    const first =
      body
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? ''
    const m = first.match(/^Owner Verdict:\s*(APPROVE|BLOCK)\s*$/)
    if (!m) continue
    if (r.state === 'DISMISSED' && m[1] === 'APPROVE') continue
    // Full 40-hex only: a short prefix could be satisfied by a later commit (Master addendum 3).
    const c = body.match(/^\s*Commit:\s*`?([0-9a-f]{40})`?\s*$/m)
    latest = { verdict: m[1], commit: c ? c[1] : null, state: r.state, commitId: r.commit_id }
  }
  return latest
}

export function verdictStatus(reviews, owner, headSha) {
  const v = latestVerdict(reviews, owner)
  if (!v) return { status: 'missing', reason: `no \`Owner Verdict:\` review by @${owner}` }
  if (v.verdict === 'EDITED')
    return {
      status: 'missing',
      reason: `an owner review was edited after it was posted — @${owner} posts a new verdict review`,
    }
  if (v.verdict === 'BLOCK')
    return { status: 'blocked', reason: `@${owner} posted \`Owner Verdict: BLOCK\`` }
  if (!['COMMENTED', 'APPROVED'].includes(v.state)) {
    return {
      status: 'missing',
      reason: `the APPROVE verdict sits in a ${v.state} review (needs COMMENT or APPROVE)`,
    }
  }
  if (!v.commit)
    return {
      status: 'stale',
      reason: 'the APPROVE verdict has no `Commit: <full 40-hex sha>` line',
    }
  if (v.commit !== headSha) {
    return {
      status: 'stale',
      reason: `the APPROVE verdict is for ${v.commit.slice(0, 7)}, head is ${headSha.slice(0, 7)}`,
    }
  }
  // The review's own commit_id is set by GitHub, not typed by anyone: it must be the head too.
  if (v.commitId !== headSha) {
    return {
      status: 'stale',
      reason: `the APPROVE review was submitted on ${String(v.commitId).slice(0, 7)}, head is ${headSha.slice(0, 7)}`,
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

// Realpaths on both sides (CR-M-5): a checkout reached through a symlink (macOS `/tmp`) must
// still run main, never exit 0 having printed nothing.
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (process.argv[1] && isMain()) main()
