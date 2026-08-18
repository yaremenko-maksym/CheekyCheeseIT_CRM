/**
 * e2e-origin-agnostic-guard.spec.ts — task-e2e-origin-agnostic (AC5).
 *
 * Prevents recidivism of backlog item 84: a spec file re-introducing a
 * hardcoded `http://localhost:3001` (or any other live host:port) inside a
 * `page.route()` / `page.unroute()` / `page.request.<verb>()` call.
 *
 * Why this matters (see fixtures.ts `API_GLOB` / `API_RE` / `REAL_API_BASE`
 * comments for the full rationale): a route mock built from a literal origin
 * only matches when the web app happens to be served from EXACTLY that
 * host:port. It silently never fires against any other origin (dev-preview
 * on a scratch port, a different CI leg) — no error, the mock is simply never
 * installed and an earlier, broader mock (or the real, unmocked backend)
 * answers instead. That is what made the whole `apps/e2e` suite impossible to
 * run locally on free ports before this task: the failures were invisible
 * until someone actually tried.
 *
 * Fix when this fails: replace the literal origin with
 *   - `API_GLOB` (`'**\/api'`)   for plain-string `page.route()` / `.unroute()` patterns
 *   - `API_RE` (`'\\/api'`)      for `new RegExp(...)` patterns
 *   - `REAL_API_BASE`            for real (non-mocked) `page.request.<verb>()` calls
 * — all three exported from `./fixtures`.
 *
 * ── Design, round 2 (PR #563 review — pullrequestreview-4956780720) ────────
 *
 * Round 1 scanned line-by-line: a violation only registered when a
 * route/request call AND a literal `host:port` matched the SAME source line.
 * That catches exactly one of the four shapes AC1's inventory actually found
 * in this codebase — a literal typed straight into the call
 * (`page.route('http://localhost:3001/...', ...)`, 10 files, the rarest).
 * It is structurally blind to the other three, because in each of them the
 * literal and the call site are on DIFFERENT lines:
 *
 *   1. Literal directly in the call            — SAME line   (10 files)
 *   2. Shared re-declared `const API = '...'`  — DIFFERENT lines (28 files,
 *      the most common: `const API = 'http://localhost:3001/api'` at the top
 *      of the file, `page.route(\`${API}/...\`, ...)` dozens of lines later)
 *   3. A raw literal fed straight into `new RegExp('localhost:3001/...')`
 *      (interviews.spec.ts) — happens to be on one line in that particular
 *      file, but nothing about the SHAPE guarantees that; a constant-fed
 *      regex string is line 2's problem wearing a RegExp costume.
 *   4. An origin *derived* from `PLAYWRIGHT_BASE_URL` with a hardcoded
 *      fallback (`const _webOrigin = process.env['PLAYWRIGHT_BASE_URL'] ||
 *      'http://localhost:3000'`, then wrapped a level deeper into
 *      `` const API_BASE = `${_webOrigin}/api` `` — accountant-dashboard.spec.ts,
 *      drop-routing-hub.spec.ts) — DIFFERENT lines, two hops deep.
 *
 * Line-matching cannot be patched into catching 2–4 with a wider regex: the
 * declaration and the call site are two separate statements, sometimes two
 * separate `const`s apart. Connecting them needs to know what a `const`
 * NAME refers to, which needs a real parse — so this file now walks the
 * actual TypeScript AST (the `typescript` compiler API — already a project
 * dependency, same tool `apps/web/app/__tests__/support/input-scan.ts` uses
 * for its own recidivism guard) instead of scanning text lines:
 *
 *   Pass 1 — harvest every local `const`/`let NAME = <initializer>` in the
 *            file. Record whether the initializer's own text embeds a
 *            hardcoded origin, which OTHER identifiers it references, and
 *            whether it's guarded by `process.env` (the `?? '<fallback>'`
 *            idiom `REAL_API_BASE` and the historical `_webOrigin` bug both
 *            use).
 *   Pass 2 — resolve each declaration transitively (bounded, cycle-safe):
 *            a `const` that only re-wraps an already origin-bearing `const`
 *            (kind 4's `API_BASE` wrapping `_webOrigin`) is origin-bearing
 *            too, and only counts as env-overridable if EVERY literal
 *            feeding it carries the `process.env` guard.
 *   Pass 3 — walk every call expression; for `.route()` / `.unroute()` /
 *            `.request.<verb>()` calls, inspect ONLY the first argument
 *            (the URL/pattern) — never the handler body or request options,
 *            which legitimately contain arbitrary test-data strings (mock
 *            presigned-download URLs, cache keys) that happen to look like
 *            an origin but are never matched against anything (see the
 *            negative-control tests below — this is what the four false
 *            positives from the prior scanner draft were).
 *
 * Verdict per call site:
 *   - `.route()` / `.unroute()` (a MOCK): ANY traced origin — literal or via
 *     a constant, env-overridable or not — is a violation. `page.route()`
 *     matches the browser-fetch URL; an env override changes WHICH single
 *     origin the pattern is pinned to, not the fact that it is pinned to
 *     one. That is kind 4's actual bug: `_webOrigin` genuinely honoured
 *     `PLAYWRIGHT_BASE_URL`, and it was still wrong, because the fix for a
 *     mock is "match by path, ignore the origin entirely" (`API_GLOB` /
 *     `API_RE`), not "get the origin right". No leniency for mocks.
 *   - `.request.<verb>()` (a REAL, non-mocked call): an origin is
 *     legitimately required — Playwright must send the HTTP request
 *     somewhere. A BARE literal is still a violation (not overridable,
 *     breaks on any other port — the historical `drop-confirm-payout-edges/
 *     -distribution-edge/-distribution.spec.ts` bugs). A traced constant is
 *     only accepted if EVERY literal in its chain carries a `process.env`
 *     guard — the `REAL_API_BASE` idiom.
 *
 * Known gap (see also the module doc's own admission at the top): this is a
 * per-FILE, name-based reference graph — it does not do real lexical scope
 * resolution (no shadowing awareness) and it does not follow imports across
 * files (an imported `REAL_API_BASE` is invisible to this scan, which is
 * exactly why importing it from `fixtures.ts` rather than re-declaring it
 * locally is safe — there is nothing left to trace). A `const` whose origin
 * is built through something more indirect than a same-file identifier
 * chain (a function call, a cross-file re-export under a new name, string
 * concatenation via `+` instead of a template literal) is NOT caught. Those
 * are not shapes AC1's inventory found anywhere in this codebase; if one
 * shows up, it needs a fifth self-test case here, not a wider regex.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const TESTS_DIR = path.resolve(__dirname)
const THIS_FILE = path.resolve(__filename)

function collectSpecFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectSpecFiles(full, out)
    } else if (entry.endsWith('.spec.ts')) {
      out.push(full)
    }
  }
  return out
}

// Any live host:port — not just :3001 (the historical default), per AC1's
// "не только 3001" instruction: the web port (3000), a scratch port, etc.
const HARDCODED_ORIGIN_RE = /(localhost|127\.0\.0\.1):\d{2,5}/
// The `process.env['X']` / `process.env.X` guard that makes a fallback
// literal legitimately overridable at runtime (the `REAL_API_BASE` idiom).
const ENV_OVERRIDE_RE = /process\.env(\.|\[)/

type CallKind = 'mock' | 'real'

/** One `const`/`let NAME = <initializer>` declaration harvested from a file. */
interface DeclInfo {
  /** Every free identifier referenced anywhere inside the initializer. */
  refs: Set<string>
  hasDirectLiteral: boolean
  hasEnvGuard: boolean
  resolved?: { originBearing: boolean; envOverride: boolean }
}

/** Collects every `Identifier` name referenced anywhere under `node`. */
function collectIdentifierRefs(node: ts.Node, out: Set<string>): void {
  if (ts.isIdentifier(node)) out.add(node.text)
  ts.forEachChild(node, (child) => collectIdentifierRefs(child, out))
}

/**
 * Classifies a call's callee expression — `null` for anything that isn't a
 * `.route()` / `.unroute()` / `.request.<verb>()` call (matches whatever
 * object the method is invoked on: `page`, `asAdmin`, `asSenior`, ...).
 */
function calleeKind(expr: ts.Expression): CallKind | null {
  if (!ts.isPropertyAccessExpression(expr)) return null
  const method = expr.name.text
  if (method === 'route' || method === 'unroute') return 'mock'
  if (
    method === 'get' ||
    method === 'post' ||
    method === 'put' ||
    method === 'patch' ||
    method === 'delete'
  ) {
    const inner = expr.expression
    if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'request') return 'real'
  }
  return null
}

/**
 * Scan a single file's source (real TypeScript AST, see the module doc's
 * "Design, round 2" section above) for route/request call sites whose
 * URL/pattern argument embeds — directly or via a traced local `const` — a
 * hardcoded live origin. Exported (not just used internally) so the
 * self-tests below can exercise the exact same logic against synthetic
 * inputs covering all four known recidivism shapes, proving the scanner
 * actually detects each one — not just that the real tree is clean.
 */
export function findOriginViolations(source: string, label = '<memory>'): string[] {
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )

  // Pass 1 — harvest every local `const`/`let NAME = <initializer>`.
  const decls = new Map<string, DeclInfo>()
  function harvest(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = node.initializer.getText(sourceFile)
      const refs = new Set<string>()
      collectIdentifierRefs(node.initializer, refs)
      decls.set(node.name.text, {
        refs,
        hasDirectLiteral: HARDCODED_ORIGIN_RE.test(text),
        hasEnvGuard: ENV_OVERRIDE_RE.test(text),
      })
    }
    ts.forEachChild(node, harvest)
  }
  harvest(sourceFile)

  // Pass 2 — resolve each declaration transitively. `seen` is per top-level
  // resolve() call (not shared across declarations) so it only guards
  // against genuine self-reference cycles within one chain, not against
  // re-visiting a name from a sibling branch.
  function resolve(
    name: string,
    seen: Set<string>,
  ): { originBearing: boolean; envOverride: boolean } {
    const info = decls.get(name)
    if (!info) return { originBearing: false, envOverride: false }
    if (info.resolved) return info.resolved
    if (seen.has(name)) return { originBearing: false, envOverride: false }
    seen.add(name)
    let originBearing = info.hasDirectLiteral
    let envOverride = info.hasDirectLiteral ? info.hasEnvGuard : true
    for (const ref of info.refs) {
      const r = resolve(ref, seen)
      if (r.originBearing) {
        originBearing = true
        envOverride = envOverride && r.envOverride
      }
    }
    if (!originBearing) envOverride = false
    info.resolved = { originBearing, envOverride }
    return info.resolved
  }
  for (const name of decls.keys()) resolve(name, new Set())

  // Pass 3 — walk every call expression; only the first argument (the
  // URL/pattern) of a route/unroute/request.<verb> call is inspected — see
  // the module doc for why the handler body / request options are excluded.
  const violations: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const kind = calleeKind(node.expression)
      const pattern = node.arguments[0]
      if (kind && pattern) {
        const directHit = HARDCODED_ORIGIN_RE.test(pattern.getText(sourceFile))
        const refs = new Set<string>()
        collectIdentifierRefs(pattern, refs)
        let tracedOriginBearing = false
        let tracedNonOverridable = false
        for (const ref of refs) {
          const r = resolve(ref, new Set())
          if (r.originBearing) {
            tracedOriginBearing = true
            if (!r.envOverride) tracedNonOverridable = true
          }
        }
        const violates =
          kind === 'mock' ? directHit || tracedOriginBearing : directHit || tracedNonOverridable
        if (violates) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          const snippet = node.getText(sourceFile).split('\n')[0]
          violations.push(`${label}:${line + 1}: ${snippet}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

test.describe('E2E origin-agnostic guard (task-e2e-origin-agnostic, AC5)', () => {
  test('no spec file hardcodes a live host:port in a route/request pattern', () => {
    const specFiles = collectSpecFiles(TESTS_DIR)
    const violations: string[] = []
    for (const file of specFiles) {
      if (path.resolve(file) === THIS_FILE) continue
      const source = readFileSync(file, 'utf-8')
      violations.push(...findOriginViolations(source, path.relative(TESTS_DIR, file)))
    }
    expect(
      violations,
      [
        'Hardcoded-origin route/request call(s) found — these silently stop',
        'matching whenever the web app is not served from exactly that',
        'host:port (scratch ports, a different CI leg). Use API_GLOB / API_RE',
        '(page.route mocks) or REAL_API_BASE (real page.request calls) from',
        "./fixtures instead. See this file's module doc for details.",
        '',
        ...violations,
      ].join('\n'),
    ).toEqual([])
  })

  // One case per known recidivism shape (AC1's inventory), each proven
  // separately — a single combined self-test only proves the scanner catches
  // SOME shape, not that it catches all four (that gap is exactly what round 1
  // shipped: a self-test that only ever exercised kind 1).
  test.describe('self-test — catches each of the four known shapes', () => {
    test('kind 1 — literal directly in a route() call', () => {
      const bad = `
import { test } from './fixtures'
test('example', async ({ page }) => {
  await page.route('http://localhost:3001/api/auth/me', (r) => r.fulfill({ status: 200, body: '{}' }))
})
`
      const violations = findOriginViolations(bad, 'kind1.spec.ts')
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('localhost:3001')
      expect(violations[0]).toContain('kind1.spec.ts:4')
    })

    test('kind 2 — origin traced through a shared re-declared constant', () => {
      const bad = `
const API = 'http://localhost:3001/api'
test('example', async ({ page }) => {
  await page.route(\`\${API}/transactions(\\\\?.*)?$\`, (r) => r.fulfill({}))
})
`
      const violations = findOriginViolations(bad, 'kind2.spec.ts')
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('kind2.spec.ts:4')
    })

    test('kind 3 — a regex-string literal, inline and via a constant', () => {
      // Inline — interviews.spec.ts's actual historical bug: the literal is
      // fed straight into `new RegExp(...)`, no named constant at all.
      const inlineLiteral = `
test('example', async ({ page }) => {
  await page.route(new RegExp('localhost:3001/api/interviews(\\\\?.*)?$'), (r) => r.fulfill({}))
})
`
      const v1 = findOriginViolations(inlineLiteral, 'kind3-inline.spec.ts')
      expect(v1).toHaveLength(1)
      expect(v1[0]).toContain('localhost:3001')

      // Via a constant — the same regex-string shape, but structurally a
      // kind-2 variant (declaration and call site on different lines) rather
      // than a same-line literal; exercised separately so a fix for one
      // doesn't silently stop covering the other.
      const viaConstant = `
const API_RE_LOCAL = 'localhost:3001/api'
test('example', async ({ page }) => {
  await page.route(new RegExp(\`\${API_RE_LOCAL}/interviews(\\\\?.*)?$\`), (r) => r.fulfill({}))
})
`
      const v2 = findOriginViolations(viaConstant, 'kind3-via-const.spec.ts')
      expect(v2).toHaveLength(1)
      expect(v2[0]).toContain('kind3-via-const.spec.ts:4')
    })

    test('kind 4 — origin derived from PLAYWRIGHT_BASE_URL, wrapped a level deep', () => {
      // Mirrors accountant-dashboard.spec.ts / drop-routing-hub.spec.ts's
      // actual historical bug: `API_BASE` re-wraps `_webOrigin` instead of
      // embedding the literal itself — the transitive resolve() in pass 2
      // is what this shape specifically exercises.
      const bad = `
const _webOrigin =
  (typeof process !== 'undefined' && process.env['PLAYWRIGHT_BASE_URL']) || 'http://localhost:3000'
const API_BASE = \`\${_webOrigin}/api\`
test('example', async ({ page }) => {
  await page.route(new RegExp(\`\${API_BASE}/transactions(\\\\?.*)?$\`), (r) => r.fulfill({}))
})
`
      const violations = findOriginViolations(bad, 'kind4.spec.ts')
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('kind4.spec.ts:6')
    })
  })

  // Each shape above has a real counterpart here proving no false positive —
  // these are exactly the code shapes that surround every real call site in
  // the migrated suite, and every one of them must stay green.
  test.describe('negative controls — must NOT false-positive', () => {
    test('prose/comments mentioning the literal are ignored (not AST nodes)', () => {
      const clean = `
// Previously hardcoded to 'http://localhost:3001/api/auth/me' — fixed.
test('example', async ({ page }) => {
  await page.route(\`\${API_GLOB}/auth/me\`, (r) => r.fulfill({ status: 200, body: '{}' }))
})
`
      expect(findOriginViolations(clean, 'clean-comment.spec.ts')).toEqual([])
    })

    test('test-data values inside a handler body are not the route pattern', () => {
      // Real shape: fixtures.ts / ui-invariants-pr56.spec.ts /
      // invoices-signing-flow.spec.ts return a fake MinIO presigned-download
      // URL as response BODY data — port 9000, looks exactly like a live
      // origin, and is never matched against anything. This is what the
      // prior scanner draft's four false positives actually were.
      const clean = `
test('example', async ({ page }) => {
  await page.route(\`\${API_RE}/documents/download\`, (r) =>
    r.fulfill({ status: 200, body: JSON.stringify({ url: 'http://localhost:9000/mock.pdf' }) }),
  )
})
`
      expect(findOriginViolations(clean, 'clean-testdata.spec.ts')).toEqual([])
    })

    test('a real (non-mocked) call through an env-overridable constant is not the bug this guard targets', () => {
      const clean = `
const REAL_API_BASE = process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'
test('example', async ({ page }) => {
  await page.request.post(\`\${REAL_API_BASE}/api/auth/dev-login\`, { data: {} })
})
`
      expect(findOriginViolations(clean, 'clean-real-api-base.spec.ts')).toEqual([])
    })

    test('a MOCK through the SAME env-overridable idiom is still a violation — mocks get no leniency', () => {
      const bad = `
const API_BASE = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000'
test('example', async ({ page }) => {
  await page.route(\`\${API_BASE}/api/transactions\`, (r) => r.fulfill({}))
})
`
      expect(findOriginViolations(bad, 'mock-env-override-still-bad.spec.ts')).toHaveLength(1)
    })
  })
})
