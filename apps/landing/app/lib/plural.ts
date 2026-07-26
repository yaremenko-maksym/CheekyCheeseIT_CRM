import type { PluralForms } from '@/i18n/dictionary'
import type { Locale } from '@/i18n/locale'

/**
 * CLDR-correct plural form selection via `Intl.PluralRules` (native, no
 * library) — review round 1 MED-1: a single `{count}`-substituted string
 * (the previous implementation) is grammatically wrong for ru/uk, which have
 * THREE forms (`one`/`few`/`many` — e.g. "3 открытые позиции" is wrong for
 * both count=1 and count=5) and mostly right but incidental for en/es/pt
 * (TWO forms — `one`/`other`).
 *
 * `Intl.PluralRules(locale).select(count)` returns the CLDR category for
 * `count` in `locale`'s language — verified against Node's ICU data for
 * every locale/count this app renders:
 *   ru/uk: 1→one, 2-4→few, 5-20→many, 21→one, 22-24→few, 25+→many
 *     (NOT a naive "n%10 in 2..4" range check — 11-14 are `many`, not
 *     `few`, the classic "teen exception" naive modulo-10 bucketing gets
 *     wrong; this is exactly why `Intl.PluralRules` is used instead of a
 *     hand-rolled range check).
 *   en/es/pt: 1→one, everything else→other.
 *
 * `zero`/`two` (categories some OTHER languages use) never occur for
 * en/uk/ru/es/pt, but are defensively routed to `other` below so this never
 * throws on an unexpected category.
 */
export function selectPluralForm(forms: PluralForms, locale: Locale, count: number): string {
  const category = new Intl.PluralRules(locale).select(count)
  const form = pickForm(forms, category)
  return form.replace('{count}', String(count))
}

function pickForm(forms: PluralForms, category: Intl.LDMLPluralRule): string {
  switch (category) {
    case 'one':
      return forms.one
    case 'few':
      return forms.few
    case 'many':
      return forms.many
    default:
      return forms.other
  }
}
