import type {
  DecisionAnswer,
  DecisionPort,
  DecisionQuestion,
  DecisionRequest,
} from '@crm/inference'
import { describe, expect, it, vi } from 'vitest'
import { decideAll } from './jev-decide'

const noul = (id: string): DecisionQuestion => ({ id, kind: 'noul', instructions: 'Is it?' })
const answerOf = (q: DecisionQuestion): DecisionAnswer =>
  q.kind === 'noul'
    ? { id: q.id, kind: 'noul', value: true, probability: 0.9 }
    : q.kind === 'score'
      ? { id: q.id, kind: 'score', value: 1, confidence: 0.9 }
      : { id: q.id, kind: 'choice', value: 'a', confidence: 0.9, probabilities: { a: 0.9 } }

/** A port that answers every question it is asked, with `edit` applied to the answers. */
const port = (edit: (answers: DecisionAnswer[]) => DecisionAnswer[] = (a) => a) => {
  const decide = vi.fn(async (req: DecisionRequest) => ({
    ok: true as const,
    answers: edit(req.questions.map(answerOf)),
  }))
  return { decide } satisfies DecisionPort
}

describe('decideAll', () => {
  it('51 questions → 2 decide calls, 50 then 1, each with the same state', async () => {
    const p = port()
    const questions = Array.from({ length: 51 }, (_, i) => noul(`q${i}`))
    const answers = await decideAll(p, { s: 1 }, questions)
    expect(p.decide).toHaveBeenCalledTimes(2)
    expect(p.decide.mock.calls[0]?.[0].questions).toHaveLength(50)
    expect(p.decide.mock.calls[1]?.[0].questions).toHaveLength(1)
    expect(p.decide.mock.calls[1]?.[0].state).toEqual({ s: 1 })
    expect(answers instanceof Map && answers.size).toBe(51)
    expect(answers instanceof Map && answers.get('q50')).toEqual({
      id: 'q50',
      kind: 'noul',
      value: true,
      probability: 0.9,
    })
  })

  it('a duplicate id → unavailable, nothing sent', async () => {
    const p = port()
    expect(await decideAll(p, {}, [noul('a'), noul('a')])).toEqual({
      kind: 'unavailable',
      cause: 'DUPLICATE_ID',
    })
    expect(p.decide).not.toHaveBeenCalled()
  })

  it('an invalid request → unavailable, nothing sent', async () => {
    const p = port()
    expect(await decideAll(p, {}, [{ id: 'a', kind: 'noul', instructions: '' }])).toEqual({
      kind: 'unavailable',
      cause: 'INVALID_REQUEST',
    })
    expect(p.decide).not.toHaveBeenCalled()
  })

  it('no questions → an empty map, nothing sent', async () => {
    const p = port()
    expect(await decideAll(p, {}, [])).toEqual(new Map())
    expect(p.decide).not.toHaveBeenCalled()
  })

  it('an extra id → unavailable', async () => {
    const p = port((a) => [...a.slice(1), { ...(a[0] as DecisionAnswer), id: 'zz' }])
    expect(await decideAll(p, {}, [noul('a'), noul('b')])).toEqual({
      kind: 'unavailable',
      cause: 'INVALID_ANSWER',
    })
  })

  it('a repeated answer id → unavailable', async () => {
    const p = port((a) => [a[0] as DecisionAnswer, a[0] as DecisionAnswer])
    expect(await decideAll(p, {}, [noul('a'), noul('b')])).toEqual({
      kind: 'unavailable',
      cause: 'INVALID_ANSWER',
    })
  })

  it('an answer count other than asked → unavailable', async () => {
    const p = port((a) => a.slice(1))
    expect(await decideAll(p, {}, [noul('a'), noul('b')])).toEqual({
      kind: 'unavailable',
      cause: 'ANSWER_COUNT',
    })
  })

  it('a score answer to a noul question → unavailable', async () => {
    const p = port(() => [{ id: 'a', kind: 'score', value: 1, confidence: 1 }])
    expect(await decideAll(p, {}, [noul('a')])).toEqual({
      kind: 'unavailable',
      cause: 'INVALID_ANSWER',
    })
  })

  it('the port throws → unavailable with the error name', async () => {
    const p = {
      decide: vi.fn(async () => {
        throw new TypeError('boom with text')
      }),
    }
    expect(await decideAll(p, {}, [noul('a')])).toEqual({
      kind: 'unavailable',
      cause: 'TypeError',
    })
  })

  it('a thrown non-Error → unavailable unknown', async () => {
    const p = {
      decide: vi.fn(async () => {
        throw 'x'
      }),
    }
    expect(await decideAll(p, {}, [noul('a')])).toEqual({ kind: 'unavailable', cause: 'unknown' })
  })

  it('ok: false → unavailable with the code', async () => {
    const p = { decide: vi.fn(async () => ({ ok: false as const, code: 'RATE_LIMITED' as const })) }
    expect(await decideAll(p, {}, [noul('a')])).toEqual({
      kind: 'unavailable',
      cause: 'RATE_LIMITED',
    })
  })

  it('a later chunk failing makes the whole call unavailable', async () => {
    const decide = vi
      .fn<DecisionPort['decide']>()
      .mockImplementationOnce(async (req) => ({ ok: true, answers: req.questions.map(answerOf) }))
      .mockResolvedValueOnce({ ok: false, code: 'TIMEOUT' })
    const questions = Array.from({ length: 51 }, (_, i) => noul(`q${i}`))
    expect(await decideAll({ decide }, {}, questions)).toEqual({
      kind: 'unavailable',
      cause: 'TIMEOUT',
    })
  })
})
