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
    expect(bucketOf(base())('PostgreSQL')).toBe('existing')
  })

  it('an unknown skill matches a base skill case-insensitively → existing', () => {
    expect(bucketOf(base({ skills: ['Elixir'] }))('elixir')).toBe('existing')
  })

  it('only in a bullet → supported', () => {
    expect(bucketOf(base())('React')).toBe('supported')
  })

  it('only in the summary → supported', () => {
    expect(bucketOf(base({ summary: 'Ran Kafka clusters.' }))('Kafka')).toBe('supported')
  })

  it('nowhere in the base → gap', () => {
    expect(bucketOf(base())('Kubernetes')).toBe('gap')
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
    const head = 'c'.repeat(7000)
    expect(capPosting(`${head} Why? ${'c'.repeat(6000)}`).text).toBe(`${head} Why?`)
    expect(capPosting(`${head} Go! ${'c'.repeat(6000)}`).text).toBe(`${head} Go!`)
  })

  it('a sentence end keeping under half the cap → the last word boundary that fits instead', () => {
    const text = `Short. ${'word '.repeat(3000)}`
    const out = capPosting(text)
    expect(out.truncated).toBe(true)
    expect(text.startsWith(out.text)).toBe(true)
    expect(out.text.endsWith(' word')).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(MAX_POSTING_CHARS)
    expect(out.text.length).toBeGreaterThan(MAX_POSTING_CHARS - 'word '.length)
  })

  it('no sentence end or word boundary past half the cap → a hard cut, not the early one', () => {
    const text = `Why? ${'c'.repeat(12_500)}`
    expect(capPosting(text).text).toBe(text.slice(0, MAX_POSTING_CHARS))
  })

  it('a sentence end at exactly half the cap is kept', () => {
    const kept = `${'a'.repeat(MAX_POSTING_CHARS / 2 - 1)}.`
    expect(capPosting(`${kept} ${'b '.repeat(6250)}`).text).toBe(kept)
  })

  it('a hard cut never splits a surrogate pair', () => {
    const text = `${'a'.repeat(MAX_POSTING_CHARS - 1)}\u{1F600}${'b'.repeat(100)}`
    expect(capPosting(text).text).toBe('a'.repeat(MAX_POSTING_CHARS - 1))
  })

  it('11 999 and 12 000 chars → unchanged, not truncated', () => {
    const a = 'd'.repeat(11_999)
    expect(capPosting(a)).toEqual({ text: a, truncated: false })
    const b = 'd'.repeat(MAX_POSTING_CHARS)
    expect(capPosting(b)).toEqual({ text: b, truncated: false })
  })
})
