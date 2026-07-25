/**
 * plan-landing-i18n-seo.md §3 / task-landing-i18n.md A10 — vacancy
 * translation resolution (real translation or `en` fallback) + hreflang
 * exclusion for untranslated locales.
 */
import { describe, expect, it } from 'vitest'
import {
  isVacancyFallbackLocale,
  resolveVacancyDescription,
  resolveVacancyTitle,
  vacancyHreflangExcludes,
} from '@/lib/vacancy-i18n'

const withTranslation = {
  title: 'Senior ML Engineer',
  descriptionMd: 'English description.',
  translations: {
    ru: { title: 'Старший ML-инженер', description: 'Русское описание.' },
  },
}

const withoutTranslations = {
  title: 'Senior ML Engineer',
  descriptionMd: 'English description.',
}

describe('resolveVacancyTitle', () => {
  it('always returns the original title for en (the source language)', () => {
    expect(resolveVacancyTitle(withTranslation, 'en')).toBe('Senior ML Engineer')
  })

  it('returns the real translation when present', () => {
    expect(resolveVacancyTitle(withTranslation, 'ru')).toBe('Старший ML-инженер')
  })

  it('falls back to the original title when no translation exists for that locale', () => {
    expect(resolveVacancyTitle(withTranslation, 'uk')).toBe('Senior ML Engineer')
    expect(resolveVacancyTitle(withoutTranslations, 'ru')).toBe('Senior ML Engineer')
  })
})

describe('resolveVacancyDescription', () => {
  it('returns the real translation when present, else the original descriptionMd', () => {
    expect(resolveVacancyDescription(withTranslation, 'ru')).toBe('Русское описание.')
    expect(resolveVacancyDescription(withTranslation, 'es')).toBe('English description.')
  })
})

describe('isVacancyFallbackLocale', () => {
  it('en is never a fallback (it IS the source)', () => {
    expect(isVacancyFallbackLocale(withoutTranslations, 'en')).toBe(false)
  })

  it('a non-en locale with a real translation is not a fallback', () => {
    expect(isVacancyFallbackLocale(withTranslation, 'ru')).toBe(false)
  })

  it('a non-en locale with no translation IS a fallback', () => {
    expect(isVacancyFallbackLocale(withTranslation, 'uk')).toBe(true)
    expect(isVacancyFallbackLocale(withoutTranslations, 'es')).toBe(true)
  })
})

describe('vacancyHreflangExcludes', () => {
  it('excludes only the locales without a real translation, never en', () => {
    expect(vacancyHreflangExcludes(withTranslation).sort()).toEqual(['es', 'pt', 'uk'])
  })

  it('excludes every non-en locale when there are no translations at all', () => {
    expect(vacancyHreflangExcludes(withoutTranslations).sort()).toEqual(['es', 'pt', 'ru', 'uk'])
  })
})
