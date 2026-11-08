import { createHash } from 'node:crypto'
import type { JobQueueListQuery } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { MAX_SCORE, RANK_DEFAULTS } from '../funnel/rank'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import {
  type JobQueueScope,
  type LiveSeniorVersion,
  possibleDuplicateJoin,
  scopedTeamRowPredicate,
  visibleOpportunityPredicate,
} from './queue-scope'

/**
 * r5 Task 6.2 — the SQL fragments of the queue reads. Every fragment expects the opportunity under
 * the alias `o`. CARD-FIELD AUTHORIZATION LIVES HERE, apart from row visibility: a visible row does
 * not license every field, so each count below is computed only from what the viewer's scope owns.
 *
 *   match-derived fields  only through `liveVersionRows`, whose rows are the scope's OWN seniors
 *                         (a TEAM scope's `versions` hold that team's seniors and nobody else), so a
 *                         foreign senior's match cannot reach a count, a keyword or the rank;
 *   workflow fields       only through `scopedTeamRowPredicate` (own team; STUDIO spans teams).
 */
const versionRows = (versions: readonly LiveSeniorVersion[]): SQL => {
  const json = JSON.stringify(
    versions.map((v) => ({ senior_id: v.seniorId, profile: v.profile, exclusion: v.exclusion })),
  )
  return sql`jsonb_to_recordset(${json}::jsonb) AS v(senior_id uuid, profile text, exclusion text)`
}

/** A match row that still describes the live roster: the same four comparisons as visibility. */
const liveMatch = sql`m.opportunity_id = o.id
       AND m.opportunity_revision = o.revision
       AND m.senior_profile_version = v.profile
       AND m.exclusion_version = v.exclusion
       AND m.rule_version = ${MATCH_RULE_VERSION}`

/** The live match rows of the scope's own seniors, `FROM` clause and condition. */
export const liveVersionRows = (versions: readonly LiveSeniorVersion[]): SQL =>
  sql`FROM job_opportunity_matches m
       JOIN ${versionRows(versions)} ON v.senior_id = m.senior_id
      WHERE ${liveMatch}`

/**
 * The scope's integer rank: `evaluate` persists a score per senior only (the TEAM and STUDIO
 * projections are dropped by `matchRows`), so it is derived here as the best senior's score plus
 * the same match term `rankScore` uses for the seniors beyond the first. No LEAD ranks 0, after
 * every LEAD of comparable age. Only the scope's own seniors can move it. Clamped to the range
 * `rankScore` documents.
 */
export const rankSelect = (versions: readonly LiveSeniorVersion[]): SQL =>
  sql`SELECT LEAST((COALESCE(max((m.evidence->>'score')::int), 0)
              + ${RANK_DEFAULTS.matchWeight}::int
                * GREATEST(LEAST(count(*), ${RANK_DEFAULTS.matchCap}::int) - 1, 0))::int,
              ${MAX_SCORE}::int) AS score
       ${liveVersionRows(versions)} AND m.outcome = 'LEAD'`

/** The dismissal that hides a row in THIS scope: STUDIO's own, not any team's "not for us". */
const ownDismissal = (scope: JobQueueScope): SQL =>
  sql`EXISTS (SELECT 1 FROM job_queue_dismissals d
               WHERE d.opportunity_id = o.id AND d.undone_at IS NULL
                 AND d.scope_kind = ${scope.kind}::job_queue_scope_kind
                 AND ${scopedTeamRowPredicate(scope, sql`d.team_id`)})`

/**
 * The joins behind one queue row: `stats`, `sub`, `flags`, `src` and the derived `d`. `src` is a
 * LEFT lateral for one reason: a manual card (`o.manual_team_id`, r5 Phase 6) has no source record
 * and answers `primarySource: null`. `d` is joined on "has a source OR is manual", so a SOURCED
 * opportunity with no active source record is still not a row: it has nothing to link to.
 */
export const queueRowJoins = (
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
): SQL => sql`
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE m.outcome = 'LEAD') AS matched,
           count(*) FILTER (WHERE m.outcome = 'EXCLUDED'
                              AND m.evidence->>'stage' = 'SCOPED_RESTRICTIONS') AS stop_listed
    ${liveVersionRows(versions)}) stats
  CROSS JOIN LATERAL (
    SELECT count(*) AS submitted FROM job_queue_assignments a
     WHERE a.opportunity_id = o.id AND a.state = 'TAKEN'
       AND ${scopedTeamRowPredicate(scope, sql`a.team_id`)}) sub
  CROSS JOIN LATERAL (
    SELECT ${ownDismissal(scope)} AS hidden,
           EXISTS (SELECT 1 FROM job_queue_actions qa
                    WHERE qa.opportunity_id = o.id AND qa.kind = 'OPENED'
                      AND ${scopedTeamRowPredicate(scope, sql`qa.team_id`)}) AS opened) flags
  LEFT JOIN LATERAL (
    SELECT s.source_record_id, r.source_type, r.source_url,
           count(*) OVER () AS total
      FROM job_opportunity_sources s
      JOIN job_source_records r ON r.id = s.source_record_id
     WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL AND r.source_url IS NOT NULL
     ORDER BY s.linked_at, s.source_record_id
     LIMIT 1) src ON TRUE
  JOIN LATERAL (
    SELECT CASE WHEN flags.hidden THEN 'HIDDEN'
                WHEN sub.submitted > 0 THEN 'SUBMITTED'
                ELSE 'NEW' END AS tab,
           CASE WHEN stats.matched > 0 THEN 'LEAD' ELSE 'TRIAGE' END AS eligibility,
           CASE WHEN flags.opened THEN 'OPENED' ELSE 'NOT_OPENED' END AS activity) d
    ON (src.source_record_id IS NOT NULL OR o.manual_team_id IS NOT NULL)`

/** The columns of one queue row, for `queueRowJoins`. No description: lists never carry one. */
export const QUEUE_ROW_COLUMNS = sql`
  o.id, o.revision, o.title, o.employer_name, o.location, o.availability, o.published_at,
  o.first_seen_at, src.source_record_id, src.source_type, src.source_url, src.total AS source_total,
  o.application_url, stats.matched, stats.stop_listed, sub.submitted, flags.opened, flags.hidden, d.eligibility`

/** One opportunity's row, with the description and "changed since this scope's list was built". */
export const cardRow = (
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  id: string,
): SQL =>
  sql`SELECT ${QUEUE_ROW_COLUMNS}, b.text AS description,
             (listed.opportunity_revision IS NOT NULL
              AND listed.opportunity_revision < o.revision) AS newer_than_list
        FROM job_opportunities o
        ${queueRowJoins(scope, versions)}
        LEFT JOIN job_text_blobs b ON b.sha256 = o.description_sha256
        LEFT JOIN LATERAL (
          SELECT e.opportunity_revision
            FROM job_queue_generations g
            JOIN job_queue_generation_entries e ON e.generation_id = g.id
           WHERE e.opportunity_id = o.id AND g.status = 'PUBLISHED'
             AND g.scope_kind = ${scope.kind}::job_queue_scope_kind
             AND ${scopedTeamRowPredicate(scope, sql`g.team_id`)}) listed ON TRUE
       WHERE o.id = ${id}::uuid
         AND ${visibleOpportunityPredicate(scope, sql`o.id`)}`

/**
 * The scope's own seniors matched on the opportunity. EXCLUDED and no-match stay out alike, so who
 * stop-listed it cannot be derived from this list.
 */
const matchedSeniors = (versions: readonly LiveSeniorVersion[]): SQL =>
  sql`FROM job_opportunities o
       CROSS JOIN LATERAL (
         SELECT m.senior_id, m.evidence ${liveVersionRows(versions)}
            AND m.outcome IN ('LEAD', 'TRIAGE')) ms`

export const seniorTotal = (versions: readonly LiveSeniorVersion[], id: string): SQL =>
  sql`SELECT count(*) AS total ${matchedSeniors(versions)} WHERE o.id = ${id}::uuid`

/**
 * The card's seniors. The own-scope join selects a submission's columns only when the row is the
 * scope's, so a foreign row's id, timestamps, version and actor never leave the database; for a
 * shared senior a foreign LIVE row becomes one boolean. `IS NOT TRUE` because a row with no team
 * (an ADMIN's STUDIO submission) compares NULL against a team.
 */
export const seniorRows = (
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  id: string,
  after: string | undefined,
  limit: number,
): SQL =>
  sql`SELECT ms.senior_id, o.id AS opportunity_id, ms.evidence, u.display_name,
             a.id AS submission_id, a.state AS submission_state, a.taken_at, a.released_at,
             a.version AS submission_version, by_user.display_name AS submitted_by_name,
             EXISTS (SELECT 1 FROM job_queue_assignments f
                      WHERE f.opportunity_id = o.id AND f.senior_id = ms.senior_id
                        AND f.state = 'TAKEN'
                        AND (${scopedTeamRowPredicate(scope, sql`f.team_id`)}) IS NOT TRUE
                    ) AS submitted_elsewhere
       ${matchedSeniors(versions)}
        JOIN users u ON u.id = ms.senior_id
        LEFT JOIN job_queue_assignments a
          ON a.opportunity_id = o.id AND a.senior_id = ms.senior_id
         AND ${scopedTeamRowPredicate(scope, sql`a.team_id`)}
        LEFT JOIN users by_user ON by_user.id = a.assignee_id
       WHERE o.id = ${id}::uuid
         AND ${after === undefined ? sql`TRUE` : sql`ms.senior_id > ${after}::uuid`}
       ORDER BY ms.senior_id
       LIMIT ${limit}`

const activeSources = (id: string): SQL =>
  sql`FROM job_opportunity_sources s
       JOIN job_source_records r ON r.id = s.source_record_id
      WHERE s.opportunity_id = ${id}::uuid AND s.unlinked_at IS NULL AND r.source_url IS NOT NULL`

export const sourceTotal = (id: string): SQL => sql`SELECT count(*) AS total ${activeSources(id)}`

/** Keyed on the record id, not `linked_at`: a JS Date cursor would lose the microseconds. */
export const sourceRows = (id: string, after: string | undefined, limit: number): SQL =>
  sql`SELECT s.source_record_id, r.source_type, r.source_url, s.linked_at
       ${activeSources(id)}
         AND ${after === undefined ? sql`TRUE` : sql`s.source_record_id > ${after}::uuid`}
       ORDER BY s.source_record_id
       LIMIT ${limit}`

/**
 * The possible-duplicate set (`possibleDuplicateJoin`, the one definition Task 6.3 shares), minus the
 * opportunity itself. `total` counts visible ones only.
 */
export const duplicateRows = (scope: JobQueueScope, id: string, limit: number): SQL =>
  sql`SELECT dup.id, dup.title, dup.employer_name, count(*) OVER () AS total
        FROM job_opportunities o
        JOIN job_opportunities dup ON ${possibleDuplicateJoin('o', 'dup')} AND dup.id <> o.id
       WHERE o.id = ${id}::uuid
         AND ${visibleOpportunityPredicate(scope, sql`dup.id`)}
       ORDER BY dup.id
       LIMIT ${limit}`

const textIn = (expression: SQL, values: readonly string[]): SQL =>
  sql`${expression} IN (SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

/**
 * `column IN (the ids)` with the ids as ONE bound jsonb parameter, cast to uuid on the parameter
 * side so the column's own uuid index serves the lookup. Every caller passes canonical uuids: the
 * shared list schema validates `seniorIds`, and the scope's senior ids are read from `users.id`.
 */
const uuidIn = (column: SQL, ids: readonly string[]): SQL =>
  sql`${column} IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)`

/**
 * The list filter's picker: id, display name and one team name, of seniors the scope already
 * resolved. A TEAM scope names its own team; STUDIO names the senior's first live membership,
 * preferring a live SENIOR team, alphabetically. Ordered by team, then name, for the grouping.
 */
export const seniorOptionRows = (
  seniorIds: readonly string[],
  teamId: string | null,
  limit: number,
): SQL =>
  sql`SELECT u.id, u.display_name, t.name AS team_name
        FROM users u
        JOIN LATERAL (
          SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = u.id AND tm.left_at IS NULL
                 ${teamId === null ? sql`` : sql`AND tm.team_id = ${teamId}::uuid`}
           ORDER BY t.archived_at IS NOT NULL, t.type <> 'SENIOR', t.name, t.id
           LIMIT 1) t ON TRUE
       WHERE ${uuidIn(sql`u.id`, seniorIds)}
       ORDER BY t.name, u.display_name, u.id
       LIMIT ${limit}`

/** `%`, `_` and `\` from a viewer's search are literal characters, not patterns. */
export const likePattern = (search: string): string =>
  `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The list's WHERE conditions beyond visibility: the tab and the filters, each a predicate over the
 * retained entries of the generation (no per-filter generation). Availability and eligibility read
 * the current row; `seniorIds` is an OR, and joining `versions` drops an id outside the scope.
 * Filtering by a senior hides their stop-listed opportunities, as the owner decided (r5 §4): an
 * EXCLUDED row is no match.
 */
export function listFilters(
  query: JobQueueListQuery,
  versions: readonly LiveSeniorVersion[],
): SQL[] {
  const filters: SQL[] = [sql`d.tab = ${query.tab}`]
  if (query.search !== undefined) {
    const pattern = likePattern(query.search)
    filters.push(sql`(o.title ILIKE ${pattern} OR o.employer_name ILIKE ${pattern})`)
  }
  if (query.source !== undefined) {
    filters.push(sql`EXISTS (SELECT 1 FROM job_opportunity_sources fs
                               JOIN job_source_records fr ON fr.id = fs.source_record_id
                              WHERE fs.opportunity_id = o.id AND fs.unlinked_at IS NULL
                                AND fr.source_url IS NOT NULL
                                AND ${textIn(sql`fr.source_type::text`, query.source)})`)
  }
  if (query.eligibility !== undefined) filters.push(textIn(sql`d.eligibility`, query.eligibility))
  if (query.availability !== undefined) {
    filters.push(textIn(sql`o.availability::text`, query.availability))
  }
  if (query.activity !== undefined) filters.push(textIn(sql`d.activity`, query.activity))
  if (query.seniorIds !== undefined) {
    filters.push(sql`EXISTS (SELECT 1 ${liveVersionRows(versions)}
                               AND ${uuidIn(sql`m.senior_id`, query.seniorIds)}
                               AND m.outcome IN ('LEAD', 'TRIAGE'))`)
  }
  return filters
}

/** The filter part of a cursor's signature: list order must not matter (the schema fixes spelling). */
export const filterIdentity = (query: JobQueueListQuery): readonly unknown[] => [
  query.tab,
  query.search ?? null,
  [...(query.source ?? [])].sort(),
  [...(query.eligibility ?? [])].sort(),
  [...(query.availability ?? [])].sort(),
  [...(query.activity ?? [])].sort(),
  [...(query.seniorIds ?? [])].sort(),
]

/**
 * The digest of a scope's policy inputs (stored on the generation, part of every cursor signature):
 * any change to the team, the rule version or a senior's live versions makes the generation and its
 * cursors stale. `versions` come sorted by senior id, from `loadRoster`.
 */
export function policySignature(
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
): string {
  // Stryker disable next-line ConditionalExpression: equivalent — without a teamId the value is undefined, which JSON.stringify writes as null in an array, the same text as the other branch
  const team = scope.kind === 'TEAM' ? scope.teamId : null
  return createHash('sha256')
    .update(JSON.stringify([scope.kind, team, MATCH_RULE_VERSION, versions]))
    .digest('hex')
}
