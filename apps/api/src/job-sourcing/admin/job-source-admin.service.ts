import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import type {
  CreateJobSourceNoteDto,
  ExcludedJobSourceDto,
  JobHealthReason,
  JobHealthState,
  JobSourceDetailDto,
  JobSourceExclusionReason,
  JobSourceOperationalRowDto,
  JobSourceRunDto,
  JobSourceTimelineEventDto,
  ResetJobSourceFailuresDto,
  SessionUser,
} from '@crm/shared'
import { and, desc, eq, inArray, max, sql } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
// Schema tables through the barrel (never the individual modules): the ordered-import
// `public` circular-init trap documented in job-source-health.service.ts.
import { jobCollectionRuns, jobSourceHealthEvents, jobSources, users } from '../../database/schema'
import { JobRunLedger } from '../ownership/job-run-ledger'
import { CLAIM_REFUSALS, nextAttemptAt } from '../ownership/ledger-policy'
import { MAX_CONSECUTIVE_FAILURES } from '../scheduling/due-policy'
import { correlateEvents, summarizeProfile } from './source-page-derivation'

/** How many recent runs / events the detail page carries — bounded, newest first. */
const DETAIL_RUN_LIMIT = 50
const DETAIL_EVENT_LIMIT = 100

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
        SELECT s.id, s.type, s.host_key, s.consecutive_failures, s.last_error_code, s.next_attempt_at, s.slowdown_level,
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
   * U1b: the slots are the ledger's own (`nextAttemptAt`: the profile, the floor, the manifest id,
   * and since U2 the source's slow-down level), so the listing and the ledger never disagree; `min_interval_hours` is not read. A null-profile
   * source has no next slot and is never overdue.
   */
  private overdueAtFloor(r: Record<string, unknown>): boolean {
    const manifestId = String(r['manifest_id'])
    // A NULL manifest id resolves to no entry: the ledger's daily fallback.
    const entry = this.ledger.catalog.entry(manifestId)
    const level = Number(r['slowdown_level'])
    const first = nextAttemptAt(new Date(Number(r['next_attempt_ms'])), manifestId, entry, level)
    // A first slot implies a profile, so the second exists too.
    return (
      first !== null &&
      Number(r['now_ms']) > nextAttemptAt(first, manifestId, entry, level)!.getTime()
    )
  }

  // -------------------------------------------------------------------------
  // Source-fetch-strategy U7 — the ADMIN source page
  // -------------------------------------------------------------------------

  /**
   * Every source with its CURRENT health state (the `to_state` of its latest TRANSITION; null when
   * none recorded), its freshness (when we last ran, and the newest item the provider has published)
   * and its cadence summary (replacing the stale `minIntervalHours`). Read only.
   */
  async listSourceHealth(actor: SessionUser): Promise<JobSourceOperationalRowDto[]> {
    this.assertAdmin(actor)
    const db = this.database.db
    const sources = await db
      .select({
        id: jobSources.id,
        type: jobSources.type,
        enabled: jobSources.enabled,
        manifestId: jobSources.manifestId,
        lastCollectedAt: jobSources.lastCollectedAt,
      })
      .from(jobSources)
      .orderBy(jobSources.type, jobSources.id)
    if (sources.length === 0) return []

    const ids = sources.map((s) => s.id)
    const latest = await this.latestTransitions(ids)
    const freshness = await db
      .select({
        sourceId: jobCollectionRuns.sourceId,
        newest: max(jobCollectionRuns.newestItemPublishedAt),
      })
      .from(jobCollectionRuns)
      .where(inArray(jobCollectionRuns.sourceId, ids))
      .groupBy(jobCollectionRuns.sourceId)
    const newestById = new Map(freshness.map((f) => [f.sourceId, f.newest]))

    return sources.map((s) => this.rowOf(s, latest.get(s.id), newestById.get(s.id) ?? null))
  }

  /** One source's run timeline + health-event log, with the correlation hint on each TRANSITION. */
  async sourceDetail(sourceId: string, actor: SessionUser): Promise<JobSourceDetailDto> {
    this.assertAdmin(actor)
    const db = this.database.db
    const [s] = await db
      .select({
        id: jobSources.id,
        type: jobSources.type,
        enabled: jobSources.enabled,
        manifestId: jobSources.manifestId,
        lastCollectedAt: jobSources.lastCollectedAt,
      })
      .from(jobSources)
      .where(eq(jobSources.id, sourceId))
    if (!s) throw new NotFoundException('Job source not found')

    const latest = await this.latestTransitions([s.id])
    const [fresh] = await db
      .select({ newest: max(jobCollectionRuns.newestItemPublishedAt) })
      .from(jobCollectionRuns)
      .where(eq(jobCollectionRuns.sourceId, s.id))
    const source = this.rowOf(s, latest.get(s.id), fresh?.newest ?? null)

    const runRows = await db
      .select({
        id: jobCollectionRuns.id,
        startedAt: jobCollectionRuns.startedAt,
        endedAt: jobCollectionRuns.endedAt,
        outcome: jobCollectionRuns.outcome,
        received: jobCollectionRuns.received,
        created: jobCollectionRuns.created,
        invalid: jobCollectionRuns.invalid,
        requestCount: jobCollectionRuns.requestCount,
        bytesRead: jobCollectionRuns.bytesRead,
        lastHttpStatus: jobCollectionRuns.lastHttpStatus,
        newestItemPublishedAt: jobCollectionRuns.newestItemPublishedAt,
        adapterVersion: jobCollectionRuns.adapterVersion,
        configVersion: jobCollectionRuns.configVersion,
      })
      .from(jobCollectionRuns)
      .where(eq(jobCollectionRuns.sourceId, s.id))
      .orderBy(desc(jobCollectionRuns.startedAt))
      .limit(DETAIL_RUN_LIMIT)

    const eventRows = await db
      .select({
        id: jobSourceHealthEvents.id,
        at: jobSourceHealthEvents.at,
        kind: jobSourceHealthEvents.kind,
        fromState: jobSourceHealthEvents.fromState,
        toState: jobSourceHealthEvents.toState,
        reasonCode: jobSourceHealthEvents.reasonCode,
        adapterVersion: jobSourceHealthEvents.adapterVersion,
        configVersion: jobSourceHealthEvents.configVersion,
        httpStatus: jobSourceHealthEvents.httpStatus,
        errorSample: jobSourceHealthEvents.errorSample,
        actorName: users.displayName,
        note: jobSourceHealthEvents.note,
      })
      .from(jobSourceHealthEvents)
      .leftJoin(users, eq(users.id, jobSourceHealthEvents.actorId))
      .where(eq(jobSourceHealthEvents.sourceId, s.id))
      .orderBy(desc(jobSourceHealthEvents.at))
      .limit(DETAIL_EVENT_LIMIT)

    return {
      source,
      runs: runRows.map((r): JobSourceRunDto => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        outcome: r.outcome,
        received: r.received,
        created: r.created,
        invalid: r.invalid,
        requestCount: r.requestCount,
        bytesRead: r.bytesRead,
        lastHttpStatus: r.lastHttpStatus,
        newestItemPublishedAt: r.newestItemPublishedAt?.toISOString() ?? null,
        adapterVersion: r.adapterVersion,
        configVersion: r.configVersion,
      })),
      events: correlateEvents(
        eventRows.map((e): JobSourceTimelineEventDto => ({
          id: e.id,
          at: e.at.toISOString(),
          kind: e.kind === 'NOTE' ? 'NOTE' : 'TRANSITION',
          fromState: e.fromState as JobHealthState | null,
          toState: e.toState as JobHealthState | null,
          reasonCode: e.reasonCode as JobHealthReason | null,
          adapterVersion: e.adapterVersion,
          configVersion: e.configVersion,
          httpStatus: e.httpStatus,
          errorSample: e.errorSample,
          actorName: e.actorName ?? null,
          note: e.note,
          correlation: null,
        })),
      ),
    }
  }

  /**
   * Append an ADMIN note as a `NOTE` health event — immutable (the table forbids `UPDATE`/`DELETE`).
   * The note is already bounded + non-blank by the controller's Zod `.parse()`.
   */
  async addNote(sourceId: string, body: CreateJobSourceNoteDto, actor: SessionUser): Promise<void> {
    this.assertAdmin(actor)
    const [s] = await this.database.db
      .select({ id: jobSources.id })
      .from(jobSources)
      .where(eq(jobSources.id, sourceId))
    if (!s) throw new NotFoundException('Job source not found')
    await this.database.db.insert(jobSourceHealthEvents).values({
      sourceId: s.id,
      kind: 'NOTE',
      actorId: actor.id,
      note: body.note,
    })
  }

  /** The latest TRANSITION per source, in one bounded query (the `(source_id, at desc)` index). */
  private async latestTransitions(
    sourceIds: readonly string[],
  ): Promise<Map<string, { toState: string | null; reasonCode: string | null }>> {
    const rows = await this.database.db
      .selectDistinctOn([jobSourceHealthEvents.sourceId], {
        sourceId: jobSourceHealthEvents.sourceId,
        toState: jobSourceHealthEvents.toState,
        reasonCode: jobSourceHealthEvents.reasonCode,
      })
      .from(jobSourceHealthEvents)
      .where(
        and(
          inArray(jobSourceHealthEvents.sourceId, [...sourceIds]),
          eq(jobSourceHealthEvents.kind, 'TRANSITION'),
        ),
      )
      .orderBy(jobSourceHealthEvents.sourceId, desc(jobSourceHealthEvents.at))
    return new Map(rows.map((r) => [r.sourceId, { toState: r.toState, reasonCode: r.reasonCode }]))
  }

  private rowOf(
    s: {
      id: string
      type: JobSourceOperationalRowDto['type']
      enabled: boolean
      manifestId: string | null
      lastCollectedAt: Date | null
    },
    transition: { toState: string | null; reasonCode: string | null } | undefined,
    newestItem: Date | null,
  ): JobSourceOperationalRowDto {
    const entry = s.manifestId !== null ? this.ledger.catalog.entry(s.manifestId) : undefined
    return {
      id: s.id,
      type: s.type,
      enabled: s.enabled,
      state: (transition?.toState ?? null) as JobHealthState | null,
      reasonCode: (transition?.reasonCode ?? null) as JobHealthReason | null,
      lastCollectedAt: s.lastCollectedAt?.toISOString() ?? null,
      newestItemPublishedAt: newestItem?.toISOString() ?? null,
      profileSummary: entry ? summarizeProfile(entry.fetchProfile, entry.floorHours) : null,
    }
  }
}
