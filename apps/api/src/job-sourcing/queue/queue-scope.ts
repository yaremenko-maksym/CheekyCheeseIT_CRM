import { type SQL, sql } from 'drizzle-orm'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'

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
 * ids and is not used for scope).
 *
 * A SCOPE IS PER REQUEST AND MUST NEVER BE CACHED (SR-L-2): the actor's membership, the team's
 * liveness and the seniors' live versions are checked only in `JobQueueScopeService.resolve`.
 * Keeping a scope across requests (a session, a memo, a Redis entry) would keep serving a team
 * the actor has left and versions that have since gone stale.
 */
export type JobQueueScope =
  | { readonly kind: 'STUDIO' }
  | {
      readonly kind: 'TEAM'
      readonly teamId: string
      /** The team's active, non-archived SENIOR members at resolve time, sorted by id. */
      readonly seniorIds: readonly string[]
      /**
       * Each of those seniors' LIVE input versions (`rosterVersions`), sorted by senior id. A
       * match row grants visibility only when its stored versions equal these (SR-M-2).
       */
      readonly versions: readonly LiveSeniorVersion[]
    }
  | { readonly kind: 'NONE' }

export interface LiveSeniorVersion {
  readonly seniorId: string
  readonly profile: string
  readonly exclusion: string
}

export const STUDIO_SCOPE: JobQueueScope = { kind: 'STUDIO' }
export const NONE_SCOPE: JobQueueScope = { kind: 'NONE' }

/** The roles that may use the queue at all. Every other role is a 403, not an empty scope. */
export const JOB_QUEUE_ROLES = ['ADMIN', 'HR'] as const
export type JobQueueRole = (typeof JOB_QUEUE_ROLES)[number]

export function isJobQueueRole(role: string): role is JobQueueRole {
  return (JOB_QUEUE_ROLES as readonly string[]).includes(role)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The canonical (lowercase) form of a UUID, or `null` when it is not one. Checked BEFORE any
 * `::uuid` cast, so a malformed id is a plain miss (404 / NONE) rather than a Postgres 22P02 that
 * the fail-closed wrapper would turn into a 503.
 */
export function canonicalUuid(value: string): string | null {
  return UUID.test(value) ? value.toLowerCase() : null
}

/**
 * The team a TEAM-or-NONE scope resolves to. `allowedTeamIds` is what the actor may scope to, in
 * stable order and in the database's canonical lowercase form (an HR: their active teams; an
 * ADMIN: the one team they named, if it is live). No requested team = the first allowed one. A
 * requested team outside the allowed list is `null` (the NONE scope) — never a fallback to
 * another team, never an error that would confirm the team exists. The requested id is compared
 * case-insensitively, so an uppercase spelling of a valid UUID is the same team.
 */
export function selectScopeTeam(
  requestedTeamId: string | undefined,
  allowedTeamIds: readonly string[],
): string | null {
  const teamId = requestedTeamId?.toLowerCase() ?? allowedTeamIds[0]
  return allowedTeamIds.find((allowed) => allowed === teamId) ?? null
}

/** A team is a queue scope only while it is not archived and is a SENIOR team. */
const liveTeam = (alias: string, teamId: string) =>
  sql`EXISTS (SELECT 1 FROM teams ${sql.raw(alias)}
               WHERE ${sql.raw(alias)}.id = ${teamId}::uuid
                 AND ${sql.raw(alias)}.archived_at IS NULL
                 AND ${sql.raw(alias)}.type = 'SENIOR')`

/**
 * The SQL predicate "the opportunity whose id is `opportunityId` is visible in `scope`" — the one
 * place list, card and action reads take their visibility from (Task 6.2 / 6.3).
 *
 * TEAM — the team itself must be live (not archived, SENIOR-type), re-checked here in BOTH
 * branches, and then either:
 *   LEAD   a LEAD match at the opportunity's CURRENT revision, whose `senior_profile_version`,
 *          `exclusion_version` and `rule_version` equal the senior's LIVE versions (passed in from
 *          `resolve`; a senior with no live version row grants nothing), for a senior who is
 *          right now an active, non-archived SENIOR member of the team; or
 *   GRANT  an unrevoked, unexpired explicit triage grant for the team, on an opportunity that is
 *          not CLOSED / EXPIRED and was evaluated OPEN at its CURRENT revision (SR-M-2, owner
 *          decision 2026-11-04). `evaluated_revision` / `evaluation_verdict` are written by
 *          `installMatches` with the match rows, including when there are no rows, so a revision
 *          bump hides the item until its recompute, and NULL (never evaluated) hides it: this
 *          fails closed. The verdict is opportunity-level (`opportunityVerdict`): a per-senior
 *          stop-list is `SCOPED_RESTRICTIONS` and does not hide the opportunity from the team, owner
 *          A1g. The grant itself is revision-independent: the schema states no revision rule for it.
 *          KNOWN LIMITS (backlog entry on SR-M-2, residual window under owner decision): the verdict
 *          compares no input version, so it can outlive what it was computed from without a revision
 *          bump. A new studio-wide exclusion still shows a granted item until the queue drains (for
 *          good while the match reconciliation is off); a rule-version bump leaves a zero-row OPEN
 *          until the next revision or roster change; with an empty roster, an exclusion written
 *          outside the hooked services is not picked up by the sweep at all.
 * A TRIAGE / unknown-stack verdict alone grants nothing (data quality, not a grant).
 *
 * NOT IN THIS PREDICATE — standing triage subscriptions (`job_team_triage_subscriptions`). A
 * subscription is keyed on a role family, and `job_opportunities` stores none: layer 1 computes
 * `roleFamily` during evaluation and does not persist it. Follow-up: persist the layer-1 role
 * family on `job_opportunities` (the recompute install, r5 Task 4.6 store), then add the
 * subscription branch here with `employer_verified = true`, a matching role family / source type,
 * and an unrevoked, unexpired subscription (r5 Task 6.1 "carried from Task 1.2"). Until then a
 * subscription makes nothing visible.
 *
 * STUDIO: every opportunity (ADMIN studio triage). NONE: nothing.
 */
export function visibleOpportunityPredicate(scope: JobQueueScope, opportunityId: SQL): SQL {
  if (scope.kind === 'STUDIO') return sql`TRUE`
  if (scope.kind === 'NONE') return sql`FALSE`
  const versions = JSON.stringify(
    scope.versions.map((v) => ({
      senior_id: v.seniorId,
      profile: v.profile,
      exclusion: v.exclusion,
    })),
  )
  return sql`(EXISTS (SELECT 1 FROM job_opportunity_matches m
                        JOIN job_opportunities mo ON mo.id = m.opportunity_id
                        JOIN users u ON u.id = m.senior_id
                        JOIN team_members tm ON tm.user_id = u.id
                        JOIN jsonb_to_recordset(${versions}::jsonb)
                             AS v(senior_id uuid, profile text, exclusion text)
                          ON v.senior_id = m.senior_id
                       WHERE m.opportunity_id = ${opportunityId}
                         AND m.outcome = 'LEAD'
                         AND m.opportunity_revision = mo.revision
                         AND m.senior_profile_version = v.profile
                         AND m.exclusion_version = v.exclusion
                         AND m.rule_version = ${MATCH_RULE_VERSION}
                         AND u.role = 'SENIOR' AND u.archived_at IS NULL
                         AND tm.team_id = ${scope.teamId}::uuid AND tm.left_at IS NULL
                         AND ${liveTeam('lt', scope.teamId)})
           OR EXISTS (SELECT 1 FROM job_opportunity_team_triage g
                        JOIN job_opportunities gop ON gop.id = g.opportunity_id
                       WHERE g.opportunity_id = ${opportunityId}
                         AND g.team_id = ${scope.teamId}::uuid
                         AND g.revoked_at IS NULL
                         AND g.expires_at > clock_timestamp()
                         AND gop.availability NOT IN ('CLOSED', 'EXPIRED')
                         AND gop.evaluated_revision = gop.revision
                         AND gop.evaluation_verdict = 'OPEN'
                         AND ${liveTeam('gt', scope.teamId)}))`
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
