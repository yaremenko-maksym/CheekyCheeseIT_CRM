import { describe, expect, it } from 'vitest'
import { NBU_SOURCES, ymdToDotted, type NbuSource } from './nbu-rate-sources'

/**
 * Unit tests for the NBU source registry and its response parsers.
 *
 * These parsers turn a third party's JSON into the number a payout is priced
 * with, so every branch here is a money branch: a row silently dropped, a
 * per-100 quote read as per-1, or a `"44.69"` string ignored would all produce
 * a wrong transfer amount rather than an error. They are therefore tested
 * directly, against payload shapes captured from the LIVE API on 2026-08-18,
 * plus the malformed shapes a feed can legitimately hand us.
 */

function sourceById(id: string): NbuSource {
  const found = NBU_SOURCES.find((s) => s.id === id)
  if (found === undefined) throw new Error(`no such source: ${id}`)
  return found
}

const statdirectory = sourceById('statdirectory')
const exchangeSite = sourceById('exchange_site')
const openData = sourceById('open_data')

describe('NBU source registry', () => {
  it('lists exactly the three genuinely distinct services, in a fixed order', () => {
    // Order is the resolution order for money — it must not drift silently.
    expect(NBU_SOURCES.map((s) => s.id)).toEqual(['statdirectory', 'exchange_site', 'open_data'])
  })

  it('never addresses exchangenew — verified byte-identical to exchange, so not a real second path', () => {
    for (const s of NBU_SOURCES) {
      expect(s.buildUrl('20260707')).not.toContain('exchangenew')
    }
  })

  it('every source targets bank.gov.ua over https — the honest limit of this redundancy', () => {
    for (const s of NBU_SOURCES) {
      expect(s.buildUrl('20260707')).toMatch(/^https:\/\/bank\.gov\.ua\//)
    }
  })

  it('builds the exact URLs the live services answer on', () => {
    expect(statdirectory.buildUrl('20260707')).toBe(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=20260707&json',
    )
    expect(exchangeSite.buildUrl('20260707')).toBe(
      'https://bank.gov.ua/NBU_Exchange/exchange_site?date=20260707&json',
    )
    // The open-data service rejects YYYYMMDD with `[{ Wrong date format }]`.
    expect(openData.buildUrl('20260707')).toBe(
      'https://bank.gov.ua/NBU_Exchange/exchange?date=07.07.2026&json',
    )
  })

  it('ymdToDotted reorders the parts, it does not merely reformat separators', () => {
    expect(ymdToDotted('20260707')).toBe('07.07.2026')
    // A day/month swap would be invisible on 07.07 — use an asymmetric date.
    expect(ymdToDotted('20260103')).toBe('03.01.2026')
    expect(ymdToDotted('20251231')).toBe('31.12.2025')
  })
})

describe('parser: cc/rate dialect (statdirectory + exchange_site)', () => {
  it('parses a real statdirectory row', () => {
    // Captured live 2026-08-18.
    const rows = statdirectory.parse([
      { r030: 840, txt: 'Долар США', rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026' },
    ])
    expect(rows).toEqual([{ cc: 'USD', rate: 44.6938, exchangedate: '18.08.2026' }])
  })

  it('parses a real exchange_site row and keeps calcdate — the true publication date', () => {
    // Captured live 2026-08-18: the Sunday row carries FRIDAY's calcdate.
    const rows = exchangeSite.parse([
      {
        exchangedate: '16.08.2026',
        r030: 840,
        cc: 'USD',
        txt: 'Долар США',
        enname: 'US Dollar',
        rate: 44.6988,
        units: 1,
        rate_per_unit: 44.6988,
        group: '1',
        calcdate: '13.08.2026',
        special: 'N',
      },
    ])
    expect(rows).toEqual([
      { cc: 'USD', rate: 44.6988, exchangedate: '16.08.2026', calcdate: '13.08.2026' },
    ])
  })

  it('omits calcdate entirely when the source does not publish one', () => {
    // `exactOptionalPropertyTypes` distinguishes absent from present-undefined.
    const rows = statdirectory.parse([{ rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026' }])
    expect(rows).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(rows?.[0] ?? {}, 'calcdate')).toBe(false)
  })

  it('treats an empty-string calcdate as absent, not as a date', () => {
    const rows = statdirectory.parse([
      { rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026', calcdate: '' },
    ])
    expect(Object.prototype.hasOwnProperty.call(rows?.[0] ?? {}, 'calcdate')).toBe(false)
  })

  it('rejects a body that is not an array', () => {
    expect(statdirectory.parse({ error: 'nope' })).toBeNull()
    expect(statdirectory.parse(null)).toBeNull()
    expect(statdirectory.parse('Wrong date format')).toBeNull()
  })

  it('rejects an array holding anything that is not an object', () => {
    // A half-JSON body must be refused wholesale rather than partly believed.
    expect(statdirectory.parse(['Wrong date format'])).toBeNull()
    expect(statdirectory.parse([null])).toBeNull()
    expect(statdirectory.parse([42])).toBeNull()
  })

  it('returns an empty list (not null) for an empty array — a day with no record', () => {
    // The live feed answers `[]` for a day it has no data for; that is "no
    // data", not "broken response", and the caller distinguishes them.
    expect(statdirectory.parse([])).toEqual([])
  })

  it('accepts a rate delivered as a numeric string', () => {
    const rows = statdirectory.parse([{ rate: '44.6938', cc: 'USD', exchangedate: '18.08.2026' }])
    expect(rows?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })

  it('drops rows whose rate is not a usable number', () => {
    const rows = statdirectory.parse([
      { rate: Number.NaN, cc: 'USD', exchangedate: '18.08.2026' },
      { rate: Number.POSITIVE_INFINITY, cc: 'EUR', exchangedate: '18.08.2026' },
      { rate: 'not a number', cc: 'PLN', exchangedate: '18.08.2026' },
      { rate: true, cc: 'GBP', exchangedate: '18.08.2026' },
      { rate: { v: 1 }, cc: 'CHF', exchangedate: '18.08.2026' },
      // An array is the trap case: `parseFloat(['44.69'])` coerces to the
      // string "44.69" and yields a plausible-looking 44.69. Only a `typeof`
      // guard rejects it, and a rate we invented from a malformed row is
      // exactly the kind of number that must never reach a payout.
      { rate: ['44.69'], cc: 'SEK', exchangedate: '18.08.2026' },
    ])
    expect(rows).toEqual([])
  })

  it('drops a row that states units but carries no rate', () => {
    // Guarding on units alone would compute `null / 1` and book a rate of 0.
    const rows = exchangeSite.parse([{ cc: 'USD', exchangedate: '18.08.2026', units: 1 }])
    expect(rows).toEqual([])
  })

  it('drops rows with a missing, empty or non-string currency code', () => {
    const rows = statdirectory.parse([
      { rate: 44.69, exchangedate: '18.08.2026' },
      { rate: 44.69, cc: '', exchangedate: '18.08.2026' },
      { rate: 44.69, cc: 840, exchangedate: '18.08.2026' },
    ])
    expect(rows).toEqual([])
  })

  it('drops rows with no exchangedate — an undated rate cannot price a day', () => {
    const rows = statdirectory.parse([
      { rate: 44.69, cc: 'USD' },
      { rate: 44.69, cc: 'EUR', exchangedate: '' },
    ])
    expect(rows).toEqual([])
  })

  it('keeps the good rows and drops only the bad ones', () => {
    const rows = statdirectory.parse([
      { rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026' },
      { rate: Number.NaN, cc: 'EUR', exchangedate: '18.08.2026' },
    ])
    expect(rows).toEqual([{ cc: 'USD', rate: 44.6938, exchangedate: '18.08.2026' }])
  })

  it('converts a per-100 quote to a per-unit rate', () => {
    // NBU quotes some currencies per 100 units. Reading that as per-1 would
    // overstate the rate 100-fold.
    const rows = exchangeSite.parse([
      { rate: 4469.38, units: 100, cc: 'JPY', exchangedate: '18.08.2026' },
    ])
    expect(rows?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })

  it('prefers the explicit rate_per_unit over rate/units', () => {
    const rows = exchangeSite.parse([
      { rate: 999, units: 100, rate_per_unit: 44.6938, cc: 'USD', exchangedate: '18.08.2026' },
    ])
    expect(rows?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })

  it('does not divide by a zero or missing units count', () => {
    const zero = exchangeSite.parse([
      { rate: 44.6938, units: 0, cc: 'USD', exchangedate: '18.08.2026' },
    ])
    expect(zero?.[0]?.rate).toBeCloseTo(44.6938, 4)
    const missing = statdirectory.parse([{ rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026' }])
    expect(missing?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })
})

describe('parser: open-data dialect (NBU_Exchange/exchange)', () => {
  it('parses a real open-data row, whose field names all differ', () => {
    // Captured live 2026-08-18.
    const rows = openData.parse([
      {
        StartDate: '18.08.2026',
        TimeSign: '0000',
        CurrencyCode: '840',
        CurrencyCodeL: 'USD',
        Units: 1,
        Amount: 44.6938,
        special: 'N',
      },
    ])
    expect(rows).toEqual([{ cc: 'USD', rate: 44.6938, exchangedate: '18.08.2026' }])
  })

  it('does not read the cc/rate dialect — the two services are not interchangeable', () => {
    // Feeding a statdirectory row to this parser must yield nothing, rather
    // than a half-populated row with a bogus rate.
    expect(
      openData.parse([
        { r030: 840, txt: 'USD', rate: 44.6938, cc: 'USD', exchangedate: '18.08.2026' },
      ]),
    ).toEqual([])
  })

  it('converts a per-100 quote to a per-unit rate', () => {
    const rows = openData.parse([
      { StartDate: '18.08.2026', CurrencyCodeL: 'JPY', Units: 100, Amount: 4469.38 },
    ])
    expect(rows?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })

  it('does not divide by a zero or missing Units count', () => {
    const zero = openData.parse([
      { StartDate: '18.08.2026', CurrencyCodeL: 'USD', Units: 0, Amount: 44.6938 },
    ])
    expect(zero?.[0]?.rate).toBeCloseTo(44.6938, 4)
    const missing = openData.parse([
      { StartDate: '18.08.2026', CurrencyCodeL: 'USD', Amount: 44.6938 },
    ])
    expect(missing?.[0]?.rate).toBeCloseTo(44.6938, 4)
  })

  it('rejects a non-array body and non-object rows', () => {
    expect(openData.parse({ nope: true })).toBeNull()
    expect(openData.parse(['Wrong date format'])).toBeNull()
    expect(openData.parse([null])).toBeNull()
  })

  it('drops rows missing the code, the date or the amount', () => {
    const rows = openData.parse([
      { StartDate: '18.08.2026', Units: 1, Amount: 44.69 },
      { CurrencyCodeL: 'USD', Units: 1, Amount: 44.69 },
      { StartDate: '18.08.2026', CurrencyCodeL: 'USD', Units: 1 },
      { StartDate: '18.08.2026', CurrencyCodeL: '', Units: 1, Amount: 44.69 },
      { StartDate: '18.08.2026', CurrencyCodeL: 'USD', Units: 1, Amount: 'x' },
      // Units without an Amount must not become `null / 1` = a rate of 0.
      { StartDate: '18.08.2026', CurrencyCodeL: 'USD', Units: 1 },
    ])
    expect(rows).toEqual([])
  })

  it('never carries a calcdate — this service does not publish one', () => {
    const rows = openData.parse([
      {
        StartDate: '18.08.2026',
        CurrencyCodeL: 'USD',
        Units: 1,
        Amount: 44.6938,
        calcdate: '17.08.2026',
      },
    ])
    expect(Object.prototype.hasOwnProperty.call(rows?.[0] ?? {}, 'calcdate')).toBe(false)
  })
})
