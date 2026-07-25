import { describe, expect, it } from 'vitest'
import {
  applyVacancyFieldsSchema,
  createVacancySchema,
  publicVacancyDetailSchema,
  publicVacancySchema,
  updateVacancySchema,
  vacancyApplicationSchema,
  vacancyLocaleSchema,
  vacancySchema,
  vacancySeoFieldsSchema,
  vacancyTranslationsSchema,
  VACANCY_LOCALES,
  VACANCY_TRANSLATION_LOCALES,
} from './vacancies'

describe('vacancies schemas', () => {
  describe('createVacancySchema — slug', () => {
    it('accepts a valid kebab-case slug', () => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(true)
    })

    it.each([
      'Senior-Frontend', // uppercase not allowed
      'senior_frontend', // underscore not allowed
      '-senior-frontend', // leading dash
      'senior-frontend-', // trailing dash
      '',
    ])('rejects invalid slug "%s"', (slug) => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug,
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })

    it('rejects a slug shorter than 3 chars', () => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug: 'ab',
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })

    it('rejects a slug longer than 80 chars', () => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug: 'a-'.repeat(45) + 'a', // > 80 chars
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createVacancySchema — length limits', () => {
    it('rejects title shorter than 3 chars', () => {
      const result = createVacancySchema.safeParse({
        title: 'ab',
        slug: 'valid-slug',
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })

    it('rejects descriptionMd shorter than 10 chars', () => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug: 'valid-slug',
        descriptionMd: 'short',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })

    it('rejects an unknown domain enum value', () => {
      const result = createVacancySchema.safeParse({
        title: 'Senior Frontend Engineer',
        slug: 'valid-slug',
        descriptionMd: 'A great role with plenty of details to write about.',
        domain: 'FINTECH',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createVacancySchema — seniority/location defaults (task-vacancies-form-simplify)', () => {
    const base = {
      title: 'Senior Frontend Engineer',
      slug: 'senior-frontend-engineer',
      descriptionMd: 'A great role with plenty of details to write about.',
      domain: 'AI' as const,
      employmentType: 'FULL_TIME' as const,
    }

    it('defaults seniority to SENIOR when omitted', () => {
      const result = createVacancySchema.safeParse(base)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.seniority).toBe('SENIOR')
    })

    it('defaults location to Remote when omitted', () => {
      const result = createVacancySchema.safeParse(base)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.location).toBe('Remote')
    })

    it('still accepts an explicit seniority/location override (e.g. a direct API caller)', () => {
      const result = createVacancySchema.safeParse({
        ...base,
        seniority: 'LEAD',
        location: 'Berlin',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.seniority).toBe('LEAD')
        expect(result.data.location).toBe('Berlin')
      }
    })
  })

  describe('updateVacancySchema', () => {
    it('accepts a partial update with only status', () => {
      const result = updateVacancySchema.safeParse({ status: 'PUBLISHED' })
      expect(result.success).toBe(true)
    })

    it('accepts an empty object (no-op update)', () => {
      const result = updateVacancySchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.seniority).toBeUndefined()
        expect(result.data.location).toBeUndefined()
      }
    })

    it('rejects an invalid status value', () => {
      const result = updateVacancySchema.safeParse({ status: 'ARCHIVED' })
      expect(result.success).toBe(false)
    })

    // Regression pin (task-vacancies-form-simplify): Zod v4 applies `.default()`
    // even inside `.optional()`-wrapped fields, so a naive
    // `createVacancySchema.partial()` would silently inject seniority/location
    // defaults into ANY partial update that omits them — e.g. a pure status
    // transition `{ status: 'CLOSED' }` would incorrectly reset an existing
    // LEAD / on-site vacancy back to SENIOR/Remote. `updateVacancySchema`
    // must keep "omitted key = unchanged" semantics for these two fields.
    it('a partial update touching only title does NOT inject seniority/location defaults', () => {
      const result = updateVacancySchema.safeParse({ title: 'New Title Only' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.seniority).toBeUndefined()
        expect(result.data.location).toBeUndefined()
      }
    })

    it('a pure status transition does NOT inject seniority/location defaults', () => {
      const result = updateVacancySchema.safeParse({ status: 'CLOSED' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.seniority).toBeUndefined()
        expect(result.data.location).toBeUndefined()
      }
    })

    it('still accepts an explicit seniority/location override', () => {
      const result = updateVacancySchema.safeParse({ seniority: 'LEAD', location: 'Kyiv' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.seniority).toBe('LEAD')
        expect(result.data.location).toBe('Kyiv')
      }
    })
  })

  describe('applyVacancyFieldsSchema — honeypot (website)', () => {
    const base = {
      fullName: 'Ivan Petrenko',
      email: 'ivan@example.com',
      turnstileToken: 'tok-123',
    }

    it('accepts when website is absent', () => {
      const result = applyVacancyFieldsSchema.safeParse(base)
      expect(result.success).toBe(true)
    })

    it('accepts when website is an empty string', () => {
      const result = applyVacancyFieldsSchema.safeParse({ ...base, website: '' })
      expect(result.success).toBe(true)
    })

    it('rejects when website is non-empty (honeypot filled)', () => {
      const result = applyVacancyFieldsSchema.safeParse({ ...base, website: 'http://spam.example' })
      expect(result.success).toBe(false)
    })
  })

  describe('applyVacancyFieldsSchema — field limits', () => {
    const base = {
      fullName: 'Ivan Petrenko',
      email: 'ivan@example.com',
      turnstileToken: 'tok-123',
    }

    it('rejects fullName shorter than 2 chars', () => {
      const result = applyVacancyFieldsSchema.safeParse({ ...base, fullName: 'I' })
      expect(result.success).toBe(false)
    })

    it('rejects an invalid email', () => {
      const result = applyVacancyFieldsSchema.safeParse({ ...base, email: 'not-an-email' })
      expect(result.success).toBe(false)
    })

    it('rejects a linkedinUrl that is not https://', () => {
      const result = applyVacancyFieldsSchema.safeParse({
        ...base,
        linkedinUrl: 'http://linkedin.com/in/ivan',
      })
      expect(result.success).toBe(false)
    })

    it('accepts a valid https:// linkedinUrl', () => {
      const result = applyVacancyFieldsSchema.safeParse({
        ...base,
        linkedinUrl: 'https://linkedin.com/in/ivan',
      })
      expect(result.success).toBe(true)
    })

    it('rejects a githubUrl that is not https://', () => {
      const result = applyVacancyFieldsSchema.safeParse({
        ...base,
        githubUrl: 'ftp://github.com/ivan',
      })
      expect(result.success).toBe(false)
    })

    it('rejects coverLetter longer than 2000 chars', () => {
      const result = applyVacancyFieldsSchema.safeParse({
        ...base,
        coverLetter: 'x'.repeat(2001),
      })
      expect(result.success).toBe(false)
    })

    it('rejects a missing turnstileToken', () => {
      const result = applyVacancyFieldsSchema.safeParse({
        fullName: 'Ivan Petrenko',
        email: 'ivan@example.com',
        turnstileToken: '',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('vacancySchema / vacancyApplicationSchema — round trip shape', () => {
    it('accepts a full admin vacancy DTO', () => {
      const result = vacancySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'senior-frontend-engineer',
        title: 'Senior Frontend Engineer',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
        publishedAt: null,
        descriptionMd: 'Full description here.',
        status: 'DRAFT',
        closedAt: null,
        applicationsCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        translations: null,
        skills: null,
        experienceMonths: null,
        qualifications: null,
        responsibilities: null,
        jobBenefits: null,
        workHours: null,
      })
      expect(result.success).toBe(true)
    })

    it('accepts a full vacancy application DTO', () => {
      const result = vacancyApplicationSchema.safeParse({
        id: '22222222-2222-4222-8222-222222222222',
        vacancyId: '11111111-1111-4111-8111-111111111111',
        fullName: 'Ivan Petrenko',
        email: 'ivan@example.com',
        telegram: null,
        linkedinUrl: null,
        githubUrl: null,
        coverLetter: null,
        resumeSizeBytes: 12345,
        status: 'NEW',
        createdAt: new Date().toISOString(),
      })
      expect(result.success).toBe(true)
    })
  })

  // task-vacancy-i18n-jobposting C1/C2 — 5-locale i18n contract (owner
  // scope-change 2026-07-25), data-driven over VACANCY_TRANSLATION_LOCALES.
  describe('vacancyLocaleSchema', () => {
    it('has en + the 4 translation locales, en first (site default/x-default, plan §1)', () => {
      expect(VACANCY_LOCALES).toEqual(['en', 'uk', 'ru', 'es', 'pt'])
      expect(VACANCY_TRANSLATION_LOCALES).toEqual(['uk', 'ru', 'es', 'pt'])
    })

    it.each(VACANCY_LOCALES)('accepts %s unchanged', (locale) => {
      expect(vacancyLocaleSchema.parse(locale)).toBe(locale)
    })

    it('falls back to en for an unrecognised value instead of throwing (public, unauthenticated query param)', () => {
      expect(vacancyLocaleSchema.parse('de')).toBe('en')
      expect(vacancyLocaleSchema.parse('fr-FR')).toBe('en')
    })

    it('falls back to en when absent (default site locale, plan §1)', () => {
      expect(vacancyLocaleSchema.parse(undefined)).toBe('en')
    })
  })

  describe('vacancyTranslationsSchema', () => {
    it('accepts an empty object (vacancy translated into none of the 4 locales yet)', () => {
      expect(vacancyTranslationsSchema.safeParse({}).success).toBe(true)
    })

    it('accepts a PARTIAL set — translated into some locales but not all (plan §3: "все ключи опциональны")', () => {
      const result = vacancyTranslationsSchema.safeParse({
        uk: { title: 'Провідний інженер', description: 'Опис вакансії тут.' },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.uk?.title).toBe('Провідний інженер')
        expect(result.data.ru).toBeUndefined()
      }
    })

    it('accepts all 4 translation locales populated', () => {
      const entry = { title: 'Translated Title', description: 'Translated description body.' }
      const result = vacancyTranslationsSchema.safeParse({
        uk: entry,
        ru: entry,
        es: entry,
        pt: entry,
      })
      expect(result.success).toBe(true)
    })

    it('rejects a locale entry missing description', () => {
      const result = vacancyTranslationsSchema.safeParse({ ru: { title: 'Only title' } })
      expect(result.success).toBe(false)
    })

    it('rejects an unknown locale key (e.g. a region-qualified tag, plan §1: base languages only)', () => {
      const result = vacancyTranslationsSchema.safeParse({
        'pt-BR': { title: 'Titulo', description: 'Descricao com detalhes suficientes.' },
      })
      // Unknown keys are simply not part of the typed shape (Zod strips them
      // by default) — the important invariant is the KNOWN locale keys are
      // still all independently optional, verified above; this just pins
      // that a region-qualified key is not silently accepted as one of ours.
      expect(result.success && 'pt-BR' in result.data).toBe(false)
    })
  })

  describe('createVacancySchema / updateVacancySchema — translations + SEO enrichment (C1/C3)', () => {
    const base = {
      title: 'Senior Frontend Engineer',
      slug: 'senior-frontend-engineer',
      descriptionMd: 'A great role with plenty of details to write about.',
      domain: 'AI' as const,
      employmentType: 'FULL_TIME' as const,
    }

    it('omitting translations/SEO fields on create leaves them undefined (service maps undefined -> null)', () => {
      const result = createVacancySchema.safeParse(base)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.translations).toBeUndefined()
        expect(result.data.skills).toBeUndefined()
        expect(result.data.experienceMonths).toBeUndefined()
      }
    })

    it('accepts an explicit translations + SEO enrichment payload on create', () => {
      const result = createVacancySchema.safeParse({
        ...base,
        translations: { uk: { title: 'Заголовок', description: 'Опис вакансії тут повністю.' } },
        skills: ['TypeScript', 'React'],
        experienceMonths: 36,
        qualifications: '3+ years commercial experience.',
        responsibilities: 'Own the frontend architecture.',
        jobBenefits: 'Remote-first, flexible hours.',
        workHours: '40 hours per week',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.skills).toEqual(['TypeScript', 'React'])
        expect(result.data.experienceMonths).toBe(36)
      }
    })

    it('accepts explicit null for any SEO field (clearing a previously-set value)', () => {
      const result = createVacancySchema.safeParse({
        ...base,
        skills: null,
        experienceMonths: null,
      })
      expect(result.success).toBe(true)
    })

    // Regression pin (mirrors the seniority/location Zod v4 .partial()+.default()
    // footgun documented in vacancies.ts): a PATCH that omits translations/SEO
    // fields must NOT clobber the vacancy's existing values with `null`.
    it('a partial update touching only title does NOT inject translations/SEO defaults', () => {
      const result = updateVacancySchema.safeParse({ title: 'New Title Only' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.translations).toBeUndefined()
        expect(result.data.skills).toBeUndefined()
        expect(result.data.experienceMonths).toBeUndefined()
      }
    })

    it('a partial update CAN explicitly set translations/SEO fields', () => {
      const result = updateVacancySchema.safeParse({
        skills: ['Node.js'],
        qualifications: null,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.skills).toEqual(['Node.js'])
        expect(result.data.qualifications).toBeNull()
      }
    })
  })

  describe('vacancySeoFieldsSchema — limits', () => {
    it('rejects more than 20 skills', () => {
      const result = vacancySeoFieldsSchema.safeParse({
        skills: Array.from({ length: 21 }, (_, i) => `skill-${i}`),
        experienceMonths: null,
        qualifications: null,
        responsibilities: null,
        jobBenefits: null,
        workHours: null,
      })
      expect(result.success).toBe(false)
    })

    it('rejects a negative experienceMonths', () => {
      const result = vacancySeoFieldsSchema.safeParse({
        skills: null,
        experienceMonths: -1,
        qualifications: null,
        responsibilities: null,
        jobBenefits: null,
        workHours: null,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('publicVacancySchema / publicVacancyDetailSchema — isFallback + relatedVacancies (C2/C8)', () => {
    const publicBase = {
      slug: 'senior-frontend-engineer',
      title: 'Senior Frontend Engineer',
      domain: 'AI' as const,
      seniority: 'SENIOR' as const,
      employmentType: 'FULL_TIME' as const,
      location: 'Remote',
      publishedAt: new Date().toISOString(),
    }

    it('requires isFallback on the public list DTO', () => {
      expect(publicVacancySchema.safeParse(publicBase).success).toBe(false)
      expect(publicVacancySchema.safeParse({ ...publicBase, isFallback: false }).success).toBe(true)
    })

    it('detail DTO caps relatedVacancies at 3', () => {
      const related = Array.from({ length: 4 }, (_, i) => ({
        ...publicBase,
        slug: `related-${i}`,
        isFallback: false,
      }))
      const result = publicVacancyDetailSchema.safeParse({
        ...publicBase,
        isFallback: false,
        descriptionMd: 'Full description here.',
        skills: null,
        experienceMonths: null,
        qualifications: null,
        responsibilities: null,
        jobBenefits: null,
        workHours: null,
        relatedVacancies: related,
      })
      expect(result.success).toBe(false)
    })

    it('detail DTO accepts up to 3 relatedVacancies', () => {
      const related = Array.from({ length: 3 }, (_, i) => ({
        ...publicBase,
        slug: `related-${i}`,
        isFallback: false,
      }))
      const result = publicVacancyDetailSchema.safeParse({
        ...publicBase,
        isFallback: false,
        descriptionMd: 'Full description here.',
        skills: null,
        experienceMonths: null,
        qualifications: null,
        responsibilities: null,
        jobBenefits: null,
        workHours: null,
        relatedVacancies: related,
      })
      expect(result.success).toBe(true)
    })
  })
})
