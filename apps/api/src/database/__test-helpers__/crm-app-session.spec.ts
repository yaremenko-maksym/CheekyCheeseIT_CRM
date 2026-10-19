import { statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GRANTS_FILE, ROLES_FILE } from '../privileges/generate-privilege-sql'

import {
  assertDisposableTarget,
  assertIdentifier,
  assertIsCrmApp,
  MANUAL_DIR,
  TRIGGERS_FILE,
  sqlstateOfRejection,
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
    ['the role owns one relation', { ownedRelations: 1 }, 'the role owns 1 relation(s) in public'],
    [
      'the role owns many relations',
      { ownedRelations: 69 },
      'the role owns 69 relation(s) in public',
    ],
  ] as const)('refuses when %s — and names only that problem', (_label, patch, expected) => {
    expect(refusal({ ...CRM_APP, ...patch })).toBe(`${PREFIX}${expected}`)
  })

  it('distinguishes current_user from session_user (SET ROLE from a superuser session is not a login)', () => {
    // current_user is crm_app but the session was opened by someone else: the connection is not
    // the API's, so it must be refused, and only on session_user.
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
      }),
    ).toBe(
      `${PREFIX}current_user is crm_user; session_user is crm_user; the role is a superuser; ` +
        'the role bypasses row-level security; the role owns 69 relation(s) in public',
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
  const original = process.env['DATABASE_URL']

  afterEach(() => {
    if (original === undefined) delete process.env['DATABASE_URL']
    else process.env['DATABASE_URL'] = original
  })

  it('refuses the live crm_db', () => {
    process.env['DATABASE_URL'] = 'postgresql://crm_user:x@localhost:5432/crm_db'
    expect(() => assertDisposableTarget()).toThrow(
      '[crm-app-session] refusing to run against the live crm_db',
    )
  })

  it.each(['crm%5Fdb', 'crm%5fdb', 'crm_d%62', '%63rm_db'])(
    'refuses %s — pg decodes the pathname, so it IS the live database',
    (encoded) => {
      process.env['DATABASE_URL'] = `postgresql://crm_user:x@localhost:5432/${encoded}`
      expect(() => assertDisposableTarget()).toThrow(
        '[crm-app-session] refusing to run against the live crm_db',
      )
    },
  )

  it('strips only a LEADING slash: a slash-less opaque pathname keeps its trailing one', () => {
    // `postgresql:crm_db/` is the one input that tells /^\//  from  /\//: anchored it stays
    // `crm_db/` (not the live name), unanchored it would become `crm_db` and refuse. pg reads this
    // URL as the database `rm_db/`, so nothing is lost by allowing it — the point is that the
    // pattern's anchor is pinned rather than left to a mutant.
    process.env['DATABASE_URL'] = 'postgresql:crm_db/'
    expect(() => assertDisposableTarget()).not.toThrow()
  })

  it.each(['crm_qa', 'crm_ci', 'crm_db_scratch', 'crm_scratch_x', 'crm_dbx'])(
    'allows %s — only the exact name is the live database',
    (database) => {
      process.env['DATABASE_URL'] = `postgresql://crm_user:x@localhost:5432/${database}`
      expect(() => assertDisposableTarget()).not.toThrow()
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

  it('points MANUAL_DIR at apps/api/drizzle/manual', () => {
    expect(MANUAL_DIR.split(/[\\/]/).slice(-3)).toEqual(['api', 'drizzle', 'manual'])
  })
})
