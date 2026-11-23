import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, readinessReason, type Manifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import {
  SEED_CLOCK,
  SEED_DELTA_FILE,
  generateHostKeyDelta,
  generateSeedDelta,
  rollbackCadenceHours,
  seedDeltaLocations,
  storedReadinessAt,
} from './manifest.seed-sql'

/**
 * The seed delta against a REAL Postgres: the rows it produces equal the manifest (read as rows,
 * never by parsing the SQL), reapplying it changes nothing, and a redeploy never undoes an ADMIN.
 *
 * Every test runs inside a transaction that is ROLLED BACK, so nothing is left behind and the
 * 2026-10-05 seed can be applied afresh each time. THE TABLE IS ASSUMED EMPTY at the start: the
 * row-count case expects the seed's 16 rows and the delta's 19 to be the only ones added, and an
 * "enabled" check is scoped to manifest-owned rows. Run against a scratch database only:
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_manifest37 \
 *     pnpm --filter @crm/api exec vitest run manifest.seed-delta.integration
 */

const DRIZZLE = join(__dirname, '..', '..', '..', 'drizzle')
const LEGACY_SEED = readFileSync(
  join(DRIZZLE, 'manual', '2026-10-05_vacancy_sources_seed.sql'),
  'utf8',
)

// Built on first use INSIDE a test, fresh per test: a build at module scope is invisible to a mutation
// run (a throw fails the file to load) and would be attributed to no test.
let built: Manifest | undefined
const manifest = {
  get entries() {
    return (built ??= buildOnce()).entries
  },
  get types() {
    return (built ??= buildOnce()).types
  },
}
const buildOnce = () =>
  buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
const delta = () => generateSeedDelta(manifest)
const legacyEntries = () => manifest.entries.filter((e) => e.legacySeed)
const newEntries = () => manifest.entries.filter((e) => !e.legacySeed)

let pool: Pool
let client: PoolClient

const rowsOf = async (sql = 'SELECT * FROM job_sources') =>
  (await client.query(sql)).rows as Record<string, unknown>[]

/** Every row without its random id, in a stable order: what "the DB is identical" compares. */
const snapshot = async () =>
  (await rowsOf('SELECT * FROM job_sources ORDER BY type, config::text')).map((r) => {
    const { id: _id, ...rest } = r
    return rest
  })

const byManifestId = async (id: string) =>
  (await client.query('SELECT * FROM job_sources WHERE manifest_id = $1', [id])).rows[0] as
    Record<string, unknown> | undefined

/** The types whose rows the delta binds to an owner meter (PR #1372, the A1 default caps). */
const METERED_TYPES: readonly string[] = ['JOOBLE_API', 'JSEARCH_API', 'THEIRSTACK_API', 'REED_API']

const applySeedThenDelta = async (sql = delta()) => {
  await client.query(LEGACY_SEED)
  await client.query(sql)
}

describe.skipIf(!hasDatabaseUrl())('the manifest forward seed delta, against Postgres', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_sources', column: 'manifest_id' },
      { table: 'job_sources', column: 'readiness' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    built = undefined
    client = await pool.connect()
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  it('is connected to a database that is not the live one', async () => {
    const { rows } = await client.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('every manifest entry is a row, and the row equals the entry (reading rows, not SQL)', async () => {
    const before = (await rowsOf()).length
    await applySeedThenDelta()
    for (const e of manifest.entries) {
      const row = await byManifestId(e.id)
      expect(row, e.id).toBeDefined()
      // The STORED readiness: KEY_REQUIRED is checked live, never stored (PR #1372).
      const r = storedReadinessAt(e, SEED_CLOCK)
      expect(
        {
          type: row!['type'],
          config: row!['config'],
          enabled: row!['enabled'],
          trigger_mode: row!['trigger_mode'],
          namespace: row!['namespace'],
          manifest_version: row!['manifest_version'],
          policy_version: row!['policy_version'],
          config_version: row!['config_version'],
          min_interval_hours: row!['min_interval_hours'],
          budget_limit: row!['budget_limit'],
          budget_window: row!['budget_window'],
          readiness: row!['readiness'],
          readiness_reason: row!['readiness_reason'],
          admin_state: row!['admin_state'],
          metered: row!['account_meter_id'] !== null,
        },
        e.id,
      ).toEqual({
        type: e.type,
        config: e.config,
        enabled: false,
        trigger_mode: 'SCHEDULED',
        namespace: e.namespace,
        manifest_version: e.manifestVersion,
        policy_version: e.policyVersion,
        config_version: e.configVersion,
        min_interval_hours: rollbackCadenceHours(e.fetchProfile),
        budget_limit: e.budget?.limit ?? null,
        budget_window: e.budget?.window ?? null,
        readiness: r.status === 'BLOCKED' ? 'BLOCKED' : 'CANDIDATE',
        readiness_reason: readinessReason(r),
        admin_state: 'ACTIVE',
        metered: METERED_TYPES.includes(e.type),
      })
    }
    // The legacy entries now CLAIM all 16 rows the seed inserted (none was inserted a second time);
    // the other 27 are new. Working Nomads was the one seeded row no entry claimed, until task
    // sources-04 connected it - which is why the claimed count is the whole seed and not 15.
    const after = (await rowsOf()).length
    expect(legacyEntries()).toHaveLength(15)
    expect(after - before).toBe(16 + newEntries().length)
    expect(newEntries()).toHaveLength(27)
  })

  it('Arbeitnow is a CANDIDATE row with no reason, still disabled (its block was lifted, not its off switch)', async () => {
    await applySeedThenDelta()
    const row = await byManifestId('arbeitnow.api.feed')
    expect({
      type: row?.['type'],
      namespace: row?.['namespace'],
      readiness: row?.['readiness'],
      readiness_reason: row?.['readiness_reason'],
      enabled: row?.['enabled'],
      config_version: row?.['config_version'],
    }).toEqual({
      type: 'ARBEITNOW_API',
      namespace: 'arbeitnow',
      readiness: 'CANDIDATE',
      readiness_reason: null,
      enabled: false,
      config_version: 1,
    })
  })

  it('the sources the owner decided on (2026-10-24) are CANDIDATE rows with no reason, still disabled', async () => {
    await applySeedThenDelta()
    const seen: Array<[string, unknown, unknown, unknown]> = []
    for (const id of [
      'hn-hiring.thread.latest',
      'remotive.api.software-dev',
      'remotive.api.devops',
      'remotive.api.data',
      'jobgether.api.jobs',
    ]) {
      const row = await byManifestId(id)
      seen.push([id, row?.['readiness'], row?.['readiness_reason'] === null, row?.['enabled']])
    }
    expect(seen).toEqual([
      ['hn-hiring.thread.latest', 'CANDIDATE', true, false],
      ['remotive.api.software-dev', 'CANDIDATE', true, false],
      ['remotive.api.devops', 'CANDIDATE', true, false],
      ['remotive.api.data', 'CANDIDATE', true, false],
      ['jobgether.api.jobs', 'CANDIDATE', true, false],
    ])
  })

  it('no row the delta wrote is enabled', async () => {
    await applySeedThenDelta()
    expect(
      await rowsOf('SELECT 1 FROM job_sources WHERE manifest_id IS NOT NULL AND enabled'),
    ).toEqual([])
  })

  describe('steps 6 and 7: the owner meters (PR #1372)', () => {
    const meterRows = async () =>
      await rowsOf(
        `SELECT account_key, unit::text, window_kind::text, limit_amount::int AS limit_amount,
                used::int AS used, reserved::int AS reserved, uncertain::int AS uncertain,
                window_started_at, resets_at
           FROM job_account_meters WHERE account_key LIKE '%-main' ORDER BY account_key`,
      )
    const bindings = async () =>
      await rowsOf(
        `SELECT s.manifest_id, m.account_key FROM job_sources s
           JOIN job_account_meters m ON m.id = s.account_meter_id
          WHERE s.manifest_id IS NOT NULL ORDER BY s.manifest_id`,
      )

    it('seeds the A1 default caps with nothing used, the window on the current UTC day or month', async () => {
      expect(
        await rowsOf(`SELECT 1 FROM job_account_meters WHERE account_key LIKE '%-main'`),
      ).toEqual([])
      await applySeedThenDelta()
      const d = (await rowsOf('SELECT now() AS now'))[0]!['now'] as Date
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
      const window = { DAY: [dayStart, dayStart + 86_400_000], MONTH: [monthStart, nextMonth] }
      expect(
        (await meterRows()).map((m) => {
          const [start, end] = window[m['window_kind'] as 'DAY' | 'MONTH']
          return [
            m['account_key'],
            m['unit'],
            m['window_kind'],
            m['limit_amount'],
            [m['used'], m['reserved'], m['uncertain']],
            (m['window_started_at'] as Date).getTime() === start,
            (m['resets_at'] as Date).getTime() === end,
          ]
        }),
      ).toEqual([
        ['jooble:api-main', 'REQUEST', 'DAY', 50, [0, 0, 0], true, true],
        ['jsearch:rapidapi-main', 'REQUEST', 'MONTH', 150, [0, 0, 0], true, true],
        ['reed:api-main', 'REQUEST', 'DAY', 50, [0, 0, 0], true, true],
        ['theirstack:api-main', 'RECORD', 'MONTH', 150, [0, 0, 0], true, true],
      ])
    })

    it('binds each keyed row to its account meter, and no other row', async () => {
      await applySeedThenDelta()
      expect(await bindings()).toEqual([
        { manifest_id: 'jooble.api.senior-developer-remote', account_key: 'jooble:api-main' },
        { manifest_id: 'jsearch.rapidapi.ai-engineer', account_key: 'jsearch:rapidapi-main' },
        { manifest_id: 'jsearch.rapidapi.backend', account_key: 'jsearch:rapidapi-main' },
        { manifest_id: 'jsearch.rapidapi.frontend', account_key: 'jsearch:rapidapi-main' },
        { manifest_id: 'reed.api.senior-developer-remote', account_key: 'reed:api-main' },
        { manifest_id: 'theirstack.api.senior', account_key: 'theirstack:api-main' },
      ])
      expect(
        await rowsOf(
          'SELECT 1 FROM job_sources WHERE manifest_id IS NULL AND account_meter_id IS NOT NULL',
        ),
      ).toEqual([])
    })

    it('a redeploy never touches an existing meter: counters, limit and window stay as they were', async () => {
      await applySeedThenDelta()
      await client.query(
        `UPDATE job_account_meters SET used = 7, reserved = 2, uncertain = 1, limit_amount = 120,
                window_started_at = '2026-01-15T00:00:00Z', resets_at = '2026-02-15T00:00:00Z'
          WHERE account_key = 'jsearch:rapidapi-main'`,
      )
      const before = await meterRows()
      const ids = await rowsOf('SELECT id FROM job_account_meters ORDER BY id')
      await client.query(delta())
      await client.query(delta())
      expect(await meterRows()).toEqual(before)
      expect(await rowsOf('SELECT id FROM job_account_meters ORDER BY id')).toEqual(ids)
      const js = before.find((m) => m['account_key'] === 'jsearch:rapidapi-main')!
      expect([js['used'], js['reserved'], js['uncertain'], js['limit_amount']]).toEqual([
        7, 2, 1, 120,
      ])
    })

    it('a binding an admin changed stands; a binding cleared by hand is restored on the next deploy', async () => {
      await applySeedThenDelta()
      const other = (
        await rowsOf(
          `INSERT INTO job_account_meters (account_key, unit, window_kind, limit_amount)
           VALUES ('jooble:api-spare', 'REQUEST', 'LIFETIME', 10) RETURNING id`,
        )
      )[0]!['id']
      await client.query(
        `UPDATE job_sources SET account_meter_id = $1 WHERE manifest_id = 'jooble.api.senior-developer-remote'`,
        [other],
      )
      await client.query(
        `UPDATE job_sources SET account_meter_id = NULL WHERE manifest_id = 'reed.api.senior-developer-remote'`,
      )
      await client.query(delta())
      const b = await bindings()
      expect(b.find((r) => r['manifest_id'] === 'jooble.api.senior-developer-remote')).toEqual({
        manifest_id: 'jooble.api.senior-developer-remote',
        account_key: 'jooble:api-spare',
      })
      expect(b.find((r) => r['manifest_id'] === 'reed.api.senior-developer-remote')).toEqual({
        manifest_id: 'reed.api.senior-developer-remote',
        account_key: 'reed:api-main',
      })
    })
  })

  it('a row of a blocked type that no manifest entry claims is blocked, with the type reason', async () => {
    // The seed's own Working Nomads row was this case until task sources-04 connected it, and the
    // step has no natural subject left: the one blocked type (EU Remote Jobs) carries a claiming
    // entry. So the row is CONSTRUCTED - the blocked type with a config no entry has, which is what
    // an unmanaged row of a blocked type looks like in production. Step 1 cannot claim it (it
    // matches on `s.config = m.config`), so step 4 is what writes its readiness.
    await client.query(
      `INSERT INTO job_sources (type, config) VALUES ('EUREMOTEJOBS_RSS', '{"unmanaged": true}'::jsonb)`,
    )
    await applySeedThenDelta()
    const row = (
      await rowsOf(
        `SELECT * FROM job_sources WHERE type = 'EUREMOTEJOBS_RSS' AND config = '{"unmanaged": true}'::jsonb`,
      )
    )[0]!
    expect(row['manifest_id']).toBeNull()
    expect(row['readiness']).toBe('BLOCKED')
    expect(String(row['readiness_reason'])).toMatch(/^PERMISSION_PROHIBITED: /)
  })

  it('reapplying the delta leaves every row byte-identical, including updated_at', async () => {
    await applySeedThenDelta()
    const once = await snapshot()
    await client.query(delta())
    const twice = await snapshot()
    expect(twice).toEqual(once)
    await client.query(delta())
    expect(await snapshot()).toEqual(once)
  })

  it('a redeploy never resets what an ADMIN did, and never re-adds a retired source', async () => {
    await applySeedThenDelta()
    // An admin enables a claimed legacy row, spends some budget and changes its cadence ...
    await client.query(
      `UPDATE job_sources SET enabled = true, budget_used = 7, budget_limit = 9, min_interval_hours = 48,
              admin_state = 'PAUSED', disabled_reason = 'by admin'
        WHERE manifest_id = 'jsearch.rapidapi.backend'`,
    )
    // ... and retires a source the delta inserted.
    await client.query(
      `UPDATE job_sources SET admin_state = 'RETIRED', enabled = false WHERE manifest_id = 'wwr.rss.devops'`,
    )
    const count = (await rowsOf()).length
    const idOfRetired = (await byManifestId('wwr.rss.devops'))!['id']
    const adminTouched = await snapshot()

    await client.query(delta())

    expect(await snapshot()).toEqual(adminTouched)
    expect((await rowsOf()).length).toBe(count)
    expect((await byManifestId('wwr.rss.devops'))!['id']).toBe(idOfRetired)
    const jsearch = (await byManifestId('jsearch.rapidapi.backend'))!
    expect([
      jsearch['enabled'],
      jsearch['budget_used'],
      jsearch['budget_limit'],
      jsearch['min_interval_hours'],
      jsearch['admin_state'],
    ]).toEqual([true, 7, 9, 48, 'PAUSED'])
  })

  it('claiming a seeded row that an admin had already enabled does not disable it', async () => {
    await client.query(LEGACY_SEED)
    await client.query(
      `UPDATE job_sources SET enabled = true, budget_used = 3 WHERE type = 'REMOTEOK_API'`,
    )
    await client.query(delta())
    const row = (await rowsOf(`SELECT * FROM job_sources WHERE type = 'REMOTEOK_API'`))[0]!
    expect([row['enabled'], row['budget_used'], row['manifest_id']]).toEqual([
      true,
      3,
      'remoteok.api.latest',
    ])
  })

  it('an admin-set VERIFIED survives a CANDIDATE claim, but never a BLOCKED one', async () => {
    await client.query(LEGACY_SEED)
    await client.query(
      `UPDATE job_sources SET readiness = 'VERIFIED' WHERE type IN ('REMOTEOK_API', 'JSEARCH_API', 'EUREMOTEJOBS_RSS')`,
    )
    await client.query(delta())
    const readiness = async (id: string) => (await byManifestId(id))!['readiness']
    expect(await readiness('remoteok.api.latest')).toBe('VERIFIED') // manifest: CANDIDATE
    // A keyed row stores CANDIDATE (KEY_REQUIRED is checked live, PR #1372), so its VERIFIED stands.
    expect(await readiness('jsearch.rapidapi.backend')).toBe('VERIFIED')
    // EU Remote Jobs is the only BLOCKED entry left, and a BLOCKED manifest always wins.
    expect(await readiness('euremotejobs.rss.feed')).toBe('BLOCKED')
  })

  describe('step 5: a redeploy refreshes the stored readiness of a claimed row', () => {
    // Everything an admin or the runtime owns: the refresh must leave all of it as it was.
    const untouched = async (id: string) => {
      const r = (await byManifestId(id))!
      return [
        r['enabled'],
        r['admin_state'],
        r['admin_state_history'],
        r['budget_limit'],
        r['budget_used'],
        r['min_interval_hours'],
        r['consecutive_failures'],
        r['cooldown_until'],
        r['next_attempt_at'],
        r['config_version'],
      ]
    }
    const stamp = async (id: string, readiness: string, reason: string | null) => {
      await client.query(
        `UPDATE job_sources SET readiness = $2::job_source_readiness, readiness_reason = $3,
                enabled = true, budget_used = 4, updated_at = '2026-01-01T00:00:00Z'
          WHERE manifest_id = $1`,
        [id, readiness, reason],
      )
    }
    const stored = async (id: string) => {
      const r = (await byManifestId(id))!
      return [r['readiness'], r['readiness_reason']]
    }

    it('unblocks a row the owner cleared (a stale PERMISSION_UNCLEAR becomes CANDIDATE, no reason)', async () => {
      await applySeedThenDelta()
      await stamp('wwr.rss.all-jobs', 'BLOCKED', 'PERMISSION_UNCLEAR: stale, from an older deploy')
      const kept = await untouched('wwr.rss.all-jobs')
      await client.query(delta())
      expect(await stored('wwr.rss.all-jobs')).toEqual(['CANDIDATE', null])
      expect(await untouched('wwr.rss.all-jobs')).toEqual(kept)
      expect((await byManifestId('wwr.rss.all-jobs'))!['enabled']).toBe(true)
    })

    it('blocks a row the manifest now prohibits (a stale CANDIDATE becomes BLOCKED with the reason)', async () => {
      await applySeedThenDelta()
      await stamp('euremotejobs.rss.feed', 'CANDIDATE', null)
      const kept = await untouched('euremotejobs.rss.feed')
      await client.query(delta())
      const [readiness, reason] = await stored('euremotejobs.rss.feed')
      expect(readiness).toBe('BLOCKED')
      expect(String(reason)).toMatch(/^PERMISSION_PROHIBITED: /)
      expect(await untouched('euremotejobs.rss.feed')).toEqual(kept)
    })

    it('replaces a stale reason on a row that stays BLOCKED (EU Remote Jobs: UNCLEAR -> PROHIBITED)', async () => {
      await applySeedThenDelta()
      await stamp('euremotejobs.rss.feed', 'BLOCKED', 'PERMISSION_UNCLEAR: stale')
      await client.query(delta())
      const [readiness, reason] = await stored('euremotejobs.rss.feed')
      expect(readiness).toBe('BLOCKED')
      expect(String(reason)).toMatch(/^PERMISSION_PROHIBITED: /)
      expect(String(reason)).not.toContain('PERMISSION_UNCLEAR')
    })

    it('keeps a smoke-earned VERIFIED against a CANDIDATE entry, and downgrades it for a BLOCKED one', async () => {
      await applySeedThenDelta()
      await stamp('remoteok.api.latest', 'VERIFIED', null)
      await stamp('euremotejobs.rss.feed', 'VERIFIED', null)
      await client.query(delta())
      expect(await stored('remoteok.api.latest')).toEqual(['VERIFIED', null])
      const [readiness, reason] = await stored('euremotejobs.rss.feed')
      expect(readiness).toBe('BLOCKED')
      expect(reason).not.toBeNull()
    })

    it('moves updated_at only on a row whose readiness really changed', async () => {
      await applySeedThenDelta()
      await stamp('wwr.rss.all-jobs', 'BLOCKED', 'PERMISSION_UNCLEAR: stale')
      await stamp('wwr.rss.devops', 'CANDIDATE', null) // already what the manifest says
      await client.query(delta())
      const at = async (id: string) => new Date(String((await byManifestId(id))!['updated_at']))
      expect((await at('wwr.rss.all-jobs')).getTime()).toBeGreaterThan(Date.parse('2026-02-01'))
      expect((await at('wwr.rss.devops')).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    })
  })

  it('a config revision raises config_version, replaces the config, and keeps the admin state', async () => {
    await applySeedThenDelta()
    await client.query(
      `UPDATE job_sources SET enabled = true WHERE manifest_id = 'remotive.api.data'`,
    )
    const revised = reviseRemotiveData()
    const revisedDelta = generateSeedDelta(revised)

    await client.query(revisedDelta)
    const row = (await byManifestId('remotive.api.data'))!
    expect([row['config'], row['config_version'], row['enabled']]).toEqual([
      { category: 'data-engineering' },
      2,
      true,
    ])
    // A scope belongs to its config version: the entry the worker will parse says 2, too.
    const entry = revised.entries.find((e) => e.id === 'remotive.api.data')!
    expect(entry.configVersion).toBe(2)

    // Reapplying the revision is a no-op, and so is reapplying the ORIGINAL (it is lower).
    const settled = await snapshot()
    await client.query(revisedDelta)
    await client.query(delta())
    expect(await snapshot()).toEqual(settled)
  })

  it('a board revision moves the derived namespace with it, so the row still equals the manifest', async () => {
    await applySeedThenDelta()
    const before = (await byManifestId('lever.board.spotify'))!
    expect(before['namespace']).toBe('lever:global:spotify')
    const revised = reviseSpotifyToEu()
    await client.query(generateSeedDelta(revised))
    const row = (await byManifestId('lever.board.spotify'))!
    const entry = revised.entries.find((e) => e.id === 'lever.board.spotify')!
    expect(entry.namespace).toBe('lever:eu:spotify')
    expect([
      row['namespace'],
      row['config_version'],
      (row['config'] as { region: string }).region,
    ]).toEqual(['lever:eu:spotify', 2, 'eu'])
  })

  it('an unmanaged row with the same (type, config) as a new entry is a loud failure, not a silent skip', async () => {
    await client.query(LEGACY_SEED)
    await client.query(
      `INSERT INTO job_sources (type, config) VALUES ('HIMALAYAS_API', '{}'::jsonb)`,
    )
    await expect(client.query(delta())).rejects.toThrow(/himalayas\.api\.browse/)
  })

  it('the committed file, when present, is what the generator produces (drift)', async () => {
    const { manual, staged } = seedDeltaLocations(DRIZZLE)
    const committed = readFileSync(existsSync(manual) ? manual : staged, 'utf8')
    expect(committed).toBe(delta())
    expect(SEED_DELTA_FILE).toMatch(/\.sql$/)
  })

  describe('T8 AC 7: the generated host-key delta', () => {
    const hostDelta = () => generateHostKeyDelta(manifest)
    const keys = async () =>
      (
        await client.query(
          `SELECT manifest_id, type, host_key FROM job_sources ORDER BY type, config::text`,
        )
      ).rows as { manifest_id: string | null; type: string; host_key: string | null }[]

    it('sets every reporting source`s host_key, leaves DOU NULL, and a second application changes nothing', async () => {
      await client.query(
        `INSERT INTO job_sources (type, config) VALUES ('DOU_RSS', '{"t8": 1}'::jsonb)`,
      )
      await applySeedThenDelta()
      // Before the host delta every key is NULL: the column has no default.
      expect((await keys()).every((r) => r.host_key === null)).toBe(true)
      await client.query(hostDelta())
      for (const e of manifest.entries) {
        expect((await byManifestId(e.id))?.['host_key'], e.id).toBe(e.hostKey)
      }
      const dou = (await keys()).filter((r) => r.type === 'DOU_RSS')
      expect(dou).toEqual([{ manifest_id: null, type: 'DOU_RSS', host_key: null }])
      const once = await snapshot()
      await client.query(hostDelta())
      expect(await snapshot()).toEqual(once)
    })

    it('never overwrites a key a row already has, and touches no row without a manifest_id', async () => {
      await applySeedThenDelta()
      await client.query(
        `UPDATE job_sources SET host_key = 'kept.example' WHERE manifest_id = 'remotive.api.data'`,
      )
      await client.query(
        `INSERT INTO job_sources (type, config) VALUES ('HIMALAYAS_API', '{"t8": "unmanaged"}'::jsonb)`,
      )
      await client.query(hostDelta())
      expect((await byManifestId('remotive.api.data'))?.['host_key']).toBe('kept.example')
      expect((await byManifestId('remotive.api.devops'))?.['host_key']).toBe('remotive.com')
      const unmanaged = (
        await client.query(
          `SELECT host_key FROM job_sources WHERE config = '{"t8": "unmanaged"}'::jsonb`,
        )
      ).rows
      expect(unmanaged).toEqual([{ host_key: null }])
    })
  })
})

/** The manifest with Spotify's board moved to the EU host: the config changes, and so does the namespace. */
function reviseSpotifyToEu(): Manifest {
  return buildManifest({
    definitions: MANIFEST_DEFINITIONS.map((d) =>
      d.type !== 'LEVER_ATS'
        ? d
        : {
            ...d,
            entries: d.entries.map((e) =>
              e.id === 'lever.board.spotify'
                ? { ...e, config: { board: 'spotify', region: 'eu' }, configVersion: 2 }
                : e,
            ),
          },
    ),
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
}

/** The manifest with Remotive's `data` entry revised: new config, config_version 2. */
function reviseRemotiveData(): Manifest {
  return buildManifest({
    definitions: MANIFEST_DEFINITIONS.map((d) =>
      d.type !== 'REMOTIVE_API'
        ? d
        : {
            ...d,
            entries: d.entries.map((e) =>
              e.id === 'remotive.api.data'
                ? { ...e, config: { category: 'data-engineering' }, configVersion: 2 }
                : e,
            ),
          },
    ),
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
}
