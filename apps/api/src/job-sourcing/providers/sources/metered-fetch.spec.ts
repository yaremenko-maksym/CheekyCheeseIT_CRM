import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { createMeteredFetch, type Failure, failureOfThrown } from './metered-fetch'

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

/** H-4 (task sources-16): a 410 Gone is an answer only where the caller says a posting may be gone. */
describe('createMeteredFetch and a 410 Gone', () => {
  const ask = async (
    status: number,
    notFoundIsAnAnswer: boolean,
    redirectIsAnAnswer: boolean,
    goneIsAnAnswer?: boolean,
  ) => {
    const f = fakeCollectionContext({ responses: [{ status }] })
    const reports: (Failure | null)[] = []
    const metered = createMeteredFetch(f.ctx, 5, (_at, _url, _status, _startedAt, _cost, error) => {
      reports.push(error)
    })
    const fetched = await metered(
      1,
      { url: 'https://example.test/x' },
      notFoundIsAnAnswer,
      redirectIsAnAnswer,
      ...(goneIsAnAnswer === undefined ? [] : [goneIsAnAnswer]),
    )
    return { fetched, reports }
  }

  it('a detail that may be gone gets its 410 through as an answer, unreported', async () => {
    const { fetched, reports } = await ask(410, true, false, true)
    expect(fetched).toMatchObject({ ok: true, status: 410 })
    expect(reports).toEqual([])
  })

  it('without the opt-in a 410 stays a failure: a list, a sitemap, robots (today)', async () => {
    for (const [notFound, redirect] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const { fetched, reports } = await ask(410, notFound, redirect)
      expect(fetched).toEqual({ ok: false, stop: 'ERROR' })
      expect(reports).toEqual([
        { code: 'UPSTREAM', message: 'provider answered HTTP 410', status: 410 },
      ])
    }
  })

  it('the opt-in admits 410 only: a 404 still needs notFoundIsAnAnswer, other 4xx never pass', async () => {
    expect((await ask(404, false, false, true)).fetched).toEqual({ ok: false, stop: 'ERROR' })
    expect((await ask(404, true, false, true)).fetched).toMatchObject({ ok: true, status: 404 })
    for (const status of [400, 409, 411, 500]) {
      expect((await ask(status, true, true, true)).fetched).toEqual({ ok: false, stop: 'ERROR' })
    }
  })
})
