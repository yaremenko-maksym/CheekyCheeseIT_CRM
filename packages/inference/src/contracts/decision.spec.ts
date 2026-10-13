import { describe, expect, it } from 'vitest'
import { decisionQuestionSchema, decisionAnswerSchema, decisionRequestSchema } from './decision'

describe('decision contracts', () => {
  it('accepts a choice question with 1..255 options', () => {
    const q = decisionQuestionSchema.parse({ id: 'fit', kind: 'choice', options: ['yes', 'no'] })
    expect(q.kind).toBe('choice')
  })
  it('rejects a choice question with 0 options and with 256 options', () => {
    expect(() => decisionQuestionSchema.parse({ id: 'x', kind: 'choice', options: [] })).toThrow()
    expect(() =>
      decisionQuestionSchema.parse({ id: 'x', kind: 'choice', options: Array(256).fill('o') }),
    ).toThrow()
  })
  it('rejects a score question where min >= max', () => {
    expect(() => decisionQuestionSchema.parse({ id: 's', kind: 'score', min: 5, max: 5 })).toThrow()
  })
  it('accepts a noul question', () =>
    expect(decisionQuestionSchema.parse({ id: 'n', kind: 'noul' }).kind).toBe('noul'))
  it('rejects an answer with confidence outside 0..1', () => {
    expect(() => decisionAnswerSchema.parse({ id: 'n', value: true, confidence: 1.2 })).toThrow()
  })
  it('parses a full mixed choice/score/noul request', () => {
    const req = decisionRequestSchema.parse({
      state: { a: 1 },
      questions: [
        { id: 'c', kind: 'choice', options: ['y', 'n'] },
        { id: 's', kind: 'score', min: 0, max: 10 },
        { id: 'n', kind: 'noul' },
      ],
    })
    expect(req.questions.map((q) => q.kind)).toEqual(['choice', 'score', 'noul'])
  })
  it('accepts exactly 50 questions', () => {
    const qs = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, kind: 'noul' as const }))
    expect(decisionRequestSchema.parse({ state: {}, questions: qs }).questions).toHaveLength(50)
  })
  it('rejects a request with more than 50 questions', () => {
    const qs = Array.from({ length: 51 }, (_, i) => ({ id: `q${i}`, kind: 'noul' as const }))
    expect(() => decisionRequestSchema.parse({ state: {}, questions: qs })).toThrow()
  })
})
