/**
 * Adapter-specific date contracts.
 *
 * Every adapter declares, PER FIELD, which wire format it reads. There is deliberately no
 * magnitude heuristic here (the shipped `parseDateish` guesses seconds-vs-milliseconds from the
 * size of the number, and `new Date('03/04/2026')` guesses month-first): a guess is silently wrong
 * for exactly the inputs nobody tested. A value that does not fit its declared contract is reported
 * with a status, never coerced, and the raw string always survives.
 */

export type DateContract =
  'ISO_ZONED' | 'RFC_2822' | 'REED_DMY' | 'UNIX_SECONDS' | 'UNIX_MILLISECONDS'
export type DateSemantics = 'PUBLISHED' | 'UPDATED' | 'RELEASED' | 'EXPIRY'
/**
 * OK: usable. INVALID: does not fit the contract / impossible calendar value. MISSING_ZONE: a
 * date-time with no zone (we do not guess a local zone). FUTURE: after `now` + tolerance for a
 * non-EXPIRY field. IMPLAUSIBLE: parses, but outside 2000-2100 — the signature of seconds fed to a
 * milliseconds field or the reverse.
 */
export type DateStatus = 'OK' | 'INVALID' | 'MISSING_ZONE' | 'FUTURE' | 'IMPLAUSIBLE'

export interface ObservedDate {
  semantics: DateSemantics
  contract: DateContract
  /** As received (bounded). Always retained, whatever the status. */
  raw: string
  /** Null unless status is OK. */
  value: Date | null
  status: DateStatus
}

export interface DateInput {
  raw: string | number | null | undefined
  contract: DateContract
  semantics: DateSemantics
}

const MAX_RAW_CHARS = 200
/** Clock skew + "today" in a far-east zone; beyond this a published/updated date is suspect. */
export const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000
const MIN_YEAR = 2000
const MAX_YEAR = 2100

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

type Parsed = { status: 'OK'; value: Date } | { status: 'INVALID' | 'MISSING_ZONE' }

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Calendar-validated UTC instant for a wall-clock reading at a fixed offset (minutes east). */
type WallClock = readonly [
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millis: number,
]

function buildInstant(
  [year, month, day, hour, minute, second, millis]: WallClock,
  offsetMinutes: number,
): Parsed {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { status: 'INVALID' }
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000
  return { status: 'OK', value: new Date(ms) }
}

function zoneOffsetMinutes(zone: string): number | null {
  if (/^(?:Z|GMT|UTC|UT)$/i.test(zone)) return 0
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (!m) return null
  const [hh, mm] = [Number(m[2]), Number(m[3])]
  if (hh > 23 || mm > 59) return null
  return (m[1] === '-' ? -1 : 1) * (hh * 60 + mm)
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i

function parseIso(raw: string): Parsed {
  const m = ISO_RE.exec(raw)
  if (!m) return { status: 'INVALID' }
  const hasTime = m[4] !== undefined
  const zone = m[8]
  if (hasTime && zone === undefined) return { status: 'MISSING_ZONE' }
  // A zone can only be captured together with a time, so a date-only value has none: UTC midnight.
  const offset = zone === undefined ? 0 : zoneOffsetMinutes(zone)
  if (offset === null) return { status: 'INVALID' }
  const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
  return buildInstant(
    [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
      millis,
    ],
    offset,
  )
}

const RFC_RE =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s+(\S+))?$/

function parseRfc2822(raw: string): Parsed {
  const m = RFC_RE.exec(raw)
  if (!m) return { status: 'INVALID' }
  if (m[7] === undefined) return { status: 'MISSING_ZONE' }
  const month = MONTHS.indexOf(String(m[2]).toLowerCase()) + 1
  const offset = zoneOffsetMinutes(m[7])
  // Legacy named zones (EST, PST...) are obsolete in RFC 5322 and ambiguous: rejected, not guessed.
  if (month === 0 || offset === null) return { status: 'INVALID' }
  return buildInstant(
    [Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), 0],
    offset,
  )
}

function parseReedDmy(raw: string): Parsed {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
  if (!m) return { status: 'INVALID' }
  return buildInstant([Number(m[3]), Number(m[2]), Number(m[1]), 0, 0, 0, 0], 0)
}

function parseUnix(raw: string, millisPerUnit: number): Parsed {
  if (!/^\d{1,16}$/.test(raw)) return { status: 'INVALID' }
  const n = Number(raw)
  return { status: 'OK', value: new Date(n * millisPerUnit) }
}

function parseByContract(raw: string, contract: DateContract): Parsed {
  switch (contract) {
    case 'ISO_ZONED':
      return parseIso(raw)
    case 'RFC_2822':
      return parseRfc2822(raw)
    case 'REED_DMY':
      return parseReedDmy(raw)
    case 'UNIX_SECONDS':
      return parseUnix(raw, 1000)
    case 'UNIX_MILLISECONDS':
      return parseUnix(raw, 1)
  }
}

/** Null = the field was absent (not an error). */
export function parseSourceDate(input: DateInput, now: Date): ObservedDate | null {
  const { raw: rawInput, contract, semantics } = input
  if (rawInput === null || rawInput === undefined) return null
  const text = String(rawInput).trim()
  if (text.length === 0) return null
  const raw = text.slice(0, MAX_RAW_CHARS)
  const done = (status: DateStatus, value: Date | null = null): ObservedDate => ({
    semantics,
    contract,
    raw,
    value,
    status,
  })

  // `String(NaN)` / `String(1.5)` fail the unix digit pattern; an over-long string never fits.
  if (text.length > MAX_RAW_CHARS) return done('INVALID')
  const parsed = parseByContract(text, contract)
  if (parsed.status !== 'OK') return done(parsed.status)

  const year = parsed.value.getUTCFullYear()
  // Written as a negated range so an out-of-range instant (Invalid Date, year NaN: e.g. 14 digits
  // read as seconds) is IMPLAUSIBLE rather than slipping through both comparisons as OK.
  if (!(year >= MIN_YEAR && year <= MAX_YEAR)) return done('IMPLAUSIBLE')
  if (semantics !== 'EXPIRY' && parsed.value.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    return done('FUTURE')
  }
  return done('OK', parsed.value)
}
