import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

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
import { extractDbName, LIVE_DB_NAME } from '../seed-db-guard'
import { applyDeployDdlFile, DEPLOY_ROLES, dropRolesCreated } from './deploy-ddl-preconditions'

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
 *     the pool out unless it is `crm_app`, is not a superuser, does not bypass RLS, is a
 *     member of no other role, and holds ownership of nothing in `public` — directly OR
 *     through a role it belongs to. Ownership by inheritance is the case that matters: a
 *     `crm_app` that is a member of `crm_user` has the owner's privileges while every
 *     question about the role ITSELF still answers "no" (CR-M-1 of #1040, reproduced by
 *     `GRANT crm_user TO crm_app`);
 *   - `withPrivilegeWithdrawn` lets a spec prove, in the run itself, that it is sensitive to
 *     the grant: revoke, watch `42501`, restore. It restores only a privilege `crm_app`
 *     actually held, so a control can never hand back what the shipped grants file never
 *     gave (CR-M-2).
 *
 * THE IDENTITY CHECK IS A PRE-FLIGHT ASSERTION, NOT A CONTINUOUS ONE: a membership added after
 * the session opened, or a grant to PUBLIC, is invisible to it, and the in-spec controls are what
 * catch those.
 *
 * The files are idempotent, so applying them again in a database that already has them (CI
 * after step 4, a developer's scratch database) is a no-op. Nothing depends on the database
 * having been prepared in any particular way beyond the schema `db:push` builds.
 *
 * WHAT IT LEAVES BEHIND, stated rather than discovered later
 * ----------------------------------------------------------
 * Same rule as `deploy-ddl-preconditions.ts`: a suite drops exactly the roles IT created. If
 * the deploy roles already existed (CI after a sibling spec, a developer's database) this is a
 * no-op and the roles and grants stay. If this helper created them, `close()` removes them with
 * everything they came to own in this database, so a lone run leaves no residue. The one thing
 * it cannot clean is a dependent in ANOTHER database of the same cluster: roles are
 * cluster-global, and `DROP ROLE` then refuses (SQLSTATE 2BP01). That is reported, not
 * swallowed silently, and it is why the integration database must be one per cluster. The two
 * CLUSTER-wide ACLs the roles file rewrites are restored. `crm_app`'s password is replaced by
 * a per-run random one unless `CRM_APP_DB_PASSWORD` is set, so two runs against the same
 * cluster at once would lock each other out; the integration run is serial
 * (`fileParallelism: false`).
 *
 * WHAT MUST BE CONFIRMED AT ADR STEP 4 (CR-M-4 of #1040) — NOT TESTED AGAINST A STEP-4 ENVIRONMENT
 * -----------------------------------------------------------------------------------------------
 * ADR §5 makes `DATABASE_URL` the `crm_app` URL, with owner work on a separate migration URL. Every
 * owner operation here (roles, triggers, grants, fixtures, cleanup) therefore reads the owner URL
 * from `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` as today, and the `crm_app` URL
 * is derived from THAT, never from a `DATABASE_URL` that might already be `crm_app`'s. The
 * ADR's name for the migration variable is "to be confirmed": when step 4 settles it, change
 * the one constant below. `CRM_APP_DB_PASSWORD` (the ADR's name) is reused when set, so the
 * credential the rest of the job holds is not invalidated by a fresh random one. The schema
 * probe runs on the OWNER connection too: `DATABASE_URL` may by then be `crm_app`'s own login.
 * The one spec that must not run in that shape is `crm-app-session.cleanup.integration.spec.ts`,
 * which drops the deploy roles to prove the helper cleans up after itself — dropping the role the
 * job is logged in as would fail every other file. It checks `isDeployRoleLogin` and skips with
 * an explicit reason; that behaviour is therefore covered only while `DATABASE_URL` is still the
 * migration role (CR-M-9 of #1040).
 *
 * A TEST HELPER: nothing at runtime may import it.
 */

export const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
export const TRIGGERS_FILE = '2026-10-18_job_queue_append_only_triggers.sql'

/** The migration-URL variable ADR §5 introduces at step 4. Its exact name is still to be confirmed. */
const MIGRATION_URL_ENV = 'MIGRATION_DATABASE_URL'
const APP_PASSWORD_ENV = 'CRM_APP_DB_PASSWORD'

/** Privileges a spec may withdraw — the ones the cron paths use. */
export type WithdrawablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

/** What the server says the pool is. Compared by the spec, not assumed. */
export interface CrmAppIdentity {
  currentUser: string
  sessionUser: string
  isSuperuser: boolean
  bypassesRls: boolean
  /**
   * Relations in `public` whose owner the connected role IS or has USAGE of — ownership held
   * directly or inherited through a role it belongs to. An owner bypasses its own grants.
   */
  ownedRelations: number
  /** Roles the connected role is a member of. `crm_app` belongs to none. */
  roleMemberships: number
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
   * when `run` throws — but only if `crm_app` held it to begin with. `run` is expected to fail
   * with `42501`; what it returns or throws is the caller's to assert.
   */
  withPrivilegeWithdrawn<T>(
    privilege: WithdrawablePrivilege,
    table: string,
    run: () => Promise<T>,
  ): Promise<T>
  close(): Promise<void>
}

/**
 * The role a connection string logs in as, the way `pg` resolves it: a `?user=` query parameter wins
 * over the URL's own user, and with neither it is `PGUSER`. Decoded, because `pg` decodes it.
 * `undefined` when nothing names one.
 */
export function loginRoleOf(
  databaseUrl: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  try {
    // An absent or empty URL is unparsable too — `new URL(undefined)` and `new URL('')` both throw
    // a TypeError — and falls through to PGUSER the same way; no branch of its own is needed.
    const url = new URL(databaseUrl as string)
    const user = url.searchParams.get('user') || decodeURIComponent(url.username)
    if (user) return user
  } catch {
    // Unparsable: nothing in the URL names a role. Fall through to PGUSER, as `pg` would.
  }
  return env['PGUSER'] || undefined
}

/**
 * True when the job itself is logged in as one of the deploy roles — the ADR step-4 shape, where
 * `DATABASE_URL` is `crm_app`'s own URL. A spec that drops or re-passwords those roles must not
 * run then: it would take the login out from under every other file in the job.
 */
export function isDeployRoleLogin(
  databaseUrl: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): boolean {
  // `includes(undefined)` is false, so "names nobody" needs no branch of its own.
  return (DEPLOY_ROLES as readonly (string | undefined)[]).includes(loginRoleOf(databaseUrl, env))
}

/** Where the owner work goes, and which password `crm_app` will have. Pure, so it is unit-tested. */
export interface ConnectionPlan {
  ownerUrl: string
  appPassword: string
}

function generateAppPassword(): string {
  return `cron${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function resolveConnectionPlan(
  env: Readonly<Record<string, string | undefined>>,
  generate: () => string = generateAppPassword,
): ConnectionPlan {
  // `||`, not `??`: an exported-but-empty variable means "not set" in every shell and CI system.
  const ownerUrl = env[MIGRATION_URL_ENV] || env['DATABASE_URL']
  if (!ownerUrl) {
    throw new Error(
      `[crm-app-session] neither ${MIGRATION_URL_ENV} nor DATABASE_URL is set — nowhere to apply the roles`,
    )
  }
  return { ownerUrl, appPassword: env[APP_PASSWORD_ENV] || generate() }
}

/**
 * Refuses the live database, and a target it cannot name. The name comes from the repository's one
 * definition of "the database in this URL" (`extractDbName`: decoded and trimmed, the form `pg`
 * connects to) and never from a parse of our own — `…/crm%5Fdb` IS `crm_db` to the server while the
 * raw pathname compares unequal (CR-M-6 of #1040; PR #579 closed the same bypass in the other guards).
 * It fails CLOSED: `extractDbName` returns '' for what it cannot parse, and a path-less URL lands
 * wherever `PGDATABASE` says, which is not something this guard can see.
 */
export function assertDisposableTarget(databaseUrl: string): void {
  const name = extractDbName(databaseUrl)
  if (name === '') {
    throw new Error(
      '[crm-app-session] cannot determine the database name from the owner URL — refusing to run',
    )
  }
  if (name === LIVE_DB_NAME) {
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
    memberships: string
  }>(
    `SELECT current_user,
            session_user,
            r.rolsuper,
            r.rolbypassrls,
            (SELECT count(*) FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND pg_has_role(current_user, c.relowner, 'USAGE'))::text AS owned,
            (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::text AS memberships
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
    roleMemberships: Number(row.memberships),
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
    problems.push(
      `the role owns, or inherits ownership of, ${identity.ownedRelations} relation(s) in public`,
    )
  }
  if (identity.roleMemberships !== 0) {
    problems.push(`the role is a member of ${identity.roleMemberships} other role(s)`)
  }
  if (problems.length > 0) {
    throw new Error(
      `[crm-app-session] the pool is not crm_app, so a passing spec would prove nothing: ${problems.join('; ')}`,
    )
  }
}

function urlFor(ownerUrl: string, role: string, password: string): string {
  const url = new URL(ownerUrl)
  url.username = role
  url.password = password
  return url.toString()
}

/**
 * The two tables the roles/grants files name, found through the OWNER connection. Not
 * `assertRealDbSchema`: that reads `DATABASE_URL`, which at ADR step 4 is `crm_app`'s own login.
 */
async function assertSchemaPresent(owner: Pool): Promise<void> {
  for (const [table, column] of [
    ['users', 'id'],
    ['document_access_log', 'id'],
  ] as const) {
    const { rowCount } = await owner.query(
      `SELECT 1
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = $2
          AND a.attnum > 0 AND NOT a.attisdropped`,
      [table, column],
    )
    if (rowCount === 0) {
      throw new Error(
        `[crm-app-session] ${table}.${column} not found in public through the owner URL — the schema ` +
          'is unmigrated (run `pnpm --filter @crm/api db:push`) or the owner URL points at an unrelated database',
      )
    }
  }
}

export async function openCrmAppSession(): Promise<CrmAppSession> {
  const { ownerUrl, appPassword } = resolveConnectionPlan(process.env)
  assertDisposableTarget(ownerUrl)
  // Before the roles file can rewrite them — restored by `close()`.
  const clusterAcls: ClusterAclSnapshot = await snapshotClusterAcls(ownerUrl)
  const pools: Pool[] = []
  let appPool: Pool | undefined
  let admin: Pool | undefined
  let created: readonly string[] = []

  /** Roles this helper created are dropped; pools close; the cluster ACLs go back. Idempotent. */
  async function teardown(): Promise<void> {
    await cleanupThenRestore(async () => {
      try {
        // The API's own connections go first: a role with sessions open is not one to drop.
        await appPool?.end().catch(() => undefined)
        if (admin && created.length > 0) {
          try {
            await dropRolesCreated(admin, created)
          } catch (error) {
            if ((error as { code?: string }).code !== '2BP01') throw error
            console.warn(
              `[crm-app-session] left ${created.join(', ')} in place: a database other than this one still depends on them (2BP01)`,
            )
          }
        }
      } finally {
        await Promise.allSettled(pools.map((p) => p.end()))
      }
    }, clusterAcls)
  }

  try {
    // The deploy's mechanism: the verifier arrives as a connection option (what PGOPTIONS
    // becomes on the wire), never in argv and never in the file.
    const rolesPool = new Pool({
      connectionString: ownerUrl,
      max: 1,
      options: `-c crm_roles.app_verifier=${scramSha256Verifier(appPassword)}`,
    })
    pools.push(rolesPool)
    await assertSchemaPresent(rolesPool)
    const { rows: present } = await rolesPool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`,
      [[...DEPLOY_ROLES]],
    )
    const existing = new Set(present.map((row) => row.rolname))
    created = DEPLOY_ROLES.filter((role) => !existing.has(role))
    await applyDeployDdlFile(rolesPool, join(MANUAL_DIR, ROLES_FILE))

    admin = new Pool({ connectionString: ownerUrl, max: 2 })
    pools.push(admin)
    await applyDeployDdlFile(admin, join(MANUAL_DIR, TRIGGERS_FILE))
    await applyDeployDdlFile(admin, join(MANUAL_DIR, GRANTS_FILE))

    appPool = new Pool({ connectionString: urlFor(ownerUrl, ROLES.app, appPassword), max: 2 })
    const pool = appPool
    assertIsCrmApp(await readIdentity(pool))

    // Same trick `job-sourcing.integration.spec.ts` uses: the real class, without its
    // ConfigService-bound `onModuleInit`, so the spec does not follow changes to how the
    // production service builds its own pool.
    const databaseService = Object.create(DatabaseService.prototype) as DatabaseService
    databaseService.db = drizzle(pool, { schema })

    const owner = admin
    let closed = false
    return {
      pool,
      admin: owner,
      databaseService,
      identity: () => readIdentity(pool),
      async withPrivilegeWithdrawn(privilege, table, run) {
        assertIdentifier(table)
        // Recorded BEFORE the revoke: the restore must put back what was there and nothing the
        // shipped grants file never gave, or a missing grant is laundered by its own control.
        const { rows } = await owner.query<{ held: boolean }>(
          `SELECT has_table_privilege($1, $2, $3) AS held`,
          [ROLES.app, `public.${table}`, privilege],
        )
        const held = rows[0]?.held === true
        await owner.query(`REVOKE ${privilege} ON TABLE ${table} FROM ${ROLES.app}`)
        try {
          return await run()
        } finally {
          if (held) await owner.query(`GRANT ${privilege} ON TABLE ${table} TO ${ROLES.app}`)
        }
      },
      async close() {
        if (closed) return
        closed = true
        await teardown()
      },
    }
  } catch (error) {
    await teardown()
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
