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
 * This guard is a plain Node scan (no browser needed) over every
 * `apps/e2e/tests/**\/*.spec.ts` file, run as part of the same `playwright
 * test` invocation as everything else — no separate CI wiring required.
 *
 * Fix when this fails: replace the literal origin with
 *   - `API_GLOB` (`'**\/api'`)   for plain-string `page.route()` / `.unroute()` patterns
 *   - `API_RE` (`'\\/api'`)      for `new RegExp(...)` patterns
 *   - `REAL_API_BASE`            for real (non-mocked) `page.request.<verb>()` calls
 * — all three exported from `./fixtures`.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

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

// A "call site" is a page/fixture route or real-request invocation — the
// only place a hardcoded origin actually breaks anything (a mention in prose
// or a documented default fallback is fine, see the exclusions below).
const CALL_SITE_RE = /\.(route|unroute|request\.(get|post|put|patch|delete))\s*\(/
// Any live host:port — not just :3001 (the historical default), per AC1's
// "не только 3001" instruction: the web port (3000), a scratch port, etc.
const HARDCODED_ORIGIN_RE = /(localhost|127\.0\.0\.1):\d{2,5}/

/**
 * Scan a single file's source for call-site lines that embed a hardcoded
 * origin. Exported (not just used internally) so the self-test below can
 * exercise the exact same logic against a synthetic bad input — proving the
 * scanner actually detects violations, not just that the real tree is clean.
 */
export function findOriginViolations(source: string, label = '<memory>'): string[] {
  const violations: string[] = []
  source.split('\n').forEach((line, idx) => {
    const trimmed = line.trim()
    // Full-line comments (// ... or JSDoc * ...) document history/rationale
    // and often mention the old hardcoded literal on purpose — not a call site.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (CALL_SITE_RE.test(line) && HARDCODED_ORIGIN_RE.test(line)) {
      violations.push(`${label}:${idx + 1}: ${trimmed}`)
    }
  })
  return violations
}

test.describe('E2E origin-agnostic guard (task-e2e-origin-agnostic, AC5)', () => {
  test('no spec file hardcodes a live host:port in a route/request call', () => {
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

  test('scanner catches a hardcoded origin — proves the guard is not vacuous', () => {
    const badSource = `
import { test } from './fixtures'
test('example', async ({ page }) => {
  await page.route('http://localhost:3001/api/auth/me', (r) => r.fulfill({ status: 200, body: '{}' }))
})
`
    const violations = findOriginViolations(badSource, 'synthetic-bad-fixture.spec.ts')
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('localhost:3001')
    expect(violations[0]).toContain('synthetic-bad-fixture.spec.ts:4')

    // A RegExp call site with the same defect must also be caught.
    const badRegexSource = `
test('example', async ({ page }) => {
  await page.route(new RegExp('localhost:3001/api/interviews(\\\\?.*)?$'), (r) => r.fulfill({}))
})
`
    expect(findOriginViolations(badRegexSource, 'synthetic-bad-regex.spec.ts')).toHaveLength(1)

    // Prose/comments mentioning the same literal must NOT be flagged — the
    // guard targets call sites, not documentation of the historical bug.
    const cleanCommentSource = `
// Previously hardcoded to 'http://localhost:3001/api/auth/me' — fixed.
test('example', async ({ page }) => {
  await page.route(\`\${API_GLOB}/auth/me\`, (r) => r.fulfill({ status: 200, body: '{}' }))
})
`
    expect(findOriginViolations(cleanCommentSource, 'synthetic-clean.spec.ts')).toEqual([])
  })
})
