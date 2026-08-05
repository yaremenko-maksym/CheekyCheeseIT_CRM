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
  ACKNOWLEDGED_SENSITIVE_EXEMPTIONS,
  CATEGORY_REQUIREMENTS,
  EXEMPT_FIELDS,
  FIELD_CATEGORIES,
  SENSITIVE_KEYWORDS,
} from './support/mobile-keyboard-registry'

/** Below this many trimmed characters, a "reason" is a lazy rubber stamp, not an explanation. */
const MIN_REASON_LENGTH = 12

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
      .filter((f) => !(f.key in EXEMPT_FIELDS) && !FIELD_CATEGORIES[f.key])
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
    const exemptKeys = Object.keys(EXEMPT_FIELDS)
    const staleExemptions = exemptKeys.filter((k) => !keys.has(k))
    const doubleBooked = exemptKeys.filter((k) => FIELD_CATEGORIES[k])

    expect(staleExemptions, 'EXEMPT_FIELDS lists keys the scanner no longer finds').toEqual([])
    expect(doubleBooked, 'Keys present in BOTH EXEMPT_FIELDS and FIELD_CATEGORIES').toEqual([])
  })

  // PR #481 review round 2 (MED) — a mutation test proved that moving a
  // REAL classified field (e.g. the money input) into EXEMPT_FIELDS with a
  // plausible-looking comment was caught by NOTHING: the guard only ever
  // checked "is this key present somewhere", never "is this exemption
  // legitimate". These two checks are the mitigation — not a claim that a
  // determined rewrite of the registry can't still lie, but a real second
  // signal that must ALSO be defeated.
  it('every EXEMPT_FIELDS reason is a substantive explanation, not an empty/lazy rubber stamp', () => {
    const weak = Object.entries(EXEMPT_FIELDS)
      .filter(([, reason]) => reason.trim().length < MIN_REASON_LENGTH)
      .map(([key, reason]) => `${key}: reason too short/empty ("${reason}")`)

    expect(weak).toEqual([])
  })

  it('a money/wallet/contact-shaped key cannot hide in EXEMPT_FIELDS without an explicit acknowledged override', () => {
    // The key text is derived by the scanner from the real `data-testid`/
    // `id`/`name` in source — it can't be faked without renaming the
    // attribute in source, which would also break every OTHER selector
    // (unit + E2E) targeting that field. This is the check that catches
    // the reviewer's exact repro: `testid:amount-currency-amount-input`
    // moved into EXEMPT_FIELDS still contains "amount".
    const unacknowledged = Object.keys(EXEMPT_FIELDS)
      .filter((key) => SENSITIVE_KEYWORDS.some((kw) => key.toLowerCase().includes(kw)))
      .filter((key) => !(key in ACKNOWLEDGED_SENSITIVE_EXEMPTIONS))

    expect(
      unacknowledged,
      'Key(s) in EXEMPT_FIELDS look money/wallet/contact-shaped by name. Either classify the field ' +
        'properly under FIELD_CATEGORIES, or — if it genuinely is free text despite the keyword — add ' +
        'it to ACKNOWLEDGED_SENSITIVE_EXEMPTIONS with a reason addressing the keyword specifically.',
    ).toEqual([])
  })

  it('every ACKNOWLEDGED_SENSITIVE_EXEMPTIONS override is itself substantive, and is not stale', () => {
    const weak = Object.entries(ACKNOWLEDGED_SENSITIVE_EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length < MIN_REASON_LENGTH)
      .map(([key, reason]) => `${key}: override reason too short/empty ("${reason}")`)
    const stale = Object.keys(ACKNOWLEDGED_SENSITIVE_EXEMPTIONS).filter(
      (key) => !(key in EXEMPT_FIELDS),
    )

    expect(weak).toEqual([])
    expect(
      stale,
      'ACKNOWLEDGED_SENSITIVE_EXEMPTIONS lists a key no longer present in EXEMPT_FIELDS',
    ).toEqual([])
  })
})
