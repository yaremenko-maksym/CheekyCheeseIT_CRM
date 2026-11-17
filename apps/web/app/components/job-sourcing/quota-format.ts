/** Quota figures for the active locale — counts with grouping, money as USD (task 7.5). */

const MICROS = 1_000_000

export function formatCount(locale: string, n: number): string {
  return new Intl.NumberFormat(locale).format(n)
}

/** `USD_MICROS` meters count millionths of a dollar; nobody reads 1500000. */
export function formatUsdMicros(locale: string, micros: number): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
    micros / MICROS,
  )
}
