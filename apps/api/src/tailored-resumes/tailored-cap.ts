import { HttpStatus } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import type { SqlExecutor } from '../job-sourcing/scheduling/host-state'

/**
 * The daily generation cap of one scope (plan D12): `scopeKey` is the team id, or `studio` for an
 * ADMIN's studio scope. `lockDailyCap` runs first in the POST transaction, before the active-run
 * read: the advisory lock serializes every POST of the scope until that transaction ends, so a
 * double click waits, then sees the first click's run and answers with it, and the count and the
 * audit row cannot interleave with another POST's (SR-L-2).
 */
export async function lockDailyCap(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('tailored-cap:' || ${scopeKey}))`)
}

/**
 * Refuse with 429 when the scope has used its cap today. Call only after `lockDailyCap` in the same
 * transaction. The day is the Kyiv calendar day of `now`.
 */
export async function assertUnderDailyCap(
  db: SqlExecutor,
  scopeKey: string,
  cap: number,
  now: Date,
): Promise<void> {
  const at = now.toISOString()
  const day = sql`date_trunc('day', ${at}::timestamptz AT TIME ZONE 'Europe/Kyiv')`
  const { rows } = await db.execute(
    sql`SELECT count(*)::int AS n FROM user_audit_log
         WHERE action = 'tailored_resume_generate'
           AND changes->'teamId'->>'after' = ${scopeKey}
           AND created_at >= (${day} AT TIME ZONE 'Europe/Kyiv')
           AND created_at < ((${day} + interval '1 day') AT TIME ZONE 'Europe/Kyiv')`,
  )
  if (Number(rows[0]?.['n'] ?? 0) >= cap) {
    throw apiError('TAILORED_RESUME_DAILY_CAP', HttpStatus.TOO_MANY_REQUESTS)
  }
}
