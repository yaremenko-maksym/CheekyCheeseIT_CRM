import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasDatabaseUrl } from '../../test/require-real-db'
import { DEPLOY_ROLES, dropRolesCreated, installDeployRoles } from './deploy-ddl-preconditions'
import { openCrmAppSession, resolveConnectionPlan } from './crm-app-session'

/**
 * What the `crm_app` session helper leaves behind (CR-M-5 of #1040).
 *
 * `deploy-ddl-preconditions.ts` states the rule for suites that touch the deploy roles: drop
 * exactly the roles IT created, so running in a cluster that already had them is a no-op and
 * running alone leaves no residue. Eight specs now go through this helper, and `db-privileges`
 * already left four dependents behind that failed `job-queue-append-only` AC6 in a second
 * database — so the helper must not add to the pile.
 *
 * Its own file, with no open session of its own: it has to start from a database whose deploy
 * roles it controls, and a sibling session would be holding them.
 */

describe.skipIf(!hasDatabaseUrl())('crm-app-session cleanup', () => {
  let owner: Pool

  async function deployRolesPresent(): Promise<number> {
    const { rowCount } = await owner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [[...DEPLOY_ROLES]],
    )
    return rowCount ?? 0
  }

  /** Removes whichever deploy roles exist; false if another database still depends on them. */
  async function clearRoles(): Promise<boolean> {
    const { rows } = await owner.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [[...DEPLOY_ROLES]],
    )
    try {
      await dropRolesCreated(
        owner,
        rows.map((r) => r.rolname),
      )
      return true
    } catch (error) {
      if ((error as { code?: string }).code === '2BP01') return false
      throw error
    }
  }

  beforeAll(() => {
    owner = new Pool({ connectionString: resolveConnectionPlan(process.env).ownerUrl, max: 2 })
  })

  afterAll(async () => {
    await owner?.end()
  })

  it('removes the deploy roles it created, so a lone run leaves no residue', async (ctx) => {
    if (!(await clearRoles())) {
      ctx.skip('a deploy role has dependents in another database of this cluster')
    }
    expect(await deployRolesPresent()).toBe(0)

    const session = await openCrmAppSession()
    expect(await deployRolesPresent()).toBe(DEPLOY_ROLES.length)
    await session.close()

    expect(await deployRolesPresent()).toBe(0)
  }, 180_000)

  it('leaves deploy roles that were already there, so a sibling spec’s state survives', async (ctx) => {
    if (!(await clearRoles())) {
      ctx.skip('a deploy role has dependents in another database of this cluster')
    }
    const created = await installDeployRoles(owner)
    try {
      const session = await openCrmAppSession()
      await session.close()

      expect(await deployRolesPresent()).toBe(DEPLOY_ROLES.length)
    } finally {
      await dropRolesCreated(owner, created)
    }
  }, 180_000)
})
