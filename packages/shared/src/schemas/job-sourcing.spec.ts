import { describe, expect, it } from 'vitest'
import {
  createJobExclusionSchema,
  externalHttpsUrlSchema,
  jobPostingSchema,
  updateJobSuggestionStatusSchema,
} from './job-sourcing'

const validPosting = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceType: 'DOU_RSS',
  externalId: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/',
  url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/',
  title: 'Senior Frontend Engineer',
  companyName: 'EPAM',
  location: 'Kyiv, remote',
  descriptionMd: '**We are hiring**',
  publishedAt: '2026-08-07T08:48:38.000Z',
  collectedAt: '2026-08-07T09:00:00.000Z',
}

describe('externalHttpsUrlSchema — the value that reaches window.open', () => {
  it('accepts an https URL', () => {
    expect(externalHttpsUrlSchema.parse('https://jobs.dou.ua/x/')).toBe('https://jobs.dou.ua/x/')
  })

  it('rejects javascript: (XSS via window.open)', () => {
    // NOTE: the `javascript:` URL below is the point of the test. If
    // `no-script-url` is ever enabled for this package, re-add an
    // `eslint-disable-next-line` here (task-lint-teeth: the directive that used
    // to be here was inert — no config enabled that rule).
    expect(() => externalHttpsUrlSchema.parse('javascript:alert(1)')).toThrow()
  })

  it('rejects data: URLs', () => {
    expect(() => externalHttpsUrlSchema.parse('data:text/html,<script>alert(1)</script>')).toThrow()
  })

  it('rejects plain http (downgrade)', () => {
    expect(() => externalHttpsUrlSchema.parse('http://jobs.dou.ua/x/')).toThrow()
  })

  it('rejects a non-URL string', () => {
    expect(() => externalHttpsUrlSchema.parse('not a url')).toThrow()
  })
})

describe('jobPostingSchema', () => {
  it('parses a well-formed posting', () => {
    expect(jobPostingSchema.parse(validPosting).companyName).toBe('EPAM')
  })

  it('rejects a posting whose url is not https', () => {
    expect(() => jobPostingSchema.parse({ ...validPosting, url: 'javascript:alert(1)' })).toThrow()
  })

  it('allows a null location and null publishedAt', () => {
    const parsed = jobPostingSchema.parse({ ...validPosting, location: null, publishedAt: null })
    expect(parsed.location).toBeNull()
    expect(parsed.publishedAt).toBeNull()
  })
})

describe('updateJobSuggestionStatusSchema', () => {
  it('accepts APPLIED and REJECTED', () => {
    expect(updateJobSuggestionStatusSchema.parse({ status: 'APPLIED' }).status).toBe('APPLIED')
    expect(updateJobSuggestionStatusSchema.parse({ status: 'REJECTED' }).status).toBe('REJECTED')
  })

  it('rejects a roll-back to NEW (would re-surface a rejected posting)', () => {
    expect(() => updateJobSuggestionStatusSchema.parse({ status: 'NEW' })).toThrow()
  })
})

describe('createJobExclusionSchema', () => {
  it('trims and accepts a company exclusion', () => {
    const parsed = createJobExclusionSchema.parse({
      scope: 'SENIOR',
      seniorId: '11111111-1111-4111-8111-111111111111',
      kind: 'COMPANY',
      value: '  EPAM Systems  ',
    })
    expect(parsed.value).toBe('EPAM Systems')
  })

  it('rejects a 1-character value (would filter out half the feed)', () => {
    expect(() =>
      createJobExclusionSchema.parse({ scope: 'GLOBAL', kind: 'KEYWORD', value: 'a' }),
    ).toThrow()
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      createJobExclusionSchema.parse({ scope: 'GLOBAL', kind: 'DOMAIN', value: 'gambling' }),
    ).toThrow()
  })
})
