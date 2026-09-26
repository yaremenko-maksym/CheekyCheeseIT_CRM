import { describe, expect, it, beforeEach } from 'vitest'
import { i18n } from '@lingui/core'
import {
  APPLICATION_STATUS_LABEL_MESSAGES,
  buildSeoFieldsDto,
  buildTranslationsDto,
  EMPLOYMENT_TYPE_LABEL_MESSAGES,
  emptySeoFormValues,
  emptyTranslationsFormValues,
  SALARY_PERIOD_LABEL_MESSAGES,
  safeExternalHref,
  seoFormValuesFromVacancy,
  slugifyTitle,
  translationsFormValuesFromVacancy,
  VACANCY_STATUS_LABEL_MESSAGES,
  zodIssueRu,
} from '../constants'
import { createVacancySchema, VACANCY_TRANSLATION_LOCALES } from '@crm/shared'
import { loadCatalog } from '@/test/i18n'

beforeEach(async () => {
  await loadCatalog('uk')
})

// task-i18n-stage3c-pr2 (AC1, COPY-M-proj-7) — the four label maps resolve
// through the catalog, gender-agree with their subject («вакансія»/«відгук»),
// and never leak a raw enum member (RAW_ENUM below mirrors the Global
// Constraints scan pattern, narrowed to just this test's fixtures).
const RAW_ENUM =
  /\b(DRAFT|PUBLISHED|CLOSED|NEW|VIEWED|REJECTED|FULL_TIME|PART_TIME|CONTRACT|HOUR|DAY|WEEK|MONTH|YEAR)\b/

describe('label maps resolve through the catalog (task-i18n-stage3c-pr2 AC1)', () => {
  it('VACANCY_STATUS_LABEL_MESSAGES — feminine agreement with «вакансія», no raw enum', () => {
    expect(i18n._(VACANCY_STATUS_LABEL_MESSAGES.DRAFT)).toBe('Чернетка')
    expect(i18n._(VACANCY_STATUS_LABEL_MESSAGES.PUBLISHED)).toBe('Опублікована')
    expect(i18n._(VACANCY_STATUS_LABEL_MESSAGES.CLOSED)).toBe('Закрита')
    for (const key of ['DRAFT', 'PUBLISHED', 'CLOSED'] as const) {
      expect(i18n._(VACANCY_STATUS_LABEL_MESSAGES[key])).not.toMatch(RAW_ENUM)
    }
  })

  it('APPLICATION_STATUS_LABEL_MESSAGES — masculine agreement with «відгук», no raw enum', () => {
    expect(i18n._(APPLICATION_STATUS_LABEL_MESSAGES.NEW)).toBe('Новий')
    expect(i18n._(APPLICATION_STATUS_LABEL_MESSAGES.VIEWED)).toBe('Переглянутий')
    expect(i18n._(APPLICATION_STATUS_LABEL_MESSAGES.REJECTED)).toBe('Відхилений')
    for (const key of ['NEW', 'VIEWED', 'REJECTED'] as const) {
      expect(i18n._(APPLICATION_STATUS_LABEL_MESSAGES[key])).not.toMatch(RAW_ENUM)
    }
  })

  it('EMPLOYMENT_TYPE_LABEL_MESSAGES resolves every employment type, no raw enum', () => {
    expect(i18n._(EMPLOYMENT_TYPE_LABEL_MESSAGES.FULL_TIME)).toBe('Повна зайнятість')
    expect(i18n._(EMPLOYMENT_TYPE_LABEL_MESSAGES.PART_TIME)).toBe('Часткова зайнятість')
    expect(i18n._(EMPLOYMENT_TYPE_LABEL_MESSAGES.CONTRACT)).toBe('Проєктна робота')
  })

  it('SALARY_PERIOD_LABEL_MESSAGES resolves every period, no raw enum', () => {
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.HOUR)).toBe('Година')
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.DAY)).toBe('День')
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.WEEK)).toBe('Тиждень')
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.MONTH)).toBe('Місяць')
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.YEAR)).toBe('Рік')
  })

  it('switching to en resolves the same keys through the English catalog', async () => {
    await loadCatalog('en')
    expect(i18n._(VACANCY_STATUS_LABEL_MESSAGES.PUBLISHED)).toBe('Published')
    expect(i18n._(APPLICATION_STATUS_LABEL_MESSAGES.VIEWED)).toBe('Viewed')
    expect(i18n._(EMPLOYMENT_TYPE_LABEL_MESSAGES.FULL_TIME)).toBe('Full-time')
    expect(i18n._(SALARY_PERIOD_LABEL_MESSAGES.MONTH)).toBe('Month')
  })
})

// task-i18n-stage3c-pr2 (shape J, COPY-M-proj-9) — zodIssueRu's too_small/
// too_big branches carry the character count as an ICU plural: uk needs
// one/few/many/other, verified across the boundary values a schema
// min-length actually produces (not just n=1).
describe('zodIssueRu pluralizes the character count (shape J)', () => {
  const tooSmall = (minimum: number) => zodIssueRu({ code: 'too_small' as const, minimum } as never)

  it.each([
    [1, 'Мінімум 1 символ'],
    [2, 'Мінімум 2 символи'],
    [5, 'Мінімум 5 символів'],
    [11, 'Мінімум 11 символів'],
    [21, 'Мінімум 21 символ'],
  ])('minimum=%i -> %s', (minimum, expected) => {
    expect(tooSmall(minimum)).toBe(expected)
  })
})

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

// task-candidate-card-resume §3 — `safeTelegramHref` moved to
// `@/lib/tg-url` (code-review round 2 — reused by UserProfileHeader.tsx/
// UserRow.tsx too, which sit outside this module). Its tests moved with it
// — see apps/web/app/lib/tg-url.test.ts.

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
