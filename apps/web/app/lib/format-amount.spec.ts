// task-i18n-stage3a (Task 2) — new file (format-amount.ts had no test
// before this wave). `formatAmount`/`formatAmountUsd` read the CURRENT
// locale off the global `i18n` singleton rather than taking a `locale`
// argument (see format-amount.ts's comment for why) — `loadCatalog`
// activates that same singleton, so no wrapper/render is needed to test it.
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import { formatAmount, formatAmountUsd } from './format-amount'

// uk-UA's grouping separator is U+00A0 (non-breaking space), not a plain
// space — comparing against real `Intl` output (not a hand-typed literal)
// avoids the encoding trap, same convention as format.spec.ts.
const ukBody = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(1500)
const ukUsdBody = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(3500)

describe('formatAmount', () => {
  it('formats with the active locale grouping/decimal separator', async () => {
    await loadCatalog('uk')
    // fix-round 1 (COPY-L-3): routes through `formatMoney`, which now joins
    // the amount and currency code with U+00A0, not a plain space.
    expect(formatAmount(1500, 'USDT')).toBe(`${ukBody} USDT`)
    await loadCatalog('en')
    expect(formatAmount(1500, 'USDT')).toBe('1,500.00 USDT')
  })

  it('accepts a string amount (Postgres NUMERIC round-trip)', async () => {
    await loadCatalog('en')
    expect(formatAmount('1500.000000', 'USDT')).toBe('1,500.00 USDT')
  })

  it('falls back to a raw string for non-finite input', async () => {
    await loadCatalog('en')
    expect(formatAmount(Number.NaN, 'USDT')).toBe('NaN USDT')
    expect(formatAmount('not-a-number', 'USDT')).toBe('not-a-number USDT')
  })
})

describe('formatAmountUsd', () => {
  it('prepends $ and formats per the active locale', async () => {
    await loadCatalog('en')
    expect(formatAmountUsd(3500, 'USDT')).toBe('$3,500.00 USDT')
    await loadCatalog('uk')
    expect(formatAmountUsd(3500, 'USDT')).toBe(`$${ukUsdBody} USDT`)
  })

  it('falls back to a raw string for non-finite input', async () => {
    await loadCatalog('en')
    expect(formatAmountUsd(Number.POSITIVE_INFINITY, 'USDT')).toBe('Infinity USDT')
  })
})
