/**
 * mobile-keyboard-fields.spec.ts — task-mobile-keyboards.md §1.
 *
 * "Страж первым, красным": scans every real `.tsx` source file under
 * `app/` for `<input>`/`<Input>`/`<textarea>`/`<Textarea>` JSX elements and
 * asserts each one either (a) needs no mobile-keyboard hint at all (native
 * non-text type, unconditionally `disabled`/`readOnly`, or named in the
 * explicit `EXEMPT_FIELDS` free-text allow-list) or (b) is classified in
 * `FIELD_CATEGORIES` AND carries every attribute that category requires.
 *
 * Classification is inverted (task §1): a NEW field found by the scanner
 * that is in neither list fails the "every field is classified" test below
 * by construction, forcing an explicit decision instead of silently
 * inheriting a loose default.
 *
 * `__tests__` fixtures themselves are excluded from the scan — they stub
 * DOM elements for unrelated component tests (e.g.
 * `ContractEditor.test.tsx`'s bare `<textarea>` mock), not real UI.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanFile, type ScannedField } from './support/input-scan'
import {
  CATEGORY_REQUIREMENTS,
  EXEMPT_FIELDS,
  FIELD_CATEGORIES,
} from './support/mobile-keyboard-registry'

const ROOT = resolve(__dirname, '..', '..') // apps/web
const APP_DIR = resolve(ROOT, 'app')

function listTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'test' || entry === 'node_modules') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      listTsxFiles(full, out)
    } else if (
      entry.endsWith('.tsx') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.spec.tsx')
    ) {
      out.push(full)
    }
  }
  return out
}

function scanAll(): ScannedField[] {
  const files = listTsxFiles(APP_DIR)
  return files.flatMap((f) => scanFile(f, ROOT))
}

describe('mobile keyboard attributes — task-mobile-keyboards.md', () => {
  const fields = scanAll()

  it('found a non-trivial number of input/textarea fields (scan sanity check)', () => {
    // Recon counted ~109 raw <input>/<Input>/<Textarea> occurrences in
    // apps/web. If the AST walk regresses to near-zero, every assertion
    // below would vacuously pass — this guards against that silent no-op.
    expect(fields.length).toBeGreaterThan(80)
  })

  it('every scanned field is either exempt (free text) or classified — no field falls through the cracks', () => {
    const unclassified = fields
      .filter((f) => !f.isNonTextType && !f.isNeverEditable)
      .filter((f) => !EXEMPT_FIELDS.has(f.key) && !FIELD_CATEGORIES[f.key])
      .map((f) => `${f.file}:${f.line} (${f.tag}, key="${f.key}")`)

    expect(
      unclassified,
      'New field(s) found that are neither in EXEMPT_FIELDS nor FIELD_CATEGORIES ' +
        '(apps/web/app/__tests__/support/mobile-keyboard-registry.ts). Classify it under the ' +
        'task-mobile-keyboards.md taxonomy, or add it to EXEMPT_FIELDS with a one-line reason ' +
        'if it is genuinely free text.',
    ).toEqual([])
  })

  it('every classified field carries all attributes its category requires', () => {
    const byKey = new Map(fields.map((f) => [f.key, f]))
    const violations: string[] = []

    for (const [key, category] of Object.entries(FIELD_CATEGORIES)) {
      const field = byKey.get(key)
      if (!field) {
        violations.push(
          `${key}: registered under FIELD_CATEGORIES but no longer found by the scanner (stale entry — field renamed/removed/moved?)`,
        )
        continue
      }
      const requirements = CATEGORY_REQUIREMENTS[category]
      for (const req of requirements) {
        if (!req.check(field.attrs)) {
          violations.push(
            `${field.file}:${field.line} (${key}, category=${category}) missing: ${req.describe}`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('EXEMPT_FIELDS entries still exist and are not ALSO double-booked in FIELD_CATEGORIES', () => {
    // Guards the inverted classification itself — a stale exemption
    // (renamed/removed field) silently stops protecting anything, and a
    // key present in both lists is an ambiguous, contradictory rule.
    const keys = new Set(fields.map((f) => f.key))
    const staleExemptions = [...EXEMPT_FIELDS].filter((k) => !keys.has(k))
    const doubleBooked = [...EXEMPT_FIELDS].filter((k) => FIELD_CATEGORIES[k])

    expect(staleExemptions, 'EXEMPT_FIELDS lists keys the scanner no longer finds').toEqual([])
    expect(doubleBooked, 'Keys present in BOTH EXEMPT_FIELDS and FIELD_CATEGORIES').toEqual([])
  })
})
