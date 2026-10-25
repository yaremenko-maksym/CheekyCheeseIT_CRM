import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import type {
  ExcludedJobSourceDto,
  JobSourceExclusionReason,
  ResetJobSourceFailuresDto,
  SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
import type { LedgerCatalog } from '../ownership/ledger-catalog'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { CLAIM_REFUSALS } from '../ownership/ledger-policy'
import { JobSourceRegistry } from '../registry/job-source-registry'
import { MAX_CONSECUTIVE_FAILURES } from '../scheduling/due-policy'

/**
 * ADMIN controls over the run ledger (r5 Task 2.5 T9; ADR
 * docs/architecture/2026-10-24-job-source-run-ownership.md, section T9).
 *
 * The ONLY write is T3's `JobRunLedger.resetFailures`: the counter, the cooldown, the due time and
 * the `RESET_FAILURES` audit entry all live there, appended in SQL (SR-L-25), so this service never
 * does its own read-modify-write of `admin_state_history`. The listing is read only.
 *
 * RBAC: the controller carries `@Roles('ADMIN')`, and every method here re-checks the role, because
 * `RolesGuard` is a no-op on a handler without `@Roles` (security-review "no-op RolesGuard").
 */

/**
 * `resetFailures` reads neither the catalog nor the registry, and T7 owns wiring the production
 * catalog. Until then this ledger is built with a catalog that resolves nothing, so any other method
 * called on it would refuse every claim (fail closed) rather than run a source.
 * shortcut: a private ledger instance; inject T7's provider once it exists.
 */
const NO_CATALOG: LedgerCatalog = { entry: () => undefined, hostPolicy: () => undefined }

const REFUSAL_CODES = `{${CLAIM_REFUSALS.join(',')}}`

/** The cadence fallback of a NULL or unusable `min_interval_hours` (the manifest entry default). */
const DEFAULT_CADENCE_HOURS = 24

/** Instants are read as epoch milliseconds: the driver's timestamptz parsing is not relied on. */
const iso = (ms: unknown): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString() : null

@Injectable()
export class JobSourceAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobSourceRegistry) private readonly registry: JobSourceRegistry,
  ) {}

  private assertAdmin(user: SessionUser): void {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Job source controls are ADMIN only')
    }
  }

  /**
   * Reset one source's failure cap. `sourceId` is already a UUID (the controller's pipe); it is
   * lower-cased because the ledger accepts the canonical form only.
   */
  async resetFailures(
    sourceId: string,
    body: ResetJobSourceFailuresDto,
    actor: SessionUser,
  ): Promise<void> {
    this.assertAdmin(actor)
    const ledger = new JobRunLedger(this.database.db, this.registry, NO_CATALOG)
    const found = await ledger.resetFailures({
      sourceId: sourceId.toLowerCase(),
      actor: actor.id,
      reason: body.reason,
    })
    if (!found) throw new NotFoundException('Job source not found')
  }

  /**
   * Sources the ledger is not running, each with every reason that applies; capped ones first.
   * The cadence of OVERDUE is the stored `min_interval_hours` (24 when unusable), WITHOUT the
   * provider floor T8 applies at claim time: the floor only lengthens a cadence, so this can list a
   * source early, never hide a starved one.
   */
  async listExcluded(actor: SessionUser): Promise<ExcludedJobSourceDto[]> {
    this.assertAdmin(actor)
    const { rows } = await this.database.db.execute(sql`
      SELECT * FROM (
        SELECT s.id, s.type, s.host_key, s.consecutive_failures, s.last_error_code, s.next_attempt_at,
               (extract(epoch FROM s.next_attempt_at) * 1000)::float8 AS next_attempt_ms,
               CASE WHEN h.paused_until > clock_timestamp()
                    THEN (extract(epoch FROM h.paused_until) * 1000)::float8 END AS paused_until_ms,
               CASE WHEN h.paused_until > clock_timestamp() THEN h.pause_reason END AS pause_reason,
               CASE WHEN h.paused_until > clock_timestamp() THEN h.pause_source_id END AS pause_source_id,
               s.consecutive_failures >= ${MAX_CONSECUTIVE_FAILURES} AS capped,
               COALESCE(h.paused_until > clock_timestamp(), false) AS host_paused,
               COALESCE(s.last_error_code = ANY(${REFUSAL_CODES}::text[]), false) AS refused,
               COALESCE(s.enabled AND s.admin_state = 'ACTIVE'
                 AND s.next_attempt_at < clock_timestamp() - make_interval(hours => 2 *
                   CASE WHEN s.min_interval_hours BETWEEN 1 AND 8760 THEN s.min_interval_hours
                        ELSE ${DEFAULT_CADENCE_HOURS} END), false) AS overdue
          FROM job_sources s
          LEFT JOIN job_source_hosts h ON h.host_key = s.host_key
      ) x
      WHERE capped OR host_paused OR refused OR overdue
      ORDER BY capped DESC, next_attempt_at ASC NULLS FIRST, id`)
    return rows.map((r) => {
      const reasons: JobSourceExclusionReason[] = []
      if (r['capped'] === true) reasons.push('FAILURE_CAP')
      if (r['host_paused'] === true) reasons.push('HOST_PAUSED')
      if (r['refused'] === true) reasons.push('CLAIM_REFUSED')
      if (r['overdue'] === true) reasons.push('OVERDUE')
      return {
        sourceId: String(r['id']),
        type: r['type'] as ExcludedJobSourceDto['type'],
        hostKey: (r['host_key'] as string | null) ?? null,
        reasons,
        consecutiveFailures: Number(r['consecutive_failures']),
        lastErrorCode: (r['last_error_code'] as string | null) ?? null,
        nextAttemptAt: iso(r['next_attempt_ms']),
        pausedUntil: iso(r['paused_until_ms']),
        pauseReason: (r['pause_reason'] as string | null) ?? null,
        pauseSourceId: (r['pause_source_id'] as string | null) ?? null,
      }
    })
  }
}
