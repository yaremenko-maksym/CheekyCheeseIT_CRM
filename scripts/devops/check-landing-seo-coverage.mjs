#!/usr/bin/env node
/**
 * check-landing-seo-coverage.mjs — task-infra-silent-failures (2026-08-01)
 *
 * Independent, CI-side witness for a class of regression already documented
 * in apps/landing/scripts/prerender.mjs's `assertJsonLd` (search
 * "CI's Lighthouse job never exercised because it always built against 0
 * PUBLISHED vacancies") and repeated as the root cause of the Deploy outage
 * 2026-07-27 21:22 → 2026-07-31: the landing build only validates vacancy
 * structured data (JobPosting / ItemList JSON-LD) when the build actually
 * runs against a NON-EMPTY, PUBLISHED vacancy set. When it was always built
 * against zero vacancies, that validation silently never ran, and SEO-less
 * pages shipped to prod undetected.
 *
 * `ci.yml`'s `landing` E2E shard already closes the "always zero" gap going
 * forward: `apps/e2e/scripts/seed-landing.ts` seeds 2 PUBLISHED + 1 CLOSED
 * vacancy through the real admin API BEFORE `build:prerender` runs (PR #433,
 * 2026-07-26) — so `prerender.mjs`'s own `assertJsonLd` already exercises
 * this path on every code-touching PR. This script is a SECOND, INDEPENDENT
 * witness on top of that: it does not import or re-use anything from
 * prerender.mjs (Coder zone — this repo's DevOps zone-of-write does not
 * extend there), and it inspects the ALREADY-BUILT `dist/` output directly,
 * the same way a search engine crawler would. That means this guard keeps
 * catching the "shipped without real structured data" class of regression
 * even in a future where prerender.mjs's own internal assertions are ever
 * weakened, refactored away, or accidentally skipped — belt-and-suspenders,
 * same spirit as prerender.mjs's own multiple "belt-and-suspenders" checks.
 *
 * Usage (from repo root, AFTER `pnpm --filter @crm/landing build:prerender`
 * has produced apps/landing/dist/ against a non-empty vacancy set):
 *   node scripts/devops/check-landing-seo-coverage.mjs
 *
 * Exits non-zero with an `::error::`-prefixed message (GitHub Actions
 * annotation) on any check failure.
 *
 * Tests: scripts/devops/tests/test-check-landing-seo-coverage.sh — positive AND
 * negative cases, including an ItemList that is present, valid and EMPTY (the
 * exact shape of the 2026-07-27 outage: technically-correct markup carrying zero
 * jobs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'apps/landing/dist'

/** @param {string} msg */
function fail(msg) {
  console.error(`::error::check-landing-seo-coverage: ${msg}`)
  process.exit(1)
}

/**
 * Mirrors prerender.mjs's own `extractJsonLd` (same `id="seo-json-ld"`
 * marker — see that file's `use-document-head.ts` `JSON_LD_ELEMENT_ID`
 * constant) — duplicated on purpose rather than imported, so this check
 * does not depend on prerender.mjs continuing to export (or even contain)
 * that helper.
 * @param {string} html
 * @returns {unknown}
 */
function extractJsonLd(html) {
  const match = html.match(/<script id="seo-json-ld"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

if (!existsSync(DIST)) {
  fail(`${DIST} does not exist — did build:prerender run first?`)
}

// 1. The vacancy LIST page must ship a non-empty ItemList JSON-LD.
const listPath = join(DIST, 'careers', 'index.html')
if (!existsSync(listPath)) {
  fail(`${listPath} missing — /careers was not prerendered`)
}
const listHtml = readFileSync(listPath, 'utf8')
const listData = /** @type {any} */ (extractJsonLd(listHtml))
if (
  !listData ||
  listData['@type'] !== 'ItemList' ||
  !Array.isArray(listData.itemListElement) ||
  listData.itemListElement.length === 0
) {
  fail(
    `${listPath} has no non-empty ItemList JSON-LD — the vacancy list page shipped ` +
      'without SEO markup (exactly the class of bug that silently reached prod when ' +
      'CI always built against 0 vacancies).',
  )
}

// 2. At least one prerendered vacancy DETAIL page (dist/careers/<slug>/
// index.html, siblings of the list page above, never the list page itself)
// must carry real JobPosting JSON-LD.
const careersDir = join(DIST, 'careers')
const detailDirs = readdirSync(careersDir, { withFileTypes: true }).filter((e) => e.isDirectory())

if (detailDirs.length === 0) {
  fail(
    `${careersDir} has no vacancy detail subdirectories — no vacancy detail page was ` +
      'prerendered at all. Did seed-landing.ts run, and did it publish anything?',
  )
}

let sawJobPosting = false
for (const dir of detailDirs) {
  const detailPath = join(careersDir, dir.name, 'index.html')
  if (!existsSync(detailPath)) continue
  const detailHtml = readFileSync(detailPath, 'utf8')
  const detailData = extractJsonLd(detailHtml)
  if (Array.isArray(detailData) && detailData.some((entry) => entry?.['@type'] === 'JobPosting')) {
    sawJobPosting = true
    break
  }
}

if (!sawJobPosting) {
  fail(
    `none of the ${detailDirs.length} prerendered vacancy detail page(s) under ${careersDir} ` +
      'carry JobPosting JSON-LD — vacancy pages shipped without structured data.',
  )
}

console.log(
  'check-landing-seo-coverage: OK — vacancy list + at least one detail page ship real structured data.',
)
