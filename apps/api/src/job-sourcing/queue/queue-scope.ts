import { type SQL, sql } from 'drizzle-orm'

/**
 * r5 Task 6.1 — queue visibility: WHO may see WHICH part of the `/job-queue`.
 *
 * Owner decisions (2026-10-18): submissions are per senior, teams are invisible to each other,
 * there is no global "taken" state. So a viewer always works inside exactly ONE scope:
 *
 *   STUDIO  an ADMIN without a `teamId` — the whole studio, triage included;
 *   TEAM    one team: an HR who is a CURRENT active member of it, or an ADMIN who named it;
 *   NONE    everything else that is allowed to ask (an HR with no active team, or one naming a
 *           team they do not belong to). NONE is indistinguishable from an empty queue: empty
 *           lists and counts, the same `JOB_OPPORTUNITY_NOT_FOUND` 404 on a detail or action.
 *
 * Every scope is resolved per request from the live roster (C-09: the team query lives in
 * job-sourcing, never imported from finance; `getActiveTeamPeers` is a merged union without team
 * ids and is not used for scope). A cached projection never replaces this check.
 */
export type JobQueueScope =
  | { readonly kind: 'STUDIO' }
  | {
      readonly kind: 'TEAM'
      readonly teamId: string
      /** The team's active, non-archived SENIOR members at resolve time, sorted by id. */
      readonly seniorIds: readonly string[]
    }
  | { readonly kind: 'NONE' }

export const STUDIO_SCOPE: JobQueueScope = { kind: 'STUDIO' }
export const NONE_SCOPE: JobQueueScope = { kind: 'NONE' }

/** The roles that may use the queue at all. Every other role is a 403, not an empty scope. */
export const JOB_QUEUE_ROLES = ['ADMIN', 'HR'] as const
export type JobQueueRole = (typeof JOB_QUEUE_ROLES)[number]

export function isJobQueueRole(role: string): role is JobQueueRole {
  return (JOB_QUEUE_ROLES as readonly string[]).includes(role)
}

/**
 * The team a TEAM-or-NONE scope resolves to. `allowedTeamIds` is what the actor may scope to, in
 * stable order (an HR: their active teams; an ADMIN: the one team they named, if it is live).
 * No requested team = the first allowed one. A requested team outside the allowed list is
 * `null` (the NONE scope) — never a fallback to another team, never an error that would confirm
 * the team exists.
 */
export function selectScopeTeam(
  requestedTeamId: string | undefined,
  allowedTeamIds: readonly string[],
): string | null {
  const teamId = requestedTeamId ?? allowedTeamIds[0]
  return allowedTeamIds.find((allowed) => allowed === teamId) ?? null
}

/**
 * The SQL predicate "the opportunity whose id is `opportunityId` is visible in `scope`" — the one
 * place list, card and action reads take their visibility from (Task 6.2 / 6.3).
 *
 * TEAM: a LEAD match, at the opportunity's CURRENT revision, for a senior who is RIGHT NOW an
 * active, non-archived SENIOR member of the team (re-evaluated inside the query, not taken from
 * `scope.seniorIds`); OR an unrevoked, unexpired explicit triage grant for the team. A TRIAGE /
 * unknown-stack verdict alone grants nothing (data quality, not a grant); EXCLUDED never shows.
 * STUDIO: every opportunity (ADMIN studio triage). NONE: nothing.
 */
export function visibleOpportunityPredicate(scope: JobQueueScope, opportunityId: SQL): SQL {
  if (scope.kind === 'STUDIO') return sql`TRUE`
  if (scope.kind === 'NONE') return sql`FALSE`
  return sql`(EXISTS (SELECT 1 FROM job_opportunity_matches m
                        JOIN job_opportunities mo ON mo.id = m.opportunity_id
                        JOIN users u ON u.id = m.senior_id
                        JOIN team_members tm ON tm.user_id = u.id
                       WHERE m.opportunity_id = ${opportunityId}
                         AND m.outcome = 'LEAD'
                         AND m.opportunity_revision = mo.revision
                         AND u.role = 'SENIOR' AND u.archived_at IS NULL
                         AND tm.team_id = ${scope.teamId}::uuid AND tm.left_at IS NULL)
           OR EXISTS (SELECT 1 FROM job_opportunity_team_triage g
                       WHERE g.opportunity_id = ${opportunityId}
                         AND g.team_id = ${scope.teamId}::uuid
                         AND g.revoked_at IS NULL
                         AND g.expires_at > clock_timestamp()))`
}

/**
 * The SQL predicate for a TEAM-carrying row of the queue store (assignments, dismissals,
 * actions, generations): an HR reads only their team's rows, an ADMIN in STUDIO may span teams,
 * an ADMIN who named a team reads that team's, NONE reads nothing. Pass the row's `team_id` (or
 * `subject_team_id`) column expression.
 */
export function scopedTeamRowPredicate(scope: JobQueueScope, teamIdColumn: SQL): SQL {
  if (scope.kind === 'STUDIO') return sql`TRUE`
  if (scope.kind === 'NONE') return sql`FALSE`
  return sql`${teamIdColumn} = ${scope.teamId}::uuid`
}

export interface GenerationHead {
  readonly scopeKind: 'TEAM' | 'STUDIO'
  readonly teamId: string | null
  readonly status: 'BUILDING' | 'PUBLISHED' | 'INVALIDATED'
  readonly expiresAt: Date
}

/**
 * May this published generation be served to this scope? A STUDIO generation only to the STUDIO
 * scope (an ADMIN), a TEAM generation only to that same team's scope; only PUBLISHED; and an
 * expired one (`expires_at <= now`) never — even while it is still its scope's published row
 * (SR-L-3), the caller answers refresh-required.
 */
export function isGenerationServable(
  scope: JobQueueScope,
  generation: GenerationHead,
  now: Date,
): boolean {
  if (generation.status !== 'PUBLISHED') return false
  if (generation.expiresAt.getTime() <= now.getTime()) return false
  if (scope.kind === 'STUDIO') return generation.scopeKind === 'STUDIO'
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — a NONE scope has no teamId, so the TEAM comparison below is already false for it; the line narrows the type and states the rule
  if (scope.kind === 'NONE') return false
  return generation.scopeKind === 'TEAM' && generation.teamId === scope.teamId
}
