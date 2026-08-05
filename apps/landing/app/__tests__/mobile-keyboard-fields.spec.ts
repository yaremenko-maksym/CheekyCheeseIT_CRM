/**
 * mobile-keyboard-fields.spec.ts — task-mobile-keyboards.md §1 (apps/landing).
 * See `apps/web/app/__tests__/mobile-keyboard-fields.spec.ts` for the full
 * rationale — same inverted-classification guard, scoped to the landing
 * app's two public marketing forms.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanFile, type ScannedField } from './support/input-scan'
import { CATEGORY_REQUIREMENTS, EXEMPT_FIELDS, FIELD_CATEGORIES } from './support/mobile-keyboard-registry'

const ROOT = resolve(__dirname, '..', '..') // apps/landing
const APP_DIR = resolve(ROOT, 'app')

function listTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'test' || entry === 'node_modules') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      listTsxFiles(full, out)
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx') && !entry.endsWith('.spec.tsx')) {
      out.push(full)
    }
  }
  return out
}

function scanAll(): ScannedField[] {
  const files = listTsxFiles(APP_DIR)
  return files.flatMap((f) => scanFile(f, ROOT))
}

describe('mobile keyboard attributes — task-mobile-keyboards.md (landing)', () => {
  const fields = scanAll()

  it('found the expected marketing-form fields (scan sanity check)', () => {
    // Recon counted ~13 <input>/<Input>/<Textarea> occurrences in apps/landing.
    expect(fields.length).toBeGreaterThan(8)
  })

  it('every scanned field is either exempt (free text) or classified', () => {
    const unclassified = fields
      .filter((f) => !f.isNonTextType && !f.isNeverEditable)
      .filter((f) => !EXEMPT_FIELDS.has(f.key) && !FIELD_CATEGORIES[f.key])
      .map((f) => `${f.file}:${f.line} (${f.tag}, key="${f.key}")`)

    expect(
      unclassified,
      'New field(s) found that are neither in EXEMPT_FIELDS nor FIELD_CATEGORIES ' +
        '(apps/landing/app/__tests__/support/mobile-keyboard-registry.ts).',
    ).toEqual([])
  })

  it('every classified field carries all attributes its category requires', () => {
    const byKey = new Map(fields.map((f) => [f.key, f]))
    const violations: string[] = []

    for (const [key, category] of Object.entries(FIELD_CATEGORIES)) {
      const field = byKey.get(key)
      if (!field) {
        violations.push(`${key}: registered under FIELD_CATEGORIES but no longer found by the scanner (stale entry)`)
        continue
      }
      for (const req of CATEGORY_REQUIREMENTS[category]) {
        if (!req.check(field.attrs)) {
          violations.push(`${field.file}:${field.line} (${key}, category=${category}) missing: ${req.describe}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('EXEMPT_FIELDS entries still exist and are not double-booked in FIELD_CATEGORIES', () => {
    const keys = new Set(fields.map((f) => f.key))
    const staleExemptions = [...EXEMPT_FIELDS].filter((k) => !keys.has(k))
    const doubleBooked = [...EXEMPT_FIELDS].filter((k) => FIELD_CATEGORIES[k])

    expect(staleExemptions, 'EXEMPT_FIELDS lists keys the scanner no longer finds').toEqual([])
    expect(doubleBooked, 'Keys present in BOTH EXEMPT_FIELDS and FIELD_CATEGORIES').toEqual([])
  })
})
