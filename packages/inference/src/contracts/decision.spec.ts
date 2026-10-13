import { describe, expect, it } from 'vitest'
import { decisionQuestionSchema, decisionAnswerSchema, decisionRequestSchema } from './decision'

const noulQ = (i: number) => ({ id: `q${i}`, kind: 'noul' as const, instructions: 'ok?' })

describe('decision contracts', () => {
  it('accepts a choice question with described options', () => {
    const q = decisionQuestionSchema.parse({
      id: 'fit',
      kind: 'choice',
      instructions: 'Pick the fit',
      options: [{ value: 'yes', description: 'a good fit' }, { value: 'no' }],
    })
    expect(q.kind).toBe('choice')
  })
  it('rejects a choice question with 0 options, 256 options or an empty option value', () => {
    const base = { id: 'x', kind: 'choice', instructions: 'i' }
    expect(() => decisionQuestionSchema.parse({ ...base, options: [] })).toThrow()
    expect(() =>
      decisionQuestionSchema.parse({ ...base, options: Array(256).fill({ value: 'o' }) }),
    ).toThrow()
    expect(() => decisionQuestionSchema.parse({ ...base, options: [{ value: '' }] })).toThrow()
  })
  it('accepts a score question with 2..10 levels and rejects 1 or 11', () => {
    const base = { id: 's', kind: 'score', instructions: 'i' }
    expect(decisionQuestionSchema.parse({ ...base, levels: ['low', 'high'] }).kind).toBe('score')
    expect(() => decisionQuestionSchema.parse({ ...base, levels: ['only'] })).toThrow()
    expect(() => decisionQuestionSchema.parse({ ...base, levels: Array(11).fill('l') })).toThrow()
    expect(() => decisionQuestionSchema.parse({ ...base, levels: ['a', ''] })).toThrow()
  })
  it('accepts a noul question with optional labels', () => {
    const q = decisionQuestionSchema.parse({
      id: 'n',
      kind: 'noul',
      instructions: 'remote?',
      trueLabel: 'remote',
      falseLabel: 'onsite',
    })
    expect(q.kind).toBe('noul')
  })
  it('rejects empty instructions', () => {
    expect(() =>
      decisionQuestionSchema.parse({ id: 'n', kind: 'noul', instructions: '' }),
    ).toThrow()
  })
  it('validates each answer kind and rejects confidence outside 0..1', () => {
    expect(
      decisionAnswerSchema.parse({
        id: 'c',
        kind: 'choice',
        value: 'yes',
        confidence: 0.9,
        probabilities: { yes: 0.9, no: 0.1 },
      }).kind,
    ).toBe('choice')
    expect(
      decisionAnswerSchema.parse({ id: 's', kind: 'score', value: 2, confidence: 0.5 }).kind,
    ).toBe('score')
    expect(
      decisionAnswerSchema.parse({ id: 'n', kind: 'noul', value: true, probability: 0.3 }).kind,
    ).toBe('noul')
    expect(() =>
      decisionAnswerSchema.parse({ id: 's', kind: 'score', value: 2, confidence: 1.2 }),
    ).toThrow()
    expect(() =>
      decisionAnswerSchema.parse({ id: 'n', kind: 'noul', value: true, probability: -0.1 }),
    ).toThrow()
  })
  it('parses a full mixed request', () => {
    const req = decisionRequestSchema.parse({
      state: { a: 1 },
      questions: [
        { id: 'c', kind: 'choice', instructions: 'i', options: [{ value: 'y' }, { value: 'n' }] },
        { id: 's', kind: 'score', instructions: 'i', levels: ['lo', 'hi'] },
        noulQ(1),
      ],
    })
    expect(req.questions.map((q) => q.kind)).toEqual(['choice', 'score', 'noul'])
  })
  it('accepts exactly 50 questions and rejects 51', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => noulQ(i))
    expect(decisionRequestSchema.parse({ state: {}, questions: mk(50) }).questions).toHaveLength(50)
    expect(() => decisionRequestSchema.parse({ state: {}, questions: mk(51) })).toThrow()
  })
})
