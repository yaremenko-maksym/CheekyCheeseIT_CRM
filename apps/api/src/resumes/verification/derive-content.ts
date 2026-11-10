/**
 * Deterministic resume fields and the legacy `ResumeContent` → `ResumeFacts`
 * mapping (verified-base-resume spec §3).
 *
 * Everything here is pure: no Nest, no I/O and no clock — `now` is a parameter —
 * so the same facts always derive the same content.
 */
import {
  RESUME_LANGUAGE_LEVELS,
  canonicalSkill,
  mergeSkills,
  type ResumeContent,
  type ResumeFacts,
} from '@crm/shared'

type LanguageLevel = ResumeFacts['languages'][number]['level']

export interface FreePeriod {
  start: string | null
  end: string | null
  current: boolean
}

const MONTH_LABELS = [
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
] as const

/** Mirrors `resumeYear` in `resumeFactsSchema` (1950..2100). */
const RESUME_YEAR_MIN = 1950
const RESUME_YEAR_MAX = 2100

/**
 * Scanned left to right as ONE alternation, so a token cannot be matched twice
 * and a month-bearing form always wins over the bare year inside it.
 */
const PERIOD_TOKEN = new RegExp(
  [
    // 2021-03
    String.raw`(?<iso>\b\d{4}-(?:0[1-9]|1[0-2])\b)`,
    // 03/2021
    String.raw`|(?<slash>\b(?:0[1-9]|1[0-2])\/\d{4}\b)`,
    // Mar 2021 / March 2021 / Sept. 2021
    String.raw`|(?<named>\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,]+(?:\d{4})\b)`,
    // a year with no month
    String.raw`|(?<year>\b\d{4}\b)`,
  ].join(''),
  'gi',
)

/**
 * Present/Current/Now plus the Cyrillic spellings the existing resumes use.
 * `\b` keeps `Present` out of `Presented` and `now` out of `know`.
 */
const CURRENT_PERIOD = /\b(?:present|current|now)\b|наст|тепер|по\s*н\.?\s*в\.?/iu

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/

function pad2(value: string): string {
  return value.padStart(2, '0')
}

function monthFromGroups(groups: Record<string, string | undefined>): string | null {
  const iso = groups['iso']
  if (iso) return iso

  // `slash` is `MM/YYYY`, so slicing is the whole conversion.
  const slash = groups['slash']
  if (slash) return `${slash.slice(3)}-${slash.slice(0, 2)}`

  // `named` is `Mar 2021` / `March 2021` / `Sept. 2021`.
  const named = groups['named']
  if (named) {
    const index = MONTH_LABELS.findIndex((label) =>
      named.toLowerCase().startsWith(label.toLowerCase()),
    )
    return `${named.slice(-4)}-${pad2(String(index + 1))}`
  }

  return null
}

function periodTokens(text: string): Array<string | null> {
  return [...text.matchAll(PERIOD_TOKEN)].map((match) => monthFromGroups(match.groups ?? {}))
}

/**
 * Parses the free-text `period` of a legacy resume. Unrecognised text yields
 * `{ start: null, end: null, current: false }` and never throws; HR fixes it in
 * the facts form (spec §3).
 */
export function parseFreePeriod(text: string): FreePeriod {
  const tokens = periodTokens(text)
  return {
    start: tokens[0] ?? null,
    end: tokens[1] ?? null,
    current: CURRENT_PERIOD.test(text),
  }
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split('-')
  const label = MONTH_LABELS[Number(monthNumber) - 1]
  return year && label ? `${label} ${year}` : ''
}

/** `"Mar 2021 – May 2023"` / `"Mar 2021 – Present"` (en dash, English months). */
export function formatPeriod(start: string, end: string | null, current: boolean): string {
  const startLabel = formatMonth(start)
  if (!startLabel) return ''
  if (current) return `${startLabel} – Present`
  const endLabel = end ? formatMonth(end) : ''
  return endLabel ? `${startLabel} – ${endLabel}` : startLabel
}

/** `"2015 – 2019"`; with only one year known, that year alone. */
export function formatYears(start: number | null, end: number | null): string {
  if (start !== null && end !== null) return `${start} – ${end}`
  const only = start ?? end
  return only === null ? '' : String(only)
}

function toMonthIndex(month: string | null): number | null {
  // `exec` coerces, so a null start simply fails to match.
  const match = MONTH_KEY.exec(String(month))
  if (!match) return null
  return Number(match[1]) * 12 + (Number(match[2]) - 1)
}

/**
 * Union of the experience intervals, floored to whole years. Overlapping jobs
 * count once, and a current job runs to `now`.
 */
export function yearsOfExperience(items: ResumeFacts['experience'], now: Date): number {
  const nowIndex = now.getFullYear() * 12 + now.getMonth()
  // Stryker disable next-line ArrayDeclaration: an extra empty element destructures to undefined/undefined, which every comparison below ignores
  const intervals: Array<[number, number]> = new Array<[number, number]>()

  for (const item of items) {
    const start = toMonthIndex(item.start)
    if (start === null) continue
    const end = item.current ? nowIndex : item.end ? toMonthIndex(item.end) : start
    intervals.push([start, Math.max(start, end ?? start)])
  }

  intervals.sort((a, b) => a[0] - b[0])

  let months = 0
  let mergedStart = 0
  let mergedEnd = -1
  for (const [start, end] of intervals) {
    if (start > mergedEnd) {
      months += Math.max(0, mergedEnd - mergedStart + 1)
      mergedStart = start
    }
    mergedEnd = Math.max(mergedEnd, end)
  }
  months += Math.max(0, mergedEnd - mergedStart + 1)

  return Math.floor(months / 12)
}

/**
 * The deterministic half of the rendered content: every field except the
 * AI-written `summary` and each item's `bullets`.
 */
export function deriveFrozenContent(facts: ResumeFacts): ResumeContent {
  return {
    summary: '',
    skills: mergeSkills(
      facts.skills,
      facts.experience.map((item) => item.technologies),
    ),
    experience: facts.experience.map((item) => ({
      company: item.company,
      role: item.role,
      period: item.start ? formatPeriod(item.start, item.end, item.current) : '',
      bullets: [],
    })),
    education: facts.education.map((item) => ({
      institution: item.institution,
      degree: item.degree,
      period: formatYears(item.startYear, item.endYear),
    })),
    languages: facts.languages.map((item) => ({ name: item.name, level: item.level })),
    links: facts.links.map((item) => ({ label: item.label, url: item.url })),
  }
}

/**
 * Legacy `content.languages[].level` is free text ("Fluent", "родной"). The
 * facts form accepts CEFR or `native`, so map the spellings we know and leave
 * an unrecognised one at a neutral B2 for HR to correct.
 */
const LEGACY_LANGUAGE_LEVELS: Readonly<Record<string, LanguageLevel>> = {
  родной: 'native',
  fluent: 'C1',
  advanced: 'C1',
  'upper-intermediate': 'B2',
  intermediate: 'B1',
  'pre-intermediate': 'A2',
  elementary: 'A1',
  beginner: 'A1',
}

function toLanguageLevel(raw: string): LanguageLevel {
  const folded = raw.trim().toLowerCase()
  const direct = RESUME_LANGUAGE_LEVELS.find((level) => level.toLowerCase() === folded)
  return direct ?? LEGACY_LANGUAGE_LEVELS[folded] ?? 'B2'
}

function inResumeYearRange(value: number | undefined): number | null {
  if (value === undefined) return null
  if (value < RESUME_YEAR_MIN || value > RESUME_YEAR_MAX) return null
  return value
}

/** First two four-digit years of an education period, in schema range. */
function parseYearRange(text: string): { startYear: number | null; endYear: number | null } {
  const years = [...text.matchAll(/\b\d{4}\b/g)].map((match) => Number(match[0]))
  return { startYear: inResumeYearRange(years[0]), endYear: inResumeYearRange(years[1]) }
}

/**
 * The lazy mapping for legacy rows (spec §3): bullets become notes and the
 * free-text period is parsed where it can be, left for HR where it cannot.
 */
export function contentToFacts(content: ResumeContent): ResumeFacts {
  return {
    headline: '',
    location: { city: '', country: '' },
    workFormat: null,
    skills: content.skills.map(canonicalSkill),
    experience: content.experience.map((item) => {
      const period = parseFreePeriod(item.period)
      return {
        company: item.company,
        role: item.role,
        location: null,
        start: period.start,
        end: period.end,
        current: period.current,
        technologies: [],
        notes: [...item.bullets],
      }
    }),
    education: content.education.map((item) => {
      const years = parseYearRange(item.period)
      return {
        institution: item.institution,
        degree: item.degree,
        startYear: years.startYear,
        endYear: years.endYear,
      }
    }),
    languages: content.languages.map((item) => ({
      name: item.name,
      level: toLanguageLevel(item.level),
    })),
    links: content.links.map((item) => ({ label: item.label, url: item.url })),
  }
}
