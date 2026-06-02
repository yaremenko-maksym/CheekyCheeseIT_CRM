import type { SeniorSharePercentSource } from '@crm/shared'

/**
 * Resolved senior share % with its provenance.
 *
 * `source` records *where* the percent came from at resolution time so the
 * UI can render a "Источник: проект/команда/default" badge on each
 * transaction snapshot. The pair is written verbatim into
 * `transactions.senior_share_percent` + `transactions.senior_share_percent_source`
 * at create time and is never recomputed on read.
 */
export type ResolvedSeniorShare = {
  value: number
  source: SeniorSharePercentSource
}

/**
 * Minimal project-shaped input the resolver needs. Only the override field
 * is consulted; `seniorId` is the project's primary subject used to query
 * the senior's teams (caller pre-fetches the team rows below).
 */
export type ResolverProject = {
  seniorSharePercentOverride: number | null | undefined
}

/**
 * Senior-shaped input the resolver consults when no override applies.
 * `seniorSharePercent` is the user-level default (non-null in DB by virtue
 * of a NOT NULL + DEFAULT 26 column; falls back to 26 here defensively).
 */
export type ResolverSenior = {
  seniorSharePercent: number | null | undefined
}

/**
 * Pre-fetched team rows that *might* carry an override for the senior at
 * resolution time. The resolver applies a team override only when:
 *   - exactly ONE active SENIOR-team membership of the project's senior
 *     carries a non-null override, OR
 *   - the team passed in is a drop-team override (drop-project route).
 *
 * If the senior is a member of multiple teams that each define an override
 * the resolver intentionally falls through to the user default — a deliberate
 * "ambiguous configuration → safe default" behavior. The caller is
 * responsible for the membership lookup (it cuts a DB round-trip when the
 * resolver is invoked outside a request flow).
 */
export type ResolverTeam = {
  seniorSharePercentOverride: number | null | undefined
}

/**
 * Resolve the senior share % with source provenance.
 *
 * Hierarchy (highest priority first):
 *   1. `project.seniorSharePercentOverride` (NULL skips → step 2)
 *   2. `team.seniorSharePercentOverride` where `team` is the *single*
 *      applicable team (NULL skips → step 3). When two or more teams in
 *      `teams[]` carry a non-null override, the resolver treats the
 *      situation as ambiguous and skips to step 3.
 *   3. `senior.seniorSharePercent` (falls back to 26 when null).
 *
 * The output is intentionally pure — no DB writes, no `await`. The resolver
 * is invoked once per income (createSeniorIncome / createDropIncome) and
 * its result is written into the transaction snapshot.
 *
 * @param project — minimum project shape (override-bearing column only).
 * @param senior — minimum senior shape (default-bearing column only).
 * @param teams  — zero or more team rows whose override *might* apply. The
 *                caller filters this to active senior-team / drop-team
 *                memberships of the relevant principal.
 */
export function resolveSeniorShare(
  project: ResolverProject,
  senior: ResolverSenior,
  teams: ResolverTeam[] = [],
): ResolvedSeniorShare {
  // 1) Project-level override wins.
  if (
    project.seniorSharePercentOverride !== null &&
    project.seniorSharePercentOverride !== undefined
  ) {
    return { value: project.seniorSharePercentOverride, source: 'PROJECT' }
  }

  // 2) Team-level override applies only when *exactly one* applicable team
  // carries an override. Multiple overrides → ambiguous → fall through.
  const overrideTeams = teams.filter(
    (t) => t.seniorSharePercentOverride !== null && t.seniorSharePercentOverride !== undefined,
  )
  if (overrideTeams.length === 1) {
    return {
      value: overrideTeams[0]!.seniorSharePercentOverride as number,
      source: 'TEAM',
    }
  }

  // 3) Fall back to the user-level default (or 26 if somehow null).
  return {
    value: senior.seniorSharePercent ?? 26,
    source: 'USER_DEFAULT',
  }
}
