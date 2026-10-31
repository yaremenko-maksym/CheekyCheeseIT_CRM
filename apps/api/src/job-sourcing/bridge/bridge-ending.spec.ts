import { describe, expect, it } from 'vitest'
import {
  JobSourceBudgetContentionError,
  JobSourceBudgetExhaustedError,
} from '../source-budget.error'
import { ZeroPostingsError, bridgeEnding } from './bridge-ending'

describe('bridgeEnding (ADR §1 error → run-ending map)', () => {
  it('an exhausted budget → PARTIAL / COST_STOP', () => {
    const err = new JobSourceBudgetExhaustedError('DOU_RSS', 10, new Date('2026-11-01T00:00:00Z'))
    expect(bridgeEnding(err)).toEqual({
      outcome: 'PARTIAL',
      errorCode: 'COST_STOP',
      errorMessage: err.message,
    })
  })

  it('a budget contention → CANCELLED / CANCELLED', () => {
    const err = new JobSourceBudgetContentionError('DOU_RSS', 3)
    expect(bridgeEnding(err)).toEqual({
      outcome: 'CANCELLED',
      errorCode: 'CANCELLED',
      errorMessage: err.message,
    })
  })

  it('an empty feed (ZeroPostingsError) → FAILED / PARSE_DRIFT', () => {
    expect(bridgeEnding(new ZeroPostingsError('0 usable postings'))).toEqual({
      outcome: 'FAILED',
      errorCode: 'PARSE_DRIFT',
      errorMessage: '0 usable postings',
    })
  })

  it('any other error → FAILED / UPSTREAM', () => {
    expect(bridgeEnding(new Error('dou is down'))).toEqual({
      outcome: 'FAILED',
      errorCode: 'UPSTREAM',
      errorMessage: 'dou is down',
    })
    // A non-Error throw is stringified into the message.
    expect(bridgeEnding('boom')).toMatchObject({ outcome: 'FAILED', errorCode: 'UPSTREAM' })
  })
})
