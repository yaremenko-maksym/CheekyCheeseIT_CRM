import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobSourceTypeSchema } from '@crm/shared'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * `manual/2026-11-23_remove_muse_api.sql` against a REAL Postgres (owner decision 2026-11-23:
 * remove The Muse fully, its append-only health events included).
 *
 * The pushed `public` schema has no MUSE_API (the Drizzle enum dropped it), so the spec first
 * builds the production state: the label is re-added where it sat (after THEIRSTACK_API), the
 * append-only triggers are installed from their own manual file, and a Muse source with runs and
 * health events is seeded next to a control source that must survive. Then:
 *  - too many Muse rows: the file refuses and rolls back, the trigger untouched;
 *  - the file applied twice: the Muse rows are gone, the label is gone, the other labels keep their
 *    order, every CHECK / index / default that names the type reads back exactly as before, the
 *    append-only trigger is ENABLE ALWAYS again and still refuses a DELETE.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run remove-muse-api-migration.integration
 */
const MANUAL = join(__dirname, '..', '..', 'drizzle', 'manual')
const FILE = join(MANUAL, '2026-11-23_remove_muse_api.sql')
const HEALTH_EVENTS_FILE = join(MANUAL, '2026-10-31_job_source_health_events.sql')
const TRIGGERS = [
  'trg_job_source_health_events_append_only',
  'trg_job_source_health_events_no_truncate',
] as const

let pool: Pool
let client: PoolClient
let museSource: string
let controlSource: string
let controlEvent: string
let cycleId: string
let catalogBefore: Catalog

type Catalog = {
  constraints: { rel: string; name: string; def: string }[]
  indexes: { name: string; def: string }[]
  defaults: { rel: string; col: string; expr: string }[]
  columns: { rel: string; col: string; type: string }[]
}

async function applyFile(path: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(path, 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

async function labels(): Promise<string[]> {
  const { rows } = await client.query<{ l: string }>(
    `SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = 'job_source_type'::regtype ORDER BY enumsortorder`,
  )
  return rows.map((r) => r.l)
}

/** Everything that names the type, read the way the file reads it (pg_depend + pg_get_*def). */
async function catalog(): Promise<Catalog> {
  const deps = `SELECT objid FROM pg_depend
                 WHERE refobjid IN ('job_source_type'::regtype, 'job_source_type[]'::regtype)`
  const constraints = await client.query(
    `SELECT conrelid::regclass::text AS rel, conname AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE oid IN (${deps}) ORDER BY 1, 2`,
  )
  const indexes = await client.query(
    `SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def
       FROM pg_class c
      WHERE c.relkind = 'i'
        AND (c.oid IN (${deps}) OR c.oid IN (SELECT i.indexrelid FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
             WHERE a.atttypid IN ('job_source_type'::regtype, 'job_source_type[]'::regtype)))
      ORDER BY 1`,
  )
  const defaults = await client.query(
    `SELECT ad.adrelid::regclass::text AS rel, a.attname AS col, pg_get_expr(ad.adbin, ad.adrelid) AS expr
       FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
      WHERE ad.oid IN (${deps}) ORDER BY 1, 2`,
  )
  const columns = await client.query(
    `SELECT c.relname AS rel, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT a.attisdropped
        AND a.atttypid IN ('job_source_type'::regtype, 'job_source_type[]'::regtype)
      ORDER BY 1, 2`,
  )
  return {
    constraints: constraints.rows,
    indexes: indexes.rows,
    defaults: defaults.rows,
    columns: columns.rows,
  }
}

async function triggerStates(): Promise<Record<string, string>> {
  const { rows } = await client.query<{ tgname: string; tgenabled: string }>(
    `SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'job_source_health_events'::regclass AND tgname = ANY ($1) ORDER BY tgname`,
    [TRIGGERS],
  )
  return Object.fromEntries(rows.map((r) => [r.tgname, r.tgenabled]))
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql, params)
  return Number(rows[0]!.n)
}

async function insertSource(type: string, tag: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO job_sources (type, config) VALUES ($1::job_source_type, $2::jsonb) RETURNING id`,
    [type, JSON.stringify({ spec: 'remove-muse-api', tag })],
  )
  return rows[0]!.id
}

async function insertRun(sourceId: string, attempt: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, outcome,
        ended_at, account_key)
     VALUES ($1, $2, $3, 1, 'spec-1', 'SCHEDULED', 'FAILED', now(), 'spec-remove-muse')
     RETURNING id`,
    [sourceId, cycleId, attempt],
  )
  return rows[0]!.id
}

async function insertEvent(sourceId: string, runId: string | null): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO job_source_health_events (source_id, kind, to_state, first_bad_run_id)
     VALUES ($1, 'TRANSITION', 'FAILING', $2) RETURNING id`,
    [sourceId, runId],
  )
  return rows[0]!.id
}

const museRows = async () => ({
  sources: await count(`SELECT count(*) AS n FROM job_sources WHERE id = $1`, [museSource]),
  runs: await count(`SELECT count(*) AS n FROM job_collection_runs WHERE source_id = $1`, [
    museSource,
  ]),
  events: await count(`SELECT count(*) AS n FROM job_source_health_events WHERE source_id = $1`, [
    museSource,
  ]),
})

describe.skipIf(!hasDatabaseUrl())('2026-11-23_remove_muse_api.sql', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')

    await applyFile(HEALTH_EVENTS_FILE)
    const cycle = await client.query<{ id: string }>(
      `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
      [`remove-muse-api:${Date.now()}`],
    )
    cycleId = cycle.rows[0]!.id
    catalogBefore = await catalog()

    // The production state: the label where the 2026-10-05 file put it. ADD VALUE commits on its
    // own: a new label cannot be used in the transaction that adds it.
    await client.query(
      `ALTER TYPE job_source_type ADD VALUE IF NOT EXISTS 'MUSE_API' AFTER 'THEIRSTACK_API'`,
    )
    museSource = await insertSource('MUSE_API', 'muse')
    const runs = [
      await insertRun(museSource, 'muse-1'),
      await insertRun(museSource, 'muse-2'),
      await insertRun(museSource, 'muse-3'),
    ]
    for (const run of runs) await insertEvent(museSource, run)
    await insertEvent(museSource, null)
    await insertEvent(museSource, null)

    controlSource = await insertSource('REMOTIVE_API', 'control')
    controlEvent = await insertEvent(controlSource, await insertRun(controlSource, 'control-1'))
  }, 120_000)

  afterAll(async () => {
    if (client === undefined) return
    try {
      // The control rows sit in the append-only log: suspend the guard (owner only), clear them,
      // and put it back the way the deploy leaves it.
      await client.query('BEGIN')
      await client.query(
        `ALTER TABLE job_source_health_events DISABLE TRIGGER trg_job_source_health_events_append_only`,
      )
      await client.query(`DELETE FROM job_source_health_events WHERE source_id = ANY ($1)`, [
        [controlSource, museSource],
      ])
      await client.query(
        `ALTER TABLE job_source_health_events ENABLE ALWAYS TRIGGER trg_job_source_health_events_append_only`,
      )
      await client.query(`DELETE FROM job_collection_runs WHERE source_id = ANY ($1)`, [
        [controlSource, museSource],
      ])
      await client.query(`DELETE FROM job_sources WHERE id = ANY ($1)`, [
        [controlSource, museSource],
      ])
      await client.query(`DELETE FROM job_collection_cycles WHERE id = $1`, [cycleId])
      await client.query('COMMIT')
      // A failed run would leave the label behind for every later spec: take it out again.
      if ((await labels()).includes('MUSE_API')) await applyFile(FILE)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('starts from the production state (guards the setup itself)', async () => {
    expect(await labels()).toContain('MUSE_API')
    expect(await museRows()).toEqual({ sources: 1, runs: 3, events: 5 })
    expect(await triggerStates()).toEqual({
      trg_job_source_health_events_append_only: 'A',
      trg_job_source_health_events_no_truncate: 'A',
    })
    // The dependents the file must carry across exist on this database.
    expect(catalogBefore.constraints.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ck_job_bridge_legacy_only',
        'ck_job_sources_inventory_namespace_nonempty',
        'ck_job_team_triage_subscriptions_source_types_bounded',
        'ck_job_team_triage_subscriptions_source_types_shape',
      ]),
    )
    expect(catalogBefore.indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'uq_job_source_records_identity',
        'uq_job_sources_inventory_type_namespace',
        'uq_job_sources_type_config',
      ]),
    )
    expect(catalogBefore.defaults).toHaveLength(1)
    expect(catalogBefore.columns).toHaveLength(5)
  })

  it('refuses a second Muse source and leaves everything as it was', async () => {
    const extra = await insertSource('MUSE_API', 'muse-2')
    try {
      await expect(applyFile(FILE)).rejects.toThrow(/more Muse rows than expected/)
      expect(await museRows()).toEqual({ sources: 1, runs: 3, events: 5 })
      expect(await count(`SELECT count(*) AS n FROM job_sources WHERE id = $1`, [extra])).toBe(1)
      expect(await labels()).toContain('MUSE_API')
      expect((await triggerStates())['trg_job_source_health_events_append_only']).toBe('A')
    } finally {
      await client.query(`DELETE FROM job_sources WHERE id = $1`, [extra])
    }
  })

  it('accepts a run and a health event written after the prod read', async () => {
    // The source stays enabled until the deploy: growth past the 2026-11-23 read must not block it.
    const run = await insertRun(museSource, 'muse-4')
    await insertEvent(museSource, run)
    expect(await museRows()).toEqual({ sources: 1, runs: 4, events: 6 })
  })

  for (const pass of ['first apply', 'replay'] as const) {
    it(`${pass}: Muse rows and label gone, everything else exactly as before`, async () => {
      await applyFile(FILE)

      expect(await museRows()).toEqual({ sources: 0, runs: 0, events: 0 })
      expect(
        await count(`SELECT count(*) AS n FROM job_source_health_events WHERE id = $1`, [
          controlEvent,
        ]),
      ).toBe(1)
      expect(await labels()).toEqual([...jobSourceTypeSchema.options])
      expect(await catalog()).toEqual(catalogBefore)
      expect(await triggerStates()).toEqual({
        trg_job_source_health_events_append_only: 'A',
        trg_job_source_health_events_no_truncate: 'A',
      })
      // The guard is not only flagged on: it still refuses (restrict_violation).
      await expect(
        client.query(`DELETE FROM job_source_health_events WHERE id = $1`, [controlEvent]),
      ).rejects.toMatchObject({ code: '23001' })
    })
  }
})
