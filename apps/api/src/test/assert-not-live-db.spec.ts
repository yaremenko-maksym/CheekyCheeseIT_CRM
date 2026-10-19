import { describe, expect, it } from 'vitest'

import { assertNotLiveDb } from './assert-not-live-db'

/**
 * The second lock behind `integration-db-guard.ts`: specs that create roles, databases or grants
 * refuse the live `crm_db` themselves, in case they are ever run without the global guard.
 *
 * What this pins is the part three hand-rolled copies got wrong. `pg` percent-decodes the database
 * name before it connects, so `…/crm%5Fdb` IS the live database while the raw string compares
 * unequal to it. The decoding and trimming live in `extractDbName` (PR #579); this wrapper must
 * keep calling it rather than parse the URL again, and must fail CLOSED where the old
 * `new URL(…)` call did (it threw on a URL it could not parse; `extractDbName` returns '').
 */

const LABEL = 'some-spec'
const LIVE = `[${LABEL}] refusing to run against the live crm_db`
const UNKNOWN = `[${LABEL}] cannot determine the database name from DATABASE_URL — refusing to run`

function messageOf(url: string): string | null {
  try {
    assertNotLiveDb(url, LABEL)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

describe('assertNotLiveDb', () => {
  it('refuses the live database by its plain name', () => {
    expect(messageOf('postgresql://u:p@localhost:5432/crm_db')).toBe(LIVE)
  })

  it.each([
    ['percent-encoded underscore', 'crm%5Fdb'],
    ['lower-case hex', 'crm%5fdb'],
    ['percent-encoded letter', 'crm_d%62'],
    ['percent-encoded first letter', '%63rm_db'],
    ['trailing space', 'crm_db%20'],
    ['trailing space, raw', 'crm_db '],
    ['leading space', '%20crm_db'],
    ['encoded and padded', 'crm%5Fdb%20'],
  ])('refuses the live database spelled with %s', (_label, spelled) => {
    expect(messageOf(`postgresql://u:p@localhost:5432/${spelled}`)).toBe(LIVE)
  })

  it('refuses it regardless of host, port, credentials and query string', () => {
    expect(messageOf('postgresql://a:b@127.0.0.1:5544/crm_db?sslmode=disable')).toBe(LIVE)
    expect(messageOf('postgres://prod.example.com/crm_db')).toBe(LIVE)
  })

  it('carries the caller’s label, so a refusal names the spec that raised it', () => {
    expect(() => assertNotLiveDb('postgresql://u:p@h:5432/crm_db', 'cluster-acl-snapshot')).toThrow(
      '[cluster-acl-snapshot] refusing to run against the live crm_db',
    )
  })

  it.each(['crm_qa', 'crm_ci', 'crm_db_scratch', 'crm_dbx', 'xcrm_db', 'CRM_DB', 'crm_scratch_a1'])(
    'allows %s — only the exact name is the live database',
    (database) => {
      expect(messageOf(`postgresql://u:p@localhost:5432/${database}`)).toBeNull()
    },
  )

  it.each([
    ['a URL it cannot parse', 'not a url'],
    ['an empty string', ''],
    ['no database in the path', 'postgresql://u:p@localhost:5432'],
    ['an empty path', 'postgresql://u:p@localhost:5432/'],
    ['a name of only spaces', 'postgresql://u:p@localhost:5432/%20%20'],
  ])('fails CLOSED on %s — an unknown target is not a disposable one', (_label, url) => {
    expect(messageOf(url)).toBe(UNKNOWN)
  })
})
