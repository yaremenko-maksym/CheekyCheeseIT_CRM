import { describe, expect, it } from 'vitest'
import {
  jobSourceBudgetSchema,
  jobSourceBudgetStateSchema,
  jobSourceBudgetWindowSchema,
  jobSourceSchema,
  jobSourceTriggerModeSchema,
  jobSuggestionListSchema,
  jobSuggestionSchema,
} from './job-sourcing'
import { MAX_STACK_KEYWORD_CHARS, MAX_STACK_KEYWORDS } from '../utils/stack-keywords'

/**
 * The wire contract for task-vacancy-matching, asserted as behaviour.
 *
 * Raised by the mutation gate: the bounds and enum members in this file were
 * declarations nobody checked. `max` could become `min`, `1` could become `0`,
 * and an enum could lose a member with every test still green — which is how a
 * contract silently stops contracting. Each limit below is asserted from BOTH
 * sides, because a bound only means something if the value past it is refused.
 */

const suggestion = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  seniorId: '11111111-1111-4111-8111-111111111111',
  status: 'NEW' as const,
  statusChangedAt: null,
  statusChangedByName: null,
  createdAt: '2026-08-12T09:00:00.000Z',
  matchScore: 0.5,
  matchedKeywords: ['java'],
  posting: {
    id: '22222222-2222-4222-8222-222222222222',
    sourceType: 'DOU_RSS' as const,
    externalId: 'https://jobs.dou.ua/companies/acme/vacancies/1',
    url: 'https://jobs.dou.ua/companies/acme/vacancies/1',
    title: 'Senior Java Developer',
    companyName: 'Acme',
    location: null,
    descriptionMd: '',
    publishedAt: null,
    collectedAt: '2026-08-12T09:00:00.000Z',
  },
  ...over,
})

describe('matchScore is a share, so it is bounded at BOTH ends', () => {
  it('accepts the ends of the range and a value between them', () => {
    for (const matchScore of [0, 0.5, 1]) {
      expect(jobSuggestionSchema.safeParse(suggestion({ matchScore })).success).toBe(true)
    }
  })

  it('refuses anything above 1 — a share cannot exceed the whole', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: 1.0001 })).success).toBe(false)
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: 2 })).success).toBe(false)
  })

  it('refuses anything below 0', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: -0.0001 })).success).toBe(false)
  })

  it('accepts null — "not ranked" is a different fact from "scored zero"', () => {
    expect(jobSuggestionSchema.safeParse(suggestion({ matchScore: null })).success).toBe(true)
  })
})

describe('keyword arrays are capped in length AND in element size', () => {
  const keyword = (n: number) => 'a'.repeat(n)

  it('accepts a keyword of exactly the maximum length', () => {
    const dto = suggestion({ matchedKeywords: [keyword(MAX_STACK_KEYWORD_CHARS)] })
    expect(jobSuggestionSchema.safeParse(dto).success).toBe(true)
  })

  it('refuses a keyword one character too long', () => {
    const dto = suggestion({ matchedKeywords: [keyword(MAX_STACK_KEYWORD_CHARS + 1)] })
    expect(jobSuggestionSchema.safeParse(dto).success).toBe(false)
  })

  it('accepts exactly the maximum number of keywords, and refuses one more', () => {
    const fill = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`)
    expect(
      jobSuggestionSchema.safeParse(suggestion({ matchedKeywords: fill(MAX_STACK_KEYWORDS) }))
        .success,
    ).toBe(true)
    expect(
      jobSuggestionSchema.safeParse(suggestion({ matchedKeywords: fill(MAX_STACK_KEYWORDS + 1) }))
        .success,
    ).toBe(false)
  })

  it('applies the same two caps to the senior stack on the list envelope', () => {
    const envelope = (stackKeywords: string[]) => ({
      items: [],
      lowMatch: [],
      lowMatchCount: 0,
      total: 0,
      threshold: 0.2,
      stackKeywords,
    })
    expect(
      jobSuggestionListSchema.safeParse(envelope([keyword(MAX_STACK_KEYWORD_CHARS)])).success,
    ).toBe(true)
    expect(
      jobSuggestionListSchema.safeParse(envelope([keyword(MAX_STACK_KEYWORD_CHARS + 1)])).success,
    ).toBe(false)
    expect(
      jobSuggestionListSchema.safeParse(
        envelope(Array.from({ length: MAX_STACK_KEYWORDS + 1 }, (_, i) => `k${i}`)),
      ).success,
    ).toBe(false)
  })
})

describe('the budget enums carry exactly the members the code branches on', () => {
  it('budget window: DAY and MONTH, nothing else', () => {
    expect(jobSourceBudgetWindowSchema.options).toEqual(['DAY', 'MONTH'])
    for (const value of ['DAY', 'MONTH']) {
      expect(jobSourceBudgetWindowSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['WEEK', 'YEAR', 'day', '']) {
      expect(jobSourceBudgetWindowSchema.safeParse(value).success).toBe(false)
    }
  })

  it('trigger mode: SCHEDULED, MANUAL, BOTH — dropping one silently re-enables a source', () => {
    expect(jobSourceTriggerModeSchema.options).toEqual(['SCHEDULED', 'MANUAL', 'BOTH'])
    for (const value of ['SCHEDULED', 'MANUAL', 'BOTH']) {
      expect(jobSourceTriggerModeSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['NEVER', 'manual', '']) {
      expect(jobSourceTriggerModeSchema.safeParse(value).success).toBe(false)
    }
  })

  it('budget state: the four cases the panel renders differently', () => {
    expect(jobSourceBudgetStateSchema.options).toEqual([
      'UNLIMITED',
      'ACTIVE',
      'EXHAUSTED',
      'MISCONFIGURED',
    ])
    for (const value of ['UNLIMITED', 'ACTIVE', 'EXHAUSTED', 'MISCONFIGURED']) {
      expect(jobSourceBudgetStateSchema.safeParse(value).success).toBe(true)
    }
    expect(jobSourceBudgetStateSchema.safeParse('BROKEN').success).toBe(false)
  })
})

describe('the source DTO keeps its shape', () => {
  const budget = {
    state: 'ACTIVE' as const,
    limit: 200,
    window: 'MONTH' as const,
    used: 153,
    remaining: 47,
    resetsAt: '2026-09-01T00:00:00.000Z',
  }
  const source = {
    id: '55555555-5555-4555-8555-555555555555',
    type: 'DOU_RSS' as const,
    enabled: true,
    triggerMode: 'SCHEDULED' as const,
    lastCollectedAt: null,
    budget,
  }

  it('accepts a fully-populated source', () => {
    expect(jobSourceSchema.safeParse(source).success).toBe(true)
  })

  it('refuses a budget missing its state — the field the UI branches on', () => {
    const { state: _state, ...withoutState } = budget
    expect(jobSourceBudgetSchema.safeParse(withoutState).success).toBe(false)
    expect(jobSourceSchema.safeParse({ ...source, budget: withoutState }).success).toBe(false)
  })

  it('refuses a source missing its trigger mode', () => {
    const { triggerMode: _mode, ...withoutMode } = source
    expect(jobSourceSchema.safeParse(withoutMode).success).toBe(false)
  })

  it('refuses a negative remaining count', () => {
    expect(jobSourceBudgetSchema.safeParse({ ...budget, remaining: -1 }).success).toBe(false)
    expect(jobSourceBudgetSchema.safeParse({ ...budget, used: -1 }).success).toBe(false)
  })
})
