import type { JobExclusionDto } from '@crm/shared'
import { canonicalStackKeywords, stackKeywordHits, stackTokens } from '@crm/shared'
import { findMatchingExclusion, type FilterablePosting } from '../filtering'

/**
 * Funnel Layer 2 — `tech ∩ union(users.tech_stack)` and the per-senior match
 * (plan r5 Task 4.2, C-24, C-25, A1f, A1g, A1o).
 *
 * PURE: no network, no database, no model, no clock. The caller supplies the
 * roster, the exclusions and one posting; the result is a function of them.
 * Merging this module makes nothing runnable — it has no caller yet.
 *
 * ORDER OF EVALUATION (A1g): exclusions first, then access, then matching. A
 * profile that is excluded or has no team access never reaches the tokenised
 * text, so it cannot add a keyword to the roster union, a count, a rank input or
 * an explanation line. That includes a posting whose stack is unknown: an
 * excluded company is excluded, it is not "low information, send to triage".
 *
 * CAPS (C-25): each profile keeps the shared `MAX_STACK_KEYWORDS` /
 * `MAX_STACK_KEYWORD_CHARS` ceilings through `canonicalStackKeywords`. The
 * roster union of several profiles is the distinct COMPLETE union and is NOT
 * re-capped, which is why the matching goes through `stackKeywordHits`.
 *
 * EVIDENCE COMPLETENESS (A1f) replaces the old 200-character cliff. Whether a
 * posting is "low information" depends on which evidence SURFACES it carries
 * (tags, a requirements statement, a keyword hit), never on how many characters
 * the body has: a 120-character body that says "Requirements: Python" is
 * complete, a 20 000-character marketing page is not.
 *
 * CONTEXT. A mention is CORE unless its sentence is an optional statement ("nice
 * to have", "bonus", a section headed so) or it is negated ("no Java", "Java is
 * not required"). The cue lists are English only; text in another language is
 * simply read as CORE, which is the stricter reading for a match and never
 * hides a posting.
 */

/** Strength of the best mention of one keyword in the posting. */
export type MentionStrength = 'CORE' | 'OPTIONAL' | 'NEGATED'
export type MentionSource = 'TITLE' | 'TAG' | 'BODY'

/** Longest body excerpt carried as evidence. */
export const MAX_EVIDENCE_EXCERPT_CHARS = 160

export interface SeniorTechProfile {
  seniorId: string
  /** Teams the senior is an ACTIVE member of (`findEligibleSeniorIds` joins on `left_at IS NULL`). */
  teamIds: readonly string[]
  techStack: readonly string[]
}

export interface TechMatchPosting extends FilterablePosting {
  tags: readonly string[]
  body: string | null
}

export interface TechMatchInput {
  posting: TechMatchPosting
  /** Eligible SENIOR ids from the caller's roster query: every one must have a profile. */
  rosterSeniorIds: readonly string[]
  profiles: readonly SeniorTechProfile[]
  exclusions: readonly JobExclusionDto[]
}

export interface KeywordEvidence {
  keyword: string
  strength: MentionStrength
  /** Surfaces where a mention of the winning strength was found, in TITLE, TAG, BODY order. */
  sources: MentionSource[]
  /** The sentence of the first winning body mention, cut to MAX_EVIDENCE_EXCERPT_CHARS; null for title/tag-only. */
  excerpt: string | null
}

export interface RosterKeywordMatch extends KeywordEvidence {
  /** Matchable seniors whose profile holds this keyword. */
  seniorIds: string[]
}

export type SeniorDisposition =
  | {
      seniorId: string
      disposition: 'EXCLUDED'
      exclusionId: string | null
      exclusionKind: JobExclusionDto['kind']
      exclusionScope: JobExclusionDto['scope']
    }
  | { seniorId: string; disposition: 'NO_TEAM_ACCESS' }
  | {
      seniorId: string
      disposition: 'MATCHABLE'
      /** Distinct canonical keywords of the profile after the per-profile caps. */
      profileKeywordCount: number
      /** CORE and OPTIONAL mentions, in profile order. */
      matches: KeywordEvidence[]
      negated: KeywordEvidence[]
      coreMatchCount: number
      optionalMatchCount: number
      /** Recomputable, never stored: the posting states its requirements and none of this stack is core in it. */
      coreMismatch: boolean
    }

export interface TechMatchReady {
  status: 'READY'
  /** Matchable seniors only. */
  matchableSeniorIds: string[]
  /** Size of the distinct union over matchable profiles — NOT capped at 60. */
  rosterUnionSize: number
  rosterMatches: RosterKeywordMatch[]
  rosterNegated: RosterKeywordMatch[]
  seniors: SeniorDisposition[]
  evidenceSurfaces: { tags: boolean; requirements: boolean; keywordHit: boolean }
  /** Not enough evidence to judge, and somebody could still be offered it: a triage candidate. */
  lowInformation: boolean
  /** Global COMPANY exclusions are unused by decision A1g; their ids are listed instead of silently dropped. */
  ignoredExclusionIds: string[]
}

export type ReadinessIssueCode = 'MISSING_ROSTER_PROFILES' | 'DUPLICATE_PROFILES'

export interface TechMatchReadinessIssue {
  status: 'READINESS_ISSUE'
  issues: { code: ReadinessIssueCode; seniorIds: string[] }[]
}

export type TechMatchResult = TechMatchReady | TechMatchReadinessIssue

// ---------------------------------------------------------------------------
// Reading the posting text
// ---------------------------------------------------------------------------

const SEGMENT_BREAK = '|'

const NEGATORS: ReadonlySet<string> = new Set([
  'no',
  'not',
  'without',
  'excluding',
  'except',
  'non',
  'never',
  'nor',
])
const NEGATOR_WINDOW = 3
const TRAILING_NEGATION_WINDOW = 4
const TRAILING_NEGATION_FOLLOWERS: ReadonlySet<string> = new Set([
  'required',
  'needed',
  'necessary',
  'mandatory',
  'expected',
])

const OPTIONAL_PHRASES: readonly (readonly string[])[] = [
  ['nice', 'to', 'have'],
  ['good', 'to', 'have'],
  ['would', 'be', 'nice'],
  ['a', 'plus'],
  ['bonus'],
  ['optional'],
  ['advantage'],
  ['desirable'],
  ['preferred'],
]

const REQUIREMENT_MARKERS: ReadonlySet<string> = new Set([
  'requirements',
  'requirement',
  'qualifications',
  'skills',
  'stack',
  'proficiency',
])

const MAX_HEADING_TOKENS = 8

interface BodySegment {
  text: string
  tokens: string[]
  optional: boolean
  /** Index of this segment's first token in the joined body token list. */
  start: number
}

function containsAnyPhrase(tokens: readonly string[], phrases: readonly (readonly string[])[]) {
  return phrases.some((phrase) => {
    for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
      if (phrase.every((word, j) => tokens[i + j] === word)) return true
    }
    return false
  })
}

function isHeadingLine(line: string, tokenCount: number): boolean {
  if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)) return true
  return line.endsWith(':') && tokenCount <= MAX_HEADING_TOKENS
}

/**
 * Cut the body into sentences, tracking the optional/required section a heading
 * opens. Tokenised once: the joined token list (segments separated by a token no
 * keyword can contain) is what `stackKeywordHits` scans.
 */
function segmentBody(body: string | null): { segments: BodySegment[]; tokens: string[] } {
  const segments: BodySegment[] = []
  const tokens: string[] = []
  let sectionOptional = false

  for (const rawLine of (body ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const lineTokens = stackTokens(line)
    if (isHeadingLine(line, lineTokens.length)) {
      sectionOptional = containsAnyPhrase(lineTokens, OPTIONAL_PHRASES)
      continue
    }
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const sentenceTokens = stackTokens(sentence)
      if (sentenceTokens.length === 0) continue
      if (tokens.length > 0) tokens.push(SEGMENT_BREAK)
      segments.push({
        text: sentence.trim(),
        tokens: sentenceTokens,
        optional: sectionOptional || containsAnyPhrase(sentenceTokens, OPTIONAL_PHRASES),
        start: tokens.length,
      })
      tokens.push(...sentenceTokens)
    }
  }
  return { segments, tokens }
}

function isNegatedAt(segmentTokens: readonly string[], local: number): boolean {
  for (let i = Math.max(0, local - NEGATOR_WINDOW); i < local; i += 1) {
    if (NEGATORS.has(segmentTokens[i] ?? '')) return true
  }
  const end = Math.min(segmentTokens.length - 1, local + TRAILING_NEGATION_WINDOW)
  for (let i = local + 1; i < end; i += 1) {
    if (segmentTokens[i] === 'not' && TRAILING_NEGATION_FOLLOWERS.has(segmentTokens[i + 1] ?? '')) {
      return true
    }
  }
  return false
}

function segmentIndexOf(segments: readonly BodySegment[], tokenIndex: number): number {
  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((segments[mid]?.start ?? 0) <= tokenIndex) low = mid
    else high = mid - 1
  }
  return low
}

const STRENGTH_RANK: Readonly<Record<MentionStrength, number>> = {
  CORE: 2,
  OPTIONAL: 1,
  NEGATED: 0,
}
const SOURCE_ORDER: readonly MentionSource[] = ['TITLE', 'TAG', 'BODY']
