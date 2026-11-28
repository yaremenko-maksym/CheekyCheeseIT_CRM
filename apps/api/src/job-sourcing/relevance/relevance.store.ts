import { createHash } from 'node:crypto'
import type { TechnicalRole } from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { MeterDb } from '../metering/account-meter.store'
import { enqueueDirty } from '../ownership/dirty-work.store'
import { MATCH_RULE_VERSION, type SeniorVersions } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import { setLockTimeout, withLockRetry } from '../store/lock-order'
import { textArray } from '../store/opportunity-roles'
import { STORE_LOCK_TIMEOUT_MS } from '../store/source-record.store'
import { RELEVANCE_GRADER_VERSION } from './jev-relevance-grader'
import {
  RELEVANCE_BACKOFF,
  RELEVANCE_BACKOFF_BASE_MS,
  RELEVANCE_BACKOFF_CAP_MS,
  RELEVANCE_MAX_ATTEMPTS,
  type RelevanceCandidate,
  type RelevanceStore,
} from './relevance-pass'

const READ_COMMITTED = { isolationLevel: 'read committed' } as const
const V = RELEVANCE_GRADER_VERSION

type OpportunityKey = Pick<RelevanceCandidate, 'titleKey' | 'descriptionSha256'> & {
  roles: readonly string[]
}

/** GRADED rows of one opportunity at the current grader version and vacancy key. */
const gradedAtVacancyKey = (opportunityId: string, key: OpportunityKey) =>
  sql`opportunity_id = ${opportunityId}::uuid AND status = 'GRADED'
                 AND grader_version = ${V} AND title_key = ${key.titleKey}
                 AND description_sha256 IS NOT DISTINCT FROM ${key.descriptionSha256}
                 AND opportunity_roles = ${textArray(key.roles)}`

/**
 * The dirty reason of a grade landing: a digest of the opportunity's whole current-key graded set
 * (the vacancy key, and per senior its profile version and fit), order-insensitive. The dirty
 * queue dedupes (kind, entity, version, reason) across completed rows too, so a second grading at
 * one revision (a new senior, a re-grade after a profile or roles change) must give a new reason,
 * or its recompute is swallowed. `gradedAt` (the set's latest `updated_at`) tells an A -> B -> A
 * re-grade from the first A, whose dirty row may be completed already (SO-6). It never starts with
 * `AVAILABILITY:`, so the match worker claims it.
 */
export function relevanceReason(
  key: OpportunityKey,
  graded: readonly { seniorId: string; profileVersion: string; fit: number }[],
  gradedAt: string,
): string {
  const set = graded.map((g) => `${g.seniorId}:${g.profileVersion}:${g.fit}`).sort()
  const digest = createHash('sha256')
    .update(JSON.stringify([key.titleKey, key.descriptionSha256, key.roles, set, gradedAt]))
    .digest('hex')
    .slice(0, 16)
  return `RELEVANCE:${V}:${digest}`
}

function inTx<T>(db: MeterDb, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      await setLockTimeout(tx, STORE_LOCK_TIMEOUT_MS)
      return work(tx)
    }, READ_COMMITTED),
  )
}

/**
 * The candidate's opportunity still as selected: same title, description and roles, still open
 * and not manual. Locked like the recompute worker locks it (NO KEY UPDATE), so a grade write and
 * a recompute serialise. The revision, or null when it moved.
 */
async function lockUnchanged(tx: SqlExecutor, c: RelevanceCandidate): Promise<number | null> {
  const { rows } = await tx.execute(
    sql`SELECT o.revision FROM job_opportunities o
         WHERE o.id = ${c.id}::uuid AND o.title_key = ${c.titleKey}
           AND o.description_sha256 IS NOT DISTINCT FROM ${c.descriptionSha256}
           AND o.technical_roles = ${textArray(c.roles)}
           AND o.availability IN ('OPEN', 'UNKNOWN') AND o.manual_team_id IS NULL
           FOR NO KEY UPDATE OF o`,
  )
  const row = rows[0]
  return row === undefined ? null : Number(row['revision'])
}

/** The key columns of a row written for `c` (the roles as the lock re-checked them). */
const keyValues = (c: RelevanceCandidate) =>
  sql`${V}, ${c.titleKey}, ${c.descriptionSha256}, ${textArray(c.roles)}`

// The increment is the row's own, so two writers of one key never lose one. A failure never
// overwrites a GRADED row of the same key: that grade is current.
// Stryker disable next-line StringLiteral: a raw SQL fragment; only Postgres tells it apart (relevance-pass.integration.spec: backoff + never overwrites GRADED)
const sameKey = sql`job_opportunity_relevance.grader_version = EXCLUDED.grader_version
       AND job_opportunity_relevance.title_key = EXCLUDED.title_key
       AND job_opportunity_relevance.description_sha256
           IS NOT DISTINCT FROM EXCLUDED.description_sha256
       AND job_opportunity_relevance.opportunity_roles = EXCLUDED.opportunity_roles
       AND job_opportunity_relevance.senior_profile_version = EXCLUDED.senior_profile_version`
// Stryker disable next-line StringLiteral: a raw SQL fragment (relevance-pass.integration.spec: attempts counted)
const nextAttempts = sql`CASE WHEN ${sameKey} THEN job_opportunity_relevance.attempts + 1 ELSE 1 END`

/**
 * The pass's SQL. A candidate is a LEAD opportunity at the live rule version and its current,
 * evaluated revision, open and not a manual card (HR-entered text is never sent to a model); a pair
 * is pending when no GRADED row holds its current key, and is skipped while a FAILED row of that
 * key backs off or has spent its attempts.
 */
export function createRelevanceStore(db: MeterDb): RelevanceStore {
  return {
    async candidates(now, limit) {
      const { rows } = await db.execute(
        sql`SELECT o.id, o.title, o.title_key, o.description_sha256, o.stack_keywords,
                   o.technical_roles,
                   COALESCE((SELECT b.text FROM job_text_blobs b
                              WHERE b.sha256 = o.description_sha256), '') AS description,
                   jsonb_agg(jsonb_build_object('seniorId', m.senior_id::text,
                                                'profileVersion', m.senior_profile_version)
                             ORDER BY m.senior_id) AS pairs
              FROM job_opportunities o
              JOIN job_opportunity_matches m
                ON m.opportunity_id = o.id AND m.outcome = 'LEAD'
               AND m.rule_version = ${MATCH_RULE_VERSION} AND m.opportunity_revision = o.revision
             WHERE o.evaluated_revision = o.revision
               AND o.availability IN ('OPEN', 'UNKNOWN') AND o.manual_team_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM job_opportunity_relevance r
                  WHERE r.opportunity_id = o.id AND r.senior_id = m.senior_id
                    AND r.grader_version = ${V} AND r.title_key = o.title_key
                    AND r.description_sha256 IS NOT DISTINCT FROM o.description_sha256
                    AND r.opportunity_roles = o.technical_roles
                    AND r.senior_profile_version = m.senior_profile_version
                    AND (r.status = 'GRADED'
                         OR r.next_attempt_at > ${now.toISOString()}::timestamptz
                         OR r.attempts >= ${RELEVANCE_MAX_ATTEMPTS}))
             GROUP BY o.id
             ORDER BY o.last_observed_at DESC, o.id
             LIMIT ${limit}`,
      )
      return rows.map((r) => ({
        id: String(r['id']),
        title: String(r['title']),
        titleKey: String(r['title_key']),
        descriptionSha256: (r['description_sha256'] as string | null) ?? null,
        description: String(r['description']),
        categories: r['stack_keywords'] as string[],
        roles: r['technical_roles'] as TechnicalRole[],
        pairs: r['pairs'] as { seniorId: string; profileVersion: string }[],
      }))
    },

    applyGrades(c, grades) {
      return inTx(db, async (tx) => {
        const revision = await lockUnchanged(tx, c)
        if (revision === null) return false
        // One multi-row upsert under the lock (CR-M-3).
        const values = sql.join(
          grades.map(
            (g) => sql`(${c.id}::uuid, ${g.seniorId}::uuid, ${keyValues(c)}, ${g.profileVersion},
                        'GRADED', ${g.fit}, 0, NULL, clock_timestamp())`,
          ),
          sql`, `,
        )
        await tx.execute(
          sql`INSERT INTO job_opportunity_relevance
                (opportunity_id, senior_id, grader_version, title_key, description_sha256,
                 opportunity_roles, senior_profile_version, status, fit, attempts,
                 next_attempt_at, updated_at)
              VALUES ${values}
              ON CONFLICT (opportunity_id, senior_id) DO UPDATE
                 SET grader_version = EXCLUDED.grader_version, title_key = EXCLUDED.title_key,
                     description_sha256 = EXCLUDED.description_sha256,
                     opportunity_roles = EXCLUDED.opportunity_roles,
                     senior_profile_version = EXCLUDED.senior_profile_version,
                     status = 'GRADED', fit = EXCLUDED.fit, attempts = 0,
                     next_attempt_at = NULL, updated_at = clock_timestamp()`,
        )
        const { rows } = await tx.execute(
          sql`SELECT senior_id::text AS senior_id, senior_profile_version, fit,
                     to_char(max(updated_at) OVER () AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS graded_at
                FROM job_opportunity_relevance
               WHERE ${gradedAtVacancyKey(c.id, c)}`,
        )
        const graded = rows.map((r) => ({
          seniorId: String(r['senior_id']),
          profileVersion: String(r['senior_profile_version']),
          fit: Number(r['fit']),
        }))
        // The upsert above wrote at least one current-key row, so the set is never empty.
        // Stryker disable next-line OptionalChaining: equivalent; rows[0] always exists after the upsert, `?.` only satisfies noUncheckedIndexedAccess
        const gradedAt = String(rows[0]?.['graded_at'])
        await enqueueDirty(tx, 'OPPORTUNITY', c.id, revision, relevanceReason(c, graded, gradedAt))
        return true
      })
    },

    recordFailures(c, pairs, now) {
      if (pairs.length === 0) return Promise.resolve(0)
      return inTx(db, async (tx) => {
        if ((await lockUnchanged(tx, c)) === null) return 0
        const first = new Date(now.getTime() + RELEVANCE_BACKOFF(0)).toISOString()
        const values = sql.join(
          pairs.map(
            (x) => sql`(${c.id}::uuid, ${x.seniorId}::uuid, ${keyValues(c)}, ${x.profileVersion},
                        'FAILED', NULL, 1, ${first}::timestamptz, clock_timestamp())`,
          ),
          sql`, `,
        )
        // One multi-row upsert (CR-M-3). SET reads the OLD row, so the backoff repeats the new
        // attempts expression: RELEVANCE_BACKOFF(attempts - 1) from now.
        const { rows } = await tx.execute(
          sql`INSERT INTO job_opportunity_relevance
                (opportunity_id, senior_id, grader_version, title_key, description_sha256,
                 opportunity_roles, senior_profile_version, status, fit, attempts,
                 next_attempt_at, updated_at)
              VALUES ${values}
              ON CONFLICT (opportunity_id, senior_id) DO UPDATE
                 SET attempts = ${nextAttempts},
                     next_attempt_at = ${now.toISOString()}::timestamptz
                       + LEAST(${RELEVANCE_BACKOFF_BASE_MS}::float8 * power(2, ${nextAttempts} - 1),
                               ${RELEVANCE_BACKOFF_CAP_MS}::float8) * interval '1 millisecond',
                     grader_version = EXCLUDED.grader_version, title_key = EXCLUDED.title_key,
                     description_sha256 = EXCLUDED.description_sha256,
                     opportunity_roles = EXCLUDED.opportunity_roles,
                     senior_profile_version = EXCLUDED.senior_profile_version,
                     status = 'FAILED', fit = NULL, updated_at = clock_timestamp()
               WHERE job_opportunity_relevance.status = 'FAILED' OR NOT (${sameKey})
              RETURNING 1`,
        )
        return rows.length
      })
    },
  }
}

/**
 * The current-key Jev fits of one opportunity for recompute (eval.3): seniorId -> fit in [0,1].
 * Current = GRADED at `RELEVANCE_GRADER_VERSION` with the live vacancy key (from the locked row
 * and its gated roles) AND the senior's live profile version. A stale-key row is left out, so the
 * senior ranks at the neutral fit and shows no percent until the pass grades the pair again.
 */
export async function loadRelevanceFits(
  tx: SqlExecutor,
  opportunityId: string,
  key: { titleKey: string; descriptionSha256: string | null; roles: readonly TechnicalRole[] },
  versions: ReadonlyMap<string, SeniorVersions>,
): Promise<Record<string, number>> {
  const { rows } = await tx.execute(
    sql`SELECT senior_id::text AS senior_id, senior_profile_version, fit
          FROM job_opportunity_relevance
         WHERE ${gradedAtVacancyKey(opportunityId, key)}`,
  )
  const fits: Record<string, number> = {}
  for (const r of rows) {
    const seniorId = String(r['senior_id'])
    if (versions.get(seniorId)?.profile !== r['senior_profile_version']) continue
    const fit = r['fit'] === null ? Number.NaN : Number(r['fit'])
    if (fit >= 0 && fit <= 1) fits[seniorId] = fit
  }
  return fits
}
