/**
 * selectPluralForm — task-landing-contact-and-hiring-strip.md review round 1
 * MED-1: `hiringStrip.text` must be CLDR-pluralized per locale, not a single
 * `{count}`-substituted string (grammatically wrong for ru/uk at every count
 * other than the one it was written for). Matrix drawn from the review
 * comment itself (1, 2, 4, 5, 11, 21 for ru/uk — including the CLDR "teen
 * exception": 11 is `many`, NOT `few`, despite `11 % 10 === 1` looking like
 * it should follow the `one`/1-ending pattern) + a couple of values for the
 * two-form locales (en/es/pt).
 */
import { describe, expect, it } from 'vitest'
import { selectPluralForm } from '@/lib/plural'
import { getDictionary } from '@/i18n/dictionaries'

describe('selectPluralForm', () => {
  describe('ru — one/few/many (CLDR, not naive n%10 in 2..4 bucketing)', () => {
    const text = getDictionary('ru').hiringStrip.text

    it.each([
      [1, 'Мы нанимаем — 1 открытая позиция'],
      [2, 'Мы нанимаем — 2 открытые позиции'],
      [4, 'Мы нанимаем — 4 открытые позиции'],
      [5, 'Мы нанимаем — 5 открытых позиций'],
      [11, 'Мы нанимаем — 11 открытых позиций'], // teen exception → many, NOT few
      [21, 'Мы нанимаем — 21 открытая позиция'], // ends in 1, not 11 → one
    ])('count=%i → %s', (count, expected) => {
      expect(selectPluralForm(text, 'ru', count)).toBe(expected)
    })
  })

  describe('uk — one/few/many (same CLDR category structure as ru)', () => {
    const text = getDictionary('uk').hiringStrip.text

    it.each([
      [1, 'Ми наймаємо — 1 відкрита позиція'],
      [2, 'Ми наймаємо — 2 відкриті позиції'],
      [4, 'Ми наймаємо — 4 відкриті позиції'],
      [5, 'Ми наймаємо — 5 відкритих позицій'],
      [11, 'Ми наймаємо — 11 відкритих позицій'],
      [21, 'Ми наймаємо — 21 відкрита позиція'],
    ])('count=%i → %s', (count, expected) => {
      expect(selectPluralForm(text, 'uk', count)).toBe(expected)
    })
  })

  describe('en — one/other (2 forms)', () => {
    const text = getDictionary('en').hiringStrip.text

    it.each([
      [1, "We're hiring — 1 open position"],
      [5, "We're hiring — 5 open positions"],
    ])('count=%i → %s', (count, expected) => {
      expect(selectPluralForm(text, 'en', count)).toBe(expected)
    })
  })

  describe('es — one/other (2 forms)', () => {
    const text = getDictionary('es').hiringStrip.text

    it.each([
      [1, 'Estamos contratando — 1 posición abierta'],
      [5, 'Estamos contratando — 5 posiciones abiertas'],
    ])('count=%i → %s', (count, expected) => {
      expect(selectPluralForm(text, 'es', count)).toBe(expected)
    })
  })

  describe('pt — one/other (2 forms)', () => {
    const text = getDictionary('pt').hiringStrip.text

    it.each([
      [1, 'Estamos contratando — 1 posição aberta'],
      [5, 'Estamos contratando — 5 posições abertas'],
    ])('count=%i → %s', (count, expected) => {
      expect(selectPluralForm(text, 'pt', count)).toBe(expected)
    })
  })
})
