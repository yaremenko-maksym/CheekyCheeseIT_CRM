import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import type {
  ExcludedJobSourceDto,
  JobSourceExclusionReason,
  ResetJobSourceFailuresDto,
  SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { CLAIM_REFUSALS, nextAttemptAt } from '../ownership/ledger-policy'
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

const REFUSAL_CODES = `{${CLAIM_REFUSALS.join(',')}}`

/** Instants are read as epoch milliseconds: the driver's timestamptz parsing is not relied on. */
const iso = (ms: unknown): string | null =>
  typeof ms === 'number' ? new Date(ms).toISOString() : null

@Injectable()
export class JobSourceAdminService {
  /** `ledger` is the production ledger (T7): its catalog is the generated production catalog. */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobRunLedger) private readonly ledger: JobRunLedger,
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
    const found = await this.ledger.resetFailures({
      sourceId: sourceId.toLowerCase(),
      actor: actor.id,
      reason: body.reason,
    })
    if (!found) throw new NotFoundException('Job source not found')
  }

  /**
   * Sources the ledger is not running, each with every reason that applies; capped ones first.
   * OVERDUE is "due for more than 2 cadences" at the cadence the ledger actually runs the source at
   * (T7, T9 CR-M-2 / SPEC-L-1; U1b): two slots of the ledger's own `nextAttemptAt` past the due
   * time. The SQL pre-selects every source past due (a superset); the slots are applied here, and a
   * row left with no reason is dropped.
   */
  async listExcluded(actor: SessionUser): Promise<ExcludedJobSourceDto[]> {
    this.assertAdmin(actor)
    const { rows } = await this.database.db.execute(sql`
      SELECT * FROM (
        SELECT s.id, s.type, s.host_key, s.consecutive_failures, s.last_error_code, s.next_attempt_at,
               s.manifest_id,
               (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms,
               (extract(epoch FROM s.next_attempt_at) * 1000)::float8 AS next_attempt_ms,
               CASE WHEN h.paused_until > clock_timestamp()
                    THEN (extract(epoch FROM h.paused_until) * 1000)::float8 END AS paused_until_ms,
               CASE WHEN h.paused_until > clock_timestamp() THEN h.pause_reason END AS pause_reason,
               CASE WHEN h.paused_until > clock_timestamp() THEN h.pause_source_id END AS pause_source_id,
               s.consecutive_failures >= ${MAX_CONSECUTIVE_FAILURES} AS capped,
               COALESCE(h.paused_until > clock_timestamp(), false) AS host_paused,
               COALESCE(s.last_error_code = ANY(${REFUSAL_CODES}::text[]), false) AS refused,
               COALESCE(s.enabled AND s.admin_state = 'ACTIVE'
                 AND s.next_attempt_at < clock_timestamp(), false) AS overdue
          FROM job_sources s
          LEFT JOIN job_source_hosts h ON h.host_key = s.host_key
      ) x
      WHERE capped OR host_paused OR refused OR overdue
      ORDER BY capped DESC, next_attempt_at ASC NULLS FIRST, id`)
    return rows.flatMap((r): ExcludedJobSourceDto[] => {
      const reasons: JobSourceExclusionReason[] = []
      if (r['capped'] === true) reasons.push('FAILURE_CAP')
      if (r['host_paused'] === true) reasons.push('HOST_PAUSED')
      if (r['refused'] === true) reasons.push('CLAIM_REFUSED')
      if (r['overdue'] === true && this.overdueAtFloor(r)) reasons.push('OVERDUE')
      if (reasons.length === 0) return []
      return [
        {
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
        },
      ]
    })
  }

  /**
   * Overdue: two whole slots of the source's own schedule have passed since it was due (DB clock).
   * U1b: the slots are the ledger's own (`nextAttemptAt`: the profile, the floor, the manifest id),
   * so the listing and the ledger never disagree; `min_interval_hours` is not read. A null-profile
   * source has no next slot and is never overdue.
   */
  private overdueAtFloor(r: Record<string, unknown>): boolean {
    const manifestId = String(r['manifest_id'])
    // A NULL manifest id resolves to no entry: the ledger's daily fallback.
    const entry = this.ledger.catalog.entry(manifestId)
    const first = nextAttemptAt(new Date(Number(r['next_attempt_ms'])), manifestId, entry)
    // A first slot implies a profile, so the second exists too.
    return (
      first !== null && Number(r['now_ms']) > nextAttemptAt(first, manifestId, entry)!.getTime()
    )
  }
}
