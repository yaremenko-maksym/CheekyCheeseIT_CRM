import type { JobExclusionDto } from '@crm/shared'
import { canonicalStackKeywords, stackKeywordHits, stackTokens } from '@crm/shared'
import { MAX_DESCRIPTION_CHARS } from '../html-to-markdown'
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
 * WHO MAY SEE WHAT. The per-senior list holds matchable seniors only. Who was
 * excluded, by which exclusion, who lacks team access and which exclusions were
 * ignored live under `audit`, which a viewer-facing caller must never pass on:
 * `forViewer` returns the shape without it, for the given seniors only.
 *
 * CAPS (C-25): each profile keeps the shared `MAX_STACK_KEYWORDS` /
 * `MAX_STACK_KEYWORD_CHARS` ceilings through `canonicalStackKeywords`. The
 * roster union of several profiles is the distinct COMPLETE union and is NOT
 * re-capped, which is why the matching goes through `stackKeywordHits`.
 *
 * INPUT BOUNDS. The posting is cut to the limits below BEFORE it is tokenised,
 * and every cut sets `inputTruncated` — never a silent truncation.
 *
 * EVIDENCE COMPLETENESS (A1f) replaces the old 200-character cliff. Whether a
 * posting is "low information" depends on which evidence SURFACES it carries
 * (tags, a requirements statement, a keyword hit), never on how many characters
 * the body has: a 120-character body that says "Requirements: Python" is
 * complete, a 20 000-character marketing page is not.
 *
 * CONTEXT. A mention is CORE unless its sentence is an optional statement ("nice
 * to have", "bonus", a section headed so) or its own clause negates it ("no
 * Java", "Java is not required"). A negation never crosses a clause boundary
 * (comma, colon, semicolon, full stop, newline, bullet). The cue lists are
 * English only; text in another language (for example Ukrainian "без Java") is
 * read as CORE. That is a documented fail-open: it can show a posting that
 * explicitly excludes a technology, it never hides one.
 */

/** Strength of the best mention of one keyword in the posting. */
export type MentionStrength = 'CORE' | 'OPTIONAL' | 'NEGATED'
export type MentionSource = 'TITLE' | 'TAG' | 'BODY'

/** Longest body excerpt carried as evidence. */
export const MAX_EVIDENCE_EXCERPT_CHARS = 160

/** The description cap of the normalizer (`html-to-markdown`): nothing longer is ever stored. */
export const MAX_BODY_CHARS = MAX_DESCRIPTION_CHARS
/** Title cap of the normalizer (500). */
export const MAX_TITLE_CHARS = 500
/** Tag caps of the normalizer (50 tags of 60 characters). */
export const MAX_TAGS = 50
export const MAX_TAG_CHARS = 60
/**
 * Body tokens read per posting. Ordinary prose is ~6 characters per token, so a
 * full 20 000-character description is ~3 500 tokens; 8 000 is only reached by
 * token spam, which is exactly what the bound is for.
 */
export const MAX_BODY_TOKENS = 8_000

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

export interface SeniorMatch {
  seniorId: string
  /** Distinct canonical keywords of the profile after the per-profile caps. */
  keywords: string[]
  profileKeywordCount: number
  /** CORE and OPTIONAL mentions, in profile order. */
  matches: KeywordEvidence[]
  negated: KeywordEvidence[]
  coreMatchCount: number
  optionalMatchCount: number
  /** Recomputable, never stored: the posting states its requirements and none of this stack is core in it. */
  coreMismatch: boolean
}

/** Staff-only account of why seniors are absent from `seniors`. Never pass it to a viewer. */
export interface TechMatchAudit {
  excluded: {
    seniorId: string
    exclusionId: string | null
    exclusionKind: JobExclusionDto['kind']
    exclusionScope: JobExclusionDto['scope']
  }[]
  noTeamAccess: string[]
  /** Global COMPANY exclusions are unused by decision A1g; their ids are listed instead of silently dropped. */
  ignoredExclusionIds: string[]
}

export interface TechMatchView {
  status: 'READY'
  /** Matchable seniors only. */
  matchableSeniorIds: string[]
  /** Size of the distinct union over matchable profiles — NOT capped at 60. */
  rosterUnionSize: number
  rosterMatches: RosterKeywordMatch[]
  rosterNegated: RosterKeywordMatch[]
  seniors: SeniorMatch[]
  evidenceSurfaces: { tags: boolean; requirements: boolean; keywordHit: boolean }
  /** Not enough evidence to judge, and somebody could still be offered it: a triage candidate. */
  lowInformation: boolean
  /** The posting was cut to the input bounds before it was read. */
  inputTruncated: boolean
}

export interface TechMatchReady extends TechMatchView {
  audit: TechMatchAudit
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

/**
 * `non` is deliberately not here: "non-trivial Python" is a requirement, not a
 * negation. A negator only reaches tokens of its own clause.
 */
const NEGATORS: ReadonlySet<string> = new Set([
  'no',
  'not',
  'without',
  'excluding',
  'except',
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

const MAX_HEADING_WORDS = 8

/** Clause boundaries inside a sentence: comma / colon followed by a space, or a bullet glyph. */
const CLAUSE_BOUNDARY = /[,:]\s|\s[•·▪●]\s/
/** Sentence boundaries inside a line. */
const SENTENCE_BOUNDARY = /(?<=[.!?;])\s/

interface BodyClause {
  /** The whole sentence the clause belongs to: what an excerpt shows. */
  sentence: string
  tokens: string[]
  /** Optionality is a property of the sentence or section, shared by its clauses. */
  optional: boolean
}

function hasOptionalPhrase(tokens: readonly string[]): boolean {
  const joined = ` ${tokens.join(' ')} `
  return OPTIONAL_PHRASES.some((phrase) => joined.includes(` ${phrase} `))
}

function hasRequirementMarker(tokens: readonly string[]): boolean {
  return tokens.some((token) => REQUIREMENT_MARKERS.has(token))
}

function isHeadingLine(line: string): boolean {
  if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line)) return true
  return line.endsWith(':') && line.split(/\s+/).length <= MAX_HEADING_WORDS
}

interface BodyReading {
  clauses: BodyClause[]
  /** Every clause's tokens, each followed by SEGMENT_BREAK. */
  tokens: string[]
  /** For every entry of `tokens`, the clause it belongs to and where that clause starts in `tokens`. */
  owner: { clause: BodyClause; start: number }[]
  /** A heading or a sentence names the stack ("Requirements:", "Skills"). */
  requirements: boolean
  truncated: boolean
}

/**
 * Cut the body into sentences and clauses, tracking the optional/required
 * section a heading opens. Every character is tokenised once: a heading line as
 * a whole, any other line clause by clause.
 */
function readBody(body: string | null): BodyReading {
  const clauses: BodyClause[] = []
  // Stryker disable next-line ArrayDeclaration: a junk first token only shifts every start by one and never equals a keyword token, so no observable output changes
  const tokens: string[] = []
  const owner: BodyReading['owner'] = []
  let sectionOptional = false
  let requirements = false
  let truncated = body !== null && body.length > MAX_BODY_CHARS
  let budget = MAX_BODY_TOKENS

  const lines = body === null ? [] : body.slice(0, MAX_BODY_CHARS).split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (isHeadingLine(line)) {
      const headingTokens = stackTokens(line)
      sectionOptional = hasOptionalPhrase(headingTokens)
      requirements = requirements || hasRequirementMarker(headingTokens)
      continue
    }
    for (const sentence of line.split(SENTENCE_BOUNDARY)) {
      const clauseTokens = sentence.split(CLAUSE_BOUNDARY).map((part) => stackTokens(part))
      const optional = sectionOptional || clauseTokens.some(hasOptionalPhrase)
      for (const part of clauseTokens) {
        if (part.length > budget) {
          part.length = budget
          truncated = true
        }
        budget -= part.length
        requirements = requirements || hasRequirementMarker(part)
        const clause: BodyClause = { sentence: sentence.trim(), tokens: part, optional }
        clauses.push(clause)
        const owned = { clause, start: tokens.length }
        for (const token of part) {
          tokens.push(token)
          owner.push(owned)
        }
        tokens.push(SEGMENT_BREAK)
        owner.push(owned)
      }
    }
  }
  return { clauses, tokens, owner, requirements, truncated }
}

/** Is the keyword at `local` negated by a cue inside its own clause? */
function isNegatedAt(clauseTokens: readonly string[], local: number): boolean {
  const before = clauseTokens.slice(Math.max(0, local - NEGATOR_WINDOW), local)
  if (before.some((token) => NEGATORS.has(token))) return true
  for (let distance = 1; distance <= TRAILING_NEGATION_WINDOW; distance += 1) {
    if (
      clauseTokens[local + distance] === 'not' &&
      TRAILING_NEGATION_FOLLOWERS.has(String(clauseTokens[local + distance + 1]))
    ) {
      return true
    }
  }
  return false
}

const SOURCE_ORDER: readonly MentionSource[] = ['TITLE', 'TAG', 'BODY']

interface Mention {
  source: MentionSource
  excerpt: string | null
}

/** Every mention of one keyword, grouped by its strength. */
type Buckets = Record<MentionStrength, Mention[]>

/** The strongest bucket wins; its mentions supply the sources and the excerpt. */
function bestEvidence(keyword: string, buckets: Buckets): KeywordEvidence {
  const strength: MentionStrength =
    buckets.CORE.length > 0 ? 'CORE' : buckets.OPTIONAL.length > 0 ? 'OPTIONAL' : 'NEGATED'
  const winners = buckets[strength]
  return {
    keyword,
    strength,
    sources: SOURCE_ORDER.filter((source) => winners.some((m) => m.source === source)),
    excerpt: winners.find((m) => m.source === 'BODY')?.excerpt ?? null,
  }
}

interface PostingReading {
  evidence: Map<string, KeywordEvidence>
  tags: boolean
  requirements: boolean
  inputTruncated: boolean
}

/**
 * Tokenise the posting ONCE (title, each tag, the body) and read the strongest
 * mention of every keyword in `union`, after cutting it to the input bounds.
 */
function readPosting(posting: TechMatchPosting, union: readonly string[]): PostingReading {
  const surface: string[] = []
  const surfaceSource: MentionSource[] = []
  const addSurface = (tokens: readonly string[], source: MentionSource) => {
    for (const token of tokens) {
      surface.push(token)
      surfaceSource.push(source)
    }
    surface.push(SEGMENT_BREAK)
    surfaceSource.push(source)
  }

  // Title and tags are structured surfaces: always CORE, ambiguous aliases such as `go` count.
  addSurface(stackTokens(posting.title.slice(0, MAX_TITLE_CHARS)), 'TITLE')
  let tags = false
  for (const tag of posting.tags.slice(0, MAX_TAGS)) {
    const tagTokens = stackTokens(tag.slice(0, MAX_TAG_CHARS))
    tags = tags || tagTokens.length > 0
    addSurface(tagTokens, 'TAG')
  }
  const body = readBody(posting.body)

  const buckets = new Map<string, Buckets>()
  const record = (keyword: string, strength: MentionStrength, mention: Mention) => {
    let entry = buckets.get(keyword)
    if (entry === undefined) {
      entry = { CORE: [], OPTIONAL: [], NEGATED: [] }
      buckets.set(keyword, entry)
    }
    entry[strength].push(mention)
  }

  for (const [keyword, hit] of stackKeywordHits(union, surface, body.tokens)) {
    for (const index of hit.titleIndexes) {
      // `surfaceSource` has one entry per surface token, and the matcher only returns token indexes.
      record(keyword, 'CORE', { source: surfaceSource[index] as MentionSource, excerpt: null })
    }
    for (const index of hit.bodyIndexes) {
      // `owner` has one entry per body token, and the matcher only returns token indexes.
      const { clause, start } = body.owner[index] as BodyReading['owner'][number]
      const negated = isNegatedAt(clause.tokens, index - start)
      record(keyword, negated ? 'NEGATED' : clause.optional ? 'OPTIONAL' : 'CORE', {
        source: 'BODY',
        excerpt: clause.sentence.slice(0, MAX_EVIDENCE_EXCERPT_CHARS),
      })
    }
  }

  const evidence = new Map<string, KeywordEvidence>()
  for (const [keyword, entry] of buckets) evidence.set(keyword, bestEvidence(keyword, entry))
  return {
    evidence,
    tags,
    requirements: body.requirements,
    inputTruncated:
      body.truncated ||
      posting.title.length > MAX_TITLE_CHARS ||
      posting.tags.length > MAX_TAGS ||
      posting.tags.some((tag) => tag.length > MAX_TAG_CHARS),
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

interface Classified {
  matchable: { seniorId: string; keywords: string[] }[]
  audit: Omit<TechMatchAudit, 'ignoredExclusionIds'>
}

/** Steps 1 and 2 — exclusions, then access — before any posting text is read. */
function classify(input: TechMatchInput): Classified {
  const rosterSet = new Set(input.rosterSeniorIds)
  const globalKeyword = input.exclusions.filter((e) => e.scope === 'GLOBAL' && e.kind === 'KEYWORD')
  // The global verdict depends on the posting only, so it is decided once for the roster.
  const globalHit = findMatchingExclusion(input.posting, globalKeyword)
  const result: Classified = { matchable: [], audit: { excluded: [], noTeamAccess: [] } }
  for (const profile of input.profiles) {
    if (!rosterSet.has(profile.seniorId)) continue
    const own = input.exclusions.filter(
      (e) => e.scope === 'SENIOR' && e.seniorId === profile.seniorId,
    )
    const excluded = globalHit ?? findMatchingExclusion(input.posting, own)
    if (excluded) {
      result.audit.excluded.push({
        seniorId: profile.seniorId,
        exclusionId: excluded.id,
        exclusionKind: excluded.kind,
        exclusionScope: excluded.scope,
      })
    } else if (profile.teamIds.length === 0) {
      result.audit.noTeamAccess.push(profile.seniorId)
    } else {
      result.matchable.push({
        seniorId: profile.seniorId,
        keywords: canonicalStackKeywords(profile.techStack),
      })
    }
  }
  return result
}

function seniorMatch(
  seniorId: string,
  keywords: string[],
  evidence: ReadonlyMap<string, KeywordEvidence>,
  lowInformation: boolean,
): SeniorMatch {
  const found = keywords.flatMap((k) => evidence.get(k) ?? [])
  const matches = found.filter((e) => e.strength !== 'NEGATED')
  const coreMatchCount = matches.filter((e) => e.strength === 'CORE').length
  return {
    seniorId,
    keywords,
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

  const ignoredExclusionIds = input.exclusions
    .filter((e) => e.scope === 'GLOBAL' && e.kind === 'COMPANY')
    .flatMap((e) => (e.id === null ? [] : [e.id]))

  const { matchable, audit } = classify(input)

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
    seniors: matchable.map((m) =>
      seniorMatch(m.seniorId, m.keywords, reading.evidence, lowInformation),
    ),
    evidenceSurfaces: {
      tags: reading.tags,
      requirements: reading.requirements,
      keywordHit,
    },
    lowInformation,
    inputTruncated: reading.inputTruncated,
    audit: { ...audit, ignoredExclusionIds },
  }
}

/**
 * The result as a viewer may see it: only the given seniors, no `audit`, and
 * every aggregate recomputed from those seniors alone — so neither an excluded
 * senior, an exclusion, nor another senior's keywords can be read off it.
 */
export function forViewer(
  result: TechMatchReady,
  scope: { visibleSeniorIds: readonly string[] },
): TechMatchView {
  const visible = new Set(scope.visibleSeniorIds)
  const seniors = result.seniors.filter((s) => visible.has(s.seniorId))
  const narrow = (list: readonly RosterKeywordMatch[]): RosterKeywordMatch[] =>
    list
      .map((m) => ({ ...m, seniorIds: m.seniorIds.filter((id) => visible.has(id)) }))
      .filter((m) => m.seniorIds.length > 0)
  const rosterMatches = narrow(result.rosterMatches)
  const rosterNegated = narrow(result.rosterNegated)
  const { tags, requirements } = result.evidenceSurfaces
  const keywordHit = rosterMatches.length + rosterNegated.length > 0
  const lowInformation = seniors.length > 0 && !keywordHit && !tags && !requirements
  return {
    status: 'READY',
    matchableSeniorIds: seniors.map((s) => s.seniorId),
    rosterUnionSize: new Set(seniors.flatMap((s) => s.keywords)).size,
    rosterMatches,
    rosterNegated,
    seniors: seniors.map((s) => ({
      ...s,
      coreMismatch: s.profileKeywordCount > 0 && s.coreMatchCount === 0 && !lowInformation,
    })),
    evidenceSurfaces: { tags, requirements, keywordHit },
    lowInformation,
    inputTruncated: result.inputTruncated,
  }
}
