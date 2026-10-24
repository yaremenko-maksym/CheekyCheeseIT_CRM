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

export class UnsupportedRuleVersionError extends Error {
  constructor(version: string) {
    super(`Layer 1 does not implement rule version "${version}" (implements ${RULE_VERSION})`)
    this.name = 'UnsupportedRuleVersionError'
  }
}

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

interface Hit {
  index: number
  text: string
}

/** Precedence: structured hints and the title first, body requirement sections second. */
const tierOf = (s: EvidenceSource): 0 | 1 => (s === 'BODY' ? 1 : 0)

const NEGATOR =
  /(?:^|[^\p{L}])(?:no|not|non|without|never|neither|nor|не|нет|ні|без|kein|keine|nie|brak|bez|\p{L}*n't)(?:[\s-]+\p{L}+){0,4}[\s-]*$/iu
const SOFTENER =
  /(?:occasional\p{L}*|optional\p{L}*|rare\p{L}*|periodic\p{L}*|quarterly|annual\p{L}*|sometimes|from time to time|епізодичн\p{L}*|іноді)(?:[\s-]+\p{L}+){0,3}[\s-]*$/iu

function precedingClause(sentence: string, index: number): string {
  const head = sentence.slice(Math.max(0, index - 48), index)
  const cut = Math.max(
    head.lastIndexOf('.'),
    head.lastIndexOf(';'),
    head.lastIndexOf('!'),
    head.lastIndexOf('?'),
    head.lastIndexOf(':'),
    head.lastIndexOf(','),
  )
  return cut === -1 ? head : head.slice(cut + 1)
}

const isNegated = (sentence: string, index: number): boolean =>
  NEGATOR.test(precedingClause(sentence, index))
const isSoftened = (sentence: string, index: number): boolean =>
  SOFTENER.test(precedingClause(sentence, index))

function hits(sentence: string, re: RegExp): Hit[] {
  return [...sentence.matchAll(re)].map((m) => ({ index: m.index ?? 0, text: m[0] }))
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\u0000/g, '')
}

function sentencesOf(text: string): string[] {
  return normalizeText(text)
    .split(/[\r\n]+|(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/[*_#>`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((s) => s.length > 0)
}

const excerptOf = (s: string): string => s.slice(0, MAX_EXCERPT)

interface TextSource {
  source: EvidenceSource
  field: string
  text: string
}

function textSources(input: Layer1Input): TextSource[] {
  const out: TextSource[] = []
  out.push({ source: 'TITLE', field: 'title', text: input.title })
  if (input.location) out.push({ source: 'STRUCTURED', field: 'location', text: input.location })
  if (input.employmentType)
    out.push({ source: 'STRUCTURED', field: 'employmentType', text: input.employmentType })
  if (input.seniorityHint)
    out.push({ source: 'STRUCTURED', field: 'seniorityHint', text: input.seniorityHint })
  for (const tag of input.tags ?? []) out.push({ source: 'STRUCTURED', field: 'tags', text: tag })
  out.push({ source: 'BODY', field: 'descriptionMd', text: input.descriptionMd })
  return out
}

type Extractor<V> = (sentence: string) => Array<{ value: V; code: string }>

function collect<V>(sources: TextSource[], extract: Extractor<V>, only?: string[]): Signal<V>[] {
  const out: Signal<V>[] = []
  for (const src of sources) {
    if (only && !only.includes(src.field)) continue
    for (const sentence of sentencesOf(src.text)) {
      for (const found of extract(sentence)) {
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
  /** The tier the decision was taken in. */
  tier: 0 | 1 | null
  evidence: Layer1Evidence[]
}

/**
 * Highest-precedence tier that has any signal decides. Distinct values inside that tier are a
 * conflict (unresolved, never guessed). Lower-tier signals stay on the record, marked unused.
 */
function resolve<V>(signals: Signal<V>[]): Resolution<V> {
  const tiers = signals.map((s) => tierOf(s.source))
  const tier: 0 | 1 | null = tiers.includes(0) ? 0 : tiers.includes(1) ? 1 : null
  const deciding = signals.filter((s) => tierOf(s.source) === tier)
  const distinct = new Set(deciding.map((s) => s.value))
  const conflict = distinct.size > 1
  const evidence = signals.map<Layer1Evidence>((s) => ({
    source: s.source,
    field: s.field,
    excerpt: s.excerpt,
    code: s.code,
    used: tierOf(s.source) === tier && !conflict,
  }))
  return {
    value: tier !== null && !conflict ? (deciding[0] as Signal<V>).value : null,
    conflict,
    tier,
    evidence,
  }
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

// ---------------------------------------------------------------------------------------------
// Workplace
// ---------------------------------------------------------------------------------------------

type WorkplaceSignal = Workplace | 'NOT_REMOTE'

const REMOTE_RE =
  /\b(?:fully[- ]remote|remote(?:ly)?(?:[- ]first)?|work(?:ing)? from home|wfh|telecommut\w*|fully distributed)\b|віддален\p{L}*|дистанційн\p{L}*|удал[её]нн\p{L}*|дистанцион\p{L}*|zdaln\p{L}*|homeoffice/giu
const HYBRID_RE =
  /\bhybrid\b|\bpartially remote\b|гібрид\p{L}*|гибрид\p{L}*|частков\p{L}* віддален\p{L}*|\b[1-4]\s+days?\s+(?:per\s+week\s+|a\s+week\s+|weekly\s+)?(?:in|at)\s+(?:the\s+)?office\b/giu
const ONSITE_RE =
  /\bon[- ]?site\b(?!\s+(?:interview|meeting|event|visit|offsite|training|workshop|onboarding))|\bin[- ]office\b|\boffice[- ]based\b|\bwork from (?:the )?office\b|\b5\s+days?\s+(?:per\s+week\s+|a\s+week\s+)?(?:in|at)\s+(?:the\s+)?office\b|офісн\p{L}* формат|робота в офісі|офисн\p{L}* формат|работа в офисе|vor ort/giu

const extractWorkplace: Extractor<WorkplaceSignal> = (sentence) => {
  const out: Array<{ value: WorkplaceSignal; code: string }> = []
  const hybrid = hits(sentence, HYBRID_RE)
  for (const h of hybrid) {
    if (isNegated(sentence, h.index) || isSoftened(sentence, h.index)) continue
    out.push({ value: 'HYBRID', code: 'HYBRID_KEYWORD' })
  }
  for (const h of hits(sentence, ONSITE_RE)) {
    if (isNegated(sentence, h.index) || isSoftened(sentence, h.index)) continue
    out.push({ value: 'ONSITE', code: 'ONSITE_KEYWORD' })
  }
  for (const h of hits(sentence, REMOTE_RE)) {
    // "partially remote" is a hybrid phrase: its "remote" is not a remote signal.
    if (hybrid.some((p) => h.index >= p.index && h.index < p.index + p.text.length)) continue
    if (isNegated(sentence, h.index)) out.push({ value: 'NOT_REMOTE', code: 'NEGATED_REMOTE' })
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
  const effective = signals.filter(
    (s) => !(s.value === 'NOT_REMOTE' && strongTiers.has(tierOf(s.source))),
  )
  const r = resolve(effective)
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
  return {
    dimension: dim<Workplace>('UNKNOWN', 'WARN_UNKNOWN', r.evidence),
    contradiction: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Schedule, basis, duration, agency
// ---------------------------------------------------------------------------------------------

const FULL_RE =
  /\bfull[\s_-]?time\b|\bfulltime\b|повн\p{L}* (?:робочий день|зайнятість)|vollzeit|pełny etat/giu
const PART_RE =
  /\bpart[\s_-]?time\b|\bparttime\b|неповн\p{L}*|парт-?тайм|teilzeit|niepełny etat|część etatu/giu
const HOURS_RE =
  /\b(\d{1,2})\s*(?:hours?|hrs?|год(?:ин)?)\s*(?:\/|per|a|в|на)\s*(?:week|wk|тиждень|тиж)/giu

const extractSchedule: Extractor<Schedule> = (sentence) => {
  const full = hits(sentence, FULL_RE).filter((h) => !isNegated(sentence, h.index))
  const part = hits(sentence, PART_RE).filter((h) => !isNegated(sentence, h.index))
  const out: Array<{ value: Schedule; code: string }> = []
  if (full.length > 0 && part.length > 0) out.push({ value: 'FLEXIBLE', code: 'FULL_OR_PART_TIME' })
  else if (full.length > 0) out.push({ value: 'FULL_TIME', code: 'FULL_TIME_KEYWORD' })
  else if (part.length > 0) out.push({ value: 'PART_TIME', code: 'PART_TIME_KEYWORD' })
  for (const m of sentence.matchAll(HOURS_RE)) {
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
  const r = resolve(
    collect(textSources(input), extractSchedule, [
      'title',
      'employmentType',
      'tags',
      'descriptionMd',
    ]),
  )
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
const B2B_RE = /\bb\s?-?2\s?-?b\b|\bфоп\b|\bjdg\b|\bsole proprietor\w*/giu
const CONTRACTOR_RE =
  /\bcontractor\b|\bfreelanc\w*|\bself[- ]employed\b|\b1099\b|договір підряду|\bcontract\b/giu
const EMPLOYEE_RE =
  /\bemployment contract\b|\bcontract of employment\b|\bpermanent employ\w*|\bemployee\b|\bw-?2\b|трудов\p{L}* договір|\bumowa o pracę\b|\barbeitsvertrag\b/giu

const extractBasis: Extractor<BasisSignal> = (sentence) => {
  const out: Array<{ value: BasisSignal; code: string }> = []
  if (hits(sentence, EMPLOYEE_RE).some((h) => !isNegated(sentence, h.index)))
    out.push({ value: 'EMPLOYEE', code: 'EMPLOYMENT_KEYWORD' })
  if (hits(sentence, B2B_RE).some((h) => !isNegated(sentence, h.index)))
    out.push({ value: 'B2B', code: 'B2B_KEYWORD' })
  // "employment contract" contains the word "contract": it must not read as a contractor signal.
  const stripped = sentence.replace(EMPLOYEE_RE, ' ')
  if (hits(stripped, CONTRACTOR_RE).some((h) => !isNegated(stripped, h.index)))
    out.push({ value: 'CONTRACTOR', code: 'CONTRACTOR_KEYWORD' })
  return out
}

function classifyBasis(input: Layer1Input): Dimension<Basis> {
  const signals = collect(textSources(input), extractBasis, [
    'title',
    'employmentType',
    'tags',
    'descriptionMd',
  ])
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

const FIXED_RE =
  /\bfixed[- ]term\b|\btemporary\b|\b\d{1,2}[- ]months?\s+(?:contract|term|engagement|project)\b|\bcontract (?:for|of) \d{1,2} months\b|терміновий|строков\p{L}* договір|befristet/giu
const PROJECT_RE =
  /\bproject[- ]based\b|\bproject basis\b|\bone[- ]off project\b|проєктн\p{L}*|проектн\p{L}*/giu
const PERMANENT_RE = /\bpermanent\b|\bindefinite\b|безстроков\p{L}*|unbefristet/giu

const extractDuration: Extractor<Duration> = (sentence) => {
  const out: Array<{ value: Duration; code: string }> = []
  if (hits(sentence, FIXED_RE).some((h) => !isNegated(sentence, h.index)))
    out.push({ value: 'FIXED_TERM', code: 'FIXED_TERM_KEYWORD' })
  if (hits(sentence, PROJECT_RE).some((h) => !isNegated(sentence, h.index)))
    out.push({ value: 'PROJECT', code: 'PROJECT_KEYWORD' })
  if (hits(sentence, PERMANENT_RE).some((h) => !isNegated(sentence, h.index)))
    out.push({ value: 'PERMANENT', code: 'PERMANENT_KEYWORD' })
  return out
}

function classifyDuration(input: Layer1Input): Dimension<Duration> {
  const r = resolve(
    collect(textSources(input), extractDuration, [
      'title',
      'employmentType',
      'tags',
      'descriptionMd',
    ]),
  )
  // No A1o rule depends on duration, so it never warns or rejects; a conflict only goes unknown.
  if (r.conflict) return dim<Duration>('UNKNOWN', 'PASS', [...r.evidence, policyNote('CONFLICT')])
  return dim<Duration>(r.value ?? 'UNKNOWN', 'PASS', r.evidence)
}

const NO_AGENCY_RE =
  /\b(?:no|not|without)\s+(?:\w+\s+){0,2}(?:agenc(?:y|ies)|recruiters|vendors)\b|\bagenc(?:y|ies)\s+(?:need not|should not|do not|don't|please do not|not)\b|\bno third[- ]party\b|без (?:посередників|агенцій|рекрутинг\p{L}*)|без посредников/giu
const AGENCY_OK_RE =
  /\b(?:agenc(?:y|ies)|recruiters|vendors)\s+(?:are\s+)?(?:welcome|accepted|encouraged)\b|\bopen to (?:recruitment\s+)?agenc(?:y|ies)\b|\bwe (?:work|partner) with (?:recruitment |staffing )?agenc(?:y|ies)\b/giu

const extractAgency: Extractor<AgencyAcceptance> = (sentence) => {
  if (hits(sentence, NO_AGENCY_RE).length > 0) return [{ value: 'PROHIBITED', code: 'NO_AGENCY' }]
  if (hits(sentence, AGENCY_OK_RE).length > 0)
    return [{ value: 'ACCEPTED', code: 'AGENCY_WELCOME' }]
  return []
}

function classifyAgency(input: Layer1Input): Dimension<AgencyAcceptance> {
  const r = resolve(collect(textSources(input), extractAgency, ['descriptionMd']))
  if (r.conflict) return dim<AgencyAcceptance>('UNKNOWN', 'WARN_UNKNOWN', r.evidence)
  const v = r.value ?? 'UNKNOWN'
  return dim<AgencyAcceptance>(
    v,
    v === 'PROHIBITED' ? 'REJECT' : v === 'ACCEPTED' ? 'PASS' : 'WARN_UNKNOWN',
    r.evidence,
  )
}
