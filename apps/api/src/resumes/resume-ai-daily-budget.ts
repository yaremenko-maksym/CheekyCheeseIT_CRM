/**
 * ResumeAiDailyBudget — a per-UTC-day ceiling on the Cloudflare Workers AI calls the resume
 * extraction makes, so the app never spends more than its share of the free allowance whatever
 * plan the account is on. On Workers Free, usage above 10 000 Neurons/day is refused (free); on
 * Workers Paid it is billed at $0.011 per 1 000 Neurons with no cap. This ceiling is what keeps the
 * second case at $0.
 *
 * STORAGE: one row of the existing `job_account_meters` table (account `cloudflare:resume-extraction`,
 * unit MODEL_CALL, window DAY). It is applied on every deploy, `crm_app` holds class-A grants on it,
 * and its CHECK `used + reserved + uncertain <= limit_amount` is the database's own backstop. So the
 * count survives an API restart within the day, and needs no migration.
 *
 * ONE STATEMENT reserves a call: an INSERT … ON CONFLICT DO UPDATE whose `WHERE` admits the update only
 * while there is room. Postgres takes the row lock for the conflicting row and re-evaluates the
 * `WHERE` on its latest version, so concurrent requests (in this process or another) serialise on
 * that row and cannot overshoot. No row returned = the day's budget is spent. The refusal goes
 * through the `WHERE`, not through the CHECK: a CHECK violation would throw instead.
 *
 * The UTC day rolls over in the same statement: a row whose `resets_at` has passed (or is NULL)
 * restarts at 1.
 *
 * RELEASE: a reserved call is given back only when Cloudflare cannot have billed it: the request
 * failed in the CONNECT phase (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, UND_ERR_CONNECT_TIMEOUT: no request
 * byte was sent; the codes live in resume-ai.service.ts), or Cloudflare answered HTTP 429. Our own
 * timeout keeps it spent (the model may have run), as does any other transport failure (ECONNRESET,
 * a socket closed mid-request, an unknown error) and any other answer. The release touches only the
 * reservation's own UTC day and never takes `used` below 0.
 */
import { Injectable } from '@nestjs/common'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DatabaseService } from '../database/database.service'
import type * as schema from '../database/schema'
import { jobAccountMeters } from '../database/schema'

/** The meter row's identity. Never a credential (the table's CHECKs refuse one anyway). */
export const RESUME_AI_METER_ACCOUNT_KEY = 'cloudflare:resume-extraction'

/**
 * Calls per UTC day, both attempts (initial + corrective retry) counted.
 *
 * Worst case of ONE call, priced at the catalog rate of `@cf/mistralai/mistral-small-3.1-24b-instruct`
 * ($0.351 per M input tokens, $0.555 per M output tokens, $0.011 per 1 000 Neurons):
 *   input  <= 13 100 tokens: 12 000 chars of resume text + 531 chars of system prompt + 497 chars of
 *            retry preamble (with the 400-char parser error) + chat-template tokens, at ONE TOKEN PER
 *            CHAR (Cyrillic text tokenises far denser than English; Latin text is ~4 chars a token)
 *          = 13 100 x 0.351 / 0.011 / 1e6 x 1e3 = 13 100 x 0.031 909 ≈ 418.0 Neurons
 *   output <= 1 400 tokens (`max_tokens`) = 1 400 x 0.050 455 ≈ 70.6 Neurons
 *   total  ≈ 488.6 Neurons a call.
 * Ceiling: 50 % of the 10 000 free Neurons/day = 5 000; the other 50 % is the extraction router's
 * (PR #1375 caps its own share there). 10 x 488.6 ≈ 4 886 <= 5 000; 11 x 488.6 ≈ 5 375 > 5 000.
 * Residual: text that tokenises at 2 tokens a char (rare scripts, emoji) would cost ≈ 9 060 for ten
 * calls: past this share, still under the whole free allowance.
 */
export const RESUME_AI_DAILY_CALL_CAP = 10

/** Cloudflare's free allowance resets at 00:00 UTC. */
export function nextUtcMidnight(from: Date = new Date()): Date {
  const next = new Date(from)
  next.setUTCHours(24, 0, 0, 0)
  return next
}

/** [start of the UTC day containing `now`, start of the next one). */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  return { start, end: nextUtcMidnight(now) }
}

/** The reservation statement, exposed so its SQL can be asserted without a database. */
export function reserveCallQuery(
  db: NodePgDatabase<typeof schema>,
  now: Date,
  accountKey: string,
  limit: number,
) {
  const m = jobAccountMeters
  const { start, end } = utcDayBounds(now)
  // NULL `resets_at` counts as rolled over: `NULL <= now` alone is NULL, which would never roll.
  const rolledOver = sql`COALESCE(${m.resetsAt} <= ${now.toISOString()}::timestamptz, true)`
  return db
    .insert(m)
    .values({
      accountKey,
      unit: 'MODEL_CALL',
      window: 'DAY',
      limitAmount: limit,
      used: 1,
      windowStartedAt: start,
      resetsAt: end,
    })
    .onConflictDoUpdate({
      target: [m.accountKey, m.unit, m.window],
      set: {
        used: sql`CASE WHEN ${rolledOver} THEN 1 ELSE ${m.used} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${rolledOver} THEN excluded.window_started_at ELSE ${m.windowStartedAt} END`,
        resetsAt: sql`CASE WHEN ${rolledOver} THEN excluded.resets_at ELSE ${m.resetsAt} END`,
        // The code constant wins over a stale row, so a redeploy with a new cap takes effect.
        limitAmount: sql`excluded.limit_amount`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`(CASE WHEN ${rolledOver} THEN 0 ELSE ${m.used} END) + ${m.reserved} + ${m.uncertain} < excluded.limit_amount`,
    })
    .returning({ used: m.used })
}

/** The release statement: one call back, on the reservation's UTC day only, never below 0. */
export function releaseCallQuery(db: NodePgDatabase<typeof schema>, now: Date, accountKey: string) {
  const m = jobAccountMeters
  return db
    .update(m)
    .set({ used: sql`${m.used} - 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(m.accountKey, accountKey),
        eq(m.unit, 'MODEL_CALL'),
        eq(m.window, 'DAY'),
        eq(m.windowStartedAt, utcDayBounds(now).start),
        gt(m.used, 0),
      ),
    )
}

@Injectable()
export class ResumeAiDailyBudget {
  constructor(private readonly database: DatabaseService) {}

  /** True = one call reserved for today; false = today's budget is spent. Throws on a DB failure. */
  async reserveCall(
    now: Date = new Date(),
    accountKey: string = RESUME_AI_METER_ACCOUNT_KEY,
    limit: number = RESUME_AI_DAILY_CALL_CAP,
  ): Promise<boolean> {
    const rows = await reserveCallQuery(this.database.db, now, accountKey, limit)
    return rows.length > 0
  }

  /**
   * Gives back one call reserved at `now` (pass the reservation's own instant). A row that has
   * rolled over to a later day, or is already at 0, is left alone. Throws on a DB failure.
   */
  async releaseCall(
    now: Date = new Date(),
    accountKey: string = RESUME_AI_METER_ACCOUNT_KEY,
  ): Promise<void> {
    await releaseCallQuery(this.database.db, now, accountKey)
  }
}
