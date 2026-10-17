import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 1.2 (part 2) — the COLLECTION machinery against the REAL Postgres
 * catalog. Every UNIQUE / partial UNIQUE / CHECK / FK / default is proven by
 * inserting and expecting the database itself to accept or reject, by error
 * code; nothing here reads Drizzle metadata (that is
 * `job-collection-schema.spec.ts`, the unit twin the mutation gate can see).
 *
 * Two of its blocks cannot be written any other way: the one-running-owner
 * guard and the meter spend guard are claims about what happens when two
 * writers race, and a single-connection test cannot observe either. They use
 * two real connections and real transactions.
 *
 * The other r5 real-DB cases — duplicate discovery configs observing one
 * native job, out-of-order revisions — belong to the records/revisions tables
 * and are already proven in `job-opportunities.integration.spec.ts` (PR #1011);
 * they run unchanged on this additive schema.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_collection1012 \
 *     pnpm --filter @crm/api test -- job-collection.integration
 *
 * The Drizzle-vs-forward-SQL catalog comparison belongs to Task 1.3 (no forward
 * SQL exists yet) and is intentionally not done here.
 */

const TAG = `it1012-${randomUUID().slice(0, 8)}`

let pool: Pool

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

/** Run a statement that MUST be rejected; return the Postgres error code + constraint. */
async function rejected(text: string, params: unknown[] = []) {
  try {
    await pool.query(text, params)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    return { code: err.code, constraint: err.constraint }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

/** Same, on a specific connection (used by the two concurrency blocks). */
async function rejectedOn(client: PoolClient, text: string, params: unknown[] = []) {
  try {
    await client.query(text, params)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    return { code: err.code, constraint: err.constraint }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const NOT_NULL_VIOLATION = '23502'

let seq = 0
const nextTag = () => {
  seq += 1
  return `${TAG}-${seq}`
}

/** A source of our own, keyed by a tagged config so the seeded rows are untouched. */
async function newSource(configVersion = 1): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_sources (type, config, config_version)
     VALUES ('DOU_RSS', jsonb_build_object('tag', $1::text), $2) RETURNING id`,
    [nextTag(), configVersion],
  )
  return rows[0].id as string
}

async function newUser(): Promise<string> {
  const t = nextTag()
  const { rows } = await q(
    `INSERT INTO users (email, display_name, role) VALUES ($1, $2, 'ADMIN') RETURNING id`,
    [`${t}@test.spec`, `${t} user`],
  )
  return rows[0].id as string
}

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [nextTag()],
  )
  return rows[0].id as string
}

async function newMeter(
  opts: { limit?: number | null; unit?: string; window?: string } = {},
): Promise<string> {
  const window = opts.window ?? 'DAY'
  // A LIFETIME meter must have NO window start (ck_..._lifetime_never_resets),
  // a rolling one must have one (ck_..._windowed_has_start).
  const { rows } = await q(
    `INSERT INTO job_account_meters (account_key, unit, window_kind, limit_amount, window_started_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      `${TAG.toLowerCase()}:${(seq += 1)}`,
      opts.unit ?? 'REQUEST',
      window,
      opts.limit === undefined ? null : opts.limit,
      window === 'LIFETIME' ? null : new Date(),
    ],
  )
  return rows[0].id as string
}

/** A STARTED run needs an owner and a lease; this is the valid shape. */
async function startRun(
  sourceId: string,
  cycleId: string,
  opts: { configVersion?: number; attemptId?: string } = {},
) {
  return q(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
        owner_token, lease_expires_at)
     VALUES ($1, $2, $3, $4, 'v1', 'SCHEDULED', $5, now() + interval '5 min') RETURNING id`,
    [sourceId, cycleId, opts.attemptId ?? nextTag(), opts.configVersion ?? 1, `owner-${nextTag()}`],
  )
}

describe.skipIf(!hasDatabaseUrl())('job collection machinery (real Postgres catalog)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_sources', column: 'manifest_id' },
      { table: 'job_collection_cycles', column: 'trigger_key' },
      { table: 'job_collection_runs', column: 'fencing_epoch' },
      { table: 'job_account_meters', column: 'limit_amount' },
      { table: 'job_account_meter_reservations', column: 'used_amount' },
      { table: 'job_dirty_work', column: 'target_version' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db')
    // Writing spec: refuse the live database outright (the vitest guard does too).
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
  })

  afterAll(async () => {
    if (!pool) return
    // Children first: every link into provenance is RESTRICT by design.
    await q(`DELETE FROM job_dirty_work WHERE reason LIKE $1`, [`${TAG}%`])
    await q(
      `DELETE FROM job_account_meter_reservations WHERE attempt_id LIKE $1
         OR cycle_id IN (SELECT id FROM job_collection_cycles WHERE trigger_key LIKE $1)`,
      [`${TAG}%`],
    )
    await q(`DELETE FROM job_collection_runs WHERE attempt_id LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE $1`, [`${TAG}%`])
    await q(`UPDATE job_sources SET account_meter_id = NULL WHERE config->>'tag' LIKE $1`, [
      `${TAG}%`,
    ])
    await q(`DELETE FROM job_account_meters WHERE account_key LIKE $1`, [`${TAG.toLowerCase()}%`])
    await q(`DELETE FROM job_sources WHERE config->>'tag' LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    await pool.end()
  })

  describe('job_sources extended in place (AC1)', () => {
    it('applies the new columns to a row inserted the OLD way (seed compatibility)', async () => {
      // Exactly the shape the immutable 2026-10-05 seed uses: type + config only.
      const { rows } = await q(
        `INSERT INTO job_sources (type, config, enabled)
         VALUES ('REMOTEOK_API', jsonb_build_object('tag', $1::text), false)
         ON CONFLICT (type, config) DO NOTHING
         RETURNING manifest_id, namespace, manifest_version, policy_version, config_version,
                   readiness, admin_state, admin_state_history, consecutive_failures,
                   account_meter_id`,
        [nextTag()],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        // NULL, not invented: no seeded row has a verified manifest identity yet.
        manifest_id: null,
        namespace: '',
        manifest_version: 1,
        policy_version: 1,
        config_version: 1,
        readiness: 'CANDIDATE',
        admin_state: 'ACTIVE',
        admin_state_history: [],
        consecutive_failures: 0,
        account_meter_id: null,
      })
    })

    it('keeps the legacy (type, config) conflict target the seed relies on', async () => {
      const tag = nextTag()
      await q(
        `INSERT INTO job_sources (type, config) VALUES ('JOBICY_API', jsonb_build_object('tag', $1::text))`,
        [tag],
      )
      const r = await rejected(
        `INSERT INTO job_sources (type, config) VALUES ('JOBICY_API', jsonb_build_object('tag', $1::text))`,
        [tag],
      )
      expect(r.code).toBe(UNIQUE_VIOLATION)
      expect(r.constraint).toBe('uq_job_sources_type_config')
    })

    it('lets MANY sources hold no manifest id, but only ONE hold a given id', async () => {
      const a = await newSource()
      const b = await newSource()
      // Two unclaimed rows coexist: the unique index is partial.
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_sources WHERE id IN ($1, $2) AND manifest_id IS NULL`,
        [a, b],
      )
      expect(rows[0].n).toBe(2)

      const id = `${TAG.toLowerCase()}-manifest`
      await q(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [id, a])
      const r = await rejected(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [id, b])
      expect(r.code).toBe(UNIQUE_VIOLATION)
      expect(r.constraint).toBe('uq_job_sources_manifest_id')
    })

    /**
     * What the CHECK guarantees, stated precisely: a bounded lowercase
     * alphabet. That rules out an uppercase bearer token, a base64 blob
     * (`+ / =` are absent), a URL (`/` is absent) and anything over 100
     * characters. It does NOT rule out a lowercase alphanumeric string that
     * happens to be a credential — no regex can, and claiming otherwise in a
     * test name would be the kind of false assurance a reviewer rightly
     * distrusts. Keeping a secret out of this column is a worker obligation.
     */
    it('refuses a manifest id outside the bounded lowercase alphabet', async () => {
      const id = await newSource()
      for (const bad of [
        'Bearer-ABCDEF', // uppercase
        'aGVsbG8+d29ybGQ=', // base64
        'https://example.com/x', // a URL
        'a'.repeat(101), // over the bound
        'has space',
        '-leading-dash',
        '',
      ]) {
        const r = await rejected(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [bad, id])
        expect({ bad, code: r.code }).toEqual({ bad, code: CHECK_VIOLATION })
      }
      // ... and accepts the intended shape.
      await q(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [
        `${TAG.toLowerCase()}:remoteok.v1`,
        id,
      ])
    })

    it('requires a stated reason before a source may be readiness-BLOCKED', async () => {
      const id = await newSource()
      const r = await rejected(`UPDATE job_sources SET readiness = 'BLOCKED' WHERE id = $1`, [id])
      expect(r.code).toBe(CHECK_VIOLATION)
      expect(r.constraint).toBe('ck_job_sources_blocked_has_reason')
      await q(
        `UPDATE job_sources SET readiness = 'BLOCKED', readiness_reason = 'no API key' WHERE id = $1`,
        [id],
      )
    })

    it('refuses a non-positive version, a negative failure count and a non-array history', async () => {
      const id = await newSource()
      for (const [sql_, constraint] of [
        [
          `UPDATE job_sources SET config_version = 0 WHERE id = $1`,
          'ck_job_sources_versions_positive',
        ],
        [
          `UPDATE job_sources SET manifest_version = -1 WHERE id = $1`,
          'ck_job_sources_versions_positive',
        ],
        [
          `UPDATE job_sources SET consecutive_failures = -1 WHERE id = $1`,
          'ck_job_sources_consecutive_failures_nonneg',
        ],
        [
          `UPDATE job_sources SET admin_state_history = '{"a":1}'::jsonb WHERE id = $1`,
          'ck_job_sources_admin_state_history_array',
        ],
      ] as const) {
        const r = await rejected(sql_, [id])
        expect({ sql_, code: r.code, constraint: r.constraint }).toEqual({
          sql_,
          code: CHECK_VIOLATION,
          constraint,
        })
      }
    })

    it('refuses a last error message long enough to be a raw upstream body', async () => {
      const id = await newSource()
      const r = await rejected(`UPDATE job_sources SET last_error_message = $1 WHERE id = $2`, [
        'x'.repeat(501),
        id,
      ])
      expect(r.constraint).toBe('ck_job_sources_last_error_bounded')
      await q(
        `UPDATE job_sources SET last_error_code = 'HTTP_403', last_error_message = $1 WHERE id = $2`,
        ['provider refused: forbidden', id],
      )
    })

    it('refuses an error code that is not a TYPED code, and bounds the readiness reason', async () => {
      const id = await newSource()
      // What the column was documented as refusing and in fact accepted: a raw
      // upstream body, which is where a leaked credential travels.
      const body = await rejected(`UPDATE job_sources SET last_error_code = $1 WHERE id = $2`, [
        'Forbidden: the provider returned {"api_key":"sk_live_0123456789abcdef"}',
        id,
      ])
      expect(body).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_sources_last_error_code_format',
      })
      const long = await rejected(`UPDATE job_sources SET last_error_code = $1 WHERE id = $2`, [
        'C'.repeat(65),
        id,
      ])
      expect(long.constraint).toBe('ck_job_sources_last_error_code_format')
      const lower = await rejected(`UPDATE job_sources SET last_error_code = $1 WHERE id = $2`, [
        'http_403',
        id,
      ])
      expect(lower.constraint).toBe('ck_job_sources_last_error_code_format')
      const reason = await rejected(
        `UPDATE job_sources SET readiness = 'BLOCKED', readiness_reason = $1 WHERE id = $2`,
        ['x'.repeat(501), id],
      )
      expect(reason).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_sources_readiness_reason_bounded',
      })
      // Both bounds are inclusive: 64 characters of code, 500 of reason.
      await q(
        `UPDATE job_sources
         SET last_error_code = $1, readiness = 'BLOCKED', readiness_reason = $2
         WHERE id = $3`,
        ['C'.repeat(64), 'x'.repeat(500), id],
      )
    })

    it('releases the meter reference instead of pinning the source when an account is retired', async () => {
      const id = await newSource()
      const meter = await newMeter()
      await q(`UPDATE job_sources SET account_meter_id = $1 WHERE id = $2`, [meter, id])
      await q(`DELETE FROM job_account_meters WHERE id = $1`, [meter])
      const { rows } = await q(`SELECT account_meter_id FROM job_sources WHERE id = $1`, [id])
      expect(rows[0].account_meter_id).toBeNull()
    })

    it('refuses an account meter that does not exist', async () => {
      const id = await newSource()
      const r = await rejected(`UPDATE job_sources SET account_meter_id = $1 WHERE id = $2`, [
        randomUUID(),
        id,
      ])
      expect(r.code).toBe(FK_VIOLATION)
    })
  })

  describe('job_collection_cycles (AC3)', () => {
    it('deduplicates a trigger occurrence in the DATABASE', async () => {
      const key = nextTag()
      await q(`INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1)`, [
        key,
      ])
      const r = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1)`,
        [key],
      )
      expect(r.code).toBe(UNIQUE_VIOLATION)
      expect(r.constraint).toBe('uq_job_collection_cycles_trigger_key')
    })

    it('scopes the dedupe BY trigger: the same key under MANUAL is a different occurrence', async () => {
      const key = nextTag()
      const actor = await newUser()
      await q(`INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1)`, [
        key,
      ])
      const { rows } = await q(
        `INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
         VALUES ('MANUAL', $1, $2) RETURNING id`,
        [key, actor],
      )
      expect(rows).toHaveLength(1)
    })

    it('defaults to OPEN with the shared 20-call HTML reservation', async () => {
      const { rows } = await q(
        `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1)
         RETURNING status, html_call_reservation, closed_at`,
        [nextTag()],
      )
      expect(rows[0]).toMatchObject({ status: 'OPEN', html_call_reservation: 20, closed_at: null })
    })

    it('ties MANUAL to an actor and SCHEDULED to none, in both directions', async () => {
      const actor = await newUser()
      const manualWithoutActor = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('MANUAL', $1)`,
        [nextTag()],
      )
      expect(manualWithoutActor.constraint).toBe('ck_job_collection_cycles_manual_has_actor')
      const scheduledWithActor = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
         VALUES ('SCHEDULED', $1, $2)`,
        [nextTag(), actor],
      )
      expect(scheduledWithActor.constraint).toBe('ck_job_collection_cycles_manual_has_actor')
    })

    it('closes only with a closing instant, and never claims OPEN with one', async () => {
      const id = await newCycle()
      const noInstant = await rejected(
        `UPDATE job_collection_cycles SET status = 'CLOSED' WHERE id = $1`,
        [id],
      )
      expect(noInstant.constraint).toBe('ck_job_collection_cycles_closed_pair')
      const openWithInstant = await rejected(
        `UPDATE job_collection_cycles SET closed_at = now() WHERE id = $1`,
        [id],
      )
      expect(openWithInstant.constraint).toBe('ck_job_collection_cycles_closed_pair')
      await q(
        `UPDATE job_collection_cycles SET status = 'CLOSED', closed_at = now() WHERE id = $1`,
        [id],
      )
    })

    it('refuses a blank trigger key and a non-positive HTML reservation', async () => {
      const blank = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', '   ')`,
      )
      expect(blank.constraint).toBe('ck_job_collection_cycles_trigger_key_nonempty')
      const zero = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key, html_call_reservation)
         VALUES ('SCHEDULED', $1, 0)`,
        [nextTag()],
      )
      expect(zero.constraint).toBe('ck_job_collection_cycles_html_reservation_positive')
    })

    it('keeps the cycle when its actor is deleted: a cycle is provenance', async () => {
      const actor = await newUser()
      await q(
        `INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
         VALUES ('MANUAL', $1, $2)`,
        [nextTag(), actor],
      )
      const r = await rejected(`DELETE FROM users WHERE id = $1`, [actor])
      expect(r.code).toBe(FK_VIOLATION)
    })
  })

  describe('job_collection_runs (AC2)', () => {
    it('starts with STARTED / PARTIAL, zeroed counts and an empty checkpoint', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const { rows } = await startRun(source, cycle)
      const { rows: got } = await q(
        `SELECT outcome, coverage, received, created, persistence_errors, checkpoint,
                source_config_snapshot, fencing_epoch, ended_at
         FROM job_collection_runs WHERE id = $1`,
        [rows[0].id],
      )
      expect(got[0]).toMatchObject({
        outcome: 'STARTED',
        // The strictest reading: a run that dies before reporting coverage
        // must not be read as having covered the whole inventory.
        coverage: 'PARTIAL',
        received: 0,
        created: 0,
        persistence_errors: 0,
        checkpoint: {},
        source_config_snapshot: {},
        fencing_epoch: '1',
        ended_at: null,
      })
    })

    it('is one row per (source, attempt): a retry under the same id does not double up', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const attempt = nextTag()
      await startRun(source, cycle, { attemptId: attempt })
      await q(
        `UPDATE job_collection_runs SET outcome = 'FAILED', ended_at = now() WHERE attempt_id = $1`,
        [attempt],
      )
      const r = await rejected(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
            owner_token, lease_expires_at)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', 'o', now())`,
        [source, cycle, attempt],
      )
      expect(r.code).toBe(UNIQUE_VIOLATION)
      expect(r.constraint).toBe('uq_job_collection_runs_attempt')
    })

    it('permits ONE running owner per (source, config) and frees the slot when it ends', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const first = await startRun(source, cycle)
      const second = await rejected(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
            owner_token, lease_expires_at)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', 'other-owner', now() + interval '5 min')`,
        [source, cycle, nextTag()],
      )
      expect(second.code).toBe(UNIQUE_VIOLATION)
      expect(second.constraint).toBe('uq_job_collection_runs_running_owner')

      // Terminal runs are history, not contenders: the slot reopens.
      await q(`UPDATE job_collection_runs SET outcome = 'FAILED', ended_at = now() WHERE id = $1`, [
        first.rows[0].id,
      ])
      await startRun(source, cycle)
    })

    it('scopes the running-owner slot BY config version: a new config may start at once', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      await startRun(source, cycle, { configVersion: 1 })
      // A config bump invalidates the old checkpoint, so the new-config run is
      // not the same work and does not wait for the stale one.
      const { rows } = await startRun(source, cycle, { configVersion: 2 })
      expect(rows).toHaveLength(1)
    })

    it('keeps workflow state independent per source: two sources run at once', async () => {
      const cycle = await newCycle()
      const a = await newSource()
      const b = await newSource()
      await startRun(a, cycle)
      const { rows } = await startRun(b, cycle)
      expect(rows).toHaveLength(1)
      const { rows: running } = await q(
        `SELECT count(*)::int AS n FROM job_collection_runs
         WHERE cycle_id = $1 AND outcome = 'STARTED'`,
        [cycle],
      )
      expect(running[0].n).toBe(2)
    })

    it('requires an owner and a lease while running, and an end instant once terminal', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const unowned = await rejected(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED')`,
        [source, cycle, nextTag()],
      )
      expect(unowned.constraint).toBe('ck_job_collection_runs_running_has_lease')

      const { rows } = await startRun(source, cycle)
      const noEnd = await rejected(
        `UPDATE job_collection_runs SET outcome = 'SUCCEEDED' WHERE id = $1`,
        [rows[0].id],
      )
      expect(noEnd.constraint).toBe('ck_job_collection_runs_terminal_pair')
      const endedWhileRunning = await rejected(
        `UPDATE job_collection_runs SET ended_at = now() WHERE id = $1`,
        [rows[0].id],
      )
      expect(endedWhileRunning.constraint).toBe('ck_job_collection_runs_terminal_pair')
    })

    it('bounds the dispositions by the received count at every moment', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const { rows } = await startRun(source, cycle)
      // Mid-run: fewer dispositions than received is normal.
      await q(
        `UPDATE job_collection_runs SET received = 10, created = 3, unchanged = 2 WHERE id = $1`,
        [rows[0].id],
      )
      const r = await rejected(`UPDATE job_collection_runs SET created = 9 WHERE id = $1`, [
        rows[0].id,
      ])
      expect(r.constraint).toBe('ck_job_collection_runs_dispositions_bounded')
    })

    it('lets SUCCEEDED carry zero items but never an unsettled or failed disposition', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const { rows } = await startRun(source, cycle)
      const id = rows[0].id

      await q(`UPDATE job_collection_runs SET received = 10, created = 4 WHERE id = $1`, [id])
      const incomplete = await rejected(
        `UPDATE job_collection_runs SET outcome = 'SUCCEEDED', coverage = 'FULL_INVENTORY', ended_at = now() WHERE id = $1`,
        [id],
      )
      expect(incomplete.constraint).toBe('ck_job_collection_runs_succeeded_complete')

      await q(
        `UPDATE job_collection_runs SET unchanged = 5, persistence_errors = 1 WHERE id = $1`,
        [id],
      )
      const withPersistenceError = await rejected(
        `UPDATE job_collection_runs SET outcome = 'SUCCEEDED', ended_at = now() WHERE id = $1`,
        [id],
      )
      expect(withPersistenceError.constraint).toBe('ck_job_collection_runs_succeeded_complete')

      // A PARTIAL run may keep the persistence error: it is OUR fault, recorded.
      await q(
        `UPDATE job_collection_runs SET outcome = 'PARTIAL', ended_at = now() WHERE id = $1`,
        [id],
      )

      // A valid empty feed is SUCCEEDED, not FAILED (r5).
      const empty = await startRun(await newSource(), cycle)
      await q(
        `UPDATE job_collection_runs
         SET outcome = 'SUCCEEDED', coverage = 'FULL_INVENTORY', received = 0, ended_at = now()
         WHERE id = $1`,
        [empty.rows[0].id],
      )
    })

    it('refuses a negative count, a non-positive epoch and an oversized error message', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const { rows } = await startRun(source, cycle)
      const id = rows[0].id
      for (const [sql_, constraint] of [
        [
          `UPDATE job_collection_runs SET received = -1 WHERE id = $1`,
          'ck_job_collection_runs_counts_nonneg',
        ],
        [
          `UPDATE job_collection_runs SET fencing_epoch = 0 WHERE id = $1`,
          'ck_job_collection_runs_fencing_epoch_positive',
        ],
        [
          `UPDATE job_collection_runs SET config_version = 0 WHERE id = $1`,
          'ck_job_collection_runs_config_version_positive',
        ],
      ] as const) {
        const r = await rejected(sql_, [id])
        expect({ sql_, constraint: r.constraint }).toEqual({ sql_, constraint })
      }
      const long = await rejected(
        `UPDATE job_collection_runs SET error_message = $1 WHERE id = $2`,
        ['x'.repeat(501), id],
      )
      expect(long.constraint).toBe('ck_job_collection_runs_error_message_bounded')
      const freeText = await rejected(
        `UPDATE job_collection_runs SET error_code = $1 WHERE id = $2`,
        ['Forbidden: upstream said {"token":"abcdef0123456789abcdef"}', id],
      )
      expect(freeText).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_collection_runs_error_code_format',
      })
      const longCode = await rejected(
        `UPDATE job_collection_runs SET error_code = $1 WHERE id = $2`,
        ['C'.repeat(65), id],
      )
      expect(longCode.constraint).toBe('ck_job_collection_runs_error_code_format')
      await q(`UPDATE job_collection_runs SET error_code = 'HTTP_429' WHERE id = $1`, [id])
    })

    it('never lets a source or a cycle be deleted out from under its history', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      await startRun(source, cycle)
      const bySource = await rejected(`DELETE FROM job_sources WHERE id = $1`, [source])
      expect(bySource.code).toBe(FK_VIOLATION)
      const byCycle = await rejected(`DELETE FROM job_collection_cycles WHERE id = $1`, [cycle])
      expect(byCycle.code).toBe(FK_VIOLATION)
    })
  })

  describe('job_account_meters (AC4)', () => {
    it('keeps DAY, MONTH and LIFETIME meters of one account as distinct rows', async () => {
      const key = `${TAG.toLowerCase()}:shared`
      for (const [window, started] of [
        ['DAY', 'now()'],
        ['MONTH', 'now()'],
        ['LIFETIME', 'NULL'],
      ] as const) {
        await q(
          `INSERT INTO job_account_meters (account_key, unit, window_kind, window_started_at)
           VALUES ($1, 'REQUEST', $2, ${started})`,
          [key, window],
        )
      }
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_account_meters WHERE account_key = $1`,
        [key],
      )
      expect(rows[0].n).toBe(3)
      const dup = await rejected(
        `INSERT INTO job_account_meters (account_key, unit, window_kind, window_started_at)
         VALUES ($1, 'REQUEST', 'DAY', now())`,
        [key],
      )
      expect(dup.constraint).toBe('uq_job_account_meters_identity')
    })

    it('keeps request / record / model / money units on separate counters', async () => {
      const key = `${TAG.toLowerCase()}:units`
      for (const unit of ['REQUEST', 'RECORD', 'MODEL_CALL', 'USD_MICROS']) {
        await q(
          `INSERT INTO job_account_meters (account_key, unit, window_kind, window_started_at)
           VALUES ($1, $2, 'MONTH', now())`,
          [key, unit],
        )
      }
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_account_meters WHERE account_key = $1`,
        [key],
      )
      expect(rows[0].n).toBe(4)
    })

    // Same precision as the manifest-id case above: this is an alphabet and
    // length guard (no uppercase, no base64, no URL, ≤ 100 chars), not a
    // secret detector. It makes the common accidents fail loudly.
    it('refuses an account key outside the bounded lowercase alphabet', async () => {
      for (const bad of [
        'Bearer ABC',
        'RAPIDAPI_KEY_0123456789ABCDEF',
        'https://user:pass@api.example.com',
        'aGVsbG8+d29ybGQ=',
        'a'.repeat(101),
        '',
        ' leading',
      ]) {
        const r = await rejected(
          `INSERT INTO job_account_meters (account_key, unit, window_kind, window_started_at)
           VALUES ($1, 'REQUEST', 'DAY', now())`,
          [bad],
        )
        expect({ bad, constraint: r.constraint }).toEqual({
          bad,
          constraint: 'ck_job_account_meters_account_key_format',
        })
      }
    })

    it('is the spend guard: used + reserved + uncertain may not pass the limit', async () => {
      const meter = await newMeter({ limit: 10 })
      await q(`UPDATE job_account_meters SET used = 4, reserved = 3, uncertain = 3 WHERE id = $1`, [
        meter,
      ])
      const r = await rejected(`UPDATE job_account_meters SET used = used + 1 WHERE id = $1`, [
        meter,
      ])
      expect(r.constraint).toBe('ck_job_account_meters_spend_within_limit')
    })

    it('leaves an unlimited meter (NULL limit) free to spend', async () => {
      const meter = await newMeter({ limit: null })
      await q(`UPDATE job_account_meters SET used = 1000000 WHERE id = $1`, [meter])
      const { rows } = await q(`SELECT used, limit_amount FROM job_account_meters WHERE id = $1`, [
        meter,
      ])
      // `used` is bigint now (CR-M-2), and node-postgres renders bigint as a
      // string — the same way `fencing_epoch` already came back.
      expect(rows[0]).toMatchObject({ used: '1000000', limit_amount: null })
    })

    it('refuses a LIFETIME meter that resets, and a windowed meter with no start', async () => {
      const resets = await rejected(
        `INSERT INTO job_account_meters (account_key, unit, window_kind, resets_at)
         VALUES ($1, 'REQUEST', 'LIFETIME', now())`,
        [`${TAG.toLowerCase()}:lt1`],
      )
      expect(resets.constraint).toBe('ck_job_account_meters_lifetime_never_resets')
      const noStart = await rejected(
        `INSERT INTO job_account_meters (account_key, unit, window_kind)
         VALUES ($1, 'REQUEST', 'DAY')`,
        [`${TAG.toLowerCase()}:day1`],
      )
      expect(noStart.constraint).toBe('ck_job_account_meters_windowed_has_start')
    })

    it('refuses negative counters, a negative limit and a non-positive policy version', async () => {
      const meter = await newMeter({ limit: 5 })
      for (const [sql_, constraint] of [
        [
          `UPDATE job_account_meters SET reserved = -1 WHERE id = $1`,
          'ck_job_account_meters_counters_nonneg',
        ],
        [
          `UPDATE job_account_meters SET limit_amount = -1 WHERE id = $1`,
          'ck_job_account_meters_limit_nonneg',
        ],
        [
          `UPDATE job_account_meters SET policy_version = 0 WHERE id = $1`,
          'ck_job_account_meters_policy_version_positive',
        ],
      ] as const) {
        const r = await rejected(sql_, [meter])
        expect({ sql_, constraint: r.constraint }).toEqual({ sql_, constraint })
      }
    })
  })

  describe('job_account_meter_reservations (AC4)', () => {
    const reserve = (meter: string, cycle: string, attempt: string, amount = 1) =>
      q(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, cycle_id, amount)
         VALUES ($1, $2, $3, $4) RETURNING id, status, used_amount`,
        [meter, attempt, cycle, amount],
      )

    it('is idempotent per attempt: the retry finds its own reservation', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      const attempt = nextTag()
      const { rows } = await reserve(meter, cycle, attempt)
      expect(rows[0]).toMatchObject({ status: 'RESERVED', used_amount: '0' })
      const r = await rejected(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, cycle_id, amount)
         VALUES ($1, $2, $3, 1)`,
        [meter, attempt, cycle],
      )
      expect(r.code).toBe(UNIQUE_VIOLATION)
      expect(r.constraint).toBe('uq_job_account_meter_reservations_attempt')
    })

    it('requires a cycle on every reservation', async () => {
      const meter = await newMeter()
      const r = await rejected(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, amount)
         VALUES ($1, $2, 1)`,
        [meter, nextTag()],
      )
      expect(r.code).toBe(NOT_NULL_VIOLATION)
    })

    it('releases only provably unsent cost', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      const { rows } = await reserve(meter, cycle, nextTag(), 5)
      // Cost converted but NOT yet sent, so the refusal below is the
      // used-amount rule and not CR-L-1's send-instant rule, which has its own
      // case under "cross-row consistency". Postgres reports whichever CHECK it
      // evaluates first, so each rule is exercised on a row only it refuses.
      await q(`UPDATE job_account_meter_reservations SET used_amount = 5 WHERE id = $1`, [
        rows[0].id,
      ])
      const r = await rejected(
        `UPDATE job_account_meter_reservations SET status = 'RELEASED' WHERE id = $1`,
        [rows[0].id],
      )
      expect(r.constraint).toBe('ck_job_account_meter_reservations_released_unused')
      // An untouched reservation releases fine.
      const unsent = await reserve(meter, cycle, nextTag(), 5)
      await q(
        `UPDATE job_account_meter_reservations SET status = 'RELEASED', settled_at = now() WHERE id = $1`,
        [unsent.rows[0].id],
      )
    })

    it('records the send instant for anything past RESERVED / RELEASED', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      const { rows } = await reserve(meter, cycle, nextTag(), 2)
      for (const status of ['SENT', 'USED', 'UNCERTAIN']) {
        const r = await rejected(
          `UPDATE job_account_meter_reservations SET status = $1 WHERE id = $2`,
          [status, rows[0].id],
        )
        expect({ status, constraint: r.constraint }).toEqual({
          status,
          constraint: 'ck_job_account_meter_reservations_sent_pair',
        })
      }
      // An UNCERTAIN hold is legitimate once the request left: it may have been billed.
      await q(
        `UPDATE job_account_meter_reservations SET status = 'UNCERTAIN', sent_at = now() WHERE id = $1`,
        [rows[0].id],
      )
    })

    it('settles a USED reservation exactly once, with cost and within the amount', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      const { rows } = await reserve(meter, cycle, nextTag(), 3)
      const id = rows[0].id
      await q(
        `UPDATE job_account_meter_reservations SET status = 'SENT', sent_at = now() WHERE id = $1`,
        [id],
      )
      const unsettled = await rejected(
        `UPDATE job_account_meter_reservations SET status = 'USED', used_amount = 3 WHERE id = $1`,
        [id],
      )
      expect(unsettled.constraint).toBe('ck_job_account_meter_reservations_used_settled')
      const costless = await rejected(
        `UPDATE job_account_meter_reservations SET status = 'USED', settled_at = now() WHERE id = $1`,
        [id],
      )
      expect(costless.constraint).toBe('ck_job_account_meter_reservations_used_settled')
      const overspent = await rejected(
        `UPDATE job_account_meter_reservations SET used_amount = 4 WHERE id = $1`,
        [id],
      )
      expect(overspent.constraint).toBe('ck_job_account_meter_reservations_used_within_amount')
      await q(
        `UPDATE job_account_meter_reservations SET status = 'USED', used_amount = 3, settled_at = now() WHERE id = $1`,
        [id],
      )
    })

    it('refuses a zero-cost reservation and a blank attempt id', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      const zero = await rejected(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, cycle_id, amount)
         VALUES ($1, $2, $3, 0)`,
        [meter, nextTag(), cycle],
      )
      expect(zero.constraint).toBe('ck_job_account_meter_reservations_amount_positive')
      const blank = await rejected(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, cycle_id, amount)
         VALUES ($1, '  ', $2, 1)`,
        [meter, cycle],
      )
      expect(blank.constraint).toBe('ck_job_account_meter_reservations_attempt_id_nonempty')
    })

    it('never lets a metered account be deleted out from under its spend history', async () => {
      const meter = await newMeter({ limit: 100 })
      const cycle = await newCycle()
      await reserve(meter, cycle, nextTag())
      const r = await rejected(`DELETE FROM job_account_meters WHERE id = $1`, [meter])
      expect(r.code).toBe(FK_VIOLATION)
    })
  })

  describe('job_dirty_work (AC5)', () => {
    const enqueue = (kind: string, entityId: string, targetVersion: number, reason: string) =>
      q(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ($1, $2, $3, $4) RETURNING id, status, retry_count, checkpoint, fencing_epoch`,
        [kind, entityId, targetVersion, reason],
      )

    it('is enqueued with nothing but the row itself — no sequence, no id service', async () => {
      const { rows } = await enqueue('OPPORTUNITY', randomUUID(), 1, `${TAG}-revision`)
      expect(rows[0]).toMatchObject({
        status: 'PENDING',
        retry_count: 0,
        checkpoint: {},
        fencing_epoch: '1',
      })
      expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('is one row per (entity, target version, reason) so a producer may enqueue blindly', async () => {
      const entity = randomUUID()
      const reason = `${TAG}-exclusion`
      await enqueue('SENIOR', entity, 7, reason)
      const dup = await rejected(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('SENIOR', $1, 7, $2)`,
        [entity, reason],
      )
      expect(dup.code).toBe(UNIQUE_VIOLATION)
      expect(dup.constraint).toBe('uq_job_dirty_work_entity_target')

      // A different version, reason or entity kind is different work.
      await enqueue('SENIOR', entity, 8, reason)
      await enqueue('SENIOR', entity, 7, `${TAG}-team-change`)
      await enqueue('OPPORTUNITY', entity, 7, reason)
    })

    it('accepts a polymorphic entity id with no row behind it (no FK by design)', async () => {
      // The target can be a senior, an opportunity, an exclusion or a project
      // client: Postgres has no polymorphic FK, so this must be accepted.
      const { rows } = await enqueue('PROJECT_CLIENT', randomUUID(), 1, `${TAG}-client`)
      expect(rows).toHaveLength(1)
    })

    it('pairs CLAIMED with an owner and a lease, in both directions', async () => {
      const { rows } = await enqueue('SOURCE_RECORD', randomUUID(), 1, `${TAG}-claim`)
      const id = rows[0].id
      const bare = await rejected(`UPDATE job_dirty_work SET status = 'CLAIMED' WHERE id = $1`, [
        id,
      ])
      expect(bare.constraint).toBe('ck_job_dirty_work_claim_pair')
      const ownerWhilePending = await rejected(
        `UPDATE job_dirty_work SET claim_owner = 'w1', lease_expires_at = now() WHERE id = $1`,
        [id],
      )
      expect(ownerWhilePending.constraint).toBe('ck_job_dirty_work_claim_pair')
      await q(
        `UPDATE job_dirty_work
         SET status = 'CLAIMED', claim_owner = 'w1', claimed_at = now(),
             lease_expires_at = now() + interval '1 min'
         WHERE id = $1`,
        [id],
      )
    })

    it('refuses a HALF-SET claim on work that is not CLAIMED (CR-M-1)', async () => {
      // The hole: `(status = 'CLAIMED') = (owner IS NOT NULL AND lease IS NOT
      // NULL)` is satisfied when BOTH sides are false, so a non-CLAIMED row
      // with an owner and a NULL lease passed — the stale-owner state the
      // constraint exists to forbid.
      const { rows } = await enqueue('SOURCE_RECORD', randomUUID(), 1, `${TAG}-halfclaim`)
      const id = rows[0].id
      const ownerNoLease = await rejected(
        `UPDATE job_dirty_work SET claim_owner = 'w1' WHERE id = $1`,
        [id],
      )
      expect(ownerNoLease).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_dirty_work_claim_pair',
      })
      const leaseNoOwner = await rejected(
        `UPDATE job_dirty_work SET lease_expires_at = now() WHERE id = $1`,
        [id],
      )
      expect(leaseNoOwner.constraint).toBe('ck_job_dirty_work_claim_pair')
      // ... and on a TERMINAL row too: releasing must clear both halves.
      await q(
        `UPDATE job_dirty_work
         SET status = 'CLAIMED', claim_owner = 'w1', claimed_at = now(),
             lease_expires_at = now() + interval '1 min'
         WHERE id = $1`,
        [id],
      )
      const doneWithOwner = await rejected(
        `UPDATE job_dirty_work SET status = 'DONE', completed_at = now() WHERE id = $1`,
        [id],
      )
      expect(doneWithOwner.constraint).toBe('ck_job_dirty_work_claim_pair')
      // The release that clears both is accepted.
      await q(
        `UPDATE job_dirty_work
         SET status = 'DONE', completed_at = now(), claim_owner = NULL, lease_expires_at = NULL
         WHERE id = $1`,
        [id],
      )
    })

    it('refuses a last error code that is not a TYPED code (SR-M-2 / SPEC-M-1)', async () => {
      const { rows } = await enqueue('OPPORTUNITY', randomUUID(), 1, `${TAG}-errcode`)
      const id = rows[0].id
      const free = await rejected(`UPDATE job_dirty_work SET last_error_code = $1 WHERE id = $2`, [
        'could not reach the opportunity store (timeout after 30s)',
        id,
      ])
      expect(free).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_dirty_work_last_error_code_format',
      })
      const longCode = await rejected(
        `UPDATE job_dirty_work SET last_error_code = $1 WHERE id = $2`,
        ['C'.repeat(65), id],
      )
      expect(longCode.constraint).toBe('ck_job_dirty_work_last_error_code_format')
      await q(`UPDATE job_dirty_work SET last_error_code = 'VERSION_STALE' WHERE id = $1`, [id])
    })

    it('pairs DONE, FAILED and DEFERRED alike with a completion instant', async () => {
      for (const status of ['DONE', 'FAILED', 'DEFERRED']) {
        const { rows } = await enqueue('OPPORTUNITY', randomUUID(), 1, `${TAG}-terminal-${status}`)
        const r = await rejected(`UPDATE job_dirty_work SET status = $1 WHERE id = $2`, [
          status,
          rows[0].id,
        ])
        expect({ status, constraint: r.constraint }).toEqual({
          status,
          constraint: 'ck_job_dirty_work_terminal_pair',
        })
        await q(`UPDATE job_dirty_work SET status = $1, completed_at = now() WHERE id = $2`, [
          status,
          rows[0].id,
        ])
      }
      // ... and refuses a completion instant on work that is still pending.
      const pending = await enqueue('OPPORTUNITY', randomUUID(), 1, `${TAG}-still-pending`)
      const r = await rejected(`UPDATE job_dirty_work SET completed_at = now() WHERE id = $1`, [
        pending.rows[0].id,
      ])
      expect(r.constraint).toBe('ck_job_dirty_work_terminal_pair')
    })

    it('refuses a non-positive target version, a blank or oversized reason, a negative retry', async () => {
      const entity = randomUUID()
      const zeroVersion = await rejected(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('OPPORTUNITY', $1, 0, $2)`,
        [entity, `${TAG}-v0`],
      )
      expect(zeroVersion.constraint).toBe('ck_job_dirty_work_target_version_positive')
      const blank = await rejected(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('OPPORTUNITY', $1, 1, '   ')`,
        [entity],
      )
      expect(blank.constraint).toBe('ck_job_dirty_work_reason_nonempty')
      const long = await rejected(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('OPPORTUNITY', $1, 1, $2)`,
        [entity, 'r'.repeat(101)],
      )
      expect(long.constraint).toBe('ck_job_dirty_work_reason_bounded')

      const { rows } = await enqueue('OPPORTUNITY', entity, 1, `${TAG}-retry`)
      const negative = await rejected(`UPDATE job_dirty_work SET retry_count = -1 WHERE id = $1`, [
        rows[0].id,
      ])
      expect(negative.constraint).toBe('ck_job_dirty_work_retry_count_nonneg')
      const epoch = await rejected(`UPDATE job_dirty_work SET fencing_epoch = 0 WHERE id = $1`, [
        rows[0].id,
      ])
      expect(epoch.constraint).toBe('ck_job_dirty_work_fencing_epoch_positive')
    })
  })

  /**
   * The two claims no single-connection test can make. Both follow the same
   * shape: A takes the row, B blocks on A's lock, A commits, B is re-evaluated
   * against A's committed state and refused by the database — no advisory lock
   * and no application arithmetic anywhere in the path.
   */
  describe('bounded shapes (SR-M-1 / SR-M-3 / CR-M-2)', () => {
    it('refuses a pasted raw key as an account key or a manifest id (SR-M-1)', async () => {
      const pasted = '0123456789abcdef01234567'
      const key = await rejected(
        `INSERT INTO job_account_meters (account_key, unit, window_kind, window_started_at)
         VALUES ($1, 'REQUEST', 'DAY', now())`,
        [pasted],
      )
      expect(key).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_account_meters_account_key_segmented',
      })
      const id = await newSource()
      const manifest = await rejected(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [
        `sk.live.${pasted}`,
        id,
      ])
      expect(manifest.constraint).toBe('ck_job_sources_manifest_id_segmented')
      // A segmented id of the same length is accepted: the rule is about the
      // RUN, not the length, which the format CHECK already bounds.
      await q(`UPDATE job_sources SET manifest_id = $1 WHERE id = $2`, [
        `dou.rss.${nextTag().toLowerCase()}`,
        id,
      ])
    })

    it('refuses an oversized or wrongly typed JSONB checkpoint and snapshot (SR-M-3)', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const { rows } = await startRun(source, cycle)
      const id = rows[0].id
      const bigCheckpoint = JSON.stringify({ cursor: 'c'.repeat(9000) })
      const oversized = await rejected(
        `UPDATE job_collection_runs SET checkpoint = $1::jsonb WHERE id = $2`,
        [bigCheckpoint, id],
      )
      expect(oversized).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_collection_runs_checkpoint_bounded',
      })
      const asArray = await rejected(
        `UPDATE job_collection_runs SET checkpoint = '[]'::jsonb WHERE id = $1`,
        [id],
      )
      expect(asArray.constraint).toBe('ck_job_collection_runs_checkpoint_bounded')
      const snapshot = await rejected(
        `UPDATE job_collection_runs SET source_config_snapshot = $1::jsonb WHERE id = $2`,
        [bigCheckpoint, id],
      )
      expect(snapshot.constraint).toBe('ck_job_collection_runs_config_snapshot_bounded')
      // An ordinary checkpoint object is accepted.
      await q(`UPDATE job_collection_runs SET checkpoint = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ page: 3, remaining: ['a', 'b'] }),
        id,
      ])

      const work = await q(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('OPPORTUNITY', $1, 1, $2) RETURNING id`,
        [randomUUID(), `${TAG}-checkpoint`],
      )
      const workCheckpoint = await rejected(
        `UPDATE job_dirty_work SET checkpoint = '"scalar"'::jsonb WHERE id = $1`,
        [work.rows[0].id],
      )
      expect(workCheckpoint.constraint).toBe('ck_job_dirty_work_checkpoint_bounded')
    })

    it('gives every handle column the bound its shared schema already carried (SR-M-3)', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const over = 'h'.repeat(201)
      const triggerKey = await rejected(
        `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1)`,
        [over],
      )
      expect(triggerKey).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_collection_cycles_trigger_key_bounded',
      })
      const attempt = await rejected(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
            owner_token, lease_expires_at)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', 'owner', now() + interval '5 min')`,
        [source, cycle, over],
      )
      expect(attempt.constraint).toBe('ck_job_collection_runs_attempt_id_bounded')
      const { rows } = await startRun(source, cycle)
      const owner = await rejected(
        `UPDATE job_collection_runs SET owner_token = $1 WHERE id = $2`,
        [over, rows[0].id],
      )
      expect(owner.constraint).toBe('ck_job_collection_runs_owner_token_bounded')
      const adapter = await rejected(
        `UPDATE job_collection_runs SET adapter_version = $1 WHERE id = $2`,
        ['v'.repeat(101), rows[0].id],
      )
      expect(adapter.constraint).toBe('ck_job_collection_runs_adapter_version_bounded')
      const namespace = await rejected(`UPDATE job_sources SET namespace = $1 WHERE id = $2`, [
        over,
        source,
      ])
      expect(namespace.constraint).toBe('ck_job_sources_namespace_bounded')
      // Exactly at the bound is accepted on both.
      await q(`UPDATE job_sources SET namespace = $1 WHERE id = $2`, ['h'.repeat(200), source])
    })

    it('stores a USD_MICROS amount an integer column could not hold (CR-M-2)', async () => {
      // 2_147_483_648 micros = USD 2,147.48, one past the old `integer` ceiling.
      const meter = await newMeter({ unit: 'USD_MICROS', window: 'LIFETIME' })
      await q(`UPDATE job_account_meters SET used = $1 WHERE id = $2`, [2147483648, meter])
      const { rows } = await q(`SELECT used FROM job_account_meters WHERE id = $1`, [meter])
      expect(rows[0].used).toBe('2147483648')

      const source = await newSource()
      const cycle = await newCycle()
      const run = await startRun(source, cycle)
      const { rows: res } = await q(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, run_id, cycle_id, amount)
         VALUES ($1, $2, $3, $4, $5) RETURNING amount`,
        [meter, nextTag(), run.rows[0].id, cycle, 4294967296],
      )
      expect(res[0].amount).toBe('4294967296')
    })

    it('refuses a claim owner longer than its shared bound (SR-M-3)', async () => {
      const { rows } = await q(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('SENIOR', $1, 1, $2) RETURNING id`,
        [randomUUID(), `${TAG}-owner-bound`],
      )
      const r = await rejected(
        `UPDATE job_dirty_work
         SET status = 'CLAIMED', claim_owner = $1, claimed_at = now(),
             lease_expires_at = now() + interval '1 min'
         WHERE id = $2`,
        ['w'.repeat(201), rows[0].id],
      )
      expect(r).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_dirty_work_claim_owner_bounded',
      })
    })
  })

  describe('cross-row consistency (CR-L-1 / CR-L-2 / SPEC-L-1)', () => {
    it('refuses a send instant on a RELEASED reservation (CR-L-1)', async () => {
      const meter = await newMeter({ limit: 100 })
      const source = await newSource()
      const cycle = await newCycle()
      const run = await startRun(source, cycle)
      const { rows } = await q(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, run_id, cycle_id, amount)
         VALUES ($1, $2, $3, $4, 5) RETURNING id`,
        [meter, nextTag(), run.rows[0].id, cycle],
      )
      const r = await rejected(
        `UPDATE job_account_meter_reservations SET status = 'RELEASED', sent_at = now()
         WHERE id = $1`,
        [rows[0].id],
      )
      expect(r).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_account_meter_reservations_released_unsent',
      })
      // A release with nothing sent is what the status is FOR.
      await q(`UPDATE job_account_meter_reservations SET status = 'RELEASED' WHERE id = $1`, [
        rows[0].id,
      ])
    })

    it("refuses a run whose trigger disagrees with its cycle's (CR-L-2 / SPEC-L-1)", async () => {
      const source = await newSource()
      const cycle = await newCycle() // SCHEDULED
      const r = await rejected(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
            owner_token, lease_expires_at)
         VALUES ($1, $2, $3, 1, 'v1', 'MANUAL', 'owner', now() + interval '5 min')`,
        [source, cycle, nextTag()],
      )
      expect(r.code).toBe(FK_VIOLATION)
      expect(r.constraint).toBe('fk_job_collection_runs_cycle_trigger')
      // The matching trigger is accepted — the rule is agreement, not a ban.
      await startRun(source, cycle)
    })

    it("refuses a reservation whose cycle is not its run's cycle (CR-L-2 / SPEC-L-1)", async () => {
      const meter = await newMeter({ limit: 100 })
      const source = await newSource()
      const cycle = await newCycle()
      const otherCycle = await newCycle()
      const run = await startRun(source, cycle)
      const r = await rejected(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, run_id, cycle_id, amount)
         VALUES ($1, $2, $3, $4, 5)`,
        [meter, nextTag(), run.rows[0].id, otherCycle],
      )
      expect(r.code).toBe(FK_VIOLATION)
      expect(r.constraint).toBe('fk_job_account_meter_reservations_run_cycle')
      // A reservation with NO run (a model call) is still free to name its own
      // cycle: the composite FK is MATCH SIMPLE, so a NULL run_id skips it.
      await q(
        `INSERT INTO job_account_meter_reservations (meter_id, attempt_id, run_id, cycle_id, amount)
         VALUES ($1, $2, NULL, $3, 5)`,
        [meter, nextTag(), otherCycle],
      )
    })
  })

  describe('real-DB concurrency (AC8)', () => {
    it('two workers racing a start: exactly one holds the (source, config) slot', async () => {
      const source = await newSource()
      const cycle = await newCycle()
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        const insert = `INSERT INTO job_collection_runs
             (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
              owner_token, lease_expires_at)
           VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', $4, now() + interval '5 min')`
        await a.query(insert, [source, cycle, nextTag(), 'owner-a'])

        // B's INSERT blocks on the partial unique index until A resolves. Start
        // it WITHOUT awaiting, then let A commit.
        const bInsert = rejectedOn(b, insert, [source, cycle, nextTag(), 'owner-b'])
        await a.query('COMMIT')
        const loser = await bInsert
        expect(loser.code).toBe(UNIQUE_VIOLATION)
        expect(loser.constraint).toBe('uq_job_collection_runs_running_owner')
        await b.query('ROLLBACK')

        const { rows } = await q(
          `SELECT count(*)::int AS n, min(owner_token) AS owner FROM job_collection_runs
           WHERE source_id = $1 AND outcome = 'STARTED'`,
          [source],
        )
        expect(rows[0]).toMatchObject({ n: 1, owner: 'owner-a' })
      } finally {
        a.release()
        b.release()
      }
    })

    it('two workers racing the last unit of budget: exactly one spends it', async () => {
      const meter = await newMeter({ limit: 1 })
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        const spend = `UPDATE job_account_meters SET reserved = reserved + 1 WHERE id = $1`
        await a.query(spend, [meter])

        // Both read "room for one". B blocks on A's row lock; when A commits, B
        // re-evaluates against reserved = 1 and the CHECK refuses it. This is
        // the whole reason the guard is a CHECK and not application arithmetic.
        const bSpend = rejectedOn(b, spend, [meter])
        await a.query('COMMIT')
        const loser = await bSpend
        expect(loser.code).toBe(CHECK_VIOLATION)
        expect(loser.constraint).toBe('ck_job_account_meters_spend_within_limit')
        await b.query('ROLLBACK')

        const { rows } = await q(
          `SELECT used, reserved, uncertain, limit_amount FROM job_account_meters WHERE id = $1`,
          [meter],
        )
        expect(rows[0]).toMatchObject({
          used: '0',
          reserved: '1',
          uncertain: '0',
          limit_amount: '1',
        })
      } finally {
        a.release()
        b.release()
      }
    })

    it('two replicas racing one trigger: exactly one cycle exists for the occurrence', async () => {
      const key = nextTag()
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        const insert = `INSERT INTO job_collection_cycles (trigger, trigger_key)
                        VALUES ('SCHEDULED', $1)`
        await a.query(insert, [key])
        const bInsert = rejectedOn(b, insert, [key])
        await a.query('COMMIT')
        const loser = await bInsert
        expect(loser.code).toBe(UNIQUE_VIOLATION)
        expect(loser.constraint).toBe('uq_job_collection_cycles_trigger_key')
        await b.query('ROLLBACK')

        const { rows } = await q(
          `SELECT count(*)::int AS n FROM job_collection_cycles WHERE trigger_key = $1`,
          [key],
        )
        expect(rows[0].n).toBe(1)
      } finally {
        a.release()
        b.release()
      }
    })
  })
})
