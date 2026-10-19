import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasDatabaseUrl } from '../../test/require-real-db'
import { ROLES } from '../privileges/privilege-classes'
import { openCrmAppSession, type CrmAppSession } from './crm-app-session'

/**
 * The session helper against a REAL database — the behaviours its unit spec cannot reach.
 *
 * The seven `*.crm-app.integration.spec.ts` files all trust `openCrmAppSession` to hand them an
 * unprivileged `crm_app`. Each has in-spec controls that go red if the grant is withdrawn, but
 * those are a backstop: the claim "this pool is crm_app and owns nothing" is the helper's own,
 * and it was reviewed (CR-M-1 of #1040) and found to be blind to a `crm_app` that is a member of
 * the owner role. These tests pin the helper's three promises by NAMED tests that go red when it
 * is broken, rather than leaving them to be noticed through the specs that use it.
 */

const TABLE = 'document_access_log'

describe.skipIf(!hasDatabaseUrl())('crm-app-session helper against a real database', () => {
  let anchor: CrmAppSession
  let ownerRole: string

  beforeAll(async () => {
    // Opened first and closed LAST: it makes the roles exist for the tests below and holds the
    // original cluster ACLs, which the nested sessions' own restores must not outlive.
    anchor = await openCrmAppSession()
    const { rows } = await anchor.admin.query<{ owner: string }>(`SELECT current_user AS owner`)
    ownerRole = (rows[0] as { owner: string }).owner
  }, 120_000)

  afterAll(async () => {
    await anchor?.admin.query(`REVOKE "${ownerRole}" FROM ${ROLES.app}`).catch(() => undefined)
    await anchor?.close()
  })

  async function held(privilege: string): Promise<boolean> {
    const { rows } = await anchor.admin.query<{ held: boolean }>(
      `SELECT has_table_privilege($1, $2, $3) AS held`,
      [ROLES.app, `public.${TABLE}`, privilege],
    )
    return rows[0]?.held === true
  }

  describe('CR-M-1: the identity check sees ownership the role does not hold itself', () => {
    it.each([
      ['inheriting', 'INHERIT TRUE'],
      ['non-inheriting', 'INHERIT FALSE'],
    ])(
      'refuses a crm_app that is a %s member of the migration role',
      async (_label, inheritClause) => {
        await anchor.admin.query(`GRANT "${ownerRole}" TO ${ROLES.app} WITH ${inheritClause}`)
        try {
          // The roles file does not remove the membership (it did not in the reviewer's run), so
          // the session it hands back is one that has the owner's privileges.
          await expect(openCrmAppSession()).rejects.toThrow(
            /the pool is not crm_app, so a passing spec would prove nothing: .*the role is a member of 1 other role\(s\)/,
          )
        } finally {
          await anchor.admin.query(`REVOKE "${ownerRole}" FROM ${ROLES.app}`)
        }
      },
      120_000,
    )

    it('reports inherited ownership as owned relations, not only the membership', async () => {
      await anchor.admin.query(`GRANT "${ownerRole}" TO ${ROLES.app} WITH INHERIT TRUE`)
      try {
        await expect(openCrmAppSession()).rejects.toThrow(
          /owns, or inherits ownership of, [1-9]\d* relation\(s\) in public/,
        )
      } finally {
        await anchor.admin.query(`REVOKE "${ownerRole}" FROM ${ROLES.app}`)
      }
    }, 120_000)

    it('accepts the unmodified crm_app again once the membership is gone', async () => {
      const again = await openCrmAppSession()
      try {
        expect(await again.identity()).toMatchObject({
          currentUser: 'crm_app',
          ownedRelations: 0,
          roleMemberships: 0,
        })
      } finally {
        await again.close()
      }
    }, 120_000)
  })

  describe('CR-M-2: a control restores what was held and never what was not', () => {
    it('puts a held privilege back', async () => {
      expect(await held('DELETE')).toBe(true)

      await anchor.withPrivilegeWithdrawn('DELETE', TABLE, async () => {
        expect(await held('DELETE')).toBe(false)
      })

      expect(await held('DELETE')).toBe(true)
    })

    it('does NOT grant a privilege the shipped grants file never gave', async () => {
      await anchor.admin.query(`REVOKE DELETE ON TABLE ${TABLE} FROM ${ROLES.app}`)
      try {
        await anchor.withPrivilegeWithdrawn('DELETE', TABLE, async () => undefined)

        // A control that granted it back would turn a missing grant into a present one, and the
        // positive test that follows it would pass on a privilege nothing ever gave.
        expect(await held('DELETE')).toBe(false)
      } finally {
        await anchor.admin.query(`GRANT DELETE ON TABLE ${TABLE} TO ${ROLES.app}`)
      }
    })

    it('restores also when the body throws', async () => {
      await expect(
        anchor.withPrivilegeWithdrawn('DELETE', TABLE, async () => {
          throw new Error('body failed')
        }),
      ).rejects.toThrow('body failed')

      expect(await held('DELETE')).toBe(true)
    })
  })
})
