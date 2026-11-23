import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PAGE_TEXT_MAX,
  externalFieldStatusSchema,
  externalVacancyPrefillSchema,
} from './external-vacancy-prefill'
import { DESCRIPTION_MD_MAX } from './job-sourcing'

const base = {
  v: 1,
  recognition: 'recognized',
  url: 'https://jobs.example.com/vacancy/42',
  title: 'Senior React Developer',
  company: 'Acme',
  description: 'Build things.',
  status: { url: 'found', title: 'found', company: 'guessed', description: 'found' },
} as const

const parse = (over: Record<string, unknown>) =>
  externalVacancyPrefillSchema.parse({ ...base, ...over })

describe('externalVacancyPrefillSchema', () => {
  it('accepts a full payload as is', () => {
    expect(externalVacancyPrefillSchema.parse(base)).toEqual(base)
  })

  it('trims text and cuts each field at its cap instead of rejecting the payload', () => {
    const p = parse({
      title: `  ${'a'.repeat(501)}  `,
      company: 'b'.repeat(256),
      description: 'c'.repeat(DESCRIPTION_MD_MAX + 1),
      pageText: 'd'.repeat(EXTERNAL_PAGE_TEXT_MAX + 1),
    })
    expect(p.title).toBe('a'.repeat(500))
    expect(p.company).toHaveLength(255)
    expect(p.description).toHaveLength(DESCRIPTION_MD_MAX)
    expect(p.pageText).toHaveLength(EXTERNAL_PAGE_TEXT_MAX)
  })

  it.each(['http://x.example', 'javascript:alert(1)', 'https://user@host.example/a', 42])(
    'drops the unsafe link %s and marks it missing',
    (url) => {
      const p = parse({ url })
      expect(p.url).toBeUndefined()
      expect(p.status.url).toBe('missing')
      expect(p.title).toBe(base.title)
    },
  )

  it('marks the link missing when it is absent, and keeps the other statuses', () => {
    const { url: _dropped, ...noUrl } = base
    const p = externalVacancyPrefillSchema.parse(noUrl)
    expect(p.status).toEqual({ ...base.status, url: 'missing' })
  })

  it('strips unknown keys', () => {
    expect(parse({ evil: '<script>' })).not.toHaveProperty('evil')
  })

  it('rejects a wrong version, recognition or status value', () => {
    expect(externalVacancyPrefillSchema.safeParse({ ...base, v: 2 }).success).toBe(false)
    expect(externalVacancyPrefillSchema.safeParse({ ...base, recognition: 'maybe' }).success).toBe(
      false,
    )
    expect(
      externalVacancyPrefillSchema.safeParse({ ...base, status: { ...base.status, title: 'ok' } })
        .success,
    ).toBe(false)
  })

  it('has exactly three field statuses', () => {
    expect(externalFieldStatusSchema.options).toEqual(['found', 'guessed', 'missing'])
  })
})
