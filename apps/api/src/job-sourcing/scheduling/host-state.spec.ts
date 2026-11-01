import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import {
  HOST_BAN_PAUSE_MAX_HOURS,
  HOST_BAN_PAUSE_MIN_HOURS,
  HOST_REFUSALS,
  type HostBan,
  type SqlExecutor,
  banTargetOf,
  claimHostSlot,
  hostBanStatement,
  hostOpenPredicate,
  hostSlotStatements,
  parseRetryAfter,
  readHostPaused,
  recordHostBan,
  retrySql,
} from './host-state'

/**
 * Task 2.5 T8, unit level. The SEMANTICS of every statement are proven against Postgres, as
 * `crm_app`, by `host-state.integration.spec.ts` (which the mutation gate cannot run); this pins
 * the exact text and parameters, and every TypeScript branch, against a scripted executor.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const SOURCE = '11111111-1111-4111-8111-111111111111'
const ban = (over: Partial<HostBan> = {}): HostBan => ({
  hostKey: 'remotive.com',
  reason: 'HTTP_429',
  sourceId: SOURCE,
  floorHours: 0,
  ...over,
})

describe('parseRetryAfter', () => {
  it('reads delay-seconds as a delay, trimming whitespace', () => {
    expect(parseRetryAfter('7200')).toEqual({ kind: 'DELAY', seconds: 7200 })
    expect(parseRetryAfter(' 0 ')).toEqual({ kind: 'DELAY', seconds: 0 })
    expect(parseRetryAfter('999999999999')).toEqual({ kind: 'DELAY', seconds: 30 * 24 * 3600 })
  })

  it('caps a delay at exactly 30 days, and keeps one just under', () => {
    expect(parseRetryAfter('2592000')).toEqual({ kind: 'DELAY', seconds: 2_592_000 })
    expect(parseRetryAfter('2592001')).toEqual({ kind: 'DELAY', seconds: 2_592_000 })
    expect(parseRetryAfter('2591999')).toEqual({ kind: 'DELAY', seconds: 2_591_999 })
  })

  it('reads an IMF-fixdate as an absolute instant', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toEqual({
      kind: 'AT',
      at: new Date('2026-10-21T07:28:00.000Z'),
    })
    expect(parseRetryAfter('Sat, 31 Oct 2026 23:59:59 GMT')).toEqual({
      kind: 'AT',
      at: new Date('2026-10-31T23:59:59.000Z'),
    })
  })

  it('ignores malformed, negative, fractional and non-string values', () => {
    for (const bad of [
      '-5',
      '1.5',
      '',
      '  ',
      'soon',
      '1e3',
      '0x10',
      'Infinity',
      'NaN',
      '1234567890123',
      'Wed, 21 Oct 2026 07:28:00 UTC',
      'Wednesday, 21-Oct-26 07:28:00 GMT',
      'Wed Oct 21 07:28:00 2026',
      'Wed, 21 Oct 2026 07:28 GMT',
      'x Wed, 21 Oct 2026 07:28:00 GMT',
      'Wed, 21 Oct 2026 07:28:00 GMT x',
    ]) {
      expect(parseRetryAfter(bad), bad).toBeNull()
    }
    for (const bad of [7200, null, undefined, Number.NaN, {}, ['7200']]) {
      expect(parseRetryAfter(bad)).toBeNull()
    }
  })

  describe('SR-H-1: a header that parses to NO instant is ignored, never thrown on', () => {
    const NAN_INPUTS = [
      'Invalid Date',
      'invalid date',
      'INVALID DATE',
      ' Invalid Date ',
      'Mon, 32 Foo 2026',
      'Mon, 32 Foo 2026 00:00:00 GMT',
      'NaN',
      'undefined',
      'null',
      '\u0000',
      'Wed, 21 Oct 2026 07:28:00 GMT\u0000',
      '２０２６',
      '9'.repeat(400),
    ]

    it('parseRetryAfter returns null for every one of them', () => {
      for (const raw of NAN_INPUTS) expect(parseRetryAfter(raw), JSON.stringify(raw)).toBeNull()
    })

    it('hostBanStatement builds for every one of them, with no retry term (the 24 h floor)', () => {
      for (const raw of NAN_INPUTS) {
        const q = render(hostBanStatement(ban({ retryAfter: raw })))
        expect(q.params, JSON.stringify(raw)).toEqual(['remotive.com', 720, 24, 'HTTP_429', SOURCE])
        expect(q.sql).toContain(
          'GREATEST(clock_timestamp() + make_interval(hours => $3), NULL::timestamptz)',
        )
      }
    })

    it('retrySql itself cannot throw: an invalid Date or a year past 9999 becomes NULL', () => {
      const shape = (q: SQL) => {
        const { sql, params } = render(q)
        return { sql, params }
      }
      const nul = shape(retrySql({ kind: 'AT', at: new Date(Number.NaN) }))
      expect(nul).toEqual({ sql: 'NULL::timestamptz', params: [] })
      const y10k = new Date(Date.UTC(2000, 0, 1))
      y10k.setUTCFullYear(10_000)
      expect(shape(retrySql({ kind: 'AT', at: y10k }))).toEqual({
        sql: 'NULL::timestamptz',
        params: [],
      })
      expect(shape(retrySql({ kind: 'AT', at: new Date('9999-12-31T23:59:59.000Z') }))).toEqual({
        sql: '$1::timestamptz',
        params: ['9999-12-31T23:59:59.000Z'],
      })
      expect(shape(retrySql(null))).toEqual({ sql: 'NULL::timestamptz', params: [] })
      expect(shape(retrySql({ kind: 'DELAY', seconds: 5 }))).toEqual({
        sql: 'clock_timestamp() + make_interval(secs => $1)',
        params: [5],
      })
    })

    it('CR-M-6 / SR-L-1: retrySql refuses year 0, negative years and non-finite or negative delays', () => {
      const shape = (q: SQL) => {
        const { sql, params } = render(q)
        return { sql, params }
      }
      const NULL = { sql: 'NULL::timestamptz', params: [] }
      const inYear = (year: number) => {
        const d = new Date(Date.UTC(2000, 0, 1))
        d.setUTCFullYear(year)
        return d
      }
      for (const at of [inYear(0), inYear(-1), new Date(-8.64e15)]) {
        expect(shape(retrySql({ kind: 'AT', at })), String(at.getUTCFullYear())).toEqual(NULL)
      }
      // The first storable year passes: the bound is `< 1`, not `<= 1`.
      expect(shape(retrySql({ kind: 'AT', at: inYear(1) }))).toEqual({
        sql: '$1::timestamptz',
        params: ['0001-01-01T00:00:00.000Z'],
      })
      for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
        expect(shape(retrySql({ kind: 'DELAY', seconds })), String(seconds)).toEqual(NULL)
      }
      // A zero delay is a valid argument: the bound is `< 0`, not `<= 0`.
      expect(shape(retrySql({ kind: 'DELAY', seconds: 0 }))).toEqual({
        sql: 'clock_timestamp() + make_interval(secs => $1)',
        params: [0],
      })
    })
  })

  describe('SEC-AUTO-1: only an instant Postgres can store reaches the SQL', () => {
    const inYear = (year: number) => {
      const d = new Date(Date.UTC(2000, 0, 1, 0, 0, 0))
      d.setUTCFullYear(year)
      return d
    }

    it('refuses year 0000 (out of range for timestamptz) and every year 0001-0099 (the parser reads them as 19xx/20xx)', () => {
      expect(inYear(0).toUTCString()).toBe('Sat, 01 Jan 0000 00:00:00 GMT')
      for (const year of [0, 1, 49, 50, 99]) {
        expect(parseRetryAfter(inYear(year).toUTCString()), String(year)).toBeNull()
      }
    })

    it('refuses year 10000 and later, and negative years, in every spelling', () => {
      for (const year of [10_000, 275_000, -1, -271_000]) {
        const d = inYear(year)
        expect(parseRetryAfter(d.toUTCString()), d.toUTCString()).toBeNull()
        expect(parseRetryAfter(d.toISOString()), d.toISOString()).toBeNull()
      }
      expect(parseRetryAfter('Sat, 01 Jan 10000 00:00:00 GMT')).toBeNull()
      expect(parseRetryAfter('+010000-01-01T00:00:00.000Z')).toBeNull()
      expect(parseRetryAfter('-000001-01-01T00:00:00.000Z')).toBeNull()
      expect(parseRetryAfter('2026-10-21T07:28:00.000Z')).toBeNull()
    })

    it('accepts the last storable instant, a far-past date and a date 100 years ahead (SQL caps them)', () => {
      expect(parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT')).toEqual({
        kind: 'AT',
        at: new Date('9999-12-31T23:59:59.000Z'),
      })
      expect(parseRetryAfter('Mon, 01 Jan 1900 00:00:00 GMT')).toEqual({
        kind: 'AT',
        at: new Date('1900-01-01T00:00:00.000Z'),
      })
      const ahead = new Date(Date.UTC(2126, 9, 24, 12, 0, 0))
      expect(parseRetryAfter(ahead.toUTCString())).toEqual({ kind: 'AT', at: ahead })
    })

    it('delta-seconds is a finite non-negative integer, capped at 30 days', () => {
      for (const bad of ['Infinity', '-Infinity', 'NaN', '-1', '1.5', '1e9', '9'.repeat(13)]) {
        expect(parseRetryAfter(bad), bad).toBeNull()
      }
      expect(parseRetryAfter('9'.repeat(12))).toEqual({ kind: 'DELAY', seconds: 2_592_000 })
      expect(parseRetryAfter('3600')).toEqual({ kind: 'DELAY', seconds: 3600 })
    })

    it('every instant it returns renders to an unsigned four-digit ISO year', () => {
      for (const header of [
        'Fri, 31 Dec 9999 23:59:59 GMT',
        'Mon, 01 Jan 1900 00:00:00 GMT',
        'Wed, 21 Oct 2026 07:28:00 GMT',
      ]) {
        const r = parseRetryAfter(header)
        expect(r?.kind, header).toBe('AT')
        expect((r as { at: Date }).at.toISOString()).toMatch(/^\d{4}-/)
      }
    })
  })

  it('reads every month and every weekday', () => {
    for (let month = 0; month < 12; month += 1) {
      for (const day of [1, 2, 3, 4, 5, 6, 7]) {
        const at = new Date(Date.UTC(2027, month, day, 9, 5, 7))
        expect(parseRetryAfter(at.toUTCString()), at.toUTCString()).toEqual({ kind: 'AT', at })
      }
    }
  })

  it('ignores a date the parser would roll over, even with the weekday of the rolled date', () => {
    // 31 Feb 2026 rolls to Tue 3 Mar; 24:00 on Wed 21 Oct rolls to Thu 22 Oct.
    expect(parseRetryAfter('Tue, 31 Feb 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('Thu, 21 Oct 2026 24:00:00 GMT')).toBeNull()
  })

  it('ignores a date that does not exist or whose weekday is wrong', () => {
    expect(parseRetryAfter('Sat, 31 Feb 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('Thu, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2026 24:00:00 GMT')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:60:00 GMT')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:60 GMT')).toBeNull()
    expect(parseRetryAfter('Wed, 32 Oct 2026 07:28:00 GMT')).toBeNull()
  })
})

describe('banTargetOf (SR-M-24)', () => {
  it('429 and 451 ban the host whatever the scope', () => {
    for (const scope of ['HOST', 'SOURCE'] as const) {
      expect(banTargetOf(scope, 429)).toBe('HOST')
      expect(banTargetOf(scope, 451)).toBe('HOST')
    }
  })

  it('a 403 bans the host by default and only the source under the SOURCE scope', () => {
    expect(banTargetOf('HOST', 403)).toBe('HOST')
    expect(banTargetOf('SOURCE', 403)).toBe('SOURCE')
    // An unknown scope fails toward stopping.
    expect(banTargetOf('ANYTHING' as never, 403)).toBe('HOST')
  })

  it('a 401 bans exactly as a 403 does (T6)', () => {
    expect(banTargetOf('HOST', 401)).toBe('HOST')
    expect(banTargetOf('SOURCE', 401)).toBe('SOURCE')
  })

  it('an absent scope bans the host, typed as such (T6: no cast at the caller)', () => {
    expect(banTargetOf(undefined, 403)).toBe('HOST')
    expect(banTargetOf(undefined, 401)).toBe('HOST')
  })

  it('any other status is not a ban', () => {
    for (const s of [200, 400, 402, 404, 430, 450, 452, 500, 503]) {
      expect(banTargetOf('HOST', s)).toBe('NONE')
    }
  })
})

describe('hostBanStatement', () => {
  it('pins the statement: capped, never shorter than a day or the floor, monotone, same-source no-op', () => {
    const q = render(hostBanStatement(ban({ retryAfter: '7200', floorHours: 6 })))
    expect(q.sql)
      .toBe(`INSERT INTO job_source_hosts AS h (host_key, paused_until, pause_reason, pause_source_id)
VALUES ($1, LEAST(clock_timestamp() + make_interval(hours => $2), GREATEST(clock_timestamp() + make_interval(hours => $3), clock_timestamp() + make_interval(secs => $4))), $5, $6::uuid)
ON CONFLICT (host_key) DO UPDATE SET
  paused_until = GREATEST(h.paused_until, EXCLUDED.paused_until),
  pause_reason = CASE WHEN EXCLUDED.paused_until > COALESCE(h.paused_until, '-infinity') THEN EXCLUDED.pause_reason ELSE h.pause_reason END,
  pause_source_id = CASE WHEN EXCLUDED.paused_until > COALESCE(h.paused_until, '-infinity') THEN EXCLUDED.pause_source_id ELSE h.pause_source_id END
WHERE h.paused_until IS NULL OR h.paused_until <= clock_timestamp() OR h.pause_source_id IS DISTINCT FROM EXCLUDED.pause_source_id
RETURNING 1 AS applied`)
    expect(q.params).toEqual(['remotive.com', 720, 24, 7200, 'HTTP_429', SOURCE])
  })

  it('a floor longer than a day is the base; a missing Retry-After is a NULL that GREATEST skips', () => {
    const q = render(hostBanStatement(ban({ floorHours: 48 })))
    expect(q.params).toEqual(['remotive.com', 720, 48, 'HTTP_429', SOURCE])
    expect(q.sql).toContain(
      'GREATEST(clock_timestamp() + make_interval(hours => $3), NULL::timestamptz)',
    )
    expect(render(hostBanStatement(ban({ floorHours: 24 }))).params[2]).toBe(24)
    expect(render(hostBanStatement(ban({ floorHours: 23 }))).params[2]).toBe(24)
    expect(render(hostBanStatement(ban({ floorHours: 25 }))).params[2]).toBe(25)
  })

  it('an HTTP-date is passed as an absolute instant parameter, not computed from an app clock (SR-L-20)', () => {
    const q = render(hostBanStatement(ban({ retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' })))
    expect(q.params).toEqual([
      'remotive.com',
      720,
      24,
      '2026-10-21T07:28:00.000Z',
      'HTTP_429',
      SOURCE,
    ])
    expect(q.sql).toContain(
      'GREATEST(clock_timestamp() + make_interval(hours => $3), $4::timestamptz)',
    )
  })

  it('a malformed Retry-After is ignored', () => {
    expect(render(hostBanStatement(ban({ retryAfter: '-1' }))).params).toEqual([
      'remotive.com',
      720,
      24,
      'HTTP_429',
      SOURCE,
    ])
  })

  it('refuses an invalid key, reason, source or floor before building any SQL', () => {
    for (const hostKey of ['', 'Remotive.com', 'remotive', 'a.b/c', 'x'.repeat(250) + '.com']) {
      expect(() => hostBanStatement(ban({ hostKey }))).toThrow('recordHostBan: invalid host key')
    }
    for (const reason of ['', 'http_429', '4XX', 'A'.repeat(65)]) {
      expect(() => hostBanStatement(ban({ reason }))).toThrow('recordHostBan: invalid reason code')
    }
    for (const sourceId of [
      '',
      'not-a-uuid',
      'AAAAAAAA-1111-4111-8111-111111111111',
      `${SOURCE}0`,
      `x${SOURCE}`,
    ]) {
      expect(() => hostBanStatement(ban({ sourceId }))).toThrow('recordHostBan: invalid source id')
    }
    for (const floorHours of [-1, 1.5, 721, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => hostBanStatement(ban({ floorHours }))).toThrow(
        'recordHostBan: invalid floor hours',
      )
    }
    expect(() => hostBanStatement(ban({ floorHours: 0 }))).not.toThrow()
    expect(() => hostBanStatement(ban({ floorHours: 720 }))).not.toThrow()
    expect(() => hostBanStatement(ban({ reason: 'A'.repeat(64) }))).not.toThrow()
  })

  it('names the bounds it is built on', () => {
    expect([HOST_BAN_PAUSE_MIN_HOURS, HOST_BAN_PAUSE_MAX_HOURS]).toEqual([24, 720])
  })
})

describe('recordHostBan (against a recording transaction)', () => {
  function fakeDb(rows: Record<string, unknown>[]) {
    const seen: { query?: SQL; options?: unknown } = {}
    const db = {
      transaction: async (
        run: (tx: SqlExecutor) => Promise<{ rows: Record<string, unknown>[] }>,
        options: unknown,
      ) => {
        seen.options = options
        return run({
          execute: (q: SQL) => {
            seen.query = q
            return Promise.resolve({ rows })
          },
        })
      },
    } as unknown as DatabaseService['db']
    return { db, seen }
  }

  it('runs the ban statement in one READ COMMITTED transaction and reports a row as applied', async () => {
    const { db, seen } = fakeDb([{ applied: 1 }])
    await expect(recordHostBan(db, ban())).resolves.toEqual({ applied: true })
    expect(seen.options).toEqual({ isolationLevel: 'read committed' })
    expect(render(seen.query!)).toEqual(render(hostBanStatement(ban())))
  })

  it('reports no row (a same-source repeat) as not applied', async () => {
    await expect(recordHostBan(fakeDb([]).db, ban())).resolves.toEqual({ applied: false })
  })

  it('validates before it opens a transaction', async () => {
    const { db, seen } = fakeDb([])
    await expect(recordHostBan(db, ban({ hostKey: '' }))).rejects.toThrow(RangeError)
    expect(seen.options).toBeUndefined()
  })
})

describe('claimHostSlot (against a scripted executor)', () => {
  const policy = { rate: { perMinute: 2, perDay: 4 }, floorHours: 6 }
  const open = { paused: false, paused_until: null, busy: false, in_gap: false, gap_ends_at: null }
  const AT = new Date('2026-10-25T00:00:00.000Z')

  function scripted(results: Record<string, unknown>[][]) {
    const seen: string[] = []
    const params: unknown[][] = []
    let i = 0
    const tx: SqlExecutor = {
      execute: (q: SQL) => {
        const r = render(q)
        seen.push(r.sql)
        params.push(r.params)
        const rows = results[i] ?? []
        i += 1
        return Promise.resolve({ rows })
      },
    }
    return { tx, seen, params }
  }

  const statements = (key: string, gapMs: number, perDay?: number) => [
    render(hostSlotStatements.ensureRow(key)).sql,
    render(hostSlotStatements.lock(key)).sql,
    render(hostSlotStatements.read(key, gapMs)).sql,
    ...(perDay === undefined ? [] : [render(hostSlotStatements.daily(key, perDay)).sql]),
  ]

  it('refuses a NULL, empty or malformed key without SQL and without an exception (AC 8)', async () => {
    for (const key of [null, undefined, '', 'NOPE', 'remotive', 'a b.com']) {
      const { tx, seen } = scripted([])
      await expect(claimHostSlot(tx, key, policy)).resolves.toEqual({
        granted: false,
        reason: 'HOST_KEY_MISSING',
        opensAt: null,
      })
      expect(seen).toEqual([])
    }
  })

  it('grants an open host: ensure, lock, read, count, then stamp, in that order', async () => {
    const { tx, seen, params } = scripted([[], [{}], [open], [{ claims: 3, opens_at: null }], []])
    await expect(claimHostSlot(tx, 'remotive.com', policy)).resolves.toEqual({ granted: true })
    expect(seen).toEqual([
      ...statements('remotive.com', 30_000, 4),
      render(hostSlotStatements.stamp('remotive.com')).sql,
    ])
    expect(params).toEqual([
      ['remotive.com'],
      ['remotive.com'],
      [30_000, 30_000, 'remotive.com'],
      ['remotive.com', 4],
      ['remotive.com'],
    ])
  })

  it('refuses a paused host with the pause end, and stamps nothing', async () => {
    const { tx, seen } = scripted([[], [{}], [{ ...open, paused: true, paused_until: AT }]])
    await expect(claimHostSlot(tx, 'remotive.com', policy)).resolves.toEqual({
      granted: false,
      reason: 'HOST_PAUSED',
      opensAt: AT,
    })
    expect(seen).toEqual(statements('remotive.com', 30_000))
  })

  it('refuses a busy host with no opening time', async () => {
    const { tx, seen } = scripted([[], [{}], [{ ...open, busy: true }]])
    await expect(claimHostSlot(tx, 'remotive.com', policy)).resolves.toEqual({
      granted: false,
      reason: 'HOST_BUSY',
      opensAt: null,
    })
    expect(seen).toHaveLength(3)
  })

  it('a pause wins over a busy host', async () => {
    const { tx } = scripted([[], [{}], [{ ...open, paused: true, busy: true, paused_until: AT }]])
    expect(await claimHostSlot(tx, 'remotive.com', policy)).toMatchObject({ reason: 'HOST_PAUSED' })
  })

  it('refuses inside the per-minute gap with the gap end', async () => {
    const { tx, seen } = scripted([[], [{}], [{ ...open, in_gap: true, gap_ends_at: AT }]])
    await expect(claimHostSlot(tx, 'remotive.com', policy)).resolves.toEqual({
      granted: false,
      reason: 'HOST_RATE_GAP',
      opensAt: AT,
    })
    expect(seen).toHaveLength(3)
  })

  it('refuses at perDay claims in 24 h with the window end, and allows one below it', async () => {
    const capped = scripted([[], [{}], [open], [{ claims: 4, opens_at: AT }]])
    await expect(claimHostSlot(capped.tx, 'remotive.com', policy)).resolves.toEqual({
      granted: false,
      reason: 'HOST_DAILY_CAP',
      opensAt: AT,
    })
    expect(capped.seen).toHaveLength(4)
    const over = scripted([[], [{}], [open], [{ claims: 9, opens_at: 'not a date' }]])
    await expect(claimHostSlot(over.tx, 'remotive.com', policy)).resolves.toEqual({
      granted: false,
      reason: 'HOST_DAILY_CAP',
      opensAt: null,
    })
    // drizzle's driver returns timestamptz as text: it is read as the instant it names.
    const text = scripted([[], [{}], [open], [{ claims: 4, opens_at: '2026-10-25 00:00:00+00' }]])
    expect(await claimHostSlot(text.tx, 'remotive.com', policy)).toEqual({
      granted: false,
      reason: 'HOST_DAILY_CAP',
      opensAt: AT,
    })
    const below = scripted([[], [{}], [open], [{ claims: 3, opens_at: null }], []])
    expect(await claimHostSlot(below.tx, 'remotive.com', policy)).toEqual({ granted: true })
  })

  it('a missing count row is refused, never read as zero claims', async () => {
    const { tx } = scripted([[], [{}], [open], []])
    expect(await claimHostSlot(tx, 'remotive.com', policy)).toMatchObject({
      granted: false,
      reason: 'HOST_DAILY_CAP',
    })
  })

  it('a host without a rate is neither gap- nor count-checked, and its gap is zero', async () => {
    const { tx, seen, params } = scripted([[], [{}], [{ ...open, in_gap: true }], []])
    expect(await claimHostSlot(tx, 'api.lever.co', { rate: null, floorHours: 0 })).toEqual({
      granted: true,
    })
    expect(seen).toEqual([
      ...statements('api.lever.co', 0),
      render(hostSlotStatements.stamp('api.lever.co')).sql,
    ])
    expect(params[2]).toEqual([0, 0, 'api.lever.co'])
  })

  it('accepts the smallest usable rate: one claim a minute, one a day', async () => {
    const { tx, params } = scripted([[], [{}], [open], [{ claims: 0 }], []])
    expect(
      await claimHostSlot(tx, 'remotive.com', { rate: { perMinute: 1, perDay: 1 }, floorHours: 0 }),
    ).toEqual({ granted: true })
    expect(params[2]).toEqual([60_000, 60_000, 'remotive.com'])
  })

  it('the gap is 60 s divided by perMinute, rounded up', async () => {
    const { tx, params } = scripted([[], [{}], [{ ...open, in_gap: true }]])
    await claimHostSlot(tx, 'remotive.com', { rate: { perMinute: 7, perDay: 4 }, floorHours: 0 })
    expect(params[2]).toEqual([8572, 8572, 'remotive.com'])
  })

  it('fails closed: anything but a literal false read from the row refuses', async () => {
    for (const [field, reason] of [
      ['paused', 'HOST_PAUSED'],
      ['busy', 'HOST_BUSY'],
      ['in_gap', 'HOST_RATE_GAP'],
    ] as const) {
      for (const value of [null, undefined, 't', 0, 'false']) {
        const { tx } = scripted([[], [{}], [{ ...open, [field]: value }]])
        expect(
          await claimHostSlot(tx, 'remotive.com', policy),
          `${field}=${String(value)}`,
        ).toEqual({
          granted: false,
          reason,
          opensAt: null,
        })
      }
    }
    const { tx } = scripted([[], [{}], [open], [{ claims: '2' }], []])
    expect(await claimHostSlot(tx, 'remotive.com', policy)).toEqual({ granted: true })
    const fraction = scripted([[], [{}], [open], [{ claims: 1.5 }]])
    expect(await claimHostSlot(fraction.tx, 'remotive.com', policy)).toMatchObject({
      reason: 'HOST_DAILY_CAP',
    })
  })

  it('throws when the host row is gone under its own lock', async () => {
    const { tx } = scripted([[], [{}], []])
    await expect(claimHostSlot(tx, 'remotive.com', policy)).rejects.toThrow(
      'claimHostSlot: the host row vanished under its lock',
    )
  })

  it('throws on an unusable rate instead of claiming without one', async () => {
    for (const rate of [
      { perMinute: 0, perDay: 4 },
      { perMinute: 2, perDay: 0 },
      { perMinute: 1.5, perDay: 4 },
      { perMinute: 2, perDay: Number.NaN },
    ]) {
      const { tx, seen } = scripted([])
      await expect(claimHostSlot(tx, 'remotive.com', { rate, floorHours: 0 })).rejects.toThrow(
        'claimHostSlot: invalid rate',
      )
      expect(seen).toEqual([])
    }
  })

  it('names every refusal it can return', () => {
    expect(HOST_REFUSALS).toEqual([
      'HOST_KEY_MISSING',
      'HOST_PAUSED',
      'HOST_BUSY',
      'HOST_RATE_GAP',
      'HOST_DAILY_CAP',
      'HOST_REQUEST_BUDGET',
    ])
  })

  it('pins the statements', () => {
    expect(render(hostSlotStatements.ensureRow('a.b')).sql).toBe(
      'INSERT INTO job_source_hosts (host_key) VALUES ($1) ON CONFLICT (host_key) DO NOTHING',
    )
    expect(render(hostSlotStatements.lock('a.b')).sql).toBe(
      'SELECT 1 FROM job_source_hosts WHERE host_key = $1 FOR UPDATE',
    )
    expect(render(hostSlotStatements.read('a.b', 30_000)).sql)
      .toBe(`SELECT COALESCE(h.paused_until > clock_timestamp(), false) AS paused, h.paused_until,
  EXISTS (SELECT 1 FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
          WHERE s.host_key = h.host_key AND r.outcome = 'STARTED') AS busy,
  COALESCE(h.last_claimed_at + make_interval(secs => $1 / 1000.0) > clock_timestamp(), false) AS in_gap,
  h.last_claimed_at + make_interval(secs => $2 / 1000.0) AS gap_ends_at
FROM job_source_hosts h WHERE h.host_key = $3`)
    expect(render(hostSlotStatements.daily('a.b', 4)).sql)
      .toBe(`WITH w AS (SELECT r.started_at FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
           WHERE s.host_key = $1 AND r.started_at > clock_timestamp() - interval '24 hours')
SELECT (SELECT count(*) FROM w)::int AS claims,
  (SELECT started_at + interval '24 hours' FROM w ORDER BY started_at
    OFFSET GREATEST((SELECT count(*) FROM w) - $2, 0) LIMIT 1) AS opens_at`)
    const budget = render(hostSlotStatements.budget('a.b', 7))
    expect(budget.params).toEqual(['a.b', 7, 7])
    expect(budget.sql).toBe(`WITH r AS (SELECT x.outcome, x.request_count, x.started_at
           FROM job_collection_runs x JOIN job_sources s ON s.id = x.source_id
           WHERE s.host_key = $1
             AND (x.outcome = 'STARTED' OR x.started_at > clock_timestamp() - interval '1 hour'))
SELECT COALESCE(sum(request_count) FILTER (WHERE outcome <> 'STARTED' AND started_at > clock_timestamp() - interval '1 minute'), 0)::int
    + count(*) FILTER (WHERE outcome = 'STARTED')::int * $2 AS minute_used,
  COALESCE(sum(request_count) FILTER (WHERE outcome <> 'STARTED'), 0)::int
    + count(*) FILTER (WHERE outcome = 'STARTED')::int * $3 AS hour_used,
  min(started_at) FILTER (WHERE outcome <> 'STARTED' AND started_at > clock_timestamp() - interval '1 minute') + interval '1 minute' AS minute_opens_at,
  min(started_at) FILTER (WHERE outcome <> 'STARTED') + interval '1 hour' AS hour_opens_at
FROM r`)
    expect(render(hostSlotStatements.stamp('a.b')).sql).toBe(
      'UPDATE job_source_hosts SET last_claimed_at = clock_timestamp() WHERE host_key = $1',
    )
  })

  describe('the request budget (U11)', () => {
    const AT2 = new Date('2026-10-25T00:01:00.000Z')
    const budgetPolicy = {
      rate: null,
      floorHours: 0,
      requestBudget: { perMinute: 2, perHour: 120 },
    }
    const budgetStatements = (key: string) => [
      render(hostSlotStatements.ensureRow(key)).sql,
      render(hostSlotStatements.lock(key)).sql,
      render(hostSlotStatements.read(key, 0)).sql,
      render(hostSlotStatements.budget(key, 1)).sql,
    ]

    it('grants a budget host under budget: ensure, lock, read, budget, then stamp', async () => {
      const used = { minute_used: 1, hour_used: 1, minute_opens_at: null, hour_opens_at: null }
      const { tx, seen, params } = scripted([[], [{}], [open], [used], []])
      await expect(claimHostSlot(tx, 'boards.io', budgetPolicy)).resolves.toEqual({ granted: true })
      expect(seen).toEqual([
        ...budgetStatements('boards.io'),
        render(hostSlotStatements.stamp('boards.io')).sql,
      ])
      // The budget statement carries the host key and perRun (defaulting to 1) twice.
      expect(params[3]).toEqual(['boards.io', 1, 1])
    })

    it('refuses when this claim`s own request would exceed the minute budget, with the minute opening', async () => {
      const used = { minute_used: 2, hour_used: 2, minute_opens_at: AT2, hour_opens_at: AT2 }
      const { tx, seen } = scripted([[], [{}], [open], [used]])
      await expect(claimHostSlot(tx, 'boards.io', budgetPolicy)).resolves.toEqual({
        granted: false,
        reason: 'HOST_REQUEST_BUDGET',
        opensAt: AT2,
      })
      expect(seen).toHaveLength(4)
    })

    it('refuses on the hour budget when the minute is fine, with the hour opening', async () => {
      const used = { minute_used: 0, hour_used: 120, minute_opens_at: null, hour_opens_at: AT2 }
      const { tx } = scripted([[], [{}], [open], [used]])
      await expect(claimHostSlot(tx, 'boards.io', budgetPolicy)).resolves.toEqual({
        granted: false,
        reason: 'HOST_REQUEST_BUDGET',
        opensAt: AT2,
      })
    })

    it('a budget host is not refused HOST_BUSY: a STARTED run is counted by the budget, not blocked', async () => {
      const used = { minute_used: 1, hour_used: 1, minute_opens_at: null, hour_opens_at: null }
      const { tx } = scripted([[], [{}], [{ ...open, busy: true }], [used], []])
      expect(await claimHostSlot(tx, 'boards.io', budgetPolicy)).toEqual({ granted: true })
    })

    it('the claim`s own perRun is added, so a run sending 5 is refused against a budget of 4', async () => {
      const used = { minute_used: 0, hour_used: 0, minute_opens_at: null, hour_opens_at: null }
      const { tx, params } = scripted([[], [{}], [open], [used]])
      const policy = {
        rate: null,
        floorHours: 0,
        requestBudget: { perMinute: 4, perHour: 400 },
        requestsPerRun: 5,
      }
      expect(await claimHostSlot(tx, 'boards.io', policy)).toMatchObject({
        granted: false,
        reason: 'HOST_REQUEST_BUDGET',
      })
      expect(params[3]).toEqual(['boards.io', 5, 5])
    })

    it('fails closed: an unreadable count refuses, never claims', async () => {
      const { tx } = scripted([[], [{}], [open], [{ minute_used: 'x', hour_used: 1 }]])
      expect(await claimHostSlot(tx, 'boards.io', budgetPolicy)).toMatchObject({
        granted: false,
        reason: 'HOST_REQUEST_BUDGET',
      })
    })

    it('a paused budget host is still refused HOST_PAUSED before the budget is read', async () => {
      const { tx, seen } = scripted([[], [{}], [{ ...open, paused: true, paused_until: AT2 }]])
      expect(await claimHostSlot(tx, 'boards.io', budgetPolicy)).toMatchObject({
        reason: 'HOST_PAUSED',
      })
      expect(seen).toHaveLength(3)
    })

    it('throws on an unusable budget instead of claiming without one', async () => {
      for (const requestBudget of [
        { perMinute: 0, perHour: 120 },
        { perMinute: 2, perHour: 0 },
        { perMinute: 1.5, perHour: 120 },
        { perMinute: 10, perHour: 5 },
      ]) {
        const { tx, seen } = scripted([])
        await expect(
          claimHostSlot(tx, 'boards.io', { rate: null, floorHours: 0, requestBudget }),
        ).rejects.toThrow('claimHostSlot: invalid budget')
        expect(seen).toEqual([])
      }
    })
  })
})

describe('hostOpenPredicate and readHostPaused', () => {
  it('tests the NULL key FIRST, then a non-expired pause on the database clock', () => {
    expect(render(hostOpenPredicate()).sql).toBe(
      '("job_sources"."host_key" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM job_source_hosts h WHERE h.host_key = "job_sources"."host_key" AND h.paused_until > clock_timestamp()))',
    )
  })

  it('reads the pause per id, treating anything but a literal false as paused', async () => {
    let seen: SQL | undefined
    const db: SqlExecutor = {
      execute: (q: SQL) => {
        seen = q
        return Promise.resolve({
          rows: [
            { id: 'a', paused: false },
            { id: 'b', paused: true },
            { id: 'c', paused: null },
          ],
        })
      },
    }
    const out = await readHostPaused(db, ['a', 'b', 'c'])
    expect([...out]).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ])
    const q = render(seen!)
    expect(q.params).toEqual(['a', 'b', 'c'])
    expect(q.sql).toBe(
      'SELECT "job_sources"."id" AS id, NOT ("job_sources"."host_key" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM job_source_hosts h WHERE h.host_key = "job_sources"."host_key" AND h.paused_until > clock_timestamp())) AS paused FROM "job_sources" WHERE "job_sources"."id" IN ($1, $2, $3)',
    )
  })

  it('asks nothing for no ids', async () => {
    const db: SqlExecutor = {
      execute: () => Promise.reject(new Error('must not query')),
    }
    expect([...(await readHostPaused(db, []))]).toEqual([])
  })
})

describe('SR-L-20: no application clock in the ban or claim path', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * By behaviour, not by reading the source (a source-text check reads Stryker's instrumented copy
   * under the mutation gate): the same inputs give the same statement and verdict whatever the
   * process clock says, and `Date.now` is never asked.
   */
  it('the statement and the parse are identical under two process clocks, and Date.now is never read', async () => {
    const run = async () => {
      const header = 'Wed, 21 Oct 2026 07:28:00 GMT'
      const tx = {
        execute: () =>
          Promise.resolve({ rows: [{ paused: true, paused_until: '2026-10-25 00:00:00+00' }] }),
      }
      return {
        ban: render(hostBanStatement(ban({ retryAfter: header }))),
        parse: parseRetryAfter(header),
        slot: await claimHostSlot(tx, 'remotive.com', { rate: null, floorHours: 0 }),
      }
    }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'))
    const nowSpy = vi.spyOn(Date, 'now')
    const early = await run()
    vi.setSystemTime(new Date('2040-06-15T12:00:00Z'))
    const late = await run()
    expect(late).toEqual(early)
    expect(nowSpy).not.toHaveBeenCalled()
    expect(early.ban.params).toContain('2026-10-21T07:28:00.000Z')
  })
})
