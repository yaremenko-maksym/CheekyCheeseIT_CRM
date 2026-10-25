import {
  AGENCY_ACCEPT_AFTER,
  AGENCY_ACCEPT_PHRASES,
  AGENCY_NOUNS,
  AGENCY_PROHIBIT_AFTER,
  AGENCY_PROHIBIT_PHRASES,
  AUTHORIZATION_PHRASES,
  AUTHORIZATION_VERBS,
  B2B_PHRASES,
  CONTRACTOR_PHRASES,
  EMPLOYEE_PHRASES,
  FIXED_TERM_PHRASES,
  FULL_TIME_PHRASES,
  HYBRID_PHRASES,
  IC_BODY_PHRASES,
  LEAD_PHRASES,
  LEADS_BODY_PHRASES,
  LEVEL_PHRASES,
  NEGATORS,
  ONSITE_NOT_A_WORKPLACE_FOLLOWERS,
  ONSITE_PHRASES,
  PART_TIME_PHRASES,
  PERMANENT_PHRASES,
  PROJECT_PHRASES,
  REGIONS,
  REMOTE_PHRASES,
  ROLE_FAMILIES,
  SOFTENER_STEMS,
  TIMEZONE_PHRASES,
  YEARS_UNITS,
} from './layer1.lexicon'
import type {
  AgencyAcceptance,
  Basis,
  Dimension,
  Duration,
  EvidenceSource,
  FreshnessValue,
  Geography,
  GeographyValue,
  Layer1Evidence,
  Layer1Flag,
  Layer1Input,
  Layer1Options,
  Layer1Result,
  Leadership,
  RoleFamily,
  SalaryValue,
  Schedule,
  Seniority,
  Verdict,
  Workplace,
} from './layer1.types'
import { RULE_VERSION } from './layer1.types'

export { RULE_VERSION } from './layer1.types'
export type * from './layer1.types'

/** Owner policy A1o: monthly gross USD floor, applied only where a figure exists. */
export const SALARY_FLOOR_USD_MONTHLY = 3500
const HOURS_PER_MONTH = 160
const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Same tolerance as `FUTURE_TOLERANCE_MS` in the date policy (24h). */
const FUTURE_TOLERANCE_MS = MS_PER_DAY
const MAX_EXCERPT = 160
/** A negator counts when it is among this many words before the matched phrase, in the same clause. */
const NEGATION_WORDS = 5
const AGENCY_NEGATION_WORDS = 4
const SOFTENER_WORDS = 4

export class UnsupportedRuleVersionError extends Error {
  constructor(version: string) {
    super(`Layer 1 does not implement rule version "${version}" (implements ${RULE_VERSION})`)
    this.name = 'UnsupportedRuleVersionError'
  }
}

// ---------------------------------------------------------------------------------------------
// Text, phrases, negation
// ---------------------------------------------------------------------------------------------

interface Hit {
  index: number
  text: string
}

const WORD_START = '(?<![\\p{L}\\p{N}])'
const WORD_END = '(?![\\p{L}\\p{N}])'

/** One case-insensitive, whole-word regex per phrase list, compiled once. See `layer1.lexicon.ts`. */
function phraseRegex(phrases: readonly string[]): RegExp {
  const alternatives = phrases.map((p) =>
    p.endsWith('*') ? `${p.slice(0, -1)}\\p{L}*` : `${p}${WORD_END}`,
  )
  return new RegExp(`${WORD_START}(?:${alternatives.join('|')})`, 'giu')
}

/** Lower-case, with `-` and `_` read as a space. Length-preserving, so indices stay valid. */
const fold = (s: string): string => s.toLowerCase().replace(/[-–_]/g, ' ')

function hitsOf(re: RegExp, folded: string): Hit[] {
  return [...folded.matchAll(re)].map((m) => ({ index: m.index ?? 0, text: m[0] }))
}

const inside = (spans: readonly Hit[], index: number): boolean =>
  spans.some((s) => index >= s.index && index < s.index + s.text.length)

/** Anything that is not a letter or an apostrophe; callers drop the empty words it leaves. */
const NON_WORD = /[^\p{L}']/u

function precedingWords(folded: string, index: number, count: number): string[] {
  const head = folded.slice(0, index)
  const cut = Math.max(...['.', ';', '!', '?', ':', ','].map((c) => head.lastIndexOf(c)))
  // No punctuation: cut is -1, so this is the whole head.
  const clause = head.slice(cut + 1)
  return clause
    .split(NON_WORD)
    .filter((w) => w.length > 0)
    .slice(-count)
}

const isNegator = (w: string): boolean =>
  (NEGATORS as readonly string[]).includes(w) || w.endsWith("n't")

const isNegated = (folded: string, index: number, words = NEGATION_WORDS): boolean =>
  precedingWords(folded, index, words).some(isNegator)

const isSoftened = (folded: string, index: number): boolean =>
  precedingWords(folded, index, SOFTENER_WORDS).some((w) =>
    SOFTENER_STEMS.some((stem) => w.startsWith(stem)),
  )

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/’/g, "'")
}

/** Empty and whitespace-only pieces are harmless: no extractor reads a signal from them. */
const SENTENCE_BREAK = /[\r\n]|(?<=[.!?])\s/
const MARKDOWN_MARKS = /[*#>`]/g
function sentencesOf(text: string): string[] {
  return normalizeText(text)
    .split(SENTENCE_BREAK)
    .map((s) => s.replace(MARKDOWN_MARKS, ' ').replace(/\s+/g, ' ').trim())
}

const excerptOf = (s: string): string => s.slice(0, MAX_EXCERPT)

// ---------------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------------

interface Signal<V> {
  value: V
  source: EvidenceSource
  field: string
  excerpt: string
  code: string
}

/** Precedence: structured hints and the title first, body requirement sections second. */
const tierOf = (s: EvidenceSource): 0 | 1 => (s === 'BODY' ? 1 : 0)

interface TextSource {
  source: EvidenceSource
  field: string
  text: string
}

function textSources(input: Layer1Input): TextSource[] {
  const out: TextSource[] = [{ source: 'TITLE', field: 'title', text: input.title }]
  if (input.location) out.push({ source: 'STRUCTURED', field: 'location', text: input.location })
  if (input.employmentType)
    out.push({ source: 'STRUCTURED', field: 'employmentType', text: input.employmentType })
  if (input.seniorityHint)
    out.push({ source: 'STRUCTURED', field: 'seniorityHint', text: input.seniorityHint })
  for (const tag of input.tags ?? []) out.push({ source: 'STRUCTURED', field: 'tags', text: tag })
  out.push({ source: 'BODY', field: 'descriptionMd', text: input.descriptionMd })
  return out
}

/** Receives the folded sentence; returns the signals found in it. */
type Extractor<V> = (folded: string) => Array<{ value: V; code: string }>

function collect<V>(sources: TextSource[], extract: Extractor<V>, only: string[]): Signal<V>[] {
  const out: Signal<V>[] = []
  for (const src of sources) {
    if (!only.includes(src.field)) continue
    for (const sentence of sentencesOf(src.text)) {
      for (const found of extract(fold(sentence))) {
        out.push({
          value: found.value,
          code: found.code,
          source: src.source,
          field: src.field,
          excerpt: excerptOf(sentence),
        })
      }
    }
  }
  return out
}

interface Resolution<V> {
  /** The agreed value, or null when there is nothing / a conflict. */
  value: V | null
  conflict: boolean
  evidence: Layer1Evidence[]
}

/**
 * Highest-precedence tier that has any signal decides. Distinct values inside that tier are a
 * conflict (unresolved, never guessed). Lower-tier signals stay on the record, marked unused.
 */
function resolve<V>(signals: Signal<V>[]): Resolution<V> {
  const tier = signals.some((s) => tierOf(s.source) === 0) ? 0 : 1
  const deciding = signals.filter((s) => tierOf(s.source) === tier)
  const conflict = new Set(deciding.map((s) => s.value)).size > 1
  const evidence = signals.map<Layer1Evidence>((s) => ({
    source: s.source,
    field: s.field,
    excerpt: s.excerpt,
    code: s.code,
    used: tierOf(s.source) === tier && !conflict,
  }))
  return { value: conflict ? null : (deciding[0]?.value ?? null), conflict, evidence }
}

const policyNote = (code: string, excerpt = ''): Layer1Evidence => ({
  source: 'POLICY',
  field: '',
  excerpt,
  code,
  used: true,
})

function dim<V>(value: V, verdict: Verdict, evidence: Layer1Evidence[]): Dimension<V> {
  return { value, verdict, evidence, ruleVersion: RULE_VERSION }
}

/** The fields a "kind of engagement" dimension reads. */
const ENGAGEMENT_FIELDS = ['title', 'employmentType', 'tags', 'descriptionMd']

// ---------------------------------------------------------------------------------------------
// Workplace
// ---------------------------------------------------------------------------------------------

type WorkplaceSignal = Workplace | 'NOT_REMOTE'

const REMOTE_RE = phraseRegex(REMOTE_PHRASES)
const HYBRID_RE = phraseRegex(HYBRID_PHRASES)
const ONSITE_RE = phraseRegex(ONSITE_PHRASES)
/** "2 days a week in the office": 1-4 days is hybrid, 5 is onsite. */
const OFFICE_DAYS_RE =
  /(?<!\d)([1-5]) days?(?: per week| a week| weekly)? (?:in|at) (?:the )?office/gu

const extractWorkplace: Extractor<WorkplaceSignal> = (folded) => {
  const out: Array<{ value: WorkplaceSignal; code: string }> = []
  const days = [...folded.matchAll(OFFICE_DAYS_RE)].map((m) => ({
    index: m.index ?? 0,
    text: m[0],
    count: Number(m[1]),
  }))
  const hybrid = [...hitsOf(HYBRID_RE, folded), ...days.filter((d) => d.count < 5)]
  for (const h of hybrid) {
    if (isNegated(folded, h.index) || isSoftened(folded, h.index)) continue
    out.push({ value: 'HYBRID', code: 'HYBRID_KEYWORD' })
  }
  // Every day entry is a candidate: a count below 5 is already in `hybrid`, so `inside` skips it.
  const onsite = [...hitsOf(ONSITE_RE, folded), ...days]
  for (const h of onsite) {
    // "2 days in the office" is one hybrid phrase: its "in office" is not an onsite signal.
    if (inside(hybrid, h.index)) continue
    if (isNegated(folded, h.index) || isSoftened(folded, h.index)) continue
    const next = wordsAfter(folded, h).split(' ')[0] ?? ''
    if ((ONSITE_NOT_A_WORKPLACE_FOLLOWERS as readonly string[]).includes(next)) continue
    out.push({ value: 'ONSITE', code: 'ONSITE_KEYWORD' })
  }
  for (const h of hitsOf(REMOTE_RE, folded)) {
    // "partially remote" is a hybrid phrase: its "remote" is not a remote signal.
    if (inside(hybrid, h.index)) continue
    if (isNegated(folded, h.index)) out.push({ value: 'NOT_REMOTE', code: 'NEGATED_REMOTE' })
    else out.push({ value: 'REMOTE', code: 'REMOTE_KEYWORD' })
  }
  return out
}

function classifyWorkplace(input: Layer1Input): {
  dimension: Dimension<Workplace>
  contradiction: boolean
} {
  const signals = collect(textSources(input), extractWorkplace, [
    'title',
    'location',
    'tags',
    'descriptionMd',
  ])
  if (input.remote === true)
    signals.push({
      value: 'REMOTE',
      source: 'STRUCTURED',
      field: 'remote',
      excerpt: 'true',
      code: 'REMOTE_FLAG',
    })
  if (input.remote === false)
    signals.push({
      value: 'NOT_REMOTE',
      source: 'STRUCTURED',
      field: 'remote',
      excerpt: 'false',
      code: 'REMOTE_FLAG_FALSE',
    })
  // A NOT_REMOTE signal agrees with HYBRID / ONSITE: it only contradicts REMOTE. Fold it away
  // when a stronger "not remote" signal sits in the same tier.
  const strongTiers = new Set(
    signals
      .filter((s) => s.value === 'HYBRID' || s.value === 'ONSITE')
      .map((s) => tierOf(s.source)),
  )
  const r = resolve(
    signals.filter((s) => !(s.value === 'NOT_REMOTE' && strongTiers.has(tierOf(s.source)))),
  )
  if (r.conflict)
    return {
      dimension: dim<Workplace>('UNKNOWN', 'WARN_UNKNOWN', [
        ...r.evidence,
        policyNote('CONFLICTING_WORKPLACE_SIGNALS'),
      ]),
      contradiction: true,
    }
  const v = r.value
  if (v === 'REMOTE')
    return { dimension: dim<Workplace>('REMOTE', 'PASS', r.evidence), contradiction: false }
  if (v === 'HYBRID' || v === 'ONSITE')
    return { dimension: dim<Workplace>(v, 'REJECT', r.evidence), contradiction: false }
  return { dimension: dim<Workplace>('UNKNOWN', 'WARN_UNKNOWN', r.evidence), contradiction: false }
}

// ---------------------------------------------------------------------------------------------
// Schedule, basis, duration, agency
// ---------------------------------------------------------------------------------------------

const FULL_RE = phraseRegex(FULL_TIME_PHRASES)
const PART_RE = phraseRegex(PART_TIME_PHRASES)
/** "40 hours per week", "20 год на тиждень". */
const HOURS_RE = /(?<!\d)(\d{1,2}) ?(?:hours?|hrs?|год\p{L}*) ?(?:\/|per|a|в|на) ?(?:week|wk|тиж)/gu

const extractSchedule: Extractor<Schedule> = (folded) => {
  const full = hitsOf(FULL_RE, folded).filter((h) => !isNegated(folded, h.index))
  const part = hitsOf(PART_RE, folded).filter((h) => !isNegated(folded, h.index))
  const out: Array<{ value: Schedule; code: string }> = []
  if (full.length > 0 && part.length > 0) out.push({ value: 'FLEXIBLE', code: 'FULL_OR_PART_TIME' })
  else if (full.length > 0) out.push({ value: 'FULL_TIME', code: 'FULL_TIME_KEYWORD' })
  else if (part.length > 0) out.push({ value: 'PART_TIME', code: 'PART_TIME_KEYWORD' })
  for (const m of folded.matchAll(HOURS_RE)) {
    const hours = Number(m[1])
    if (hours >= 35) out.push({ value: 'FULL_TIME', code: 'HOURS_PER_WEEK' })
    else if (hours <= 30) out.push({ value: 'PART_TIME', code: 'HOURS_PER_WEEK' })
  }
  return out
}

function classifySchedule(input: Layer1Input): {
  dimension: Dimension<Schedule>
  contradiction: boolean
} {
  const r = resolve(collect(textSources(input), extractSchedule, ENGAGEMENT_FIELDS))
  if (r.conflict)
    return {
      dimension: dim<Schedule>('UNKNOWN', 'WARN_UNKNOWN', [
        ...r.evidence,
        policyNote('CONFLICTING_SCHEDULE_SIGNALS'),
      ]),
      contradiction: true,
    }
  const v = r.value ?? 'UNKNOWN'
  const verdict: Verdict =
    v === 'FULL_TIME' ? 'PASS' : v === 'PART_TIME' ? 'REJECT' : 'WARN_UNKNOWN'
  return { dimension: dim<Schedule>(v, verdict, r.evidence), contradiction: false }
}

type BasisSignal = 'EMPLOYEE' | 'CONTRACTOR' | 'B2B'
const B2B_RE = phraseRegex(B2B_PHRASES)
const CONTRACTOR_RE = phraseRegex(CONTRACTOR_PHRASES)
const EMPLOYEE_RE = phraseRegex(EMPLOYEE_PHRASES)

const extractBasis: Extractor<BasisSignal> = (folded) => {
  const out: Array<{ value: BasisSignal; code: string }> = []
  const employee = hitsOf(EMPLOYEE_RE, folded)
  if (employee.some((h) => !isNegated(folded, h.index)))
    out.push({ value: 'EMPLOYEE', code: 'EMPLOYMENT_KEYWORD' })
  if (hitsOf(B2B_RE, folded).some((h) => !isNegated(folded, h.index)))
    out.push({ value: 'B2B', code: 'B2B_KEYWORD' })
  // "employment contract" contains the word "contract": it must not read as a contractor signal.
  const contractor = hitsOf(CONTRACTOR_RE, folded).filter((h) => !inside(employee, h.index))
  if (contractor.some((h) => !isNegated(folded, h.index)))
    out.push({ value: 'CONTRACTOR', code: 'CONTRACTOR_KEYWORD' })
  return out
}

function classifyBasis(input: Layer1Input): Dimension<Basis> {
  const signals = collect(textSources(input), extractBasis, ENGAGEMENT_FIELDS)
  const tier = signals.some((s) => tierOf(s.source) === 0) ? 0 : 1
  const deciding = new Set(signals.filter((s) => tierOf(s.source) === tier).map((s) => s.value))
  let value: Basis = 'UNKNOWN'
  if (deciding.has('EMPLOYEE') && (deciding.has('B2B') || deciding.has('CONTRACTOR')))
    value = 'EITHER'
  else if (deciding.has('EMPLOYEE')) value = 'EMPLOYEE'
  else if (deciding.has('B2B')) value = 'B2B'
  else if (deciding.has('CONTRACTOR')) value = 'CONTRACTOR'
  const evidence = signals.map<Layer1Evidence>((s) => ({
    source: s.source,
    field: s.field,
    excerpt: s.excerpt,
    code: s.code,
    used: tierOf(s.source) === tier,
  }))
  // Both engagement forms are accepted by A1o, so a basis is never a reason to reject.
  return dim<Basis>(value, value === 'UNKNOWN' ? 'WARN_UNKNOWN' : 'PASS', evidence)
}

const FIXED_RE = phraseRegex(FIXED_TERM_PHRASES)
const PROJECT_RE = phraseRegex(PROJECT_PHRASES)
const PERMANENT_RE = phraseRegex(PERMANENT_PHRASES)
/** "12 month contract", "6 month term", "contract for 3 months". */
const FIXED_MONTHS_RE =
  /(?<!\d)\d{1,2} months? (?:contract|term|engagement|project)|contract (?:for|of) \d{1,2} months/u

const extractDuration: Extractor<Duration> = (folded) => {
  const out: Array<{ value: Duration; code: string }> = []
  const fixed = hitsOf(FIXED_RE, folded)
  if (fixed.some((h) => !isNegated(folded, h.index)) || FIXED_MONTHS_RE.test(folded))
    out.push({ value: 'FIXED_TERM', code: 'FIXED_TERM_KEYWORD' })
  if (hitsOf(PROJECT_RE, folded).some((h) => !isNegated(folded, h.index)))
    out.push({ value: 'PROJECT', code: 'PROJECT_KEYWORD' })
  if (hitsOf(PERMANENT_RE, folded).some((h) => !isNegated(folded, h.index)))
    out.push({ value: 'PERMANENT', code: 'PERMANENT_KEYWORD' })
  return out
}

function classifyDuration(input: Layer1Input): Dimension<Duration> {
  const r = resolve(collect(textSources(input), extractDuration, ENGAGEMENT_FIELDS))
  // No A1o rule depends on duration, so it never warns or rejects; a conflict only goes unknown.
  if (r.conflict) return dim<Duration>('UNKNOWN', 'PASS', [...r.evidence, policyNote('CONFLICT')])
  return dim<Duration>(r.value ?? 'UNKNOWN', 'PASS', r.evidence)
}

/** The words after a hit, punctuation dropped, single-spaced, with a trailing space. */
const wordsAfter = (folded: string, hit: Hit): string =>
  `${folded
    .slice(hit.index + hit.text.length)
    .split(NON_WORD)
    .filter((w) => w.length > 0)
    .join(' ')} `

/** What follows an agency noun, with a linking "are" dropped: "agencies are not welcome". */
const agencyTail = (folded: string, hit: Hit): string =>
  wordsAfter(folded, hit).replace(/^are /, '')

const AGENCY_NOUN_RE = phraseRegex(AGENCY_NOUNS)
const AGENCY_PROHIBIT_RE = phraseRegex(AGENCY_PROHIBIT_PHRASES)
const AGENCY_ACCEPT_RE = phraseRegex(AGENCY_ACCEPT_PHRASES)

/** "isn't an agency", "not a recruitment agency": says what the company is, not who may apply. */
const isCopulaNegation = (words: string[], i: number): boolean =>
  (words[i] === 'not' || words[i]?.endsWith("n't") === true) &&
  (words[i + 1] === 'a' || words[i + 1] === 'an')

/** A negator shortly before an agency noun bans agencies, unless it only denies being one. */
function bansAgencies(folded: string, hit: Hit): boolean {
  const words = precedingWords(folded, hit.index, AGENCY_NEGATION_WORDS)
  return words.some((w, i) => isNegator(w) && !isCopulaNegation(words, i))
}

const extractAgency: Extractor<AgencyAcceptance> = (folded) => {
  const prohibited =
    hitsOf(AGENCY_PROHIBIT_RE, folded).length > 0 ||
    hitsOf(AGENCY_NOUN_RE, folded).some(
      (h) =>
        bansAgencies(folded, h) ||
        AGENCY_PROHIBIT_AFTER.some((p) => agencyTail(folded, h).startsWith(`${p} `)),
    )
  if (prohibited) return [{ value: 'PROHIBITED', code: 'NO_AGENCY' }]
  const accepted =
    hitsOf(AGENCY_ACCEPT_RE, folded).length > 0 ||
    hitsOf(AGENCY_NOUN_RE, folded).some((h) =>
      AGENCY_ACCEPT_AFTER.some((p) => agencyTail(folded, h).startsWith(`${p} `)),
    )
  return accepted ? [{ value: 'ACCEPTED', code: 'AGENCY_WELCOME' }] : []
}

function classifyAgency(input: Layer1Input): Dimension<AgencyAcceptance> {
  const r = resolve(collect(textSources(input), extractAgency, ['descriptionMd']))
  // A conflict resolves to value null, which maps to UNKNOWN / WARN_UNKNOWN below.
  const v = r.value ?? 'UNKNOWN'
  return dim<AgencyAcceptance>(
    v,
    v === 'PROHIBITED' ? 'REJECT' : v === 'ACCEPTED' ? 'PASS' : 'WARN_UNKNOWN',
    r.evidence,
  )
}

// ---------------------------------------------------------------------------------------------
// Role family, seniority, leadership
// ---------------------------------------------------------------------------------------------

const ROLE_FAMILY_RES = ROLE_FAMILIES.map(([family, phrases]) => ({
  family,
  re: phraseRegex(phrases),
}))

function classifyRoleFamily(input: Layer1Input): Dimension<RoleFamily> {
  const probes: Array<{ source: EvidenceSource; field: string; text: string }> = [
    { source: 'TITLE', field: 'title', text: input.title },
    ...(input.tags ?? []).map((t) => ({ source: 'STRUCTURED' as const, field: 'tags', text: t })),
  ]
  // Title decides; tags only fill in a title that names no family. The body is never read: a job
  // description mentions every family in passing.
  for (const probe of probes) {
    const rule = ROLE_FAMILY_RES.find((r) => hitsOf(r.re, fold(probe.text)).length > 0)
    if (rule)
      return dim<RoleFamily>(rule.family, 'PASS', [
        {
          source: probe.source,
          field: probe.field,
          excerpt: excerptOf(probe.text),
          code: `FAMILY_${rule.family}`,
          used: true,
        },
      ])
  }
  return dim<RoleFamily>('UNKNOWN', 'WARN_UNKNOWN', [])
}

const LEVEL_ORDER: readonly Seniority[] = [
  'INTERN',
  'JUNIOR',
  'MIDDLE',
  'SENIOR',
  'LEAD',
  'EXECUTIVE',
]
const LEVEL_RES = LEVEL_PHRASES.map(([value, code, phrases]) => ({
  value,
  code,
  re: phraseRegex(phrases),
}))
/** "5+ years", "3 - 5 years", "4 років". */
const YEARS_RE = new RegExp(
  `(?<![\\d.])(\\d{1,2})[+ ]*(?:\\d{1,2}[+ ]*)?(?:${YEARS_UNITS.join('|')})${WORD_END}`,
  'gu',
)

function levelFromYears(years: number): Seniority {
  if (years >= 5) return 'SENIOR'
  if (years >= 2) return 'MIDDLE'
  return 'JUNIOR'
}

/** A body-derived junior reading is a hint, not a strong explicit contradiction: it only warns. */
function levelVerdict(level: Seniority, fromBody: boolean): Verdict {
  if (level === 'INTERN' || level === 'JUNIOR') return fromBody ? 'WARN_UNKNOWN' : 'REJECT'
  // Above the studio's middle-teamlead range is not a stated rejection: it only warns.
  return level === 'EXECUTIVE' ? 'WARN_UNKNOWN' : 'PASS'
}

function classifySeniority(input: Layer1Input): Dimension<Seniority> {
  const first: Array<Signal<Seniority>> = []
  for (const src of textSources(input)) {
    if (src.field !== 'title' && src.field !== 'seniorityHint') continue
    for (const { value, code, re } of LEVEL_RES) {
      if (hitsOf(re, fold(src.text)).length > 0)
        first.push({
          value,
          source: src.source,
          field: src.field,
          excerpt: excerptOf(src.text),
          code,
        })
    }
  }
  if (first.length > 0) {
    const top = LEVEL_ORDER.filter((lvl) => first.some((s) => s.value === lvl)).pop() as Seniority
    const evidence = first.map<Layer1Evidence>((s) => ({
      source: s.source,
      field: s.field,
      excerpt: s.excerpt,
      code: s.code,
      used: s.value === top,
    }))
    return dim<Seniority>(top, levelVerdict(top, false), evidence)
  }
  // Body requirement sections second: only an explicit years-of-experience statement counts.
  // Words such as "junior" or "mentorship" in a body describe the team, not the role.
  let years = -1
  // Stryker disable next-line StringLiteral: equivalent — the initial value is overwritten whenever `years` is set, and `years < 0` returns before `excerpt` is read
  let excerpt = ''
  for (const sentence of sentencesOf(input.descriptionMd)) {
    for (const m of fold(sentence).matchAll(YEARS_RE)) {
      const n = Number(m[1])
      if (n > years) {
        years = n
        excerpt = excerptOf(sentence)
      }
    }
  }
  if (years < 0) return dim<Seniority>('UNKNOWN', 'WARN_UNKNOWN', [])
  const value = levelFromYears(years)
  return dim<Seniority>(value, levelVerdict(value, true), [
    { source: 'BODY', field: 'descriptionMd', excerpt, code: `YEARS_${years}`, used: true },
  ])
}

const LEAD_RE = phraseRegex(LEAD_PHRASES)
const LEADS_BODY_RE = phraseRegex(LEADS_BODY_PHRASES)
const IC_BODY_RE = phraseRegex(IC_BODY_PHRASES)

function classifyLeadership(input: Layer1Input): Dimension<Leadership> {
  // Stryker disable next-line StringLiteral: equivalent — any placeholder that is not a lead phrase reads exactly like the empty string
  const hint = input.seniorityHint ?? ''
  const probes = [
    { source: 'TITLE' as const, field: 'title', text: input.title },
    { source: 'STRUCTURED' as const, field: 'seniorityHint', text: hint },
  ]
  for (const p of probes) {
    if (hitsOf(LEAD_RE, fold(p.text)).length > 0)
      return dim<Leadership>('LEADS_PEOPLE', 'PASS', [
        {
          source: p.source,
          field: p.field,
          excerpt: excerptOf(p.text),
          code: 'LEAD_TITLE',
          used: true,
        },
      ])
  }
  // Mentorship, "staff" and "principal" are deliberately NOT leadership evidence.
  for (const sentence of sentencesOf(input.descriptionMd)) {
    const folded = fold(sentence)
    const leads = hitsOf(LEADS_BODY_RE, folded).length > 0
    if (leads || hitsOf(IC_BODY_RE, folded).length > 0)
      return dim<Leadership>(leads ? 'LEADS_PEOPLE' : 'INDIVIDUAL_CONTRIBUTOR', 'PASS', [
        {
          source: 'BODY',
          field: 'descriptionMd',
          excerpt: excerptOf(sentence),
          code: leads ? 'LEAD_BODY' : 'IC_BODY',
          used: true,
        },
      ])
  }
  return dim<Leadership>('UNKNOWN', 'PASS', [])
}

// ---------------------------------------------------------------------------------------------
// Geography / work authorization
// ---------------------------------------------------------------------------------------------

const REGION_ALTERNATIVES = REGIONS.flatMap(([, phrases]) => phrases).join('|')
/** "Remote - Europe", "EU only", "must be based in Canada". */
const REGION_LIMIT_RE = new RegExp(
  `${WORD_START}(?:${[
    `remote(?: in| within| from)?[ ,:(]*(?:the )?(${REGION_ALTERNATIVES})`,
    `(${REGION_ALTERNATIVES}) only`,
    `must (?:be (?:located|based)|reside|live) in (?:the )?(${REGION_ALTERNATIVES})`,
  ].join('|')})${WORD_END}`,
  'giu',
)
/** "authorized to work in the US". */
const AUTHORIZED_TO_WORK_RE = new RegExp(
  `${WORD_START}(?:${AUTHORIZATION_VERBS.join('|')}) to work in (?:the )?(${REGION_ALTERNATIVES})${WORD_END}`,
  'giu',
)
/** "UTC+2", "CET", "overlap with US hours": a timezone is mentioned (evidence only, never a reject). */
const TIMEZONE_RE = phraseRegex(TIMEZONE_PHRASES)
/** "overlap with ... hours" names a working-hours window without naming a zone. */
const OVERLAP_HOURS_RE = /\boverlap (?:with|of)\b[^.;]{0,60}\bhours?\b/u
const AUTHORIZATION_RES = AUTHORIZATION_PHRASES.map(([phrase, region]) => ({
  re: phraseRegex([phrase]),
  region,
}))

function regionCode(word: string): string {
  const found = REGIONS.find(([, phrases]) => (phrases as readonly string[]).includes(word))
  return found ? found[0] : word.toUpperCase()
}

function classifyGeography(input: Layer1Input): Dimension<GeographyValue> {
  const regions = new Set<string>()
  let authorization = false
  const evidence: Layer1Evidence[] = []
  const note = (src: TextSource, sentence: string, code: string) =>
    evidence.push({
      source: src.source,
      field: src.field,
      excerpt: excerptOf(sentence),
      code,
      used: true,
    })
  for (const src of textSources(input)) {
    for (const sentence of sentencesOf(src.text)) {
      const folded = fold(sentence)
      for (const m of folded.matchAll(REGION_LIMIT_RE)) {
        if (isNegated(folded, m.index ?? 0)) continue
        regions.add(regionCode(m[1] ?? m[2] ?? m[3] ?? ''))
        note(src, sentence, 'REGION_LIMIT')
      }
      if (hitsOf(TIMEZONE_RE, folded).length > 0 || OVERLAP_HOURS_RE.test(folded))
        note(src, sentence, 'TIMEZONE_MENTION')
      for (const m of folded.matchAll(AUTHORIZED_TO_WORK_RE)) {
        if (isNegated(folded, m.index ?? 0)) continue
        authorization = true
        regions.add(regionCode(m[1] ?? ''))
        note(src, sentence, 'WORK_AUTHORIZATION')
      }
      for (const { re, region } of AUTHORIZATION_RES) {
        for (const h of hitsOf(re, folded)) {
          if (isNegated(folded, h.index)) continue
          authorization = true
          if (region) regions.add(region)
          note(src, sentence, 'WORK_AUTHORIZATION')
        }
      }
    }
  }
  const kind: Geography = authorization
    ? 'WORK_AUTHORIZATION_REQUIRED'
    : regions.size > 0
      ? 'REGION_LIMITED'
      : 'UNSTATED'
  // A timezone mention is evidence only: the studio's timezone policy is not frozen, so it never
  // changes the kind or the verdict (it raises TIMEZONE_MENTIONED for a human to read).
  // Policy A1o is "any location": a restriction can only warn, because whether it excludes a
  // given senior depends on that senior, which Layer 1 does not know.
  return dim<GeographyValue>(
    { kind, regions: [...regions].sort() },
    kind === 'UNSTATED' ? 'PASS' : 'WARN_UNKNOWN',
    evidence,
  )
}

// ---------------------------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------------------------

function toMonthly(amount: number, period: 'HOUR' | 'MONTH' | 'YEAR'): number {
  if (period === 'YEAR') return amount / 12
  if (period === 'HOUR') return amount * HOURS_PER_MONTH
  return amount
}

function classifySalary(input: Layer1Input): {
  dimension: Dimension<SalaryValue>
  flag: Layer1Flag | null
} {
  const salary = input.salary
  const top = salary?.max ?? salary?.min ?? 0
  if (!salary || !(top > 0 && Number.isFinite(top)))
    return {
      dimension: dim<SalaryValue>({ state: 'UNKNOWN', monthlyUsd: null }, 'PASS', [
        policyNote('SALARY_UNKNOWN'),
      ]),
      flag: 'SALARY_UNKNOWN',
    }
  const currency = salary.currency.toUpperCase()
  const rate = input.fxRate
  const usdPerUnit =
    currency === 'USD'
      ? 1
      : rate &&
          rate.currency.toUpperCase() === currency &&
          Number.isFinite(rate.usdPerUnit) &&
          rate.usdPerUnit > 0
        ? rate.usdPerUnit
        : null
  if (usdPerUnit === null)
    return {
      dimension: dim<SalaryValue>({ state: 'UNCONVERTIBLE', monthlyUsd: null }, 'WARN_UNKNOWN', [
        policyNote('NO_RECORDED_RATE', currency),
      ]),
      flag: 'SALARY_UNCONVERTIBLE',
    }
  const evidence: Layer1Evidence[] = []
  if (rate && currency !== 'USD')
    evidence.push(
      policyNote('RECORDED_RATE', `${currency}->USD ${usdPerUnit} @ ${rate.recordedAt}`),
    )
  const monthlyUsd = toMonthly(top, salary.period) * usdPerUnit
  const above = monthlyUsd >= SALARY_FLOOR_USD_MONTHLY
  evidence.push(policyNote(above ? 'AT_OR_ABOVE_FLOOR' : 'BELOW_FLOOR', String(monthlyUsd)))
  return {
    dimension: dim<SalaryValue>(
      { state: above ? 'ABOVE_FLOOR' : 'BELOW_FLOOR', monthlyUsd },
      above ? 'PASS' : 'REJECT',
      evidence,
    ),
    flag: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Freshness (a rank, never a closure criterion)
// ---------------------------------------------------------------------------------------------

function classifyFreshness(
  input: Layer1Input,
  now: Date,
): { dimension: Dimension<FreshnessValue>; flags: Layer1Flag[] } {
  const flags: Layer1Flag[] = []
  const evidence: Layer1Evidence[] = []
  const note = (field: string, raw: string, code: string, used: boolean) =>
    evidence.push({ source: 'STRUCTURED', field, excerpt: raw, code, used })
  const datedAt: number[] = []
  let expired = false
  for (const d of input.dates) {
    const field = `date.${d.semantics}`
    if (d.status === 'FUTURE') {
      flags.push('FUTURE_DATE_IGNORED')
      note(field, d.raw, 'FUTURE_DATE', false)
    } else if (d.status !== 'OK') {
      flags.push('DATE_UNCERTAIN')
      note(field, d.raw, `DATE_${d.status}`, false)
    } else if (d.semantics === 'EXPIRY') {
      if (d.value.getTime() <= now.getTime()) {
        expired = true
        note(field, d.raw, 'EXPIRED', true)
      }
    } else if (d.value.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      flags.push('FUTURE_DATE_IGNORED')
      note(field, d.raw, 'FUTURE_DATE', false)
    } else {
      note(field, d.raw, 'DATED', true)
      datedAt.push(d.value.getTime())
    }
  }
  let value: FreshnessValue = { bucket: 'UNKNOWN', ageDays: null, rank: 0 }
  if (datedAt.length > 0) {
    const newest = Math.max(...datedAt)
    const ageDays = Math.max(0, Math.floor((now.getTime() - newest) / MS_PER_DAY))
    const bucket =
      ageDays <= 7 ? 'FRESH' : ageDays <= 30 ? 'RECENT' : ageDays <= 90 ? 'AGING' : 'OLD'
    value = { bucket, ageDays, rank: 1 / (1 + ageDays) }
  }
  // A passed EXPIRY is the source closing the posting; age alone never is.
  return { dimension: dim<FreshnessValue>(value, expired ? 'REJECT' : 'PASS', evidence), flags }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function classifyLayer1(input: Layer1Input, options: Layer1Options): Layer1Result {
  if (options.ruleVersion !== RULE_VERSION)
    throw new UnsupportedRuleVersionError(options.ruleVersion)
  const workplace = classifyWorkplace(input)
  const schedule = classifySchedule(input)
  const salary = classifySalary(input)
  const freshness = classifyFreshness(input, options.evaluationTime)

  const flags = new Set<Layer1Flag>(freshness.flags)
  if (workplace.contradiction || schedule.contradiction) flags.add('UNRESOLVED_CONTRADICTION')
  if (salary.flag) flags.add(salary.flag)
  if (input.evidence?.some((e) => e.field === 'description' && e.kind === 'DISPLAY_TRUNCATED'))
    flags.add('DESCRIPTION_TRUNCATED')

  const named = {
    workplace: workplace.dimension,
    basis: classifyBasis(input),
    schedule: schedule.dimension,
    duration: classifyDuration(input),
    agency: classifyAgency(input),
    roleFamily: classifyRoleFamily(input),
    seniority: classifySeniority(input),
    leadership: classifyLeadership(input),
    geography: classifyGeography(input),
    salary: salary.dimension,
    freshness: freshness.dimension,
  }
  if (named.geography.evidence.some((e) => e.code === 'TIMEZONE_MENTION'))
    flags.add('TIMEZONE_MENTIONED')
  const entries = Object.entries(named) as Array<[string, Dimension<unknown>]>
  const rejectedBy = entries.filter(([, d]) => d.verdict === 'REJECT').map(([k]) => k)
  const unknown = entries.filter(([, d]) => d.verdict === 'WARN_UNKNOWN').map(([k]) => k)
  return {
    ruleVersion: RULE_VERSION,
    evaluatedAt: options.evaluationTime.toISOString(),
    ...named,
    verdict: rejectedBy.length > 0 ? 'REJECT' : unknown.length > 0 ? 'WARN_UNKNOWN' : 'PASS',
    rejectedBy,
    unknown,
    flags: [...flags].sort(),
  }
}
