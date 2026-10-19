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
const SHAPE = 'postgresql://crm_user:password@localhost:5432/crm_qa'
const LIVE = `[${LABEL}] refusing to run against the live crm_db — point DATABASE_URL at a scratch database, e.g. ${SHAPE}`
const UNKNOWN = `[${LABEL}] cannot determine the database name from DATABASE_URL — refusing to run. Put the database in the path of a URL with a host, e.g. ${SHAPE}`

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

  it.each([
    ['a socket URL with ?db= and an ignored path', 'socket:/var/run/postgresql?db=crm_db'],
    ['the same, percent-encoded', 'socket:/var/run/postgresql?db=crm%5Fdb'],
    ['a socket URL with credentials', 'socket://u:p@/var/run/postgresql?db=crm_db'],
    ['a socket URL in the empty-host form', 'socket:///var/run/postgresql?db=crm_db'],
  ])('refuses %s — pg takes the database from ?db= there and ignores the path', (_label, url) => {
    // The path of the first form is `var/run/postgresql`, which `extractDbName` happily returns;
    // only asking `pg` what it resolves catches it (CR-M-1 of #1043).
    expect(messageOf(url)).toBe(LIVE)
  })

  it.each([
    ['a socket URL with the live name in the path and no ?db=', 'socket:///crm_db'],
    ['the same, encoded, with ?db= naming a scratch database', 'socket:///crm%5Fdb?db=crm_qa'],
  ])('refuses %s — the path says live even where pg resolves something else', (_label, url) => {
    // `pg` resolves the OS user for the first (it ignores the path of a socket URL) and `crm_qa` for
    // the second. A person who put the live name in a URL's path meant it; the path signal is not
    // redundant with `pg`'s (1,414 of 71,400 fuzzed shapes disagree this way), so it stays.
    expect(messageOf(url)).toBe(LIVE)
  })

  it.each([
    ['trailing space, encoded', 'socket:/var/run/postgresql?db=crm_db%20'],
    ['leading space, encoded', 'socket:/var/run/postgresql?db=%20crm_db'],
  ])('refuses ?db= with %s — the same trimming as the path check', (_label, url) => {
    expect(messageOf(url)).toBe(LIVE)
  })

  it.each([
    ['a dangling percent in the path', 'postgresql://u:p@localhost:5432/crm_db%'],
    ['malformed percent-encoding', 'postgresql://u:p@localhost:5432/%E0%A4%A'],
    ['an unclosed IPv6 bracket', 'postgresql://u:p@[::1/crm_qa'],
    ['empty host and port', 'postgres://:@:/'],
  ])('fails CLOSED when pg itself cannot parse the URL: %s', (_label, url) => {
    // `new Client({ connectionString })` throws on each of these; a URL the consumer cannot read is
    // one this guard cannot vouch for, so it is refused as unknown, not allowed by default.
    expect(messageOf(url)).toBe(UNKNOWN)
  })

  it('allows a socket URL whose ?db= is a scratch database', () => {
    expect(messageOf('socket:/var/run/postgresql?db=crm_qa')).toBeNull()
  })

  it('does not honour ?db= or ?dbname= on a host URL — for node-pg the path wins, and that is the rule', () => {
    // Pinned, with its reason: libpq honours ?dbname= (the shell-side guard covers that consumer);
    // node-pg resolves these to the PATH. If a `pg` upgrade changes this, these fail and the guard
    // gets a decision, instead of quietly checking something other than what connects.
    expect(messageOf('postgresql://u:p@localhost:5432/other?dbname=crm_db')).toBeNull()
    expect(messageOf('postgresql://u:p@localhost:5432/crm_qa?db=crm_db')).toBeNull()
  })

  it('tells a developer the shape that is accepted, not only that they were refused (CR-M-2)', () => {
    const live = messageOf('postgresql://u:p@localhost:5432/crm_db') as string
    const unknown = messageOf('postgresql://u:p@/crm_db_scratch') as string
    for (const message of [live, unknown]) {
      expect(message).toContain('postgresql://crm_user:password@localhost:5432/crm_qa')
    }
    expect(live).toContain('point DATABASE_URL at a scratch database')
    // The empty-host form is refused — the safe direction — and the message says why and what to use.
    expect(unknown).toContain('a URL with a host')
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
