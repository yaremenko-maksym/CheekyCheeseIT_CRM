import { describe, expect, it } from 'vitest'
import {
  applyVacancyFieldsSchema,
  createVacancySchema,
  updateVacancySchema,
  vacancyApplicationSchema,
  vacancySchema,
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

  describe('updateVacancySchema', () => {
    it('accepts a partial update with only status', () => {
      const result = updateVacancySchema.safeParse({ status: 'PUBLISHED' })
      expect(result.success).toBe(true)
    })

    it('accepts an empty object (no-op update)', () => {
      const result = updateVacancySchema.safeParse({})
      expect(result.success).toBe(true)
    })

    it('rejects an invalid status value', () => {
      const result = updateVacancySchema.safeParse({ status: 'ARCHIVED' })
      expect(result.success).toBe(false)
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
})
