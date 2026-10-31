/**
 * Source-fetch-strategy U4 — the detector pass.
 *
 * Runs at the end of each tick window (`JobSourcingCronService.handleTick`). It reads a 14-day
 * window of runs for every reporting source in one query, classifies each source with the pure
 * detectors + `classifyHealth`, and appends a `TRANSITION` event ONLY when the source's
 * `(state, reason)` differs from its latest event — so the log grows with change, not with time
 * (ADR 2026-10-25 section 10).
 *
 * The detectors are pure (`detectors.ts`); this is the only part that touches the database.
 *
 * The three manifest-derived facts (`isEmployerBoard`, `freshnessMaxAgeMs`, `policyDeadline`) are
 * wired from the source's `type` via `provider-facts.ts` (CR-M-4), so `BOARD_GONE`, `STALE_FEED`
 * and `DEADLINE_NEAR` are live in production, not dead. A provider with no freshness/deadline fact
 * declared simply does not fire those two — conservative, and widened by a one-line table edit.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
// Import schema tables through the barrel, never the individual modules: a single schema file
// imported out of order triggers the `public` circular-init (`transactions.deletedAt` undefined),
// which broke job-sourcing.cron.spec once this service was wired into the cron.
import {
  jobCollectionRuns,
  jobSourceHealthEvents,
  jobSourceHosts,
  jobSources,
} from '../../database/schema'
import { MAX_CONSECUTIVE_FAILURES } from '../scheduling/due-policy'
import { classifyHealth } from './classify-health'
import { runDetectors } from './detectors'
import { SourceHealthAlertService } from './source-health-alert.service'
import { freshnessMaxAgeMsFor, isEmployerBoard, policyDeadlineFor } from './provider-facts'
import { REPORTING_TYPES } from './reporting-types'
import { buildEvidence, firstBadRunId, lastGoodRunId, type PassRun } from './run-provenance'
import type { HealthSnapshot, HealthStateFacts } from './types'

const WINDOW_DAYS = 14
const DAY_MS = 86_400_000
const ERROR_SAMPLE_MAX = 500

export interface DetectorPassResult {
  readonly sources: number
  readonly eventsWritten: number
}

@Injectable()
export class JobSourceHealthService {
  private readonly logger = new Logger(JobSourceHealthService.name)

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    // U5a: optional like the cron's collaborators — a unit context without it writes events only.
    @Optional()
    @Inject(SourceHealthAlertService)
    private readonly alerts?: SourceHealthAlertService,
  ) {}

  /**
   * One pass over every reporting source. Returns how many sources were classified and how many
   * TRANSITION events were written (0 when nothing changed). Idempotent over unchanged data: a
   * second call right after writes nothing (AC 3).
   */
  async runDetectorPass(now: Date = new Date()): Promise<DetectorPassResult> {
    const db = this.database.db
    const sources = await db
      .select({
        id: jobSources.id,
        type: jobSources.type,
        adminState: jobSources.adminState,
        readiness: jobSources.readiness,
        consecutiveFailures: jobSources.consecutiveFailures,
        hostKey: jobSources.hostKey,
        manifestId: jobSources.manifestId,
      })
      .from(jobSources)
      .where(inArray(jobSources.type, REPORTING_TYPES))
    if (sources.length === 0) return { sources: 0, eventsWritten: 0 }

    const sourceIds = sources.map((s) => s.id)
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS)
    const runRows = await db
      .select({
        runId: jobCollectionRuns.id,
        sourceId: jobCollectionRuns.sourceId,
        startedAt: jobCollectionRuns.startedAt,
        endedAt: jobCollectionRuns.endedAt,
        outcome: jobCollectionRuns.outcome,
        received: jobCollectionRuns.received,
        created: jobCollectionRuns.created,
        invalid: jobCollectionRuns.invalid,
        bytesRead: jobCollectionRuns.bytesRead,
        lastHttpStatus: jobCollectionRuns.lastHttpStatus,
        newestItemPublishedAt: jobCollectionRuns.newestItemPublishedAt,
        envelopeFingerprint: jobCollectionRuns.envelopeFingerprint,
        errorCode: jobCollectionRuns.errorCode,
        errorMessage: jobCollectionRuns.errorMessage,
        adapterVersion: jobCollectionRuns.adapterVersion,
        configVersion: jobCollectionRuns.configVersion,
      })
      .from(jobCollectionRuns)
      .where(
        and(
          inArray(jobCollectionRuns.sourceId, sourceIds),
          gte(jobCollectionRuns.startedAt, windowStart),
        ),
      )
      .orderBy(jobCollectionRuns.sourceId, desc(jobCollectionRuns.startedAt))

    const runsBySource = new Map<string, PassRun[]>()
    for (const r of runRows) {
      const list = runsBySource.get(r.sourceId) ?? []
      list.push({
        runId: r.runId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        outcome: r.outcome,
        received: r.received,
        created: r.created,
        invalid: r.invalid,
        bytesRead: r.bytesRead,
        lastHttpStatus: r.lastHttpStatus,
        newestItemPublishedAt: r.newestItemPublishedAt,
        envelopeFingerprint: r.envelopeFingerprint,
        errorCode: r.errorCode,
        adapterVersion: r.adapterVersion,
        configVersion: r.configVersion,
        errorMessage: r.errorMessage,
      })
      runsBySource.set(r.sourceId, list)
    }

    const hostKeys = [
      ...new Set(sources.map((s) => s.hostKey).filter((k): k is string => k !== null)),
    ]
    const hosts =
      hostKeys.length === 0
        ? []
        : await db
            .select({ hostKey: jobSourceHosts.hostKey, pausedUntil: jobSourceHosts.pausedUntil })
            .from(jobSourceHosts)
            .where(inArray(jobSourceHosts.hostKey, hostKeys))
    const pausedHosts = new Set(
      hosts.filter((h) => h.pausedUntil !== null && h.pausedUntil > now).map((h) => h.hostKey),
    )

    // The CURRENT state of each source is its latest TRANSITION. ONE bounded query (CR-H-1):
    // `DISTINCT ON (source_id) … ORDER BY source_id, at DESC` returns exactly one row per source —
    // the newest — served by the `(source_id, at DESC)` index, so the read does not grow with the
    // append-only log's row count. `latestStates` is pinned by the integration spec (a source with
    // many events yields a single current-state row).
    const latestBySource = new Map<string, { toState: string | null; reasonCode: string | null }>()
    for (const t of await this.latestStates(sourceIds)) {
      latestBySource.set(t.sourceId, { toState: t.toState, reasonCode: t.reasonCode })
    }

    let eventsWritten = 0
    for (const source of sources) {
      const runs = runsBySource.get(source.id) ?? []
      const snapshot: HealthSnapshot = {
        now,
        runs,
        isEmployerBoard: isEmployerBoard(source.type),
        freshnessMaxAgeMs: freshnessMaxAgeMsFor(source.type),
        policyDeadline: policyDeadlineFor(source.type),
      }
      const facts: HealthStateFacts = {
        adminState: source.adminState,
        blocked: source.readiness === 'BLOCKED',
        atFailureCap: source.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
        hostPaused: source.hostKey !== null && pausedHosts.has(source.hostKey),
        consecutiveFailures: source.consecutiveFailures,
        reasons: runDetectors(snapshot),
      }
      const verdict = classifyHealth(facts)
      const prev = latestBySource.get(source.id)
      const prevState = prev?.toState ?? null
      const prevReason = prev?.reasonCode ?? null
      if (verdict.state === prevState && verdict.reasonCode === prevReason) continue

      const latestRun = runs[0]
      // The event and its ADMIN alerts (U5a) commit together; the alert path is a savepoint inside
      // (`emitInTx`), so a failure there can never roll the event back.
      await db.transaction(async (tx) => {
        const [event] = await tx
          .insert(jobSourceHealthEvents)
          .values({
            sourceId: source.id,
            kind: 'TRANSITION',
            fromState: prevState,
            toState: verdict.state,
            reasonCode: verdict.reasonCode,
            // The metric values against the baseline, plus the reasons and run ids (ADR section
            // 10). Small by construction (a handful of short codes + a few scalars), so always
            // within the 8192-char evidence CHECK; no truncation branch to leave untested.
            evidence: buildEvidence(runs, facts.reasons, source.consecutiveFailures, now),
            firstBadRunId: firstBadRunId(runs),
            lastGoodRunId: lastGoodRunId(runs),
            adapterVersion: latestRun?.adapterVersion ?? null,
            configVersion: latestRun?.configVersion ?? null,
            httpStatus: latestRun?.lastHttpStatus ?? null,
            errorSample: latestRun?.errorMessage?.slice(0, ERROR_SAMPLE_MAX) ?? null,
          })
          .returning({ id: jobSourceHealthEvents.id, at: jobSourceHealthEvents.at })
        if (event === undefined || this.alerts === undefined) return
        await this.alerts.alertOnTransition(tx, {
          eventId: event.id,
          at: event.at,
          sourceId: source.id,
          sourceName: source.manifestId ?? source.type,
          from: { state: prevState, reason: prevReason },
          to: { state: verdict.state, reason: verdict.reasonCode },
        })
      })
      eventsWritten++
    }
    this.logger.log(`health detector pass: ${sources.length} sources, ${eventsWritten} event(s)`)
    return { sources: sources.length, eventsWritten }
  }

  /**
   * The current state of each source — its latest TRANSITION — in ONE query (CR-H-1). `DISTINCT ON
   * (source_id)` with `ORDER BY source_id, at DESC` returns a single row per source regardless of
   * how many events it has accumulated, served by the `(source_id, at DESC)` index.
   */
  private async latestStates(
    sourceIds: readonly string[],
  ): Promise<{ sourceId: string; toState: string | null; reasonCode: string | null }[]> {
    return this.database.db
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
  }
}
