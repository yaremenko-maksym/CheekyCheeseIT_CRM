import { describe, expect, it } from 'vitest'
import {
  buildSeoFieldsDto,
  buildTranslationsDto,
  emptySeoFormValues,
  emptyTranslationsFormValues,
  safeExternalHref,
  safeTelegramHref,
  seoFormValuesFromVacancy,
  slugifyTitle,
  translationsFormValuesFromVacancy,
} from '../constants'
import { createVacancySchema, VACANCY_TRANSLATION_LOCALES } from '@crm/shared'

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

// task-candidate-card-resume §3 — telegram (anonymous public-form input,
// never format-validated on write) → clickable t.me/ link on the read side.
describe('safeTelegramHref (task-candidate-card-resume)', () => {
  it('accepts a handle with a leading @ and strips it in the URL', () => {
    expect(safeTelegramHref('@armghyan')).toBe('https://t.me/armghyan')
  })

  it('accepts a bare handle without @', () => {
    expect(safeTelegramHref('armghyan')).toBe('https://t.me/armghyan')
  })

  it('accepts digits/underscores after the first letter', () => {
    expect(safeTelegramHref('@john_doe_2')).toBe('https://t.me/john_doe_2')
  })

  it('accepts the minimum length (5 chars)', () => {
    expect(safeTelegramHref('@abcde')).toBe('https://t.me/abcde')
  })

  it('accepts the maximum length (32 chars)', () => {
    const handle = 'a' + '1'.repeat(31)
    expect(handle).toHaveLength(32)
    expect(safeTelegramHref(`@${handle}`)).toBe(`https://t.me/${handle}`)
  })

  it('rejects a handle one char below the minimum (4 chars)', () => {
    expect(safeTelegramHref('@abcd')).toBeUndefined()
  })

  it('rejects a handle one char above the maximum (33 chars)', () => {
    const handle = 'a' + '1'.repeat(32)
    expect(handle).toHaveLength(33)
    expect(safeTelegramHref(`@${handle}`)).toBeUndefined()
  })

  it('rejects a handle starting with a digit', () => {
    expect(safeTelegramHref('@1ivan')).toBeUndefined()
  })

  it('rejects a handle starting with an underscore', () => {
    expect(safeTelegramHref('@_ivan')).toBeUndefined()
  })

  it('rejects a handle with spaces', () => {
    expect(safeTelegramHref('@ivan petrov')).toBeUndefined()
  })

  it('rejects a full URL pasted into the field (not a bare handle)', () => {
    expect(safeTelegramHref('https://t.me/ivan')).toBeUndefined()
  })

  it('rejects arbitrary free text (anonymous public form, untrusted input)', () => {
    expect(safeTelegramHref('связаться со мной в телеге')).toBeUndefined()
  })

  it('rejects an empty string', () => {
    expect(safeTelegramHref('')).toBeUndefined()
  })
})

// task-vacancy-i18n-jobposting C1 — translations form <-> DTO.
describe('buildTranslationsDto', () => {
  it('returns null when every locale is empty (no-op create/update)', () => {
    expect(buildTranslationsDto(emptyTranslationsFormValues())).toBeNull()
  })

  it('excludes a locale where only title or only description is filled (all-or-nothing per locale)', () => {
    const values = emptyTranslationsFormValues()
    values.uk = { title: 'Тільки назва', description: '' }
    expect(buildTranslationsDto(values)).toBeNull()
  })

  it('includes a locale where BOTH title and description are filled, trimmed', () => {
    const values = emptyTranslationsFormValues()
    values.uk = { title: '  Провідний інженер  ', description: '  Повний опис вакансії тут.  ' }
    const dto = buildTranslationsDto(values)
    expect(dto?.uk).toEqual({
      title: 'Провідний інженер',
      description: 'Повний опис вакансії тут.',
    })
    expect(dto?.ru).toBeUndefined()
  })

  it('includes multiple independently-filled locales', () => {
    const values = emptyTranslationsFormValues()
    values.uk = { title: 'UK Title', description: 'UK description body.' }
    values.es = { title: 'ES Title', description: 'ES description body.' }
    const dto = buildTranslationsDto(values)
    expect(Object.keys(dto ?? {}).sort()).toEqual(['es', 'uk'])
  })

  it('round-trips with translationsFormValuesFromVacancy', () => {
    const values = emptyTranslationsFormValues()
    values.pt = { title: 'PT Title', description: 'PT description body here.' }
    const dto = buildTranslationsDto(values)
    const roundTripped = translationsFormValuesFromVacancy({ translations: dto })
    expect(roundTripped.pt).toEqual({ title: 'PT Title', description: 'PT description body here.' })
    // Untouched locales stay empty, not undefined — the form always has all 4 keys.
    for (const locale of VACANCY_TRANSLATION_LOCALES) {
      if (locale === 'pt') continue
      expect(roundTripped[locale]).toEqual({ title: '', description: '' })
    }
  })

  it('translationsFormValuesFromVacancy handles a null translations column', () => {
    expect(translationsFormValuesFromVacancy({ translations: null })).toEqual(
      emptyTranslationsFormValues(),
    )
  })
})

// task-vacancy-i18n-jobposting C3 — JobPosting SEO enrichment form <-> DTO.
describe('buildSeoFieldsDto', () => {
  it('maps every empty field to null', () => {
    expect(buildSeoFieldsDto(emptySeoFormValues())).toEqual({
      skills: null,
      experienceMonths: null,
      qualifications: null,
      responsibilities: null,
      jobBenefits: null,
      workHours: null,
    })
  })

  it('splits a comma-separated skills string into a trimmed array', () => {
    const dto = buildSeoFieldsDto({
      ...emptySeoFormValues(),
      skills: ' TypeScript ,React,  Node.js ',
    })
    expect(dto.skills).toEqual(['TypeScript', 'React', 'Node.js'])
  })

  it('drops empty entries from the skills list (trailing comma etc.)', () => {
    const dto = buildSeoFieldsDto({ ...emptySeoFormValues(), skills: 'React,,  ,Node.js' })
    expect(dto.skills).toEqual(['React', 'Node.js'])
  })

  it('parses experienceMonths, including 0 (a real "no prior experience" value)', () => {
    expect(
      buildSeoFieldsDto({ ...emptySeoFormValues(), experienceMonths: '36' }).experienceMonths,
    ).toBe(36)
    expect(
      buildSeoFieldsDto({ ...emptySeoFormValues(), experienceMonths: '0' }).experienceMonths,
    ).toBe(0)
  })

  it('treats a non-numeric experienceMonths as unset rather than erroring', () => {
    expect(
      buildSeoFieldsDto({ ...emptySeoFormValues(), experienceMonths: 'not-a-number' })
        .experienceMonths,
    ).toBeNull()
  })

  it('trims text fields and maps blank-after-trim to null', () => {
    const dto = buildSeoFieldsDto({
      ...emptySeoFormValues(),
      qualifications: '  3+ years experience.  ',
      responsibilities: '   ',
    })
    expect(dto.qualifications).toBe('3+ years experience.')
    expect(dto.responsibilities).toBeNull()
  })

  it('seoFormValuesFromVacancy round-trips skills/experienceMonths', () => {
    const values = seoFormValuesFromVacancy({
      skills: ['TypeScript', 'React'],
      experienceMonths: 24,
      qualifications: null,
      responsibilities: null,
      jobBenefits: null,
      workHours: null,
    })
    expect(values.skills).toBe('TypeScript, React')
    expect(values.experienceMonths).toBe('24')
    const dto = buildSeoFieldsDto(values)
    expect(dto.skills).toEqual(['TypeScript', 'React'])
    expect(dto.experienceMonths).toBe(24)
  })
})
