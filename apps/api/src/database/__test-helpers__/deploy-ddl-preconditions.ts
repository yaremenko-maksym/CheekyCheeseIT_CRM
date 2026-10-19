import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Pool } from 'pg'

import { splitSqlStatements } from '../manual-sql-statements'

/**
 * Preconditions the r5 Task 1.3b / 1.3c suites need from a cluster, so that each suite
 * establishes its own instead of inheriting them from whichever sibling vitest happened to
 * sequence first.
 *
 * WHY THIS FILE EXISTS (fix round 1 of PR #1026, finding CR-H-1)
 * --------------------------------------------------------------
 * `job-queue-store.integration.spec.ts` created `crm_retention_owner` by hand and nothing
 * else, so run alone on a fresh cluster it failed in `beforeAll` with
 * `required role(s) absent: crm_app`; `job-queue-append-only.integration.spec.ts` created
 * no role at all and failed the same way. Both passed in CI only because
 * `db-privileges.integration.spec.ts` is the largest file, vitest sequences largest-first,
 * and that file applies the real roles DDL — an inherited precondition, not an established
 * one. The store spec additionally LEFT `crm_retention_owner` behind in the cluster.
 *
 * The three rules this module exists to keep:
 *   1. the attributes come from the SHIPPED roles file, never from a copy of its attribute
 *      list — a copy is a second source of truth that drifts silently;
 *   2. a suite drops exactly the roles IT created and no others, so running it in a cluster
 *      that already had them (CI) is a no-op and running it alone leaves no residue;
 *   3. files are applied statement by statement, which is what the deploy does.
 */

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')

export const ROLES_DDL = join(MANUAL_DIR, '2026-10-18_db_roles.sql')
export const APPEND_ONLY_TRIGGERS_DDL = join(
  MANUAL_DIR,
  '2026-10-18_job_queue_append_only_triggers.sql',
)
export const APPEND_ONLY_CHECK_SQL = join(MANUAL_DIR, '2026-10-18_job_queue_append_only_check.sql')

/** Every role `2026-10-18_db_roles.sql` creates, in the order that file lists them. */
export const DEPLOY_ROLES = ['crm_app', 'crm_collector', 'crm_retention_owner'] as const

/**
 * Apply a manual DDL file the way the deploy does: `psql -v ON_ERROR_STOP=1 < file`, i.e.
 * one statement at a time with statement-level AUTOCOMMIT.
 *
 * NOT `pool.query(wholeFile)`. A multi-statement simple query runs as ONE IMPLICIT
 * TRANSACTION, so idempotence proven that way is idempotence under a transaction — a
 * property the deploy never has. Where a file converges only because an earlier statement
 * already committed, the two differ, and the transactional version is the more forgiving of
 * the two. `db-privileges.integration.spec.ts` and the forward-DDL spec already do it this
 * way; this is the same mechanism, shared rather than copied a third time.
 */
export async function applyDeployDdlFile(pool: Pool, file: string): Promise<void> {
  for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
    await pool.query(statement)
  }
}

function assertKnownRole(role: string): void {
  if (!(DEPLOY_ROLES as readonly string[]).includes(role)) {
    throw new Error(`refusing to touch role ${role}: not one of the deploy roles`)
  }
}

/**
 * Make the deploy roles exist by applying the SHIPPED roles DDL, and report which of them
 * this call actually created.
 *
 * The returned list is what `dropRolesCreated` must be given in `afterAll`: pass it back
 * and the suite is a no-op on a cluster that already had the roles (CI, where a sibling
 * created them) and leaves nothing behind on one that did not (a fresh cluster, a single
 * `vitest run <file>`).
 *
 * No password GUC is supplied, so the file leaves every password untouched — a role with no
 * password cannot authenticate at all, which is what these suites want: they reach the
 * roles with `SET LOCAL ROLE` over a superuser connection, never over the network.
 */
export async function installDeployRoles(pool: Pool): Promise<readonly string[]> {
  const { rows } = await pool.query(
    `SELECT candidate AS rolname
       FROM unnest($1::text[]) AS candidate
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = candidate)`,
    [[...DEPLOY_ROLES]],
  )
  const created = rows.map((row) => String(row['rolname']))
  await applyDeployDdlFile(pool, ROLES_DDL)
  return created
}

/**
 * Drop the roles a suite created, with everything they came to own.
 *
 * `DROP OWNED BY` first, because `DROP ROLE` refuses while the role still owns anything —
 * and after the 1.3b DDL `crm_retention_owner` owns the two R-B definer functions. It also
 * revokes the privileges the role was granted in this database, which is the other half of
 * leaving no residue.
 */
export async function dropRolesCreated(pool: Pool, created: readonly string[]): Promise<void> {
  for (const role of created) {
    assertKnownRole(role)
    await pool.query(`DROP OWNED BY ${role} CASCADE`)
    await pool.query(`DROP ROLE IF EXISTS ${role}`)
  }
}

/** Which of the deploy roles exist right now — for an assertion that none leaked. */
export async function existingDeployRoles(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [[...DEPLOY_ROLES]],
  )
  return rows.map((row) => String(row['rolname']))
}
