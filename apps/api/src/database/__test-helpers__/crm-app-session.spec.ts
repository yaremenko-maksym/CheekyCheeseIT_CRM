import { statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GRANTS_FILE, ROLES_FILE } from '../privileges/generate-privilege-sql'
import {
  assertDisposableTarget,
  assertIdentifier,
  assertIsCrmApp,
  MANUAL_DIR,
  resolveConnectionPlan,
  sqlstateOfRejection,
  TRIGGERS_FILE,
  type CrmAppIdentity,
} from './crm-app-session'

/**
 * The pure predicates of the `crm_app` session helper, with no database.
 *
 * Seven real-database specs rest on `assertIsCrmApp`: it is the one place that refuses a pool
 * that is not unambiguously the unprivileged API role. A spec connected as the migration role
 * passes unconditionally, so if this predicate were to accept the wrong identity every one of
 * those specs would go on being green while proving nothing — the defect they exist to replace.
 * That is why each condition is pinned on its own, by its exact message, rather than "throws".
 */

const CRM_APP: CrmAppIdentity = {
  currentUser: 'crm_app',
  sessionUser: 'crm_app',
  isSuperuser: false,
  bypassesRls: false,
  ownedRelations: 0,
  roleMemberships: 0,
}

const PREFIX = '[crm-app-session] the pool is not crm_app, so a passing spec would prove nothing: '

function refusal(identity: CrmAppIdentity): string {
  try {
    assertIsCrmApp(identity)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('assertIsCrmApp accepted an identity it must refuse')
}

describe('assertIsCrmApp', () => {
  it('accepts exactly the crm_app identity', () => {
    expect(() => assertIsCrmApp(CRM_APP)).not.toThrow()
  })

  it.each([
    ['current_user is another role', { currentUser: 'crm_user' }, 'current_user is crm_user'],
    ['session_user is another role', { sessionUser: 'crm_user' }, 'session_user is crm_user'],
    ['the role is a superuser', { isSuperuser: true }, 'the role is a superuser'],
    ['the role bypasses RLS', { bypassesRls: true }, 'the role bypasses row-level security'],
    [
      'the role owns, or inherits ownership of, one relation',
      { ownedRelations: 1 },
      'the role owns, or inherits ownership of, 1 relation(s) in public',
    ],
    [
      'the role owns many relations',
      { ownedRelations: 69 },
      'the role owns, or inherits ownership of, 69 relation(s) in public',
    ],
    [
      'the role is a member of one other role',
      { roleMemberships: 1 },
      'the role is a member of 1 other role(s)',
    ],
    [
      'the role is a member of several roles',
      { roleMemberships: 3 },
      'the role is a member of 3 other role(s)',
    ],
  ] as const)('refuses when %s — and names only that problem', (_label, patch, expected) => {
    expect(refusal({ ...CRM_APP, ...patch })).toBe(`${PREFIX}${expected}`)
  })

  it('refuses a crm_app that is a member of the owner role — the case that looks like crm_app (CR-M-1)', () => {
    // GRANT crm_user TO crm_app: current_user, session_user, superuser and RLS all still answer
    // "crm_app, no, no"; only membership and inherited ownership give it away. Exactly this
    // identity is what the server reports for such a session (see the integration spec).
    expect(refusal({ ...CRM_APP, ownedRelations: 301, roleMemberships: 1 })).toBe(
      `${PREFIX}the role owns, or inherits ownership of, 301 relation(s) in public; ` +
        'the role is a member of 1 other role(s)',
    )
  })

  it('distinguishes current_user from session_user (SET ROLE from a superuser session is not a login)', () => {
    expect(refusal({ ...CRM_APP, sessionUser: 'postgres' })).toBe(
      `${PREFIX}session_user is postgres`,
    )
    expect(refusal({ ...CRM_APP, currentUser: 'postgres' })).toBe(
      `${PREFIX}current_user is postgres`,
    )
  })

  it('lists every problem, in a fixed order, for the migration role', () => {
    expect(
      refusal({
        currentUser: 'crm_user',
        sessionUser: 'crm_user',
        isSuperuser: true,
        bypassesRls: true,
        ownedRelations: 69,
        roleMemberships: 2,
      }),
    ).toBe(
      `${PREFIX}current_user is crm_user; session_user is crm_user; the role is a superuser; ` +
        'the role bypasses row-level security; ' +
        'the role owns, or inherits ownership of, 69 relation(s) in public; ' +
        'the role is a member of 2 other role(s)',
    )
  })
})

describe('assertIdentifier', () => {
  it.each(['document_access_log', 'a', '_x', 'job_postings2', 'a1_b2'])('accepts %s', (name) => {
    expect(() => assertIdentifier(name)).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['upper case', 'Document'],
    ['leading digit', '1abc'],
    ['hyphen', 'a-b'],
    ['space', 'a b'],
    ['dot (schema-qualified)', 'public.users'],
    ['statement terminator', 'users; DROP TABLE users'],
    ['trailing newline', 'users\n'],
    ['leading newline', '\nusers'],
    ['quote', 'us"ers'],
  ])('refuses %s', (_label, name) => {
    expect(() => assertIdentifier(name)).toThrow(
      `[crm-app-session] refusing to splice a non-identifier into SQL: ${name}`,
    )
  })
})

describe('assertDisposableTarget', () => {
  const LIVE = '[crm-app-session] refusing to run against the live crm_db'
  const UNKNOWN =
    '[crm-app-session] cannot determine the database name from the owner URL — refusing to run'

  function messageOf(url: string): string | null {
    try {
      assertDisposableTarget(url)
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  it('refuses the live crm_db', () => {
    expect(messageOf('postgresql://crm_user:x@localhost:5432/crm_db')).toBe(LIVE)
  })

  it.each(['crm%5Fdb', 'crm%5fdb', 'crm_d%62', '%63rm_db', 'crm_db%20', 'crm_db '])(
    'refuses %s — pg decodes the name, so it IS the live database',
    (spelled) => {
      expect(messageOf(`postgresql://crm_user:x@localhost:5432/${spelled}`)).toBe(LIVE)
    },
  )

  it.each(['crm_qa', 'crm_ci', 'crm_db_scratch', 'crm_scratch_x', 'crm_dbx'])(
    'allows %s — only the exact name is the live database',
    (database) => {
      expect(messageOf(`postgresql://crm_user:x@localhost:5432/${database}`)).toBeNull()
    },
  )

  it.each([
    ['a path-less URL (lands wherever PGDATABASE says)', 'postgresql://crm_user:x@localhost:5432'],
    ['a bare slash', 'postgresql://crm_user:x@localhost:5432/'],
    ['an unparsable URL', 'not a url'],
    ['an empty string', ''],
  ])('fails CLOSED on %s', (_label, url) => {
    expect(messageOf(url)).toBe(UNKNOWN)
  })
})

describe('resolveConnectionPlan (the step-4 seam, CR-M-4)', () => {
  const GENERATED = 'generated-pw'
  const generate = () => GENERATED

  it('uses DATABASE_URL as the owner URL today, with a generated crm_app password', () => {
    expect(
      resolveConnectionPlan({ DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci' }, generate),
    ).toEqual({
      ownerUrl: 'postgresql://crm_user:x@h/crm_ci',
      appPassword: GENERATED,
    })
  })

  it('prefers MIGRATION_DATABASE_URL — at step 4 DATABASE_URL is crm_app’s own', () => {
    expect(
      resolveConnectionPlan(
        {
          DATABASE_URL: 'postgresql://crm_app:y@h/crm_ci',
          MIGRATION_DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci',
        },
        generate,
      ).ownerUrl,
    ).toBe('postgresql://crm_user:x@h/crm_ci')
  })

  it('treats an empty MIGRATION_DATABASE_URL as unset', () => {
    expect(
      resolveConnectionPlan(
        { DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci', MIGRATION_DATABASE_URL: '' },
        generate,
      ).ownerUrl,
    ).toBe('postgresql://crm_user:x@h/crm_ci')
  })

  it('reuses CRM_APP_DB_PASSWORD so the credential the rest of the job holds survives', () => {
    expect(
      resolveConnectionPlan(
        { DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci', CRM_APP_DB_PASSWORD: 'job-wide' },
        generate,
      ).appPassword,
    ).toBe('job-wide')
  })

  it('treats an empty CRM_APP_DB_PASSWORD as unset', () => {
    expect(
      resolveConnectionPlan(
        { DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci', CRM_APP_DB_PASSWORD: '' },
        generate,
      ).appPassword,
    ).toBe(GENERATED)
  })

  it('generates a different random password each time by default', () => {
    const env = { DATABASE_URL: 'postgresql://crm_user:x@h/crm_ci' }
    const a = resolveConnectionPlan(env).appPassword
    const b = resolveConnectionPlan(env).appPassword
    expect(a).toMatch(/^cron[a-z0-9]+$/)
    expect(a).not.toBe(b)
  })

  it.each([[{}], [{ DATABASE_URL: '' }], [{ MIGRATION_DATABASE_URL: '' }]])(
    'refuses when there is no owner URL at all (%j)',
    (env) => {
      expect(() => resolveConnectionPlan(env, generate)).toThrow(
        '[crm-app-session] neither MIGRATION_DATABASE_URL nor DATABASE_URL is set — nowhere to apply the roles',
      )
    },
  )
})

describe('sqlstateOfRejection', () => {
  it('is null when the attempt succeeds', async () => {
    await expect(sqlstateOfRejection(async () => 'fine')).resolves.toBeNull()
  })

  it('reads the code off a raw driver error', async () => {
    await expect(
      sqlstateOfRejection(() => Promise.reject(Object.assign(new Error('x'), { code: '42501' }))),
    ).resolves.toBe('42501')
  })

  it('reads the code off .cause, where drizzle keeps it (its own message is only "Failed query")', async () => {
    const wrapped = Object.assign(new Error('Failed query: delete from ...'), {
      cause: { code: '42501' },
    })
    await expect(sqlstateOfRejection(() => Promise.reject(wrapped))).resolves.toBe('42501')
  })

  it('prefers the error’s own code over its cause’s', async () => {
    const both = Object.assign(new Error('x'), { code: '23505', cause: { code: '42501' } })
    await expect(sqlstateOfRejection(() => Promise.reject(both))).resolves.toBe('23505')
  })

  it('says no-code — never a guessed SQLSTATE — for an error that carries none', async () => {
    await expect(sqlstateOfRejection(() => Promise.reject(new Error('boom')))).resolves.toBe(
      'no-code',
    )
    await expect(
      sqlstateOfRejection(() => Promise.reject(Object.assign(new Error('x'), { cause: {} }))),
    ).resolves.toBe('no-code')
  })
})

describe('the shipped DDL files the helper applies', () => {
  // The helper only reads these inside `openCrmAppSession`, which needs a database. A wrong
  // segment would therefore surface as ENOENT in an integration run only; pinning the paths here
  // makes the rot visible without one. `isFile`, not `exists`: an emptied file name resolves to
  // the directory itself, which exists.
  it.each([
    ['roles', ROLES_FILE],
    ['triggers', TRIGGERS_FILE],
    ['grants', GRANTS_FILE],
  ])('finds the %s file under MANUAL_DIR', (_label, file) => {
    expect(statSync(join(MANUAL_DIR, file)).isFile()).toBe(true)
  })

  it('points MANUAL_DIR at drizzle/manual', () => {
    expect(MANUAL_DIR.split(/[\\/]/).slice(-2)).toEqual(['drizzle', 'manual'])
  })
})
