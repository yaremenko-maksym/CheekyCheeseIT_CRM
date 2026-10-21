import type { Pool } from 'pg'

/**
 * Manufacture an AGED `job_queue_actions` row — a state the product FORBIDS.
 *
 * WHY THIS FILE EXISTS, AND WHY THE NAME IS AS BLUNT AS IT IS
 * ----------------------------------------------------------
 * Since `trg_job_queue_actions_created_at_now` (r5 Task 1.4b-i) the database writes
 * `created_at` itself on every INSERT and overrides whatever the writer supplied. That
 * closes the hole where a backdated audit row deletes itself at the next daily purge —
 * and it also removes the ONLY route to an aged row, because backdating afterwards was
 * never available either (the append-only trigger refuses every UPDATE but the
 * redaction). Nothing in the application may have such a row; two integration suites
 * must, because the two-year retention boundary cannot be tested without one.
 *
 * So this helper exists to produce AN OTHERWISE-IMPOSSIBLE STATE, and its name says so
 * rather than reading like a convenience. A future test that merely WANTS a backdated
 * row must not be able to get one by reaching for something innocuous: that is why
 * there is no general `withCreatedAtGuardDisabled(fn)` wrapper exported here, and why
 * no `age` option is left on either suite's ordinary `newAction`. The only thing
 * callable from outside is this single-purpose row builder, and calling it is a visible
 * claim that the test is deliberately standing where production cannot.
 *
 * THE DISABLE WINDOW IS BOUNDED BY A TRANSACTION, NOT BY A BLOCK
 * --------------------------------------------------------------
 * The suites' teardowns disable the append-only triggers with bare `ALTER TABLE` over
 * the pool and re-enable them in a `finally`. That idiom is the right shape for a
 * teardown but is the WEAKER pattern for a fixture, and it is deliberately not copied
 * here: between those two pool calls, restoration depends on the JavaScript `finally`
 * actually running, and a process killed in between leaves the table unguarded.
 *
 * Here the disable, the INSERT and the re-enable are ONE transaction on ONE dedicated
 * client. `ALTER TABLE ... DISABLE TRIGGER` is transactional in PostgreSQL, so:
 *   - the window is exactly this one INSERT — the guard is off for a single statement,
 *     never for a block of test body;
 *   - restoration does not depend on our control flow. Any failure path, including a
 *     dropped connection, ends in `ROLLBACK` and the catalog reverts by itself;
 *   - `ENABLE ALWAYS`, not `ENABLE` — the plain form would downgrade `tgenabled` from
 *     'A' to 'O' and quietly re-open the `session_replication_role = replica` bypass
 *     that the whole DDL file exists to close. The post-commit read below is what turns
 *     that from a comment into a checked fact.
 *
 * ONLY THE NARROWEST GUARD IS TOUCHED. `trg_job_queue_actions_append_only` and
 * `trg_job_queue_actions_no_truncate` stay enabled throughout, so the row is produced
 * under every other protection the table has, and the INSERT still proves what an
 * INSERT normally proves.
 *
 * Requires table ownership (the same procedural trust the suites already use to replay
 * tampering against the catalog check), and belongs to a SCRATCH database only.
 */

/** The one guard this helper turns off, named once. */
const CREATED_AT_GUARD = 'trg_job_queue_actions_created_at_now'

export interface BackdatedActionRow {
  /** `users.id` of the acting user. */
  actorId: string
  /** `job_opportunities.id` the action is about. */
  opportunityId: string
  /** Unique per row — the table's idempotency key. */
  idempotencyKey: string
  /** How far in the past `created_at` lands, as a PostgreSQL interval literal. */
  age: string
  /** `reason`; `null` is a legitimate value the redaction tests need. */
  reason?: string | null
}

/**
 * Insert ONE `job_queue_actions` row whose `created_at` is `age` in the past, with
 * `trg_job_queue_actions_created_at_now` disabled around that single INSERT.
 *
 * Returns the new row's id. Throws if the guard is not back to `ENABLE ALWAYS`
 * afterwards, so a bug in this helper fails the test that called it instead of leaving
 * a quietly unguarded table behind for whoever runs next.
 */
export async function insertBackdatedJobQueueActionAsTableOwner(
  pool: Pool,
  row: BackdatedActionRow,
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`ALTER TABLE job_queue_actions DISABLE TRIGGER ${CREATED_AT_GUARD}`)
    const { rows } = await client.query(
      `INSERT INTO job_queue_actions
         (kind, opportunity_id, actor_id, scope_kind, before_version, after_version,
          idempotency_key, reason, created_at)
       VALUES ('DISMISSED', $1, $2, 'STUDIO', 0, 1, $3, $4, now() - $5::interval)
       RETURNING id`,
      [
        row.opportunityId,
        row.actorId,
        row.idempotencyKey,
        row.reason === undefined ? null : row.reason,
        row.age,
      ],
    )
    await client.query(`ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER ${CREATED_AT_GUARD}`)
    await client.query('COMMIT')

    // The window is closed — verified, not assumed. 'A' is ENABLE ALWAYS; 'O' would mean
    // the re-enable above silently used the plain form.
    const { rows: state } = await client.query(
      `SELECT t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='job_queue_actions' AND t.tgname=$1`,
      [CREATED_AT_GUARD],
    )
    if (state[0]?.tgenabled !== 'A') {
      throw new Error(
        `${CREATED_AT_GUARD} is '${String(
          state[0]?.tgenabled,
        )}' after ageing a row, expected 'A' (ENABLE ALWAYS)`,
      )
    }

    return rows[0].id as string
  } catch (e) {
    // The catalog change is transactional, so this restores the guard regardless of
    // which statement above failed.
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}
