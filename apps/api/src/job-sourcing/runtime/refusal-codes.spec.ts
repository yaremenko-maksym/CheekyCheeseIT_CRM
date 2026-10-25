import { describe, expect, it } from 'vitest'
import { RunFencedError, isRunFenced } from '../ownership/run-ownership'
import { collectionCodeOf } from '../providers/reporting-provider'
import { ContextRefusedError } from './collection-context'

/**
 * r5 Task 2.5 T7 — the two readers of a refusal's code: `isRunFenced` (ownership, read by the loops
 * at `markSent`) and `collectionCodeOf` (any collection code a thrown value already carries).
 */
describe('isRunFenced', () => {
  it('is true for the ledger`s and the context`s fenced refusals', () => {
    expect(isRunFenced(new RunFencedError())).toBe(true)
    expect(isRunFenced(new ContextRefusedError('RUN_FENCED', 'lease passed'))).toBe(true)
  })

  it.each([undefined, null, 'RUN_FENCED', 7, new Error('x'), { code: 'DEADLINE' }])(
    'is false for %o',
    (value) => {
      expect(isRunFenced(value)).toBe(false)
    },
  )
})

describe('collectionCodeOf', () => {
  it('reads a known collection code', () => {
    expect(collectionCodeOf(new ContextRefusedError('NOT_MARKED_SENT', 'x'))).toBe(
      'NOT_MARKED_SENT',
    )
    expect(collectionCodeOf({ code: 'RUN_FENCED' })).toBe('RUN_FENCED')
  })

  it.each([
    undefined,
    null,
    'NOT_MARKED_SENT',
    0,
    { code: 'NOPE' },
    { code: 5 },
    { code: 'ECONNRESET' },
  ])('is null for %o', (value) => {
    expect(collectionCodeOf(value)).toBeNull()
  })
})
