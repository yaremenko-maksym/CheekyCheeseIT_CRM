import { describe, expect, it } from 'vitest'
import { safeExternalHref, slugifyTitle } from '../constants'
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

describe('safeExternalHref (security-MED, PR #396 review)', () => {
  it('accepts an https URL unchanged', () => {
    expect(safeExternalHref('https://github.com/ivan')).toBe('https://github.com/ivan')
  })

  it('accepts an http URL unchanged', () => {
    expect(safeExternalHref('http://example.com')).toBe('http://example.com')
  })

  it('rejects a javascript: URL', () => {
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
  })

  it('rejects an empty string', () => {
    expect(safeExternalHref('')).toBeUndefined()
  })

  it('rejects a data: URL', () => {
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
  })

  it('rejects a protocol-relative URL (no explicit http/https)', () => {
    expect(safeExternalHref('//evil.example.com')).toBeUndefined()
  })
})
