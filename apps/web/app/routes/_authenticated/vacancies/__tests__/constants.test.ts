import { describe, expect, it } from 'vitest'
import { slugifyTitle } from '../constants'
import { createVacancySchema } from '@crm/shared'

describe('slugifyTitle (§4.2)', () => {
  it('kebab-cases a latin title', () => {
    expect(slugifyTitle('Senior React Developer')).toBe('senior-react-developer')
  })

  it('lowercases and strips punctuation', () => {
    expect(slugifyTitle('Full-Stack (TypeScript) Engineer!')).toBe('full-stack-typescript-engineer')
  })

  it('collapses repeated separators and trims leading/trailing dashes', () => {
    expect(slugifyTitle('  React   ---  Native  ')).toBe('react-native')
  })

  it('returns empty string for a Cyrillic title — no transliteration attempted', () => {
    expect(slugifyTitle('Старший React разработчик')).toBe('')
  })

  it('returns empty string for a mixed latin+Cyrillic title', () => {
    expect(slugifyTitle('Senior Разработчик')).toBe('')
  })

  it('returns empty string for an empty/whitespace title', () => {
    expect(slugifyTitle('')).toBe('')
    expect(slugifyTitle('   ')).toBe('')
  })

  it('every non-empty slug it produces passes createVacancySchema.slug', () => {
    const titles = ['Senior React Developer', 'DevOps Engineer 2', 'QA (Manual + Auto)']
    for (const title of titles) {
      const slug = slugifyTitle(title)
      expect(slug).not.toBe('')
      expect(createVacancySchema.shape.slug.safeParse(slug).success).toBe(true)
    }
  })
})
