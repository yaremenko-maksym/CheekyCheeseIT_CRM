import type { ExternalVacancyPrefill } from '@crm/shared'
import { describe, expect, it } from 'vitest'

import { toBase64Url } from '@/lib/base64url'

import { fitToHash } from '../fit'
import { DESCRIPTION_MAX, HASH_MAX, PAGE_TEXT_MAX } from '../limits'

const base: ExternalVacancyPrefill = {
  v: 1,
  recognition: 'partial',
  url: 'https://jobs.example.com/1',
  title: 'Інженер',
  company: 'Компанія',
  status: { url: 'found', title: 'found', company: 'found', description: 'found' },
}

const encodedLength = (p: ExternalVacancyPrefill) => toBase64Url(JSON.stringify(p)).length

describe('fitToHash', () => {
  it('leaves a payload that already fits untouched', () => {
    const p = { ...base, description: 'Короткий опис', pageText: 'Текст сторінки' }
    expect(fitToHash(p)).toEqual(p)
  })

  it('shrinks Cyrillic text at the field caps until the encoded hash fits', () => {
    const p = {
      ...base,
      description: 'вимоги '.repeat(DESCRIPTION_MAX / 7),
      pageText: 'досвід '.repeat(PAGE_TEXT_MAX / 7),
    }
    expect(encodedLength(p)).toBeGreaterThan(HASH_MAX)
    const fitted = fitToHash(p)
    expect(encodedLength(fitted)).toBeLessThanOrEqual(HASH_MAX)
    // The description is what HR reads; the raw page text goes first.
    expect(fitted.pageText ?? '').toBe('')
    expect(fitted.description?.length).toBeGreaterThan(1000)
    expect(p.description.startsWith(fitted.description ?? '')).toBe(true)
  })

  it('keeps the description when cutting the page text alone is enough', () => {
    const p = { ...base, description: 'опис', pageText: 'ж'.repeat(PAGE_TEXT_MAX) }
    const fitted = fitToHash(p)
    expect(fitted.description).toBe('опис')
    expect(encodedLength(fitted)).toBeLessThanOrEqual(HASH_MAX)
    expect(fitted.pageText?.length).toBeGreaterThan(1000)
  })
})
