import { describe, expect, it } from 'vitest'
import { failureOfThrown } from './metered-fetch'

/** The transport's plain `<host> responded <status>` error, read by its status (sources-12). */
describe('failureOfThrown on a plain transport error', () => {
  it('a refusal status in the message is a refusal, never a network blip', () => {
    expect(failureOfThrown(new Error('nextleveljobs.eu responded 403'), false)).toEqual({
      code: 'ACCESS_POLICY',
      message: 'provider answered HTTP 403',
      status: 403,
    })
    expect(failureOfThrown(new Error('api.example responded 451'), false)).toMatchObject({
      code: 'ACCESS_POLICY',
      status: 451,
    })
  })

  it('another status keeps the transport message and is retryable', () => {
    expect(failureOfThrown(new Error('nextleveljobs.eu responded 500'), false)).toEqual({
      code: 'TRANSIENT_NETWORK',
      message: 'nextleveljobs.eu responded 500',
      status: null,
    })
  })

  it('only the exact shape is read: a host, one space, three digits', () => {
    for (const message of [
      ' responded 403',
      'nextleveljobs.eu  responded 403',
      'nextleveljobs.eu responded 4031',
      'nextleveljobs.eu responded 40',
      'proxy said: nextleveljobs.eu responded 403',
    ]) {
      expect(failureOfThrown(new Error(message), false).code).toBe('TRANSIENT_NETWORK')
    }
  })

  it('an aborted request is cancelled, and a non-Error throw gets a fixed message', () => {
    expect(failureOfThrown(new Error('socket hang up'), true)).toEqual({
      code: 'CANCELLED',
      message: 'socket hang up',
      status: null,
    })
    expect(failureOfThrown('boom', false)).toEqual({
      code: 'TRANSIENT_NETWORK',
      message: 'the request failed',
      status: null,
    })
  })
})
