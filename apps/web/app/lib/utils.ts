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
 * do its OWN normalization: this treats a comma exactly like a dot (the
 * user's most natural decimal separator), keeps only the FIRST separator
 * typed (a second `,`/`.` is dropped, matching how a real decimal input
 * behaves), and strips anything else that isn't a digit — so `"1,5"` -> `"1.5"`,
 * never `"15"` and never a silently emptied field.
 */
export function normalizeDecimalInput(raw: string): string {
  const withDot = raw.replace(/,/g, '.')
  const firstDot = withDot.indexOf('.')
  if (firstDot === -1) return withDot.replace(/[^0-9]/g, '')
  const intPart = withDot.slice(0, firstDot).replace(/[^0-9]/g, '')
  const fracPart = withDot.slice(firstDot + 1).replace(/[^0-9]/g, '')
  return `${intPart}.${fracPart}`
}
