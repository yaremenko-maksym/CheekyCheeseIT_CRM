/**
 * task-landing-i18n.md A2 — "0 непереведённых ключей (тест: обход всех
 * ключей всех локалей — множества совпадают)". Walks every locale
 * dictionary recursively (objects AND arrays, so `home.services[0].bullets`
 * etc. are covered too, not just top-level keys) and asserts the full set
 * of key-PATHS is identical across all 5 locales, and that every leaf VALUE
 * is a non-empty string (catches an accidentally-empty translation, not
 * just a missing key).
 */
import { describe, expect, it } from 'vitest'
import { LOCALES } from '@/i18n/locale'
import { DICTIONARIES } from '@/i18n/dictionaries'

/** Recursively collects `path -> value` for every leaf (string) in an object/array tree. */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
    }
    return
  }
  out.set(prefix, value)
}

describe('i18n dictionaries — key-set parity (task-landing-i18n.md A2)', () => {
  const flattened = new Map(LOCALES.map((locale) => [locale, flatten2(DICTIONARIES[locale])]))

  function flatten2(dict: unknown): Map<string, unknown> {
    const out = new Map<string, unknown>()
    flatten(dict, '', out)
    return out
  }

  it('every locale exposes the exact same set of key-paths as `en` (the source of truth)', () => {
    const enKeys = new Set(flattened.get('en')!.keys())
    for (const locale of LOCALES) {
      if (locale === 'en') continue
      const localeKeys = new Set(flattened.get(locale)!.keys())
      const missing = [...enKeys].filter((k) => !localeKeys.has(k))
      const extra = [...localeKeys].filter((k) => !enKeys.has(k))
      expect(missing, `${locale} is missing keys present in en`).toEqual([])
      expect(extra, `${locale} has extra keys not present in en`).toEqual([])
    }
  })

  it('no leaf value is an empty/whitespace-only string in any locale (a "translated" key that is actually blank)', () => {
    // Filter to the string leaves first, then assert over them — instead of
    // `if (typeof value === 'string') expect(...)` inside the loop
    // (task-lint-teeth). Same coverage, and the extra `expect` on the collected
    // count means a dictionary that somehow yielded no string leaves at all
    // fails loudly rather than passing with zero assertions.
    const stringLeaves = LOCALES.flatMap((locale) =>
      [...flattened.get(locale)!]
        .filter(([, value]) => typeof value === 'string')
        .map(([path, value]) => [`${locale}.${path}`, value as string] as const),
    )

    expect(
      stringLeaves.length,
      'expected the dictionaries to contain string leaves',
    ).toBeGreaterThan(0)
    for (const [path, value] of stringLeaves) {
      expect(value.trim().length, `${path} is empty`).toBeGreaterThan(0)
    }
  })

  // Deliberately NOT asserting "most strings differ from en" here — plan §4
  // A2 draws an explicit line: the automated test's job is key-SET parity
  // (this describe block); "нет машинных артефактов" (no machine-translation
  // artifacts / lazy no-op copies) is an owner manual-review chip, not
  // something a heuristic should gate CI on. Several leaves are also
  // LEGITIMATELY identical across every locale by design (numeric stat/metric
  // values, `domainLabels`, the shared `titleSuffix` brand string,
  // `languageSwitcher.names` autonyms, deliberately-kept English terminology
  // like "Discovery" — task-landing-i18n.md's own "сохраняй терминологию…
  // где перевод звучит хуже") — a blanket difference-ratio check would be a
  // fragile proxy for the wrong thing.
})
