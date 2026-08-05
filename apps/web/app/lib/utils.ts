import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
 * Two separator regimes, resolved unambiguously (PR #481 review round 2 —
 * the single-separator-only version below shipped a *worse* silent-corruption
 * bug than the one it fixed: `"1,000.50"` came out `"1.00050"`, ~1000x off,
 * with no error, whereas the old `type="number"` at least blanked the field
 * and tripped the `amt > 0` validator):
 *
 * - Only ONE separator TYPE appears (possibly repeated, e.g. `"1.2.3"`) — the
 *   FIRST occurrence is the decimal point, matching this app's primary ru/uk
 *   locale where a lone `,` is always a decimal separator, never a thousands
 *   group. `"1,5"` -> `"1.5"`, `"1.2.3"` -> `"1.23"` (pinned pre-existing case).
 * - BOTH `,` and `.` appear — this is unambiguous by POSITION regardless of
 *   locale: thousands grouping always comes before the decimal point in both
 *   the US convention (`1,000.50`) and the EU one (`1.000,50`). The LAST
 *   separator (whichever symbol) is the decimal point; everything before it
 *   is thousands grouping and gets stripped like any other non-digit.
 *   `"1,000.50"` -> `"1000.50"`, `"1.000,50"` -> `"1000.50"`.
 *
 * Every digit the user typed is preserved either way — never a 1000x
 * misread, never a silently emptied field.
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

  const withDot = raw.replace(/,/g, '.')
  const firstDot = withDot.indexOf('.')
  if (firstDot === -1) return withDot.replace(/[^0-9]/g, '')
  const intPart = withDot.slice(0, firstDot).replace(/[^0-9]/g, '')
  const fracPart = withDot.slice(firstDot + 1).replace(/[^0-9]/g, '')
  return `${intPart}.${fracPart}`
}
