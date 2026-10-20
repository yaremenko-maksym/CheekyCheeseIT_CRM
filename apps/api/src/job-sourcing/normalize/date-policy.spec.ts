import { describe, expect, it } from 'vitest'
import { type DateContract, parseSourceDate } from './date-policy'

const NOW = new Date('2026-10-20T12:00:00Z')

const parse = (
  raw: string | number | null | undefined,
  contract: DateContract,
  semantics: 'PUBLISHED' | 'UPDATED' | 'RELEASED' | 'EXPIRY' = 'PUBLISHED',
) => parseSourceDate({ raw, contract, semantics }, NOW)

describe('parseSourceDate: absent input', () => {
  it('returns null for absent values so "no date" is not recorded as a bad date', () => {
    expect(parse(null, 'ISO_ZONED')).toBeNull()
    expect(parse(undefined, 'ISO_ZONED')).toBeNull()
    expect(parse('   ', 'ISO_ZONED')).toBeNull()
  })
})

describe('parseSourceDate: ISO with zone', () => {
  it('reads Z and numeric offsets to the same instant', () => {
    const a = parse('2026-10-14T10:00:00Z', 'ISO_ZONED')
    const b = parse('2026-10-14T12:00:00+02:00', 'ISO_ZONED')
    const c = parse('2026-10-14T05:00:00-0500', 'ISO_ZONED')
    expect(a?.value?.toISOString()).toBe('2026-10-14T10:00:00.000Z')
    expect(b?.value?.toISOString()).toBe('2026-10-14T10:00:00.000Z')
    expect(c?.value?.toISOString()).toBe('2026-10-14T10:00:00.000Z')
    expect(a?.status).toBe('OK')
  })

  it('keeps fractional seconds', () => {
    expect(parse('2026-10-14T10:00:00.250Z', 'ISO_ZONED')?.value?.toISOString()).toBe(
      '2026-10-14T10:00:00.250Z',
    )
  })

  it('DST: an explicit offset fixes the instant on both sides of a fall-back transition', () => {
    // Europe/Kyiv falls back 2025-10-26 04:00 EEST -> 03:00 EET: local 03:30 happens twice.
    const first = parse('2025-10-26T03:30:00+03:00', 'ISO_ZONED')
    const second = parse('2025-10-26T03:30:00+02:00', 'ISO_ZONED')
    expect(first?.value?.toISOString()).toBe('2025-10-26T00:30:00.000Z')
    expect(second?.value?.toISOString()).toBe('2025-10-26T01:30:00.000Z')
  })

  it('a date-time without a zone is MISSING_ZONE with no value (we do not guess a local zone)', () => {
    const r = parse('2026-10-14T10:00:00', 'ISO_ZONED')
    expect(r).toMatchObject({ status: 'MISSING_ZONE', value: null, raw: '2026-10-14T10:00:00' })
  })

  it('a plain date is accepted as UTC midnight', () => {
    expect(parse('2026-10-14', 'ISO_ZONED')).toMatchObject({ status: 'OK' })
    expect(parse('2026-10-14', 'ISO_ZONED')?.value?.toISOString()).toBe('2026-10-14T00:00:00.000Z')
  })

  it('rejects impossible calendar values instead of rolling them over', () => {
    for (const bad of [
      '2026-02-30T10:00:00Z',
      '2026-13-01T10:00:00Z',
      '2026-10-14T25:00:00Z',
      '2026-10-14T10:61:00Z',
      '2025-02-29', // 2025 is not a leap year
      'garbage',
    ]) {
      expect(parse(bad, 'ISO_ZONED'), bad).toMatchObject({ status: 'INVALID', value: null })
    }
    expect(parse('2024-02-29', 'ISO_ZONED')?.status).toBe('OK')
  })
})

describe('parseSourceDate: RFC 2822', () => {
  it('reads GMT, UT, Z and numeric zones', () => {
    for (const [raw, iso] of [
      ['Tue, 14 Oct 2025 10:00:00 GMT', '2025-10-14T10:00:00.000Z'],
      ['14 Oct 2025 10:00:00 UT', '2025-10-14T10:00:00.000Z'],
      ['Tue, 14 Oct 2025 12:00:00 +0200', '2025-10-14T10:00:00.000Z'],
      ['Tue, 14 Oct 2025 05:00 -0500', '2025-10-14T10:00:00.000Z'],
    ] as const) {
      expect(parse(raw, 'RFC_2822')?.value?.toISOString(), raw).toBe(iso)
    }
  })

  it('rejects a missing zone, a legacy named zone, and impossible days', () => {
    expect(parse('Tue, 14 Oct 2025 10:00:00', 'RFC_2822')).toMatchObject({
      status: 'MISSING_ZONE',
      value: null,
    })
    expect(parse('Tue, 14 Oct 2025 10:00:00 EST', 'RFC_2822')).toMatchObject({ status: 'INVALID' })
    expect(parse('Tue, 31 Nov 2025 10:00:00 GMT', 'RFC_2822')).toMatchObject({ status: 'INVALID' })
  })
})

describe('parseSourceDate: Reed dd/MM/yyyy', () => {
  it('reads day first: 03/04/2026 is 3 April, not 4 March', () => {
    expect(parse('03/04/2026', 'REED_DMY')?.value?.toISOString()).toBe('2026-04-03T00:00:00.000Z')
  })

  it('rejects month-first and malformed input rather than swapping', () => {
    expect(parse('04/13/2026', 'REED_DMY')).toMatchObject({ status: 'INVALID', value: null })
    expect(parse('3/4/2026', 'REED_DMY')).toMatchObject({ status: 'INVALID' })
    expect(parse('2026-04-03', 'REED_DMY')).toMatchObject({ status: 'INVALID' })
    expect(parse('31/04/2026', 'REED_DMY')).toMatchObject({ status: 'INVALID' })
  })
})

describe('parseSourceDate: Unix seconds vs milliseconds is decided by the FIELD, not the magnitude', () => {
  it('the same number is right under one contract and flagged under the other', () => {
    expect(parse(1_760_000_000, 'UNIX_SECONDS')?.value?.toISOString()).toBe(
      '2025-10-09T08:53:20.000Z',
    )
    expect(parse(1_760_000_000_000, 'UNIX_MILLISECONDS')?.value?.toISOString()).toBe(
      '2025-10-09T08:53:20.000Z',
    )
    // seconds fed to a ms field -> 1970; ms fed to a seconds field -> year ~57000
    expect(parse(1_760_000_000, 'UNIX_MILLISECONDS')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
    })
    expect(parse(1_760_000_000_000, 'UNIX_SECONDS')).toMatchObject({
      status: 'IMPLAUSIBLE',
      value: null,
    })
  })

  it('accepts digit strings, rejects fractions, signs and prose', () => {
    expect(parse('1760000000', 'UNIX_SECONDS')?.status).toBe('OK')
    for (const bad of ['1760000000.5', '-1760000000', '1.76e9', 'yesterday']) {
      expect(parse(bad, 'UNIX_SECONDS'), bad).toMatchObject({ status: 'INVALID', value: null })
    }
    expect(parse(Number.NaN, 'UNIX_SECONDS')).toMatchObject({ status: 'INVALID' })
  })
})

describe('parseSourceDate: future dates and semantics', () => {
  it('a future PUBLISHED date is FUTURE with no usable value, but the raw string survives', () => {
    const r = parse('2026-12-01T00:00:00Z', 'ISO_ZONED', 'PUBLISHED')
    expect(r).toMatchObject({ status: 'FUTURE', value: null, raw: '2026-12-01T00:00:00Z' })
  })

  it('tolerates a few hours of clock skew but not more than a day', () => {
    expect(parse('2026-10-20T20:00:00Z', 'ISO_ZONED')?.status).toBe('OK') // +8h
    expect(parse('2026-10-22T12:00:00Z', 'ISO_ZONED')?.status).toBe('FUTURE') // +48h
  })

  it('a future EXPIRY date is normal and stays OK; the same date as UPDATED is FUTURE', () => {
    expect(parse('2026-12-01T00:00:00Z', 'ISO_ZONED', 'EXPIRY')).toMatchObject({ status: 'OK' })
    expect(parse('2026-12-01T00:00:00Z', 'ISO_ZONED', 'UPDATED')).toMatchObject({
      status: 'FUTURE',
    })
  })

  it('records the semantics and contract it was read under', () => {
    expect(parse('2026-10-14', 'ISO_ZONED', 'RELEASED')).toMatchObject({
      semantics: 'RELEASED',
      contract: 'ISO_ZONED',
    })
  })

  it('bounds the retained raw string', () => {
    const r = parse(`2026-10-14${'x'.repeat(500)}`, 'ISO_ZONED')
    expect(r?.raw.length).toBeLessThanOrEqual(200)
    expect(r?.status).toBe('INVALID')
  })
})
