import { describe, expect, it } from 'vitest'
import { type DateContract, parseSourceDate } from './date-policy'

/**
 * Wire-format shapes, field boundaries and the retained-raw bound of `parseSourceDate`.
 * Companion to date-policy.spec.ts (contracts, semantics, ISO boundaries).
 */

const NOW = new Date('2026-10-20T12:00:00Z')

const parse = (
  raw: string | number | null | undefined,
  contract: DateContract,
  semantics: 'PUBLISHED' | 'UPDATED' | 'RELEASED' | 'EXPIRY' = 'PUBLISHED',
) => parseSourceDate({ raw, contract, semantics }, NOW)

describe('parseSourceDate: RFC 2822 shapes', () => {
  const rfc = (raw: string) => parse(raw, 'RFC_2822')

  it('reads every month name, in any letter case', () => {
    const names = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    names.forEach((name, i) => {
      const mm = String(i + 1).padStart(2, '0')
      const expected = `2025-${mm}-14T10:00:00.000Z`
      expect(rfc(`14 ${name} 2025 10:00:00 GMT`)?.value?.toISOString(), name).toBe(expected)
      expect(rfc(`14 ${name.toUpperCase()} 2025 10:00:00 GMT`)?.value?.toISOString(), name).toBe(
        expected,
      )
      expect(rfc(`14 ${name.toLowerCase()} 2025 10:00:00 GMT`)?.value?.toISOString(), name).toBe(
        expected,
      )
    })
  })

  it('rejects an unknown month name', () => {
    expect(rfc('14 Foo 2025 10:00:00 GMT')).toMatchObject({ status: 'INVALID', value: null })
  })

  it('reads each field independently, including a one-digit day and optional seconds', () => {
    expect(rfc('4 Oct 2025 01:02:03 GMT')?.value?.toISOString()).toBe('2025-10-04T01:02:03.000Z')
    expect(rfc('4 Oct 2025 01:02 GMT')?.value?.toISOString()).toBe('2025-10-04T01:02:00.000Z')
  })

  it('tolerates the weekday prefix being absent, or followed by any run of whitespace', () => {
    expect(rfc('Tue,14 Oct 2025 10:00:00 GMT')?.status).toBe('OK')
    expect(rfc('Tue, 14 Oct 2025 10:00:00 GMT')?.status).toBe('OK')
    expect(rfc('Tue,   14 Oct 2025 10:00:00 GMT')?.status).toBe('OK')
    expect(rfc('14 Oct 2025 10:00:00 GMT')?.status).toBe('OK')
  })

  it('accepts runs of whitespace between the parts, but not none at all', () => {
    expect(rfc('14   Oct   2025   10:00:00   GMT')?.value?.toISOString()).toBe(
      '2025-10-14T10:00:00.000Z',
    )
    expect(rfc('14\tOct\t2025\t10:00:00\tGMT')?.status).toBe('OK')
    for (const bad of [
      '14Oct 2025 10:00:00 GMT',
      '14 Oct2025 10:00:00 GMT',
      '14 Oct 202510:00:00 GMT',
      '14 Oct 2025 10:00:00GMT',
    ]) {
      expect(rfc(bad), bad).toMatchObject({ status: 'INVALID', value: null })
    }
  })

  it('rejects wrong digit counts, junk around the value and a long weekday', () => {
    for (const bad of [
      '014 Oct 2025 10:00:00 GMT',
      '14 Oct 25 10:00:00 GMT',
      '14 Oct 2025 1:00:00 GMT',
      '14 Oct 2025 10:0:00 GMT',
      '14 Oct 2025 10:00:0 GMT',
      'Tuesday, 14 Oct 2025 10:00:00 GMT',
      'x14 Oct 2025 10:00:00 GMT',
      '14 Oct 2025 10:00:00 GMT (UTC)',
      'garbage',
    ]) {
      expect(rfc(bad), bad).toMatchObject({ status: 'INVALID', value: null })
    }
  })

  it('rejects impossible clock values and accepts the last valid one', () => {
    for (const bad of [
      '14 Oct 2025 24:00:00 GMT',
      '14 Oct 2025 10:60:00 GMT',
      '14 Oct 2025 10:00:60 GMT',
    ]) {
      expect(rfc(bad), bad).toMatchObject({ status: 'INVALID' })
    }
    expect(rfc('14 Oct 2025 23:59:59 GMT')?.value?.toISOString()).toBe('2025-10-14T23:59:59.000Z')
  })

  it('trims surrounding whitespace and reports the trimmed raw string', () => {
    expect(rfc('  14 Oct 2025 10:00:00 GMT  ')).toMatchObject({
      status: 'OK',
      raw: '14 Oct 2025 10:00:00 GMT',
    })
  })

  it('zone names are matched whole and case-insensitively; offsets keep sign and minutes', () => {
    const at = (z: string) => rfc(`14 Oct 2025 10:00:00 ${z}`)
    for (const z of ['Z', 'z', 'GMT', 'gmt', 'UTC', 'utc', 'UT', 'ut']) {
      expect(at(z)?.value?.toISOString(), z).toBe('2025-10-14T10:00:00.000Z')
    }
    for (const z of ['GMTX', 'XGMT', 'UTCC', 'ZZ', 'U']) {
      expect(at(z), z).toMatchObject({ status: 'INVALID', value: null })
    }
    expect(at('+0530')?.value?.toISOString()).toBe('2025-10-14T04:30:00.000Z')
    expect(at('+05:30')?.value?.toISOString()).toBe('2025-10-14T04:30:00.000Z')
    expect(at('-0030')?.value?.toISOString()).toBe('2025-10-14T10:30:00.000Z')
    expect(at('+2359')?.value?.toISOString()).toBe('2025-10-13T10:01:00.000Z')
    for (const z of ['+2400', '+0060', '+2:00', '+02000', 'x+0200', '+0200x']) {
      expect(at(z), z).toMatchObject({ status: 'INVALID', value: null })
    }
  })
})

describe('parseSourceDate: Reed dd/MM/yyyy shapes', () => {
  const reed = (raw: string) => parse(raw, 'REED_DMY')

  it('reads the first and last valid day and month', () => {
    expect(reed('01/01/2026')?.value?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(reed('31/12/2025')?.value?.toISOString()).toBe('2025-12-31T00:00:00.000Z')
  })

  it('rejects day 00, month 00, day 32 and month 13', () => {
    for (const bad of ['00/01/2026', '01/00/2026', '32/01/2026', '01/13/2026']) {
      expect(reed(bad), bad).toMatchObject({ status: 'INVALID', value: null })
    }
  })

  it('rejects other separators, short years and anything around the date', () => {
    for (const bad of [
      '03-04-2026',
      '03/04/26',
      '103/04/2026',
      '03/04/20266',
      'x03/04/2026',
      '03/04/2026x',
    ]) {
      expect(reed(bad), bad).toMatchObject({ status: 'INVALID', value: null })
    }
  })
})

describe('parseSourceDate: Unix digit strings', () => {
  it('accepts 1 to 16 digits and rejects 17', () => {
    expect(parse('5', 'UNIX_MILLISECONDS')?.status).toBe('IMPLAUSIBLE') // shape accepted, year 1970
    expect(parse('1760000000000000', 'UNIX_MILLISECONDS')?.status).toBe('IMPLAUSIBLE')
    expect(parse('17600000000000000', 'UNIX_MILLISECONDS')?.status).toBe('INVALID')
  })

  it('rejects text before or after the digits', () => {
    for (const bad of ['x1760000000', '1760000000x', '17600 00000']) {
      expect(parse(bad, 'UNIX_SECONDS'), bad).toMatchObject({ status: 'INVALID', value: null })
    }
  })

  it('a number too large to be a date at all is IMPLAUSIBLE, never an OK carrying an Invalid Date', () => {
    // 14 digits of seconds = 9.99e16 ms, beyond the +/-8.64e15 ms range of a JS Date
    expect(parse('99999999999999', 'UNIX_SECONDS')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
      raw: '99999999999999',
    })
    expect(parse('9999999999999999', 'UNIX_MILLISECONDS')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
    })
  })
})

describe('parseSourceDate: plausible-year window and future tolerance boundaries', () => {
  it('2000-01-01T00:00:00Z is the first plausible instant and 1999-12-31T23:59:59Z is not', () => {
    expect(parse('2000-01-01T00:00:00Z', 'ISO_ZONED')?.status).toBe('OK')
    expect(parse('1999-12-31T23:59:59Z', 'ISO_ZONED')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
    })
  })

  it('2100-12-31T23:59:59Z is the last plausible instant and 2101-01-01T00:00:00Z is not', () => {
    expect(parse('2100-12-31T23:59:59Z', 'ISO_ZONED', 'EXPIRY')?.status).toBe('OK')
    expect(parse('2101-01-01T00:00:00Z', 'ISO_ZONED', 'EXPIRY')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
    })
  })

  it('exactly now + 24h is still OK; one millisecond more is FUTURE', () => {
    expect(parse('2026-10-21T12:00:00.000Z', 'ISO_ZONED')?.status).toBe('OK')
    expect(parse('2026-10-21T12:00:00.001Z', 'ISO_ZONED')).toMatchObject({
      status: 'FUTURE',
      value: null,
    })
  })

  it('a date in the recent past is OK (the tolerance only widens the future side)', () => {
    expect(parse('2026-10-20T11:00:00Z', 'ISO_ZONED')?.status).toBe('OK')
    expect(parse('2026-10-19T12:00:00Z', 'ISO_ZONED')?.status).toBe('OK')
  })

  it('every non-EXPIRY semantics flags a far-future date; EXPIRY alone does not', () => {
    for (const s of ['PUBLISHED', 'UPDATED', 'RELEASED'] as const) {
      expect(parse('2026-12-01T00:00:00Z', 'ISO_ZONED', s)?.status, s).toBe('FUTURE')
    }
    expect(parse('2026-12-01T00:00:00Z', 'ISO_ZONED', 'EXPIRY')?.status).toBe('OK')
  })
})

describe('parseSourceDate: bounded raw string', () => {
  const padded = (n: number) => `Tue,${' '.repeat(n)}14 Oct 2025 10:00:00 GMT`

  it('a value of exactly 200 characters is still parsed and kept whole', () => {
    const text = padded(172)
    expect(text.length).toBe(200)
    const r = parse(text, 'RFC_2822')
    expect(r?.status).toBe('OK')
    expect(r?.raw).toBe(text)
  })

  it('a 201-character value is INVALID and its raw is cut to exactly the first 200 characters', () => {
    const text = padded(173)
    expect(text.length).toBe(201)
    const r = parse(text, 'RFC_2822')
    expect(r).toMatchObject({ status: 'INVALID', value: null })
    expect(r?.raw).toBe(text.slice(0, 200))
  })

  it('trims before measuring, and reports the trimmed raw', () => {
    expect(parse('  2026-10-14  ', 'ISO_ZONED')).toMatchObject({ status: 'OK', raw: '2026-10-14' })
  })

  it('a numeric input is read through its decimal string', () => {
    expect(parse(1_760_000_000, 'UNIX_SECONDS')).toMatchObject({ status: 'OK', raw: '1760000000' })
  })
})
