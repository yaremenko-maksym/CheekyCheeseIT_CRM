import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import type { Pool } from 'pg'
import type { ReportingJobSourceProvider } from '../job-sourcing/providers/reporting-provider'
import type { ActivationFacts } from '../job-sourcing/registry/activation'
import { JobSourceRegistry } from '../job-sourcing/registry/job-source-registry'
import { ReportingAdapter } from '../job-sourcing/registry/registered-adapter'
import type { HostPolicy } from '../job-sourcing/scheduling/host-policy'
import type { LedgerCatalog, LedgerCatalogEntry } from '../job-sourcing/ownership/ledger-catalog'

/**
 * Fixtures shared by the run ledger's real-Postgres specs (r5 Task 2.5 T3). A SPEC-ONLY module
 * (no production file imports it; the write gate and the build exclude it by its `.fixtures.ts`
 * name being imported only from specs). Rows are written on the MIGRATION role's pool and every
 * row carries the per-file tag, so specs can share a scratch database.
 */

export const READY: ActivationFacts = {
  readiness: 'CANDIDATE',
  blockerCodes: [],
  payloadVerified: true,
}

/** A catalog the spec controls: one entry per manifest id, one policy per host key. */
export class SpecCatalog implements LedgerCatalog {
  readonly entries = new Map<string, LedgerCatalogEntry>()

  readonly policies = new Map<string, HostPolicy>()

  entry(manifestId: string): LedgerCatalogEntry | undefined {
    return this.entries.get(manifestId)
  }

  hostPolicy(hostKey: string): HostPolicy | undefined {
    return this.policies.get(hostKey)
  }

  add(manifestId: string, over: Partial<LedgerCatalogEntry> = {}): void {
    this.entries.set(manifestId, {
      type: 'REMOTIVE_API',
      quotaDeclared: false,
      intervalHours: 24,
      floorHours: 0,
      activationFacts: () => READY,
      entryReadiness: () => 'CANDIDATE',
      ...over,
    })
  }
}

const provider = (type: JobSourceType) => ({ type }) as unknown as ReportingJobSourceProvider

/** A registry whose reporting adapters are wired, except the types named in `unwired`. */
export function specRegistry(
  types: readonly JobSourceType[],
  unwired: readonly JobSourceType[] = [],
): JobSourceRegistry {
  return new JobSourceRegistry(
    types.map((t) =>
      unwired.includes(t)
        ? new ReportingAdapter(provider(t))
        : new ReportingAdapter(provider(t), {
            adapterVersion: `${t.toLowerCase()}-1`,
            allowedHosts: ['fixture.test'],
          }),
    ),
  )
}

export interface SourceSeed {
  type?: JobSourceType
  manifestId?: string | null
  hostKey?: string | null
  enabled?: boolean
  adminState?: 'ACTIVE' | 'PAUSED' | 'RETIRED'
  triggerMode?: 'SCHEDULED' | 'MANUAL' | 'BOTH'
  accountMeterId?: string | null
  consecutiveFailures?: number
  nextAttemptSql?: string
  minIntervalHours?: number | null
}

export class LedgerFixtures {
  readonly sourceIds: string[] = []

  private seq = 0

  constructor(
    private readonly admin: Pool,
    readonly tag: string,
  ) {}

  manifestId(): string {
    this.seq += 1
    return `t3.spec.${this.tag}.m${this.seq}`
  }

  host(name: string): string {
    return `${name}-${this.tag}.t3spec.test`
  }

  accountKey(name: string): string {
    return `t3spec:${this.tag}-${name}`
  }

  async source(seed: SourceSeed = {}): Promise<string> {
    const id = randomUUID()
    this.seq += 1
    this.sourceIds.push(id)
    await this.admin.query(
      `INSERT INTO job_sources (id, type, config, manifest_id, enabled, admin_state, trigger_mode,
                                next_attempt_at, consecutive_failures, host_key, account_meter_id,
                                min_interval_hours)
       VALUES ($1, $2::job_source_type, $3::jsonb, $4, $5, $6::job_source_admin_state,
               $7::job_source_trigger_mode, ${seed.nextAttemptSql ?? "clock_timestamp() - interval '1 hour'"},
               $8, $9, $10, $11)`,
      [
        id,
        seed.type ?? 'REMOTIVE_API',
        JSON.stringify({ t3spec: this.tag, n: this.seq }),
        seed.manifestId === undefined ? this.manifestId() : seed.manifestId,
        seed.enabled ?? true,
        seed.adminState ?? 'ACTIVE',
        seed.triggerMode ?? 'BOTH',
        seed.consecutiveFailures ?? 0,
        seed.hostKey === undefined ? this.host(`h${this.seq}`) : seed.hostKey,
        seed.accountMeterId ?? null,
        seed.minIntervalHours ?? null,
      ],
    )
    return id
  }

  async manifestIdOf(sourceId: string): Promise<string> {
    const { rows } = await this.admin.query(`SELECT manifest_id FROM job_sources WHERE id = $1`, [
      sourceId,
    ])
    return rows[0].manifest_id as string
  }

  async meter(accountKey: string, limit: number | null, unit = 'REQUEST'): Promise<string> {
    const { rows } = await this.admin.query(
      `INSERT INTO job_account_meters
         (account_key, unit, window_kind, limit_amount, window_started_at, resets_at)
       VALUES ($1, $2, 'DAY', $3, now() - interval '1 minute', now() + interval '23 hours')
       RETURNING id`,
      [accountKey, unit, limit],
    )
    return rows[0].id as string
  }

  async sourceRow(id: string) {
    const { rows } = await this.admin.query(
      `SELECT consecutive_failures, last_error_code, admin_state_history,
              cooldown_until IS NOT NULL AND cooldown_until > clock_timestamp() AS cooling,
              extract(epoch FROM next_attempt_at - clock_timestamp())::float8 AS next_in_s,
              extract(epoch FROM cooldown_until - clock_timestamp())::float8 AS cooldown_in_s,
              last_success_at IS NOT NULL AS succeeded_once,
              last_attempt_at IS NOT NULL AS attempted
         FROM job_sources WHERE id = $1`,
      [id],
    )
    return rows[0] as {
      consecutive_failures: number
      last_error_code: string | null
      admin_state_history: unknown[]
      cooling: boolean
      next_in_s: number | null
      cooldown_in_s: number | null
      succeeded_once: boolean
      attempted: boolean
    }
  }

  async runs(sourceId: string) {
    const { rows } = await this.admin.query(
      `SELECT id, outcome, error_code, fencing_epoch::int AS epoch, checkpoint, received, created,
              unchanged, duplicates, account_key
         FROM job_collection_runs WHERE source_id = $1 ORDER BY fencing_epoch`,
      [sourceId],
    )
    return rows as {
      id: string
      outcome: string
      error_code: string | null
      epoch: number
      checkpoint: Record<string, unknown>
      received: number
      created: number
      unchanged: number
      duplicates: number
      account_key: string
    }[]
  }

  async reservations(runId: string) {
    const { rows } = await this.admin.query(
      `SELECT id, status, amount::int AS amount, used_amount::int AS used_amount
         FROM job_account_meter_reservations WHERE run_id = $1 ORDER BY reserved_at, id`,
      [runId],
    )
    return rows as { id: string; status: string; amount: number; used_amount: number }[]
  }

  async counters(meterId: string) {
    const { rows } = await this.admin.query(
      `SELECT used::float8 AS used, reserved::float8 AS reserved, uncertain::float8 AS uncertain
         FROM job_account_meters WHERE id = $1`,
      [meterId],
    )
    return rows[0] as { used: number; reserved: number; uncertain: number }
  }

  /** Delete everything this file wrote, children first. */
  async cleanup(): Promise<void> {
    const ids = this.sourceIds
    await this.admin.query(
      `DELETE FROM job_account_meter_reservations WHERE run_id IN
         (SELECT id FROM job_collection_runs WHERE source_id = ANY($1::uuid[]))`,
      [ids],
    )
    await this.admin.query(`DELETE FROM job_collection_runs WHERE source_id = ANY($1::uuid[])`, [
      ids,
    ])
    await this.admin.query(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE $1`, [
      `t3spec-${this.tag}-%`,
    ])
    await this.admin.query(`DELETE FROM job_sources WHERE id = ANY($1::uuid[])`, [ids])
    await this.admin.query(`DELETE FROM job_source_hosts WHERE host_key LIKE $1`, [
      `%-${this.tag}.t3spec.test`,
    ])
    await this.admin.query(`DELETE FROM job_account_meters WHERE account_key LIKE $1`, [
      `t3spec:${this.tag}-%`,
    ])
    await this.admin.query(`DELETE FROM job_source_records WHERE namespace LIKE $1`, [
      `t3spec-${this.tag}%`,
    ])
  }

  cycleKey(): string {
    return `t3spec-${this.tag}-${randomUUID()}`
  }
}
