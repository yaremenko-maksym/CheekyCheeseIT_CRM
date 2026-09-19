import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, localeSchema, resolveLocale } from './locales'

describe('resolveLocale', () => {
  it('takes the first supported candidate by language prefix', () => {
    expect(resolveLocale(['fr-FR', 'en-US', 'uk'])).toBe('en')
  })
  it('falls back to uk when nothing matches', () => {
    expect(resolveLocale([undefined, null, 'de'])).toBe(DEFAULT_LOCALE)
  })
  it('localeSchema rejects ru', () => {
    expect(localeSchema.safeParse('ru').success).toBe(false)
  })
})
