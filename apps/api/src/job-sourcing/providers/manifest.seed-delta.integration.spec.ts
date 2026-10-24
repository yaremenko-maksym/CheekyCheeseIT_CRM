import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, readinessAt, readinessReason, type Manifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import {
  SEED_CLOCK,
  SEED_DELTA_FILE,
  generateSeedDelta,
  seedDeltaLocations,
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
      const r = readinessAt(e, SEED_CLOCK)
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
          account_meter_id: row!['account_meter_id'],
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
        min_interval_hours: e.intervalHours,
        budget_limit: e.budget?.limit ?? null,
        budget_window: e.budget?.window ?? null,
        readiness: r.status === 'BLOCKED' ? 'BLOCKED' : 'CANDIDATE',
        readiness_reason: readinessReason(r),
        admin_state: 'ACTIVE',
        account_meter_id: null,
      })
    }
    // The legacy entries CLAIMED the 15 rows the seed inserted (none was inserted a second time);
    // the other 19 are new, and Working Nomads (a seeded row with no entry) is the 16th seeded row.
    const after = (await rowsOf()).length
    expect(legacyEntries()).toHaveLength(15)
    expect(after - before).toBe(16 + newEntries().length)
    expect(newEntries()).toHaveLength(19)
  })

  it('no row the delta wrote is enabled, and no meter row was created', async () => {
    const meters = (await rowsOf('SELECT * FROM job_account_meters')).length
    await applySeedThenDelta()
    expect(
      await rowsOf('SELECT 1 FROM job_sources WHERE manifest_id IS NOT NULL AND enabled'),
    ).toEqual([])
    expect((await rowsOf('SELECT * FROM job_account_meters')).length).toBe(meters)
  })

  it('a seeded row of a blocked type that no entry claims (Working Nomads) is blocked, with the reason', async () => {
    await applySeedThenDelta()
    const row = (await rowsOf(`SELECT * FROM job_sources WHERE type = 'WORKINGNOMADS_API'`))[0]!
    expect(row['manifest_id']).toBeNull()
    expect(row['readiness']).toBe('BLOCKED')
    expect(String(row['readiness_reason'])).toContain('PERMISSION_UNCLEAR')
    expect(String(row['readiness_reason'])).toContain('STATUS_CONSTANT_BLOCKED')
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
      `UPDATE job_sources SET readiness = 'VERIFIED' WHERE type IN ('REMOTEOK_API', 'REMOTIVE_API')`,
    )
    await client.query(delta())
    const readiness = async (id: string) => (await byManifestId(id))!['readiness']
    expect(await readiness('remoteok.api.latest')).toBe('VERIFIED') // manifest: CANDIDATE
    expect(await readiness('remotive.api.devops')).toBe('BLOCKED') // manifest: BLOCKED wins
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
