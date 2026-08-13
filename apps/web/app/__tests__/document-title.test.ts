/**
 * task-crm-tab-distinguishable — AC1/AC2/AC3.
 *
 * Mobile browser tabs truncate the title from the left edge. Before this
 * task, both apps/web/index.html ("CheekyCheeseIT CRM") and
 * apps/landing/index.html ("CheekyCheeseIT — AI, EdTech, E-Commerce")
 * shared the same leading substring, so a truncated tab read
 * "CheekyCheese…" for both — indistinguishable (see the task file for the
 * screenshot this was reported from).
 *
 * AC1/AC3 are asserted here directly against the SOURCE files (index.html /
 * site.webmanifest), not against a rendered DOM — this is a genuinely
 * static, build-time property (see AC2 below for why): nothing in
 * apps/web/app sets `document.title` at runtime, so whatever index.html
 * declares IS the title for the whole SPA session, on every route.
 *
 * AC2 ("не сбрасывается при переходах между разделами") is a claim about
 * the ABSENCE of runtime title-mutation code — pin it as a source-level
 * regression guard: if this ever starts failing, someone added
 * `document.title = ...` (or a Helmet-style per-route title) somewhere
 * under apps/web/app, and the E2E navigation coverage
 * (apps/e2e/tests/crm-tab-title.spec.ts) needs to be re-examined for
 * whether the new per-route title still starts distinguishably from the
 * landing's.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const WEB_ROOT = path.resolve(__dirname, '../..')
const APP_ROOT = path.resolve(__dirname, '..')

function readIndexHtml(): string {
  return readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8')
}

function readManifest(): { name: string; short_name: string } {
  const raw = readFileSync(path.join(WEB_ROOT, 'public/site.webmanifest'), 'utf8')
  return JSON.parse(raw) as { name: string; short_name: string }
}

/** Every .ts/.tsx file under apps/web/app, excluding this test itself. */
function listAppSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listAppSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && full !== __filename) {
      files.push(full)
    }
  }
  return files
}

describe('CRM tab title (task-crm-tab-distinguishable)', () => {
  it('AC1: index.html <title> starts with "CRM", distinguishable from the landing title', () => {
    const html = readIndexHtml()
    const match = html.match(/<title>([^<]*)<\/title>/)
    expect(match, 'index.html must declare a <title>').not.toBeNull()
    const title = match?.[1] ?? ''

    expect(title).toBe('CRM CheekyCheeseIT')
    expect(title.startsWith('CRM')).toBe(true)

    // The landing's title starts "CheekyCheeseIT — ..." — the two must diverge
    // within the first characters a truncated mobile tab actually shows.
    const landingTitlePrefix = 'CheekyCheeseIT'
    expect(title.slice(0, landingTitlePrefix.length)).not.toBe(landingTitlePrefix)
  })

  it('AC2 (regression guard): no source file under apps/web/app mutates document.title at runtime', () => {
    // If this starts failing, a per-route/dynamic title was introduced —
    // the static index.html assertion above is no longer sufficient proof
    // AC2 holds, and apps/e2e/tests/crm-tab-title.spec.ts must be checked.
    const offenders = listAppSourceFiles(APP_ROOT).filter((file) => {
      const content = readFileSync(file, 'utf8')
      return /document\.title\s*=/.test(content)
    })
    expect(offenders).toEqual([])
  })

  it('AC3: site.webmanifest name/short_name are CRM-specific, not the bare landing brand', () => {
    const manifest = readManifest()
    expect(manifest.name).toBe('CRM CheekyCheeseIT')
    expect(manifest.short_name).toBe('CRM CheekyCheeseIT')
    expect(manifest.name).not.toBe('CheekyCheeseIT')
    expect(manifest.short_name).not.toBe('CheekyCheeseIT')
  })
})
