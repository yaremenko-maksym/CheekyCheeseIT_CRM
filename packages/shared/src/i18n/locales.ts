import { z } from 'zod'

export const LOCALES = ['uk', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'uk'
export const localeSchema = z.enum(LOCALES)
export const LOCALE_COOKIE_NAME = 'pref_locale'

function toLocale(candidate: string): Locale | null {
  const prefix = candidate.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return (LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : null
}

/** First supported candidate wins (`en-US` → `en`); nothing supported → `uk`. */
export function resolveLocale(candidates: ReadonlyArray<string | null | undefined>): Locale {
  for (const c of candidates) {
    if (!c) continue
    const found = toLocale(c)
    if (found) return found
  }
  return DEFAULT_LOCALE
}
