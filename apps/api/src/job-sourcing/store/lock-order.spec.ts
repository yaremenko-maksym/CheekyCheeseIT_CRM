import { describe, expect, it } from 'vitest'
import {
  LockContentionError,
  RetryableRaceError,
  backoffMs,
  byNaturalKey,
  retryableCode,
  sortedUniqueIds,
  withLockRetry,
} from './lock-order'

/** A pg `DatabaseError` as drizzle surfaces it: wrapped, the SQLSTATE on `.cause`. */
const pgError = (code: string) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('db'), { code, severity: 'ERROR' }),
  })

const noSleep = async () => {}

describe('retryableCode', () => {
  it('names the three contention SQLSTATEs through drizzle’s wrapper', () => {
    expect(retryableCode(pgError('40P01'))).toBe('40P01')
    expect(retryableCode(pgError('40001'))).toBe('40001')
    expect(retryableCode(pgError('55P03'))).toBe('55P03')
  })

  it('names a raw pg error too', () => {
    expect(retryableCode(Object.assign(new Error('x'), { code: '40P01', severity: 'ERROR' }))).toBe(
      '40P01',
    )
  })

  it('names the store’s own lost-race signal', () => {
    const race = new RetryableRaceError('token')
    expect(retryableCode(race)).toBe('RACE')
    expect(race.message).toBe('lost a concurrent token race')
    expect(race.name).toBe('RetryableRaceError')
  })

  it('is null for every other error, a unique violation included', () => {
    expect(retryableCode(pgError('23505'))).toBeNull()
    expect(retryableCode(new Error('boom'))).toBeNull()
    expect(retryableCode('40P01')).toBeNull()
    expect(retryableCode(undefined)).toBeNull()
  })
})

describe('backoffMs', () => {
  it('doubles per attempt from a 10 ms base, scaled by a jitter in [0.5, 1.5)', () => {
    expect(backoffMs(1, () => 0)).toBe(5)
    expect(backoffMs(1, () => 0.5)).toBe(10)
    expect(backoffMs(2, () => 0.5)).toBe(20)
    expect(backoffMs(3, () => 0.5)).toBe(40)
    expect(backoffMs(3, () => 0.999)).toBe(59)
  })
})

describe('withLockRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0
    const out = await withLockRetry(
      async () => {
        calls += 1
        return 'ok'
      },
      { sleep: noSleep },
    )
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries a deadlock and returns the later success, sleeping the backoff between', async () => {
    let calls = 0
    const slept: number[] = []
    const out = await withLockRetry(
      async () => {
        calls += 1
        if (calls < 3) throw pgError('40P01')
        return calls
      },
      { sleep: async (ms) => void slept.push(ms), random: () => 0.5 },
    )
    expect(out).toBe(3)
    expect(slept).toEqual([10, 20])
  })

  it('gives up after three attempts with a typed LockContentionError carrying the code and cause', async () => {
    let calls = 0
    const last = pgError('55P03')
    const err = await withLockRetry(
      async () => {
        calls += 1
        throw calls === 3 ? last : pgError('40P01')
      },
      { sleep: noSleep },
    ).catch((e: unknown) => e)
    expect(calls).toBe(3)
    expect(err).toBeInstanceOf(LockContentionError)
    const typed = err as LockContentionError
    expect(typed.code).toBe('LOCK_CONTENTION')
    expect(typed.sqlstate).toBe('55P03')
    expect(typed.attempts).toBe(3)
    expect(typed.cause).toBe(last)
    expect(typed.name).toBe('LockContentionError')
    expect(typed.message).toBe('lock contention persisted after 3 attempts (55P03)')
  })

  it('honours a smaller attempt budget', async () => {
    let calls = 0
    await expect(
      withLockRetry(
        async () => {
          calls += 1
          throw pgError('40001')
        },
        { maxAttempts: 1, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(LockContentionError)
    expect(calls).toBe(1)
  })

  it('rethrows a non-retryable error at once, untouched', async () => {
    let calls = 0
    const boom = new Error('boom')
    await expect(
      withLockRetry(
        async () => {
          calls += 1
          throw boom
        },
        { sleep: noSleep },
      ),
    ).rejects.toBe(boom)
    expect(calls).toBe(1)
  })

  it('sleeps with the default timer when none is given', async () => {
    let calls = 0
    const started = Date.now()
    await withLockRetry(async () => {
      calls += 1
      if (calls === 1) throw pgError('40P01')
    })
    expect(calls).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(4)
  })
})

describe('lock order', () => {
  const o = (namespace: string, identityKey: string, tag = '') => ({
    identity: { namespace, identityKey },
    tag,
  })

  it('orders observations by namespace, then identity key, by code unit, dropping repeats', () => {
    const sorted = byNaturalKey([
      o('b', '1'),
      o('a', '2'),
      o('a', '10', 'first'),
      o('B', '9'),
      o('a', '10', 'second'),
    ])
    expect(sorted.map((x) => `${x.identity.namespace}/${x.identity.identityKey}${x.tag}`)).toEqual([
      'B/9',
      'a/10first',
      'a/2',
      'b/1',
    ])
  })

  it('keeps an empty input empty', () => {
    expect(byNaturalKey([])).toEqual([])
  })

  it('orders by the namespace first even when a namespace prefixes another', () => {
    const sorted = byNaturalKey([o('a1', '0'), o('a', '9'), o('a', '10')])
    expect(sorted.map((x) => `${x.identity.namespace}|${x.identity.identityKey}`)).toEqual([
      'a|10',
      'a|9',
      'a1|0',
    ])
  })

  it('sorts ids by code unit, uppercase before lowercase, whatever the input order', () => {
    expect(sortedUniqueIds(['b', 'B', 'a', 'A', 'b'])).toEqual(['A', 'B', 'a', 'b'])
  })

  it('sorts ids ascending and drops duplicates', () => {
    expect(sortedUniqueIds(['c', 'a', 'b', 'a'])).toEqual(['a', 'b', 'c'])
  })
})
