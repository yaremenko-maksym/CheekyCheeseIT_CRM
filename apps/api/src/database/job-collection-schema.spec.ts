import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  jobCollectionCoverageSchema,
  jobCollectionCycleStatusSchema,
  jobCollectionOutcomeSchema,
  jobCollectionTriggerSchema,
  jobDirtyWorkEntityKindSchema,
  jobDirtyWorkStatusSchema,
  jobMeterReservationStatusSchema,
  jobMeterUnitSchema,
  jobMeterWindowSchema,
  jobSourceAdminStateSchema,
  jobSourceReadinessSchema,
} from '@crm/shared'
import {
  jobAccountMeterReservations,
  jobAccountMeters,
  jobCollectionCoverageEnum,
  jobCollectionCycles,
  jobCollectionCycleStatusEnum,
  jobCollectionOutcomeEnum,
  jobCollectionRuns,
  jobCollectionTriggerEnum,
  jobDirtyWork,
  jobDirtyWorkEntityKindEnum,
  jobDirtyWorkStatusEnum,
  jobMeterReservationStatusEnum,
  jobMeterUnitEnum,
  jobMeterWindowEnum,
  jobSourceAdminStateEnum,
  jobSourceReadinessEnum,
  jobSources,
  SYNTHETIC_SOURCE_ACCOUNT_KEY_PATTERN,
} from './schema'
import { JOB_PUBLIC_ID_PATTERN } from './schema/job-patterns'

/**
 * The wired forward DDL of Task 2.5 T1 + T1b (moved from `manual-staged/` by backlog 337;
 * the fallback stays for a checkout that predates the move).
 * It carries the account-key CHECK as SQL text, i.e. a hard-coded COPY of the two
 * patterns the Drizzle declaration builds from constants — read here so a drift between
 * the copy and the constants fails a unit spec, not only the integration catalog diff.
 */
const T1_FORWARD_DDL = (() => {
  const name = '2026-10-24_job_run_single_flight.sql'
  const drizzle = join(__dirname, '..', '..', 'drizzle')
  const wired = join(drizzle, 'manual', name)
  return readFileSync(existsSync(wired) ? wired : join(drizzle, 'manual-staged', name), 'utf8')
})()

/**
 * r5 Task 1.2 (part 2) — the COLLECTION half of the store, asserted against the
 * Drizzle metadata (the same declarations `db:push` applies). Real-catalog proof
 * is `job-collection.integration.spec.ts` against a scratch database.
 *
 * The unit twin exists because the mutation gate runs unit specs only: a mutated
 * column name, default or predicate has to die somewhere the gate can see.
 */

const render = (s: unknown) => new PgDialect().sqlToQuery(s as SQL).sql

type Table = Parameters<typeof getTableConfig>[0]

const names = (t: Table) => getTableConfig(t).columns.map((c) => c.name)
const col = (t: Table, n: string) => {
  const c = getTableConfig(t).columns.find((x) => x.name === n)
  if (!c) throw new Error(`no column ${n}`)
  return c
}
const checkNames = (t: Table) => getTableConfig(t).checks.map((c) => c.name)
const checkSql = (t: Table, n: string) => {
  const c = getTableConfig(t).checks.find((x) => x.name === n)
  if (!c) throw new Error(`no check ${n}`)
  return render(c.value)
}
const uniqueCols = (t: Table, n: string) => {
  const u = getTableConfig(t).uniqueConstraints.find((x) => x.name === n)
  if (!u) throw new Error(`no unique ${n}`)
  return u.columns.map((c) => c.name)
}
const idx = (t: Table, n: string) => {
  const i = getTableConfig(t).indexes.find((x) => x.config.name === n)
  if (!i) throw new Error(`no index ${n}`)
  return i
}
const idxCols = (t: Table, n: string) =>
  idx(t, n).config.columns.map((c) => ('name' in c ? (c as { name: string }).name : render(c)))
const fkByName = (t: Table, n: string) => {
  const f = getTableConfig(t).foreignKeys.find((x) => x.getName() === n)
  if (!f) throw new Error(`no fk ${n}`)
  return f
}

describe('enum parity (pg <-> shared zod)', () => {
  it.each([
    [jobCollectionTriggerEnum, jobCollectionTriggerSchema, 'job_collection_trigger'],
    [jobCollectionOutcomeEnum, jobCollectionOutcomeSchema, 'job_collection_outcome'],
    [jobCollectionCoverageEnum, jobCollectionCoverageSchema, 'job_collection_coverage'],
    [jobCollectionCycleStatusEnum, jobCollectionCycleStatusSchema, 'job_collection_cycle_status'],
    [jobSourceReadinessEnum, jobSourceReadinessSchema, 'job_source_readiness'],
    [jobSourceAdminStateEnum, jobSourceAdminStateSchema, 'job_source_admin_state'],
    [jobMeterUnitEnum, jobMeterUnitSchema, 'job_meter_unit'],
    [jobMeterWindowEnum, jobMeterWindowSchema, 'job_meter_window'],
    [
      jobMeterReservationStatusEnum,
      jobMeterReservationStatusSchema,
      'job_meter_reservation_status',
    ],
    [jobDirtyWorkEntityKindEnum, jobDirtyWorkEntityKindSchema, 'job_dirty_work_entity_kind'],
    [jobDirtyWorkStatusEnum, jobDirtyWorkStatusSchema, 'job_dirty_work_status'],
  ])('%# mirrors the shared enum member for member, in order', (pgEnum, zod, pgName) => {
    expect([...pgEnum.enumValues]).toEqual([...zod.options])
    expect(pgEnum.enumName).toBe(pgName)
  })

  it('keeps LIFETIME a property of the new meter window, not the legacy budget window', () => {
    // The legacy `job_source_budget_window` is DAY|MONTH and stays that way;
    // lifetime meters live only on the new meter table (r5 AC4).
    expect([...jobMeterWindowEnum.enumValues]).toContain('LIFETIME')
  })
})

describe('table names', () => {
  it.each([
    [jobCollectionCycles, 'job_collection_cycles'],
    [jobCollectionRuns, 'job_collection_runs'],
    [jobAccountMeters, 'job_account_meters'],
    [jobAccountMeterReservations, 'job_account_meter_reservations'],
    [jobDirtyWork, 'job_dirty_work'],
  ])('%#', (t, name) => {
    expect(getTableConfig(t).name).toBe(name)
  })
})

describe('job_sources (extended in place — AC1)', () => {
  it('keeps every pre-existing column', () => {
    expect(names(jobSources)).toEqual(
      expect.arrayContaining([
        'id',
        'type',
        'config',
        'enabled',
        'last_collected_at',
        'budget_limit',
        'budget_window',
        'budget_used',
        'budget_window_started_at',
        'trigger_mode',
        'min_interval_hours',
        'disabled_reason',
        'created_at',
        'updated_at',
      ]),
    )
  })

  it('keeps the legacy (type, config) seed identity', () => {
    expect(uniqueCols(jobSources, 'uq_job_sources_type_config')).toEqual(['type', 'config'])
  })

  it('adds the manifest identity, namespace and the version triple', () => {
    expect(names(jobSources)).toEqual(
      expect.arrayContaining([
        'manifest_id',
        'namespace',
        'manifest_version',
        'policy_version',
        'config_version',
      ]),
    )
    // NULLABLE on purpose: the 2026-10-05 seed is immutable (C-16) and carries no
    // manifest id, so a NOT NULL column would make the seed unappliable.
    expect(col(jobSources, 'manifest_id').notNull).toBe(false)
    expect(col(jobSources, 'namespace').notNull).toBe(true)
    expect(col(jobSources, 'namespace').default).toBe('')
    for (const c of ['manifest_version', 'policy_version', 'config_version']) {
      expect(col(jobSources, c).notNull).toBe(true)
      expect(col(jobSources, c).default).toBe(1)
    }
  })

  it('makes the manifest id unique only where present', () => {
    const i = idx(jobSources, 'uq_job_sources_manifest_id')
    expect(i.config.unique).toBe(true)
    expect(idxCols(jobSources, 'uq_job_sources_manifest_id')).toEqual(['manifest_id'])
    expect(render(i.config.where)).toContain('IS NOT NULL')
  })

  it('adds readiness, administrative state and its history', () => {
    expect(col(jobSources, 'readiness').default).toBe('CANDIDATE')
    expect(col(jobSources, 'readiness').notNull).toBe(true)
    expect(col(jobSources, 'admin_state').default).toBe('ACTIVE')
    expect(col(jobSources, 'admin_state').notNull).toBe(true)
    expect(names(jobSources)).toEqual(
      expect.arrayContaining(['readiness_reason', 'admin_state_history']),
    )
    expect(col(jobSources, 'admin_state_history').notNull).toBe(true)
  })

  it('adds the attempt/success/nonempty/next/cooldown instants and the failure counter', () => {
    for (const c of [
      'last_attempt_at',
      'last_success_at',
      'last_nonempty_at',
      'next_attempt_at',
      'cooldown_until',
    ]) {
      expect(col(jobSources, c).notNull).toBe(false)
      expect(col(jobSources, c).getSQLType()).toBe('timestamp with time zone')
    }
    expect(col(jobSources, 'consecutive_failures').notNull).toBe(true)
    expect(col(jobSources, 'consecutive_failures').default).toBe(0)
  })

  it('adds the last TYPED error and keeps the message bounded (no raw upstream body)', () => {
    expect(names(jobSources)).toEqual(
      expect.arrayContaining(['last_error_code', 'last_error_message']),
    )
    expect(checkSql(jobSources, 'ck_job_sources_last_error_bounded')).toContain('length')
  })

  it('references the account meter and never cascades the source away', () => {
    const f = fkByName(jobSources, 'fk_job_sources_account_meter')
    expect(f.reference().columns.map((c) => c.name)).toEqual(['account_meter_id'])
    expect(f.reference().foreignTable).toBe(jobAccountMeters)
    expect(f.onDelete).toBe('set null')
  })

  it('declares the new guards', () => {
    expect(checkNames(jobSources)).toEqual(
      expect.arrayContaining([
        'ck_job_sources_manifest_id_format',
        'ck_job_sources_versions_positive',
        'ck_job_sources_consecutive_failures_nonneg',
        'ck_job_sources_blocked_has_reason',
        'ck_job_sources_last_error_bounded',
        'ck_job_sources_admin_state_history_array',
      ]),
    )
    expect(checkSql(jobSources, 'ck_job_sources_blocked_has_reason')).toContain('BLOCKED')
    expect(checkSql(jobSources, 'ck_job_sources_admin_state_history_array')).toContain(
      'jsonb_typeof',
    )
  })

  it('bounds the typed error CODE and the readiness reason (SR-M-2 / SPEC-M-1)', () => {
    expect(checkNames(jobSources)).toEqual(
      expect.arrayContaining([
        'ck_job_sources_last_error_code_format',
        'ck_job_sources_readiness_reason_bounded',
        'ck_job_sources_config_bounded',
      ]),
    )
    // A documented classification, not free text: the column was `text` with no
    // CHECK while obligation 7 of the PR body claimed alphabet AND length were
    // bound. Task 1.3 transcribes this by hand, so the claim has to be true.
    expect(checkSql(jobSources, 'ck_job_sources_last_error_code_format')).toContain(
      '^[A-Z][A-Z0-9_]{0,63}$',
    )
    expect(checkSql(jobSources, 'ck_job_sources_readiness_reason_bounded')).toContain('500')
  })
})

describe('job_collection_cycles (AC3)', () => {
  it('carries the trigger occurrence, the HTML call budget and the closing state', () => {
    expect(names(jobCollectionCycles)).toEqual(
      expect.arrayContaining([
        'id',
        'trigger',
        'trigger_key',
        'requested_by',
        'html_call_meter_id',
        'html_call_reservation',
        'status',
        'started_at',
        'closed_at',
        'created_at',
      ]),
    )
    expect(col(jobCollectionCycles, 'id').primary).toBe(true)
    expect(col(jobCollectionCycles, 'status').default).toBe('OPEN')
  })

  it('makes the trigger-occurrence dedupe a DATABASE constraint, not a convention', () => {
    expect(uniqueCols(jobCollectionCycles, 'uq_job_collection_cycles_trigger_key')).toEqual([
      'trigger',
      'trigger_key',
    ])
  })

  it('reserves the initial 20 HTML calls per trigger by default', () => {
    expect(col(jobCollectionCycles, 'html_call_reservation').default).toBe(20)
    expect(col(jobCollectionCycles, 'html_call_reservation').notNull).toBe(true)
  })

  it('ties a MANUAL cycle to its actor and a SCHEDULED cycle to none', () => {
    const s = checkSql(jobCollectionCycles, 'ck_job_collection_cycles_manual_has_actor')
    expect(s).toContain('MANUAL')
    expect(s).toContain('requested_by')
  })

  it('closes only with a closing instant', () => {
    expect(checkSql(jobCollectionCycles, 'ck_job_collection_cycles_closed_pair')).toContain(
      'CLOSED',
    )
  })

  it('declares its guards and indexes', () => {
    expect(checkNames(jobCollectionCycles)).toEqual(
      expect.arrayContaining([
        'ck_job_collection_cycles_trigger_key_nonempty',
        'ck_job_collection_cycles_closed_pair',
        'ck_job_collection_cycles_manual_has_actor',
        'ck_job_collection_cycles_html_reservation_positive',
      ]),
    )
    expect(idxCols(jobCollectionCycles, 'idx_job_collection_cycles_status')).toEqual([
      'status',
      'started_at',
    ])
  })
})

describe('job_collection_runs (AC2)', () => {
  it('snapshots the source config, versions, trigger, outcome and coverage', () => {
    expect(names(jobCollectionRuns)).toEqual(
      expect.arrayContaining([
        'id',
        'source_id',
        'cycle_id',
        'attempt_id',
        'config_version',
        'source_config_snapshot',
        'adapter_version',
        'trigger',
        'outcome',
        'coverage',
        'owner_token',
        'account_key',
        'fencing_epoch',
        'lease_expires_at',
        'checkpoint',
        'received',
        'created',
        'revised',
        'unchanged',
        'duplicates',
        'invalid',
        'persistence_errors',
        'error_code',
        'error_message',
        'started_at',
        'ended_at',
      ]),
    )
    expect(col(jobCollectionRuns, 'outcome').default).toBe('STARTED')
    expect(col(jobCollectionRuns, 'coverage').default).toBe('PARTIAL')
    expect(col(jobCollectionRuns, 'source_config_snapshot').notNull).toBe(true)
    expect(col(jobCollectionRuns, 'checkpoint').notNull).toBe(true)
  })

  it('keeps attempt ids stable across retries: UNIQUE(source, attempt)', () => {
    expect(uniqueCols(jobCollectionRuns, 'uq_job_collection_runs_attempt')).toEqual([
      'source_id',
      'attempt_id',
    ])
  })

  it('permits ONE running owner per (source, config) via a partial unique index', () => {
    const i = idx(jobCollectionRuns, 'uq_job_collection_runs_running_owner')
    expect(i.config.unique).toBe(true)
    expect(idxCols(jobCollectionRuns, 'uq_job_collection_runs_running_owner')).toEqual([
      'source_id',
      'config_version',
    ])
    // Terminal runs are history; only STARTED rows contend for the slot.
    expect(render(i.config.where)).toContain('STARTED')
  })

  it('carries the account key every run contends on: NOT NULL text with no default (2.5 T1 + T1b)', () => {
    const c = col(jobCollectionRuns, 'account_key')
    expect(c.notNull).toBe(true)
    // T1b: the METER's text account key, not a meter row id — one paid account has
    // several meter rows (one per unit/window), and a row id would split it.
    expect(c.getSQLType()).toBe('text')
    // No default: a key the database invented would be one no other run shares,
    // and the per-account slot would then lock nothing. The writer must name it.
    expect(c.hasDefault).toBe(false)
    // LAST, where the forward DDL's `ADD COLUMN` puts it — the forward-DDL spec
    // compares column order between that path and `db:push`.
    expect(names(jobCollectionRuns).at(-1)).toBe('account_key')
  })

  it('admits only a real meter key or the synthetic #source:<uuid> as an account key (2.5 T1b)', () => {
    const s = checkSql(jobCollectionRuns, 'ck_job_collection_runs_account_key_format')
    // A real meter key: exactly the meters' own public-id alphabet, which has no `#`.
    expect(s).toContain(`account_key" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'`)
    // The synthetic key: `#source:` and a lowercase uuid, nothing else.
    expect(s).toContain(
      `account_key" ~ '^#source:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    )
    expect(s).toContain(' OR ')
  })

  it("keeps the forward DDL's hard-coded copy of both key patterns equal to the constants (2.5 T1b, SPEC-M-1)", () => {
    // The ADD CONSTRAINT statement: both patterns as the Drizzle CHECK renders them.
    const add = /ADD CONSTRAINT "ck_job_collection_runs_account_key_format" CHECK \((.*)\);/.exec(
      T1_FORWARD_DDL,
    )?.[1]
    expect(add).toBe(
      `"job_collection_runs"."account_key" ~ '${JOB_PUBLIC_ID_PATTERN}' OR ` +
        `"job_collection_runs"."account_key" ~ '${SYNTHETIC_SOURCE_ACCOUNT_KEY_PATTERN}'`,
    )
    // The normalised definition the pre-check and the final check compare against —
    // two copies (one per DO block), both exactly this.
    const normalised =
      `'CHECK (((account_key ~ ''${JOB_PUBLIC_ID_PATTERN}''::text) OR ` +
      `(account_key ~ ''${SYNTHETIC_SOURCE_ACCOUNT_KEY_PATTERN}''::text)))';`
    expect(T1_FORWARD_DDL.split(normalised)).toHaveLength(3)
  })

  it.each([
    ['uq_job_collection_runs_one_started_per_source', ['source_id']],
    ['uq_job_collection_runs_one_started_per_account', ['account_key']],
  ])('%s: one STARTED run per key, terminal runs never contend (2.5 T1)', (name, cols) => {
    const i = idx(jobCollectionRuns, name)
    expect(i.config.unique).toBe(true)
    // The key ALONE — no config_version: a config bump must not open a second slot.
    expect(idxCols(jobCollectionRuns, name)).toEqual(cols)
    expect(render(i.config.where)).toBe(`"job_collection_runs"."outcome" = 'STARTED'`)
  })

  it('carries the fencing epoch and a lease while it is running', () => {
    expect(col(jobCollectionRuns, 'fencing_epoch').notNull).toBe(true)
    expect(checkNames(jobCollectionRuns)).toContain('ck_job_collection_runs_fencing_epoch_positive')
    const s = checkSql(jobCollectionRuns, 'ck_job_collection_runs_running_has_lease')
    expect(s).toContain('owner_token')
    expect(s).toContain('lease_expires_at')
  })

  it('never deletes provenance: RESTRICT to its source and cycle', () => {
    const source = fkByName(jobCollectionRuns, 'fk_job_collection_runs_source')
    expect(source.onDelete).toBe('restrict')
    expect(source.reference().foreignTable).toBe(jobSources)
    const cycle = fkByName(jobCollectionRuns, 'fk_job_collection_runs_cycle')
    expect(cycle.onDelete).toBe('restrict')
    expect(cycle.reference().foreignTable).toBe(jobCollectionCycles)
  })

  it('bounds the dispositions by the received count and settles them on SUCCEEDED', () => {
    expect(checkSql(jobCollectionRuns, 'ck_job_collection_runs_dispositions_bounded')).toContain(
      'received',
    )
    const s = checkSql(jobCollectionRuns, 'ck_job_collection_runs_succeeded_complete')
    expect(s).toContain('SUCCEEDED')
    expect(s).toContain('persistence_errors')
  })

  it('pairs the terminal outcome with an end instant', () => {
    expect(checkSql(jobCollectionRuns, 'ck_job_collection_runs_terminal_pair')).toContain(
      'ended_at',
    )
  })

  it('keeps the sanitized error bounded (no raw upstream body)', () => {
    expect(checkSql(jobCollectionRuns, 'ck_job_collection_runs_error_message_bounded')).toContain(
      'length',
    )
  })

  it('bounds the typed error CODE too, not only the message (SR-M-2 / SPEC-M-1)', () => {
    expect(checkNames(jobCollectionRuns)).toContain('ck_job_collection_runs_error_code_format')
    expect(checkSql(jobCollectionRuns, 'ck_job_collection_runs_error_code_format')).toContain(
      '^[A-Z][A-Z0-9_]{0,63}$',
    )
  })

  it('indexes the source timeline and the cycle fan-out', () => {
    expect(idxCols(jobCollectionRuns, 'idx_job_collection_runs_cycle')).toEqual(['cycle_id'])
    expect(idxCols(jobCollectionRuns, 'idx_job_collection_runs_source_started')).toEqual([
      'source_id',
      'started_at',
    ])
  })
})

describe('job_account_meters (AC4)', () => {
  it('identifies an account WITHOUT secrets and counts used/reserved/uncertain apart', () => {
    expect(names(jobAccountMeters)).toEqual(
      expect.arrayContaining([
        'id',
        'account_key',
        'unit',
        'window_kind',
        'limit_amount',
        'used',
        'reserved',
        'uncertain',
        'window_started_at',
        'resets_at',
        'policy_version',
      ]),
    )
    for (const c of ['used', 'reserved', 'uncertain']) {
      expect(col(jobAccountMeters, c).notNull).toBe(true)
      expect(col(jobAccountMeters, c).default).toBe(0)
    }
    // NULL limit = "no published limit" — the same single meaning the legacy
    // budget_limit carries, so a nonsense number never stands for unlimited.
    expect(col(jobAccountMeters, 'limit_amount').notNull).toBe(false)
  })

  it('bounds the account key to a short lowercase id (a secret cannot fit or match)', () => {
    const s = checkSql(jobAccountMeters, 'ck_job_account_meters_account_key_format')
    expect(s).toContain('account_key')
    expect(s).toContain('99')
  })

  it('keeps one meter per (account, unit, window) so units never share a counter', () => {
    expect(uniqueCols(jobAccountMeters, 'uq_job_account_meters_identity')).toEqual([
      'account_key',
      'unit',
      'window_kind',
    ])
  })

  it('is the atomic spend guard: used + reserved + uncertain <= limit', () => {
    const s = checkSql(jobAccountMeters, 'ck_job_account_meters_spend_within_limit')
    expect(s).toContain('used')
    expect(s).toContain('reserved')
    expect(s).toContain('uncertain')
    expect(s).toContain('limit_amount')
  })

  it('keeps LIFETIME meters distinct from the resetting DAY / MONTH windows', () => {
    const lifetime = checkSql(jobAccountMeters, 'ck_job_account_meters_lifetime_never_resets')
    expect(lifetime).toContain('LIFETIME')
    expect(lifetime).toContain('resets_at')
    expect(checkSql(jobAccountMeters, 'ck_job_account_meters_windowed_has_start')).toContain(
      'window_started_at',
    )
  })

  it('declares the remaining guards', () => {
    expect(checkNames(jobAccountMeters)).toEqual(
      expect.arrayContaining([
        'ck_job_account_meters_counters_nonneg',
        'ck_job_account_meters_limit_nonneg',
        'ck_job_account_meters_policy_version_positive',
      ]),
    )
  })
})

describe('job_account_meter_reservations (AC4)', () => {
  it('is one reservation per (account meter, attempt id)', () => {
    expect(
      uniqueCols(jobAccountMeterReservations, 'uq_job_account_meter_reservations_attempt'),
    ).toEqual(['meter_id', 'attempt_id'])
  })

  it('carries the cycle on every reservation (r5: reservations before spawn)', () => {
    expect(col(jobAccountMeterReservations, 'cycle_id').notNull).toBe(true)
    expect(
      fkByName(jobAccountMeterReservations, 'fk_job_account_meter_reservations_cycle').onDelete,
    ).toBe('restrict')
  })

  it('tracks the worst-case amount apart from the exactly-once converted used amount', () => {
    expect(names(jobAccountMeterReservations)).toEqual(
      expect.arrayContaining([
        'id',
        'meter_id',
        'attempt_id',
        'run_id',
        'cycle_id',
        'status',
        'amount',
        'used_amount',
        'reserved_at',
        'sent_at',
        'settled_at',
      ]),
    )
    expect(col(jobAccountMeterReservations, 'status').default).toBe('RESERVED')
    expect(col(jobAccountMeterReservations, 'used_amount').default).toBe(0)
  })

  it('releases only provably unsent cost', () => {
    const s = checkSql(
      jobAccountMeterReservations,
      'ck_job_account_meter_reservations_released_unused',
    )
    expect(s).toContain('RELEASED')
    expect(s).toContain('used_amount')
  })

  it('requires a send instant once the request left, and a settlement once used', () => {
    expect(
      checkSql(jobAccountMeterReservations, 'ck_job_account_meter_reservations_sent_pair'),
    ).toContain('sent_at')
    const used = checkSql(
      jobAccountMeterReservations,
      'ck_job_account_meter_reservations_used_settled',
    )
    expect(used).toContain('USED')
    expect(used).toContain('settled_at')
  })

  it('declares the amount guards', () => {
    expect(checkNames(jobAccountMeterReservations)).toEqual(
      expect.arrayContaining([
        'ck_job_account_meter_reservations_amount_positive',
        'ck_job_account_meter_reservations_used_within_amount',
        'ck_job_account_meter_reservations_attempt_id_nonempty',
      ]),
    )
  })
})

describe('job_dirty_work (AC5)', () => {
  it('is writable in the producer transaction: a client-side uuid key, no sequence', () => {
    expect(col(jobDirtyWork, 'id').primary).toBe(true)
    expect(col(jobDirtyWork, 'id').getSQLType()).toBe('uuid')
    expect(col(jobDirtyWork, 'id').hasDefault).toBe(true)
    // An identity/serial column would need a sequence — a side channel the
    // producer's transaction must not depend on (r5).
    expect(getTableConfig(jobDirtyWork).columns.some((c) => c.identity !== undefined)).toBe(false)
  })

  it('is one row per (entity, target version, reason)', () => {
    expect(uniqueCols(jobDirtyWork, 'uq_job_dirty_work_entity_target')).toEqual([
      'entity_kind',
      'entity_id',
      'target_version',
      'reason',
    ])
  })

  it('carries the claim, lease, fencing epoch, retry count and checkpoint', () => {
    expect(names(jobDirtyWork)).toEqual(
      expect.arrayContaining([
        'id',
        'entity_kind',
        'entity_id',
        'target_version',
        'reason',
        'status',
        'claim_owner',
        'claimed_at',
        'lease_expires_at',
        'fencing_epoch',
        'retry_count',
        'checkpoint',
        'cycle_id',
        'last_error_code',
        'created_at',
        'completed_at',
      ]),
    )
    expect(col(jobDirtyWork, 'status').default).toBe('PENDING')
    expect(col(jobDirtyWork, 'retry_count').default).toBe(0)
    expect(col(jobDirtyWork, 'checkpoint').notNull).toBe(true)
  })

  it('pairs CLAIMED with an owner and a lease, and names the cleared state (CR-M-1)', () => {
    const s = checkSql(jobDirtyWork, 'ck_job_dirty_work_claim_pair')
    expect(s).toContain('CLAIMED')
    expect(s).toContain('claim_owner')
    // The old predicate was a single equality of two booleans, so a row with
    // status <> 'CLAIMED', an owner and NO lease made both sides false and
    // passed. The non-claimed branch must state the cleared columns itself.
    expect(s).toContain('<>')
    expect(s).toContain('"claim_owner" IS NULL')
    expect(s).toContain('"lease_expires_at" IS NULL')
  })

  it('pairs every terminal status (including DEFERRED) with a completion instant', () => {
    const s = checkSql(jobDirtyWork, 'ck_job_dirty_work_terminal_pair')
    expect(s).toContain('DEFERRED')
    expect(s).toContain('completed_at')
  })

  it('leaves the polymorphic entity id without an FK and indexes it instead', () => {
    expect(
      getTableConfig(jobDirtyWork).foreignKeys.some((f) =>
        f.reference().columns.some((c) => c.name === 'entity_id'),
      ),
    ).toBe(false)
    expect(idxCols(jobDirtyWork, 'idx_job_dirty_work_entity')).toEqual(['entity_kind', 'entity_id'])
    expect(idxCols(jobDirtyWork, 'idx_job_dirty_work_pending')).toEqual(['status', 'created_at'])
  })

  it('declares the remaining guards', () => {
    expect(checkNames(jobDirtyWork)).toEqual(
      expect.arrayContaining([
        'ck_job_dirty_work_target_version_positive',
        'ck_job_dirty_work_reason_nonempty',
        'ck_job_dirty_work_retry_count_nonneg',
        'ck_job_dirty_work_fencing_epoch_positive',
      ]),
    )
  })

  it('bounds its typed last error code (SR-M-2 / SPEC-M-1)', () => {
    expect(checkNames(jobDirtyWork)).toContain('ck_job_dirty_work_last_error_code_format')
    expect(checkSql(jobDirtyWork, 'ck_job_dirty_work_last_error_code_format')).toContain(
      '^[A-Z][A-Z0-9_]{0,63}$',
    )
  })
})

describe('bounded shapes the schema must not leave open (SR-M-1 / SR-M-3 / CR-M-2)', () => {
  it('refuses a long unbroken lowercase run in an account key or a manifest id (SR-M-1)', () => {
    // The alphabet guard rejects uppercase, base64 and URLs but still admitted
    // a pasted raw hex key: a legal id is SEGMENTED, so a run of 24+ characters
    // with no separator is refused and the paste fails loudly.
    for (const [t, name] of [
      [jobAccountMeters, 'ck_job_account_meters_account_key_segmented'],
      [jobSources, 'ck_job_sources_manifest_id_segmented'],
    ] as const) {
      const sql_ = checkSql(t, name)
      expect(sql_).toContain('[a-z0-9]{24}')
      expect(sql_).toContain('!~')
    }
  })

  it('bounds every JSONB column by type AND by serialized size (SR-M-3)', () => {
    for (const [t, name, column] of [
      [jobCollectionRuns, 'ck_job_collection_runs_checkpoint_bounded', 'checkpoint'],
      [
        jobCollectionRuns,
        'ck_job_collection_runs_config_snapshot_bounded',
        'source_config_snapshot',
      ],
      [jobDirtyWork, 'ck_job_dirty_work_checkpoint_bounded', 'checkpoint'],
      // CR-L-3: the snapshot required an object and a size bound while the
      // column it snapshots had neither — so an oversized or non-object config
      // could be stored and would fail only when a run tried to copy it.
      [jobSources, 'ck_job_sources_config_bounded', 'config'],
    ] as const) {
      const sql_ = checkSql(t, name)
      expect(sql_).toContain('jsonb_typeof')
      expect(sql_).toContain(column)
      expect(sql_).toContain('8192')
    }
  })

  it('gives every text column the length limit its zod schema already carried (SR-M-3)', () => {
    for (const [t, name, bound] of [
      [jobCollectionCycles, 'ck_job_collection_cycles_trigger_key_bounded', '200'],
      [jobCollectionRuns, 'ck_job_collection_runs_attempt_id_bounded', '200'],
      [jobCollectionRuns, 'ck_job_collection_runs_owner_token_bounded', '200'],
      [jobCollectionRuns, 'ck_job_collection_runs_adapter_version_bounded', '100'],
      [jobAccountMeterReservations, 'ck_job_account_meter_reservations_attempt_id_bounded', '200'],
      [jobDirtyWork, 'ck_job_dirty_work_claim_owner_bounded', '200'],
      [jobSources, 'ck_job_sources_namespace_bounded', '200'],
    ] as const) {
      const sql_ = checkSql(t, name)
      expect(sql_).toContain('length')
      expect(sql_).toContain(bound)
    }
  })

  it('stores the meter and reservation counters as bigint (CR-M-2)', () => {
    // `integer` tops out near 2.1e9 — about USD 2,147 for a USD_MICROS meter,
    // and the shared contract accepted values the column could not store. It
    // failed loudly (22003) rather than corrupting, but contract and table
    // disagreed; now the column is the wider of the two.
    for (const c of ['limit_amount', 'used', 'reserved', 'uncertain']) {
      expect(col(jobAccountMeters, c).getSQLType()).toBe('bigint')
    }
    for (const c of ['amount', 'used_amount']) {
      expect(col(jobAccountMeterReservations, c).getSQLType()).toBe('bigint')
    }
  })
})

describe('cross-row rules the schema CAN enforce (CR-L-1 / CR-L-2 / SPEC-L-1)', () => {
  it('refuses a send instant on a RELEASED reservation (CR-L-1)', () => {
    // "Release ONLY provably unsent cost" (r5). The status pair CHECK let a
    // RELEASED row keep a `sent_at`, i.e. claim both that the request left and
    // that nothing was spent.
    const sql_ = checkSql(
      jobAccountMeterReservations,
      'ck_job_account_meter_reservations_released_unsent',
    )
    expect(sql_).toContain('RELEASED')
    expect(sql_).toContain('"sent_at" IS NULL')
  })

  it("ties a run's trigger to its cycle's trigger with a composite FK (CR-L-2 / SPEC-L-1)", () => {
    // A CHECK cannot read another row, but a composite FK can: the pair
    // (cycle_id, trigger) must exist as (id, trigger) on the cycle, so a run
    // cannot claim a trigger its own occurrence does not have.
    expect(uniqueCols(jobCollectionCycles, 'uq_job_collection_cycles_id_trigger')).toEqual([
      'id',
      'trigger',
    ])
    const f = fkByName(jobCollectionRuns, 'fk_job_collection_runs_cycle_trigger')
    expect(f.reference().columns.map((c) => c.name)).toEqual(['cycle_id', 'trigger'])
    expect(f.reference().foreignColumns.map((c) => c.name)).toEqual(['id', 'trigger'])
    expect(f.reference().foreignTable).toBe(jobCollectionCycles)
    expect(f.onDelete).toBe('restrict')
  })

  it("ties a reservation's cycle to its run's cycle with a composite FK (CR-L-2 / SPEC-L-1)", () => {
    expect(uniqueCols(jobCollectionRuns, 'uq_job_collection_runs_id_cycle')).toEqual([
      'id',
      'cycle_id',
    ])
    const f = fkByName(jobAccountMeterReservations, 'fk_job_account_meter_reservations_run_cycle')
    expect(f.reference().columns.map((c) => c.name)).toEqual(['run_id', 'cycle_id'])
    expect(f.reference().foreignColumns.map((c) => c.name)).toEqual(['id', 'cycle_id'])
    expect(f.reference().foreignTable).toBe(jobCollectionRuns)
  })
})

describe('timestamps are timestamptz everywhere (UTC store)', () => {
  it.each([
    [jobCollectionCycles, ['started_at', 'closed_at', 'created_at']],
    [jobCollectionRuns, ['lease_expires_at', 'started_at', 'ended_at']],
    [jobAccountMeters, ['window_started_at', 'resets_at']],
    [jobAccountMeterReservations, ['reserved_at', 'sent_at', 'settled_at']],
    [jobDirtyWork, ['claimed_at', 'lease_expires_at', 'created_at', 'completed_at']],
  ])('%#', (t, cols) => {
    for (const c of cols) expect(col(t, c).getSQLType()).toBe('timestamp with time zone')
  })
})
