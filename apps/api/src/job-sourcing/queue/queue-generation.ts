import { type SQL, sql } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import { rankSelect } from './queue-read-sql'
import {
  type GenerationHead,
  isGenerationServable,
  type JobQueueScope,
  listableOpportunityPredicate,
  type LiveSeniorVersion,
} from './queue-scope'

/**
 * r5 Task 6.2 — the immutable, scope-wide order the list pages over. One generation per scope, not
 * per filter: filters and authorization are predicates over its retained entries, so a removal shows
 * at once while an addition or a move waits for the next generation.
 *
 * A generation is replaced when it has expired or when the scope's policy inputs changed. Publishers
 * of one scope are coalesced by a transaction-scoped advisory lock: the second waits, finds the row
 * the first committed and serves it (the partial UNIQUEs remain the database's own backstop).
 */
export const GENERATION_TTL_MS = 15 * 60 * 1000

/** shortcut: only the top of the order is retained; no viewer pages this far. Raise it if MP-13 data says otherwise. */
export const GENERATION_MAX_ENTRIES = 5000

export interface GenerationRow extends GenerationHead {
  readonly id: string
  readonly policySignature: string
}

/** Generations of exactly this scope. A STUDIO scope must not pick up a team's. */
const ofScope = (scope: JobQueueScope): SQL =>
  scope.kind === 'TEAM'
    ? sql`scope_kind = 'TEAM' AND team_id = ${scope.teamId}::uuid`
    : sql`scope_kind = 'STUDIO'`

const toGeneration = (r: Record<string, unknown>): GenerationRow => ({
  id: String(r['id']),
  scopeKind: r['scope_kind'] as GenerationRow['scopeKind'],
  teamId: r['team_id'] == null ? null : String(r['team_id']),
  status: r['status'] as GenerationRow['status'],
  expiresAt: r['expires_at'] instanceof Date ? r['expires_at'] : new Date(String(r['expires_at'])),
  policySignature: String(r['policy_signature']),
})

const COLUMNS = sql`id, scope_kind, team_id, status, expires_at, policy_signature`

export async function generationById(db: SqlExecutor, id: string): Promise<GenerationRow | null> {
  const { rows } = await db.execute(
    sql`SELECT ${COLUMNS} FROM job_queue_generations WHERE id = ${id}::uuid`,
  )
  const row = rows[0]
  return row === undefined ? null : toGeneration(row)
}

async function publishedGeneration(
  db: SqlExecutor,
  scope: JobQueueScope,
  signature: string,
  now: Date,
): Promise<GenerationRow | null> {
  const { rows } = await db.execute(
    sql`SELECT ${COLUMNS} FROM job_queue_generations
         WHERE status = 'PUBLISHED' AND ${ofScope(scope)}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  const generation = toGeneration(row)
  return isGenerationServable(scope, generation, now) && generation.policySignature === signature
    ? generation
    : null
}

/** The scope's current generation, published on the spot when there is no usable one. */
export async function currentGeneration(
  database: DatabaseService,
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  signature: string,
  now: Date,
): Promise<GenerationRow> {
  const current = await publishedGeneration(database.db, scope, signature, now)
  if (current !== null) return current
  return database.db.transaction(async (tx) => {
    const scopeKey = scope.kind === 'TEAM' ? `TEAM:${scope.teamId}` : 'STUDIO'
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-queue-generation:${scopeKey}`}, 0))`,
    )
    const raced = await publishedGeneration(tx, scope, signature, now)
    return raced ?? publish(tx, scope, versions, signature, now)
  })
}

async function publish(
  tx: SqlExecutor,
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  signature: string,
  now: Date,
): Promise<GenerationRow> {
  const expiresAt = new Date(now.getTime() + GENERATION_TTL_MS)
  const teamId = scope.kind === 'TEAM' ? scope.teamId : null
  const { rows } = await tx.execute(
    sql`INSERT INTO job_queue_generations
          (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
        VALUES (${scope.kind}::job_queue_scope_kind, ${teamId}::uuid, ${signature},
                ${MATCH_RULE_VERSION}, ${now.toISOString()}::timestamptz,
                ${expiresAt.toISOString()}::timestamptz)
        RETURNING id`,
  )
  const id = String((rows[0] as Record<string, unknown>)['id'])
  await tx.execute(
    sql`INSERT INTO job_queue_generation_entries
          (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
        SELECT ${id}::uuid, c.id, c.score,
               (row_number() OVER (ORDER BY c.score DESC, c.first_seen_at DESC, c.id DESC) - 1)::int,
               c.first_seen_at, c.revision
          FROM (SELECT o.id, o.first_seen_at, o.revision, rank.score
                  FROM job_opportunities o
                 CROSS JOIN LATERAL (${rankSelect(versions)}) rank
                 WHERE ${listableOpportunityPredicate(scope, sql`o.id`)}
                 ORDER BY rank.score DESC, o.first_seen_at DESC, o.id DESC
                 LIMIT ${GENERATION_MAX_ENTRIES}) c`,
  )
  // A cursor of a superseded generation answers refresh-required with or without its row, so the
  // old row is purged here: nothing else collects them, and the Task 1.3 triggers allow exactly
  // this order (invalidate, then delete; the entries go by cascade).
  await tx.execute(
    sql`UPDATE job_queue_generations
           SET status = 'INVALIDATED', invalidated_at = ${now.toISOString()}::timestamptz
         WHERE status = 'PUBLISHED' AND ${ofScope(scope)}`,
  )
  await tx.execute(
    sql`UPDATE job_queue_generations
           SET status = 'PUBLISHED', published_at = ${now.toISOString()}::timestamptz
         WHERE id = ${id}::uuid`,
  )
  await tx.execute(
    sql`DELETE FROM job_queue_generations WHERE status = 'INVALIDATED' AND ${ofScope(scope)}`,
  )
  return {
    id,
    scopeKind: scope.kind === 'TEAM' ? 'TEAM' : 'STUDIO',
    teamId,
    status: 'PUBLISHED',
    expiresAt,
    policySignature: signature,
  }
}
