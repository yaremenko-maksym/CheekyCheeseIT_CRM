import type { Locale } from '../locale'
import type { Dictionary } from '../dictionary'
import { en } from './en'
import { ru } from './ru'
import { uk } from './uk'

/** Locale -> Dictionary lookup — every route file imports `getDictionary(locale)` with its own hardcoded locale (never a dynamically-detected one, see `i18n/locale.ts` module doc). */
export const DICTIONARIES: Record<Locale, Dictionary> = { en, ru, uk }

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale]
}
