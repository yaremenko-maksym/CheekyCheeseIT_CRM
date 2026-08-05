import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A single separator, followed by EXACTLY three digits and nothing else
 * (one or more such groups) — the shape of a properly thousands-grouped
 * integer in EITHER US (`1,000`) or EU (`1.000`) convention. Matched
 * against the input with everything except digits and that one separator
 * stripped out first, so a stray `$` or space doesn't block the match.
 */
function looksLikeAmbiguousThousandsGrouping(raw: string, sep: ',' | '.'): boolean {
  const escaped = sep === '.' ? '\\.' : sep
  const cleaned = raw.replace(new RegExp(`[^0-9${escaped}]`, 'g'), '')
  return new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(cleaned)
}

/**
 * Normalizes raw decimal-amount input for `type="text"` + `inputMode="decimal"`
 * money fields (task-mobile-keyboards.md AC2).
 *
 * `type="number"` silently discards a value typed with a comma in
 * comma-decimal locales (ru/uk) — the field just goes blank, no error shown.
 * Switching to `type="text"` fixes the keyboard, but a raw text field must
 * do its OWN normalization.
 *
 * Three regimes (PR #481 review rounds 2 and 3 — both prior versions of this
 * function shipped a *worse* silent-corruption bug than the one they fixed:
 * round 1 turned `"1,000.50"` into `"1.00050"`, ~1000x off; round 2 fixed
 * that but turned `"1,000"` into `"1.000"` = 1, ALSO ~1000x off — both with
 * no error anywhere, whereas the old `type="number"` at least blanked the
 * field and tripped the `amt > 0` validator):
 *
 * - BOTH `,` and `.` appear — unambiguous by POSITION regardless of locale:
 *   thousands grouping always comes before the decimal point in both the US
 *   convention (`1,000.50`) and the EU one (`1.000,50`). The LAST separator
 *   (whichever symbol) is the decimal point; everything before it is
 *   thousands grouping and gets stripped like any other non-digit.
 *   `"1,000.50"` -> `"1000.50"`, `"1.000,50"` -> `"1000.50"`.
 * - Exactly ONE separator TYPE appears, in the shape of a properly
 *   thousands-grouped integer with no fractional part at all (a single
 *   separator followed by exactly three digits and nothing else, e.g.
 *   `"1,000"`, `"12,000"`, `"1,000,000"`) — this is GENUINELY AMBIGUOUS:
 *   `"1,000"` is one thousand under US convention, or `1.000` = 1 under
 *   this app's own ru/uk decimal convention, and the two readings differ by
 *   1000x. Nobody hand-types money to three decimal places, so guessing
 *   either way risks a silent order-of-magnitude error on real input (a
 *   pasted invoice/statement amount) — worse than refusing it. Left
 *   UNCHANGED (not normalized at all): a strict downstream numeric parse
 *   (`Number()`, or this module's `parseStrictAmount`) then correctly fails
 *   on the stray separator instead of accepting a plausible wrong number,
 *   surfacing each caller's EXISTING "invalid amount" validation — no new
 *   UI needed, and the field visibly still shows exactly what was typed.
 * - Exactly ONE separator TYPE appears, in any OTHER shape (a single digit
 *   after it, e.g. `"1,5"`; a non-3-digit tail; or the SAME separator
 *   repeated, e.g. `"1.2.3"`) — the FIRST occurrence is the decimal point,
 *   matching this app's primary ru/uk locale where a lone `,` is always a
 *   decimal separator, never a thousands group, and none of these shapes
 *   look like real thousands grouping anyway. `"1,5"` -> `"1.5"`,
 *   `"1.2.3"` -> `"1.23"` (both pinned pre-existing cases, unchanged).
 */
export function normalizeDecimalInput(raw: string): string {
  const hasComma = raw.includes(',')
  const hasDot = raw.includes('.')

  if (hasComma && hasDot) {
    const decimalPos = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'))
    const intPart = raw.slice(0, decimalPos).replace(/[^0-9]/g, '')
    const fracPart = raw.slice(decimalPos + 1).replace(/[^0-9]/g, '')
    return `${intPart}.${fracPart}`
  }

  if (hasComma !== hasDot) {
    const sep = hasComma ? ',' : '.'
    if (looksLikeAmbiguousThousandsGrouping(raw, sep)) return raw
  }

  const withDot = raw.replace(/,/g, '.')
  const firstDot = withDot.indexOf('.')
  if (firstDot === -1) return withDot.replace(/[^0-9]/g, '')
  const intPart = withDot.slice(0, firstDot).replace(/[^0-9]/g, '')
  const fracPart = withDot.slice(firstDot + 1).replace(/[^0-9]/g, '')
  return `${intPart}.${fracPart}`
}

/**
 * Strict decimal parse for money fields — succeeds ONLY if the ENTIRE
 * (trimmed) string is a clean, optionally-negative decimal number, unlike
 * `parseFloat`, which silently truncates at the first invalid character
 * (`parseFloat("1,000") === 1`, not `NaN`). That truncation is exactly what
 * would let an intentionally-unresolved ambiguous amount (see
 * `normalizeDecimalInput` above — `"1,000"` is left as raw text on purpose)
 * reach a submit handler as a plausible-but-wrong number instead of
 * tripping the caller's existing `isNaN(amt)` validation. Every call site
 * that used to do `parseFloat(amount)` on a value that flowed through
 * `normalizeDecimalInput` must use this instead (PR #481 review round 3).
 */
export function parseStrictAmount(value: string): number {
  const trimmed = value.trim()
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN
}
