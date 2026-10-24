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

/** Cannot occur inside a token, so no keyword phrase can span it. */
// Stryker disable next-line StringLiteral: an empty-string break is just as unmatchable by a non-empty token phrase, so no output differs
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
/** A negator up to this many tokens before the keyword negates it ("no experience with Java"). */
const NEGATOR_WINDOW = 3
/** "<keyword> … not required": the `not` may sit up to this many tokens after the keyword. */
const TRAILING_NEGATION_WINDOW = 4
const TRAILING_NEGATION_FOLLOWERS: ReadonlySet<string> = new Set([
  'required',
  'needed',
  'necessary',
  'mandatory',
  'expected',
])

/** Token phrases (space-joined) that make a sentence or a heading optional. */
const OPTIONAL_PHRASES: readonly string[] = [
  'nice to have',
  'good to have',
  'would be nice',
  'a plus',
  'bonus',
  'optional',
  'advantage',
  'desirable',
  'preferred',
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
}

function hasOptionalPhrase(tokens: readonly string[]): boolean {
  const joined = ` ${tokens.join(' ')} `
  return OPTIONAL_PHRASES.some((phrase) => joined.includes(` ${phrase} `))
}

function isHeadingLine(line: string, tokenCount: number): boolean {
  if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line)) return true
  return line.endsWith(':') && tokenCount <= MAX_HEADING_TOKENS
}

interface BodyReading {
  segments: BodySegment[]
  /** Every segment's tokens, each followed by SEGMENT_BREAK. */
  tokens: string[]
  /** For every entry of `tokens`, the segment it belongs to and where that segment starts in `tokens`. */
  owner: { segment: BodySegment; start: number }[]
}

/**
 * Cut the body into sentences, tracking the optional/required section a heading
 * opens, and tokenise each sentence once.
 */
function readBody(body: string | null): BodyReading {
  const segments: BodySegment[] = []
  // Stryker disable next-line ArrayDeclaration: a junk first token only shifts every start by one and never equals a keyword token, so no observable output changes
  const tokens: string[] = []
  const owner: BodyReading['owner'] = []
  let sectionOptional = false

  const lines = body === null ? [] : body.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const lineTokens = stackTokens(line)
    if (isHeadingLine(line, lineTokens.length)) {
      sectionOptional = hasOptionalPhrase(lineTokens)
      continue
    }
    for (const sentence of line.split(/(?<=[.!?;])\s/)) {
      const sentenceTokens = stackTokens(sentence)
      const segment: BodySegment = {
        text: sentence.trim(),
        tokens: sentenceTokens,
        optional: sectionOptional || hasOptionalPhrase(sentenceTokens),
      }
      segments.push(segment)
      const owned = { segment, start: tokens.length }
      for (const token of [...sentenceTokens, SEGMENT_BREAK]) {
        tokens.push(token)
        owner.push(owned)
      }
    }
  }
  return { segments, tokens, owner }
}

function isNegatedAt(segmentTokens: readonly string[], local: number): boolean {
  const before = segmentTokens.slice(Math.max(0, local - NEGATOR_WINDOW), local)
  if (before.some((token) => NEGATORS.has(token))) return true
  // Stryker disable next-line ArithmeticOperator: starting one token earlier only adds the pair (token before the keyword = `not`, keyword = a follower word), and that `not` is already caught by the leading check above
  for (let i = local + 1; i <= local + TRAILING_NEGATION_WINDOW; i += 1) {
    if (
      segmentTokens[i] === 'not' &&
      TRAILING_NEGATION_FOLLOWERS.has(String(segmentTokens[i + 1]))
    ) {
      return true
    }
  }
  return false
}

const STRENGTH_RANK: Readonly<Record<MentionStrength, number>> = {
  CORE: 2,
  OPTIONAL: 1,
  NEGATED: 0,
}
const SOURCE_ORDER: readonly MentionSource[] = ['TITLE', 'TAG', 'BODY']

interface Mention {
  strength: MentionStrength
  source: MentionSource
  excerpt: string | null
}

/** The strongest mentions win; ties keep every source that reached that strength. */
function bestEvidence(keyword: string, mentions: readonly Mention[]): KeywordEvidence {
  const rank = (m: Mention) => STRENGTH_RANK[m.strength]
  // Stryker disable next-line EqualityOperator: on a tie both mentions have the same strength, and only `best.strength` is read
  const higher = (a: Mention, b: Mention) => (rank(b) > rank(a) ? b : a)
  const best = mentions.reduce(higher)
  const winners = mentions.filter((m) => m.strength === best.strength)
  return {
    keyword,
    strength: best.strength,
    sources: SOURCE_ORDER.filter((source) => winners.some((m) => m.source === source)),
    excerpt: winners.find((m) => m.source === 'BODY')?.excerpt ?? null,
  }
}

interface PostingReading {
  evidence: Map<string, KeywordEvidence>
  tags: boolean
  requirements: boolean
}

/** Tokenise the posting ONCE and read the strongest mention of every keyword in `union`. */
function readPosting(posting: TechMatchPosting, union: readonly string[]): PostingReading {
  const mentions = new Map<string, Mention[]>()
  const record = (keyword: string, mention: Mention) => {
    mentions.set(keyword, [...(mentions.get(keyword) ?? []), mention])
  }

  // Title and tags are structured surfaces: always CORE, ambiguous aliases such as `go` count.
  // The empty token list passed as the "other" surface below can be mutated to a junk token; no keyword equals it, so nothing observable changes.
  // Stryker disable next-line ArrayDeclaration: see the comment above
  for (const keyword of stackKeywordHits(union, stackTokens(posting.title), []).keys()) {
    record(keyword, { strength: 'CORE', source: 'TITLE', excerpt: null })
  }
  let tags = false
  for (const tag of posting.tags) {
    const tagTokens = stackTokens(tag)
    tags = tags || tagTokens.length > 0
    // Stryker disable next-line ArrayDeclaration: junk "other surface" token, see above
    for (const keyword of stackKeywordHits(union, tagTokens, []).keys()) {
      record(keyword, { strength: 'CORE', source: 'TAG', excerpt: null })
    }
  }

  const body = readBody(posting.body)
  // Stryker disable next-line ArrayDeclaration: junk "other surface" token, see above
  for (const [keyword, hit] of stackKeywordHits(union, [], body.tokens)) {
    for (const index of hit.bodyIndexes) {
      const owned = body.owner[index]
      // Stryker disable next-line ConditionalExpression: `owner` has one entry per token, so an index returned by the matcher always has a segment; the guard exists only for noUncheckedIndexedAccess
      if (owned === undefined) continue
      const { segment, start } = owned
      const negated = isNegatedAt(segment.tokens, index - start)
      record(keyword, {
        strength: negated ? 'NEGATED' : segment.optional ? 'OPTIONAL' : 'CORE',
        source: 'BODY',
        excerpt: segment.text.slice(0, MAX_EVIDENCE_EXCERPT_CHARS),
      })
    }
  }

  const evidence = new Map<string, KeywordEvidence>()
  for (const [keyword, list] of mentions) evidence.set(keyword, bestEvidence(keyword, list))
  return {
    evidence,
    tags,
    requirements: body.segments.some((s) => s.tokens.some((t) => REQUIREMENT_MARKERS.has(t))),
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id)
    seen.add(id)
  }
  return [...duplicated]
}

function readinessIssues(
  rosterSeniorIds: readonly string[],
  profiles: readonly SeniorTechProfile[],
): TechMatchReadinessIssue['issues'] {
  const profileIds = profiles.map((p) => p.seniorId)
  const have = new Set(profileIds)
  const missing = [...new Set(rosterSeniorIds)].filter((id) => !have.has(id))
  const duplicated = findDuplicates(profileIds)
  const issues: TechMatchReadinessIssue['issues'] = []
  if (missing.length > 0) issues.push({ code: 'MISSING_ROSTER_PROFILES', seniorIds: missing })
  if (duplicated.length > 0) issues.push({ code: 'DUPLICATE_PROFILES', seniorIds: duplicated })
  return issues
}

type Outcome =
  | { kind: 'DONE'; disposition: SeniorDisposition }
  | { kind: 'MATCHABLE'; seniorId: string; keywords: string[] }

/** Steps 1 and 2 — exclusions, then access — before any posting text is read. */
function classify(input: TechMatchInput, globalKeyword: readonly JobExclusionDto[]): Outcome[] {
  const rosterSet = new Set(input.rosterSeniorIds)
  const outcomes: Outcome[] = []
  for (const profile of input.profiles) {
    if (!rosterSet.has(profile.seniorId)) continue
    const own = input.exclusions.filter(
      (e) => e.scope === 'SENIOR' && e.seniorId === profile.seniorId,
    )
    const excluded =
      findMatchingExclusion(input.posting, [...globalKeyword]) ??
      findMatchingExclusion(input.posting, own)
    if (excluded) {
      outcomes.push({
        kind: 'DONE',
        disposition: {
          seniorId: profile.seniorId,
          disposition: 'EXCLUDED',
          exclusionId: excluded.id,
          exclusionKind: excluded.kind,
          exclusionScope: excluded.scope,
        },
      })
    } else if (profile.teamIds.length === 0) {
      outcomes.push({
        kind: 'DONE',
        disposition: { seniorId: profile.seniorId, disposition: 'NO_TEAM_ACCESS' },
      })
    } else {
      outcomes.push({
        kind: 'MATCHABLE',
        seniorId: profile.seniorId,
        keywords: canonicalStackKeywords(profile.techStack),
      })
    }
  }
  return outcomes
}

function seniorMatch(
  seniorId: string,
  keywords: readonly string[],
  evidence: ReadonlyMap<string, KeywordEvidence>,
  lowInformation: boolean,
): SeniorDisposition {
  const found = keywords.flatMap((k) => evidence.get(k) ?? [])
  const matches = found.filter((e) => e.strength !== 'NEGATED')
  const coreMatchCount = matches.filter((e) => e.strength === 'CORE').length
  return {
    seniorId,
    disposition: 'MATCHABLE',
    profileKeywordCount: keywords.length,
    matches,
    negated: found.filter((e) => e.strength === 'NEGATED'),
    coreMatchCount,
    optionalMatchCount: matches.length - coreMatchCount,
    coreMismatch: keywords.length > 0 && coreMatchCount === 0 && !lowInformation,
  }
}

export function matchTech(input: TechMatchInput): TechMatchResult {
  // Readiness: a roster senior without a profile must not read as "no match".
  const issues = readinessIssues(input.rosterSeniorIds, input.profiles)
  if (issues.length > 0) return { status: 'READINESS_ISSUE', issues }

  const globalKeyword = input.exclusions.filter((e) => e.scope === 'GLOBAL' && e.kind === 'KEYWORD')
  const ignoredExclusionIds = input.exclusions
    .filter((e) => e.scope === 'GLOBAL' && e.kind === 'COMPANY')
    .flatMap((e) => (e.id === null ? [] : [e.id]))

  const outcomes = classify(input, globalKeyword)
  const matchable = outcomes.flatMap((o) => (o.kind === 'MATCHABLE' ? [o] : []))

  // 3. matching over the distinct complete union of the matchable profiles.
  const union = [...new Set(matchable.flatMap((m) => m.keywords))]
  const reading = readPosting(input.posting, union)
  const keywordHit = reading.evidence.size > 0
  const lowInformation =
    matchable.length > 0 && !keywordHit && !reading.tags && !reading.requirements

  const rosterMatches: RosterKeywordMatch[] = []
  const rosterNegated: RosterKeywordMatch[] = []
  for (const keyword of union) {
    const ev = reading.evidence.get(keyword)
    if (!ev) continue
    const seniorIds = matchable.filter((m) => m.keywords.includes(keyword)).map((m) => m.seniorId)
    ;(ev.strength === 'NEGATED' ? rosterNegated : rosterMatches).push({ ...ev, seniorIds })
  }

  return {
    status: 'READY',
    matchableSeniorIds: matchable.map((m) => m.seniorId),
    rosterUnionSize: union.length,
    rosterMatches,
    rosterNegated,
    seniors: outcomes.map((o) =>
      o.kind === 'DONE'
        ? o.disposition
        : seniorMatch(o.seniorId, o.keywords, reading.evidence, lowInformation),
    ),
    evidenceSurfaces: {
      tags: reading.tags,
      requirements: reading.requirements,
      keywordHit,
    },
    lowInformation,
    ignoredExclusionIds,
  }
}
