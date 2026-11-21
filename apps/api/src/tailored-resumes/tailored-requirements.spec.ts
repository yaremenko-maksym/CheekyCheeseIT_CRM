import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { MAX_POSTING_CHARS } from '../extraction-worker/link-contract'
import {
  bucketOf,
  capPosting,
  extractRequirements,
  MAX_REQUIREMENTS,
} from './tailored-requirements'

const base = (over: Partial<ResumeContent> = {}): ResumeContent => ({
  ...EMPTY_RESUME_CONTENT,
  summary: 'Backend engineer.',
  skills: ['Postgres', 'TypeScript'],
  experience: [
    { company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: ['Shipped React dashboards'] },
  ],
  ...over,
})

describe('extractRequirements', () => {
  it('"JavaScript and React" yields JavaScript, React, not Java', () => {
    expect(extractRequirements('We use JavaScript and React daily.', [])).toEqual([
      'JavaScript',
      'React',
    ])
  })

  it('adds stackKeywords canonicalised, deduplicated, after the text ones, in a stable order', () => {
    expect(
      extractRequirements('Our stack: React.', ['ReactJS', 'Postgres', 'Elixir', ' ', 'postgres']),
    ).toEqual(['React', 'PostgreSQL', 'Elixir'])
  })

  it('drops a label over 200 chars and keeps at most MAX_REQUIREMENTS (the worker body limits)', () => {
    const many = Array.from({ length: 120 }, (_, i) => `Tool${i}`)
    const out = extractRequirements('', ['x'.repeat(201), ...many])
    expect(out).toHaveLength(MAX_REQUIREMENTS)
    expect(out[0]).toBe('Tool0')
    expect(extractRequirements('', ['y'.repeat(200)])).toEqual(['y'.repeat(200)])
  })
})

describe('bucketOf', () => {
  it('base skill "Postgres" → existing for "PostgreSQL"', () => {
    expect(bucketOf('PostgreSQL', base())).toBe('existing')
  })

  it('an unknown skill matches a base skill case-insensitively → existing', () => {
    expect(bucketOf('elixir', base({ skills: ['Elixir'] }))).toBe('existing')
  })

  it('only in a bullet → supported', () => {
    expect(bucketOf('React', base())).toBe('supported')
  })

  it('only in the summary → supported', () => {
    expect(bucketOf('Kafka', base({ summary: 'Ran Kafka clusters.' }))).toBe('supported')
  })

  it('nowhere in the base → gap', () => {
    expect(bucketOf('Kubernetes', base())).toBe('gap')
  })
})

describe('capPosting', () => {
  const sentence = 'We build things. ' // 17 chars

  it('12 500 chars → at most 12 000, ends at a sentence end, truncated', () => {
    const text = sentence.repeat(Math.ceil(12_500 / sentence.length)).slice(0, 12_500)
    const out = capPosting(text)
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(MAX_POSTING_CHARS)
    expect(out.text.endsWith('things.')).toBe(true)
    expect(text.startsWith(out.text)).toBe(true)
    // the last sentence end before the cap, not an earlier one
    expect(out.text.length).toBeGreaterThan(MAX_POSTING_CHARS - sentence.length)
  })

  it('a sentence end exactly at the cap is kept, not an earlier one', () => {
    const kept = `Hi. ${'a'.repeat(MAX_POSTING_CHARS - 5)}.`
    expect(kept).toHaveLength(MAX_POSTING_CHARS)
    expect(capPosting(`${kept} tail`).text).toBe(kept)
  })

  it('no sentence end before the cap → a hard cut at the cap', () => {
    const out = capPosting('b'.repeat(12_500))
    expect(out).toEqual({ text: 'b'.repeat(MAX_POSTING_CHARS), truncated: true })
  })

  it('a ? or ! counts as a sentence end', () => {
    expect(capPosting(`Why? ${'c'.repeat(12_500)}`).text).toBe('Why?')
    expect(capPosting(`Go! ${'c'.repeat(12_500)}`).text).toBe('Go!')
  })

  it('11 999 and 12 000 chars → unchanged, not truncated', () => {
    const a = 'd'.repeat(11_999)
    expect(capPosting(a)).toEqual({ text: a, truncated: false })
    const b = 'd'.repeat(MAX_POSTING_CHARS)
    expect(capPosting(b)).toEqual({ text: b, truncated: false })
  })
})
