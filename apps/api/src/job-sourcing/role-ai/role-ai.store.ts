import { type JobSourceType, sortRoles, type TechnicalRole } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { releaseCallQuery, reserveCallQuery } from '../../resumes/resume-ai-daily-budget'
import { ROLE_CLASSIFIER_VERSION } from '../funnel/role-classifier'
import type { MeterDb } from '../metering/account-meter.store'
import { enqueueDirty } from '../ownership/dirty-work.store'
import { onDemandMissingExpr } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import { setLockTimeout, withLockRetry } from '../store/lock-order'
import { textArray, writeOpportunityRoles } from '../store/opportunity-roles'
import { STORE_LOCK_TIMEOUT_MS } from '../store/source-record.store'
import {
  ROLE_AI_BACKOFF,
  ROLE_AI_MAX_ATTEMPTS,
  ROLE_AI_REASON,
  type RoleAiCandidate,
  type RoleAiStore,
  type RoleAiTerminal,
} from './role-ai-pass'

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

/** The `job_account_meters` row that counts the pass's model calls per UTC day (SR-M-1). */
export const ROLE_AI_METER_ACCOUNT_KEY = 'extraction-worker:role-ai'
const V = ROLE_CLASSIFIER_VERSION

/** The cache key's hash: a vacancy with no description is keyed by '' (the column is NOT NULL). */
export const keyHash = (c: Pick<RoleAiCandidate, 'descriptionSha256'>) => c.descriptionSha256 ?? ''

function inTx<T>(db: MeterDb, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      await setLockTimeout(tx, STORE_LOCK_TIMEOUT_MS)
      return work(tx)
    }, READ_COMMITTED),
  )
}

/**
 * The candidate still as selected: PENDING at this classifier version with the same text, and still
 * full text (`fullText`: a link to a detail-pending on-demand record made during the call would
 * otherwise store a title-only answer). Locked like the recompute worker locks it (NO KEY UPDATE),
 * so a concurrent refresh waits or wins.
 */
async function lockUnchanged(
  tx: SqlExecutor,
  c: RoleAiCandidate,
  fullText: SQL,
): Promise<number | null> {
  const { rows } = await tx.execute(
    sql`SELECT o.revision FROM job_opportunities o
         WHERE o.id = ${c.id}::uuid AND o.role_status = 'PENDING' AND o.role_classifier_version = ${V}
           AND o.title_key = ${c.titleKey}
           AND o.description_sha256 IS NOT DISTINCT FROM ${c.descriptionSha256}
           AND ${fullText}
           FOR NO KEY UPDATE OF o`,
  )
  const row = rows[0]
  return row === undefined ? null : Number(row['revision'])
}

/**
 * The pass's SQL. A candidate has its full text: a description, or no backing ON_DEMAND source (an
 * IN_LIST board whose records carry no description at all), so UNCLEAR is always writable (spec
 * correction 4). A detail-pending record is never selected (the same rule as `loadOpportunity`), so
 * it takes no slot of the limit. A manual card is HR-entered text and never sent to a model.
 */
export function createRoleAiStore(
  db: MeterDb,
  onDemandTypes: readonly JobSourceType[],
  meterAccountKey: string = ROLE_AI_METER_ACCOUNT_KEY,
): RoleAiStore {
  const onDemandSource =
    onDemandTypes.length === 0
      ? sql`false`
      : sql`EXISTS (SELECT 1 FROM job_opportunity_sources s
                      JOIN job_source_records r ON r.id = s.source_record_id
                     WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL
                       AND r.source_type IN (${sql.join(
                         onDemandTypes.map((t) => sql`${t}::job_source_type`),
                         sql`, `,
                       )}))`
  const fullText = sql`${onDemandMissingExpr(onDemandTypes)} = '[]'::jsonb
               AND (o.description_sha256 IS NOT NULL OR NOT ${onDemandSource})`
  return {
    async candidates(now, limit) {
      const { rows } = await db.execute(
        sql`SELECT o.id, o.title, o.title_key, o.description_sha256, o.stack_keywords,
                   COALESCE(b.text, '') AS description
              FROM job_opportunities o
              LEFT JOIN job_text_blobs b ON b.sha256 = o.description_sha256
             WHERE o.role_status = 'PENDING' AND o.role_classifier_version = ${V}
               AND o.availability IN ('OPEN', 'UNKNOWN') AND o.manual_team_id IS NULL
               AND ${fullText}
               AND NOT EXISTS (
                 SELECT 1 FROM job_role_classifications c
                  WHERE c.title_key = o.title_key
                    AND c.description_sha256 = COALESCE(o.description_sha256, '')
                    AND c.classifier_version = ${V} AND c.outcome = 'FAILED'
                    AND (c.next_attempt_at > ${now.toISOString()}::timestamptz
                         OR c.attempts >= ${ROLE_AI_MAX_ATTEMPTS}))
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
      }))
    },

    async cached(c) {
      const { rows } = await db.execute(
        sql`SELECT outcome, technical_roles, confidence FROM job_role_classifications
             WHERE title_key = ${c.titleKey} AND description_sha256 = ${keyHash(c)}
               AND classifier_version = ${V} AND outcome IN ('AI', 'UNCLEAR')`,
      )
      const row = rows[0]
      if (row === undefined) return null
      const roles = row['technical_roles'] as TechnicalRole[]
      // An AI row without roles cannot satisfy the opportunity's roles CHECK: unanswered.
      if (row['outcome'] === 'AI' && roles.length === 0) return null
      const confidence = row['confidence'] === null ? null : Number(row['confidence'])
      return row['outcome'] === 'AI'
        ? { outcome: 'AI', roles: sortRoles(roles), confidence }
        : { outcome: 'UNCLEAR', roles: [], confidence }
    },

    applyTerminal(c, t: RoleAiTerminal, writeCache) {
      return inTx(db, async (tx) => {
        const revision = await lockUnchanged(tx, c, fullText)
        if (revision === null) return false
        if (writeCache) {
          // The model is left NULL: the worker does not report which model of its chain answered.
          await tx.execute(
            sql`INSERT INTO job_role_classifications
                  (title_key, description_sha256, classifier_version, outcome, technical_roles,
                   confidence)
                VALUES (${c.titleKey}, ${keyHash(c)}, ${V}, ${t.outcome}, ${textArray(t.roles)},
                        ${t.confidence})
                ON CONFLICT (title_key, description_sha256, classifier_version) DO UPDATE
                   SET outcome = EXCLUDED.outcome, technical_roles = EXCLUDED.technical_roles,
                       confidence = EXCLUDED.confidence, next_attempt_at = NULL,
                       updated_at = clock_timestamp()`,
          )
        }
        await writeOpportunityRoles(tx, c.id, {
          status: t.outcome,
          roles: t.roles,
          classifierVersion: V,
        })
        await enqueueDirty(tx, 'OPPORTUNITY', c.id, revision, ROLE_AI_REASON)
        return true
      })
    },

    recordFailure(c, now) {
      return inTx(db, async (tx) => {
        if ((await lockUnchanged(tx, c, fullText)) === null) return false
        // The increment is the row's own (`attempts + 1`), so two writers of one key never lose
        // one. A terminal row for the key is an answer: a failure never overwrites it.
        const { rows } = await tx.execute(
          sql`INSERT INTO job_role_classifications
                (title_key, description_sha256, classifier_version, outcome, attempts)
              VALUES (${c.titleKey}, ${keyHash(c)}, ${V}, 'FAILED', 1)
              ON CONFLICT (title_key, description_sha256, classifier_version) DO UPDATE
                 SET attempts = job_role_classifications.attempts + 1,
                     updated_at = clock_timestamp()
               WHERE job_role_classifications.outcome = 'FAILED'
              RETURNING attempts`,
        )
        const row = rows[0]
        if (row !== undefined) {
          const next = new Date(now.getTime() + ROLE_AI_BACKOFF(Number(row['attempts']) - 1))
          await tx.execute(
            sql`UPDATE job_role_classifications SET next_attempt_at = ${next.toISOString()}::timestamptz
                 WHERE title_key = ${c.titleKey} AND description_sha256 = ${keyHash(c)}
                   AND classifier_version = ${V}`,
          )
        }
        return true
      })
    },

    async reserveCall(now, limit) {
      return (await reserveCallQuery(db, now, meterAccountKey, limit)).length > 0
    },

    async releaseCall(now) {
      await releaseCallQuery(db, now, meterAccountKey)
    },
  }
}
