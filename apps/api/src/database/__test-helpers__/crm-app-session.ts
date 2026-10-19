import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { assertRealDbSchema } from '../../test/require-real-db'
import { DatabaseService } from '../database.service'
import { GRANTS_FILE, ROLES_FILE } from '../privileges/generate-privilege-sql'
import {
  cleanupThenRestore,
  snapshotClusterAcls,
  type ClusterAclSnapshot,
} from '../privileges/cluster-acl-snapshot'
import { ROLES } from '../privileges/privilege-classes'
import { scramSha256Verifier } from '../privileges/scram'
import * as schema from '../schema'
import { applyDeployDdlFile } from './deploy-ddl-preconditions'

/**
 * A real database session AS `crm_app` — the role the API runs as once ADR 2026-10-17 step 5
 * ships — for specs whose whole point is that a statement the code issues is permitted by the
 * grants.
 *
 * WHY THIS EXISTS (ADR §4, "What step 4 does not reach", measure 1)
 * ----------------------------------------------------------------
 * The scheduled jobs are the `DELETE`/`UPDATE` paths, and their specs mock `DatabaseService`.
 * A mocked database passes whatever the grants are, so a table the manifest misclassified would
 * surface on the first cron fire as a `42501` inside a handler that swallows its errors. A real
 * database is the only thing that can say no — but only a real database CONNECTED AS THE
 * RIGHT ROLE can: the migration role owns every table and an owner bypasses every grant, so a
 * spec that quietly connects as `crm_user` passes unconditionally and proves nothing. That is
 * the defect of the mock again, one layer along. So:
 *
 *   - the grants the pool runs under are the SHIPPED files, applied here statement by
 *     statement (`2026-10-18_db_roles.sql`, the 1.3b triggers, `2026-10-18_db_grants.sql`),
 *     never a hand-written GRANT that could drift from them;
 *   - the pool's role is read back from the server (`identity()`), and `open` refuses to hand
 *     the pool out unless it is `crm_app`, is not a superuser, does not bypass RLS and owns
 *     nothing in `public`;
 *   - `withPrivilegeWithdrawn` lets a spec prove, in the run itself, that it is sensitive to
 *     the grant: revoke, watch `42501`, restore. A spec that cannot fail that way is not
 *     connected the way it claims to be.
 *
 * The files are idempotent, so applying them again in a database that already has them (CI
 * after step 4, a developer's scratch database) is a no-op. Nothing depends on the database
 * having been prepared in any particular way beyond the schema `db:push` builds.
 *
 * SIDE EFFECTS, stated rather than discovered later (same as `db-privileges.integration.spec.ts`,
 * whose header has the full reasoning): the roles and grants REMAIN in the target database, and
 * the roles file rewrites two CLUSTER-wide ACLs, which `close()` restores. `crm_app`'s password
 * is replaced by a per-run random one, so two runs against the same cluster at the same moment
 * would lock each other out; the integration run is serial (`fileParallelism: false`).
 *
 * A TEST HELPER: nothing at runtime may import it.
 */

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const TRIGGERS_FILE = '2026-10-18_job_queue_append_only_triggers.sql'

/** Privileges a spec may withdraw — the ones the cron paths use. */
export type WithdrawablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

/** What the server says the pool is. Compared by the spec, not assumed. */
export interface CrmAppIdentity {
  currentUser: string
  sessionUser: string
  isSuperuser: boolean
  bypassesRls: boolean
  /** Relations in `public` the connected role OWNS — an owner bypasses its own grants. */
  ownedRelations: number
}

export interface CrmAppSession {
  /** The API's pool, connected as `crm_app`. */
  readonly pool: Pool
  /**
   * The migration role, for fixtures the API itself may not write and for reading rows back
   * without the grants getting a say. NEVER use it to run the statement under test.
   */
  readonly admin: Pool
  /** Stands in for the injected `DatabaseService`, backed by `pool`. */
  readonly databaseService: DatabaseService
  identity(): Promise<CrmAppIdentity>
  /**
   * Runs `run` with `privilege` on `table` revoked from `crm_app`, and puts it back — also
   * when `run` throws. `run` is expected to fail with `42501`; what it returns or throws is
   * the caller's to assert.
   */
  withPrivilegeWithdrawn<T>(
    privilege: WithdrawablePrivilege,
    table: string,
    run: () => Promise<T>,
  ): Promise<T>
  close(): Promise<void>
}

export function assertDisposableTarget(): void {
  const database = new URL(process.env['DATABASE_URL'] as string).pathname.replace(/^\//, '')
  if (database === 'crm_db') {
    throw new Error('[crm-app-session] refusing to run against the live crm_db')
  }
}

export function assertIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`[crm-app-session] refusing to splice a non-identifier into SQL: ${name}`)
  }
}

async function readIdentity(pool: Pool): Promise<CrmAppIdentity> {
  const { rows } = await pool.query<{
    current_user: string
    session_user: string
    rolsuper: boolean
    rolbypassrls: boolean
    owned: string
  }>(
    `SELECT current_user,
            session_user,
            r.rolsuper,
            r.rolbypassrls,
            (SELECT count(*) FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user)::text AS owned
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  )
  const row = rows[0]
  if (!row) throw new Error('[crm-app-session] the connected role is not in pg_roles')
  return {
    currentUser: row.current_user,
    sessionUser: row.session_user,
    isSuperuser: row.rolsuper,
    bypassesRls: row.rolbypassrls,
    ownedRelations: Number(row.owned),
  }
}

/** Refuses a pool that is not unambiguously the unprivileged API role. */
export function assertIsCrmApp(identity: CrmAppIdentity): void {
  const problems: string[] = []
  if (identity.currentUser !== ROLES.app) problems.push(`current_user is ${identity.currentUser}`)
  if (identity.sessionUser !== ROLES.app) problems.push(`session_user is ${identity.sessionUser}`)
  if (identity.isSuperuser) problems.push('the role is a superuser')
  if (identity.bypassesRls) problems.push('the role bypasses row-level security')
  if (identity.ownedRelations !== 0) {
    problems.push(`the role owns ${identity.ownedRelations} relation(s) in public`)
  }
  if (problems.length > 0) {
    throw new Error(
      `[crm-app-session] the pool is not crm_app, so a passing spec would prove nothing: ${problems.join('; ')}`,
    )
  }
}

function urlFor(role: string, password: string): string {
  const url = new URL(process.env['DATABASE_URL'] as string)
  url.username = role
  url.password = password
  return url.toString()
}

export async function openCrmAppSession(): Promise<CrmAppSession> {
  assertDisposableTarget()
  const connectionString = process.env['DATABASE_URL'] as string
  // Before the roles file can rewrite them — restored by `close()`.
  const clusterAcls: ClusterAclSnapshot = await snapshotClusterAcls(connectionString)
  const pools: Pool[] = []
  try {
    await assertRealDbSchema([
      { table: 'users', column: 'id' },
      { table: 'document_access_log', column: 'id' },
    ])

    const password = `cron${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    // The deploy's mechanism: the verifier arrives as a connection option (what PGOPTIONS
    // becomes on the wire), never in argv and never in the file.
    const rolesPool = new Pool({
      connectionString,
      max: 1,
      options: `-c crm_roles.app_verifier=${scramSha256Verifier(password)}`,
    })
    pools.push(rolesPool)
    await applyDeployDdlFile(rolesPool, join(MANUAL_DIR, ROLES_FILE))

    const admin = new Pool({ connectionString, max: 2 })
    pools.push(admin)
    await applyDeployDdlFile(admin, join(MANUAL_DIR, TRIGGERS_FILE))
    await applyDeployDdlFile(admin, join(MANUAL_DIR, GRANTS_FILE))

    const pool = new Pool({ connectionString: urlFor(ROLES.app, password), max: 2 })
    pools.push(pool)
    assertIsCrmApp(await readIdentity(pool))

    // Same trick `job-sourcing.integration.spec.ts` uses: the real class, without its
    // ConfigService-bound `onModuleInit`, so the spec does not follow changes to how the
    // production service builds its own pool.
    const databaseService = Object.create(DatabaseService.prototype) as DatabaseService
    databaseService.db = drizzle(pool, { schema })

    let closed = false
    return {
      pool,
      admin,
      databaseService,
      identity: () => readIdentity(pool),
      async withPrivilegeWithdrawn(privilege, table, run) {
        assertIdentifier(table)
        await admin.query(`REVOKE ${privilege} ON TABLE ${table} FROM ${ROLES.app}`)
        try {
          return await run()
        } finally {
          await admin.query(`GRANT ${privilege} ON TABLE ${table} TO ${ROLES.app}`)
        }
      },
      async close() {
        if (closed) return
        closed = true
        await cleanupThenRestore(async () => {
          await Promise.allSettled(pools.map((p) => p.end()))
        }, clusterAcls)
      },
    }
  } catch (error) {
    await cleanupThenRestore(async () => {
      await Promise.allSettled(pools.map((p) => p.end()))
    }, clusterAcls)
    throw error
  }
}

/** SQLSTATE of a rejected promise, or `null` if it resolved. */
export async function sqlstateOfRejection(attempt: () => Promise<unknown>): Promise<string | null> {
  try {
    await attempt()
    return null
  } catch (error) {
    // drizzle wraps the driver error and keeps it on `cause`; a raw `pg` error carries `code`.
    const direct = (error as { code?: string }).code
    const wrapped = (error as { cause?: { code?: string } }).cause?.code
    return direct ?? wrapped ?? 'no-code'
  }
}
