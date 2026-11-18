import type {
  JobExclusionDto,
  SeniorSelectableRole,
  SkillOverlap,
  TechnicalRole,
} from '@crm/shared'
import { rolesMatch, skillOverlap, vacancyTechnologies } from '@crm/shared'
import { findMatchingExclusion, type FilterablePosting } from '../filtering'

/**
 * Funnel Layer 2 — the per-senior role match and the display-only skills overlap (senior roles
 * PR 4; it replaced the `tech ∩ users.tech_stack` keyword match).
 *
 * PURE: no network, no database, no model, no clock. The caller supplies the roster, the
 * exclusions, one posting and the posting's stored technical roles; the result is a function of them.
 *
 * ORDER OF EVALUATION (A1g): exclusions first, then access, then matching. A profile that is
 * excluded or has no team access never reaches the role match or the overlap, so it cannot add a
 * count, a rank input or an explanation line.
 *
 * MATCH. A senior matches when `rolesMatch` (own roles plus one hop of the spec's widening matrix)
 * covers at least one vacancy role. The skills overlap ("k of n skills") is display-only: nothing
 * here or in rank reads it, and it uses THAT senior's resume skills only.
 *
 * WHO MAY SEE WHAT. The per-senior list holds matchable seniors only. Who was excluded, by which
 * exclusion, who lacks team access and which exclusions were ignored live under `audit`, which a
 * viewer-facing caller must never pass on: `forViewer` returns the shape without it, for the given
 * seniors only.
 */

export interface SeniorTechProfile {
  seniorId: string
  /** Teams the senior is an ACTIVE member of (`findEligibleSeniorIds` joins on `left_at IS NULL`). */
  teamIds: readonly string[]
  roles: readonly SeniorSelectableRole[]
  /** Canonical resume skills; `null` = no resume (or a resume with no skills). */
  skills: readonly string[] | null
}

export interface TechMatchPosting extends FilterablePosting {
  body: string | null
  /** The vacancy's stored technical roles (`job_opportunities.technical_roles`). */
  roles: readonly TechnicalRole[]
}

export interface TechMatchInput {
  posting: TechMatchPosting
  /** Eligible SENIOR ids from the caller's roster query: every one must have a profile. */
  rosterSeniorIds: readonly string[]
  profiles: readonly SeniorTechProfile[]
  exclusions: readonly JobExclusionDto[]
}

/** One vacancy role a senior covers; `widened` = reached through the widening matrix, not owned. */
export interface RoleMatch {
  role: TechnicalRole
  widened: boolean
}

export interface SeniorMatch {
  seniorId: string
  /** The vacancy roles this senior covers, in vacancy order. Empty = a role mismatch. */
  matchedRoles: RoleMatch[]
  /** `null`: the vacancy names no technology; `NO_RESUME`: the senior has no resume skills. */
  skillOverlap: SkillOverlap | 'NO_RESUME' | null
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
  seniors: SeniorMatch[]
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
  matchable: SeniorTechProfile[]
  audit: Omit<TechMatchAudit, 'ignoredExclusionIds'>
}

/** Steps 1 and 2 — exclusions, then access — before any role or skill is read. */
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
      result.matchable.push(profile)
    }
  }
  return result
}

export function matchTech(input: TechMatchInput): TechMatchResult {
  // Readiness: a roster senior without a profile must not read as "no match".
  const issues = readinessIssues(input.rosterSeniorIds, input.profiles)
  if (issues.length > 0) return { status: 'READINESS_ISSUE', issues }

  const ignoredExclusionIds = input.exclusions
    .filter((e) => e.scope === 'GLOBAL' && e.kind === 'COMPANY')
    .flatMap((e) => (e.id === null ? [] : [e.id]))

  const { matchable, audit } = classify(input)
  // Stryker disable next-line StringLiteral: equivalent, a missing body adds no technologies either way — no replacement string is a catalog technology or alias
  const technologies = vacancyTechnologies(`${input.posting.title}\n${input.posting.body ?? ''}`)

  return {
    status: 'READY',
    matchableSeniorIds: matchable.map((m) => m.seniorId),
    seniors: matchable.map((m) => {
      const own = new Set<TechnicalRole>(m.roles)
      return {
        seniorId: m.seniorId,
        matchedRoles: rolesMatch(m.roles, input.posting.roles).matched.map((role) => ({
          role,
          widened: !own.has(role),
        })),
        skillOverlap: skillOverlap(technologies, m.skills),
      }
    }),
    audit: { ...audit, ignoredExclusionIds },
  }
}

/**
 * The result as a viewer may see it: only the given seniors and no `audit`, so neither an
 * excluded senior, an exclusion, nor another senior's roles or skills can be read off it.
 */
export function forViewer(
  result: TechMatchReady,
  scope: { visibleSeniorIds: readonly string[] },
): TechMatchView {
  const visible = new Set(scope.visibleSeniorIds)
  const seniors = result.seniors.filter((s) => visible.has(s.seniorId))
  return { status: 'READY', matchableSeniorIds: seniors.map((s) => s.seniorId), seniors }
}
