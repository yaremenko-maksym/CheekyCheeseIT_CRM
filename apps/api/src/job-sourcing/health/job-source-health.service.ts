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
 * DEFERRED, and why it does not block any U4 AC: the three manifest-derived facts
 * (`isEmployerBoard`, `freshnessMaxAgeMs`, `policyDeadline`) are passed conservatively (false /
 * null) until the manifest surface that carries board-ness, per-provider freshness and policy
 * deadlines is wired (a follow-up consumed by U7 / U5a). The detectors already accept and test
 * them; until then `STALE_FEED`, `BOARD_GONE` and `DEADLINE_NEAR` do not fire from the pass. Every
 * reason that reads only run data — including `EMPTY_RESPONSE` and its 304 rule (AC 4) — does.
 */
import { Injectable, Logger } from '@nestjs/common'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
import { jobCollectionRuns } from '../../database/schema/job-collection'
import { jobSourceHealthEvents } from '../../database/schema/job-health'
import { jobSourceHosts, jobSources } from '../../database/schema/job-sourcing'
import { MAX_CONSECUTIVE_FAILURES } from '../scheduling/due-policy'
import { classifyHealth } from './classify-health'
import { runDetectors } from './detectors'
import { REPORTING_TYPES } from './reporting-types'
import type { HealthSnapshot, HealthStateFacts, RunFact } from './types'

const WINDOW_DAYS = 14
const DAY_MS = 86_400_000
const ERROR_SAMPLE_MAX = 500

/** A run row as the pass reads it: the detector fields plus the provenance the event records. */
interface PassRun extends RunFact {
  readonly errorMessage: string | null
}

export interface DetectorPassResult {
  readonly sources: number
  readonly eventsWritten: number
}

@Injectable()
export class JobSourceHealthService {
  private readonly logger = new Logger(JobSourceHealthService.name)

  constructor(private readonly database: DatabaseService) {}

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
        adminState: jobSources.adminState,
        readiness: jobSources.readiness,
        consecutiveFailures: jobSources.consecutiveFailures,
        hostKey: jobSources.hostKey,
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

    // The latest TRANSITION per source: ordered newest first, the first row seen per source wins.
    const transitions = await db
      .select({
        sourceId: jobSourceHealthEvents.sourceId,
        toState: jobSourceHealthEvents.toState,
        reasonCode: jobSourceHealthEvents.reasonCode,
      })
      .from(jobSourceHealthEvents)
      .where(
        and(
          inArray(jobSourceHealthEvents.sourceId, sourceIds),
          eq(jobSourceHealthEvents.kind, 'TRANSITION'),
        ),
      )
      .orderBy(jobSourceHealthEvents.sourceId, desc(jobSourceHealthEvents.at))
    const latestBySource = new Map<string, { toState: string | null; reasonCode: string | null }>()
    for (const t of transitions) {
      if (!latestBySource.has(t.sourceId)) {
        latestBySource.set(t.sourceId, { toState: t.toState, reasonCode: t.reasonCode })
      }
    }

    let eventsWritten = 0
    for (const source of sources) {
      const runs = runsBySource.get(source.id) ?? []
      const snapshot: HealthSnapshot = {
        now,
        runs,
        isEmployerBoard: false,
        freshnessMaxAgeMs: null,
        policyDeadline: null,
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
      await db.insert(jobSourceHealthEvents).values({
        sourceId: source.id,
        kind: 'TRANSITION',
        fromState: prevState,
        toState: verdict.state,
        reasonCode: verdict.reasonCode,
        // Small by construction (≤11 short reason codes plus two scalars), so it is always within
        // the 8192-char evidence CHECK; no truncation branch to leave untested.
        evidence: {
          reasons: facts.reasons,
          consecutiveFailures: source.consecutiveFailures,
          latestRunId: latestRun?.runId ?? null,
        },
        firstBadRunId: firstBadRunId(runs),
        lastGoodRunId: lastGoodRunId(runs),
        adapterVersion: latestRun?.adapterVersion ?? null,
        configVersion: latestRun?.configVersion ?? null,
        httpStatus: latestRun?.lastHttpStatus ?? null,
        errorSample: latestRun?.errorMessage?.slice(0, ERROR_SAMPLE_MAX) ?? null,
      })
      eventsWritten++
    }
    this.logger.log(`health detector pass: ${sources.length} sources, ${eventsWritten} event(s)`)
    return { sources: sources.length, eventsWritten }
  }
}

/** The most recent run that brought items in and did not fail — the last good reading. */
function lastGoodRunId(runs: readonly PassRun[]): string | null {
  return (
    runs.find((r) => r.received > 0 && (r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL'))
      ?.runId ?? null
  )
}

/** The oldest run of the current head streak of bad readings (failed, or empty and not a 304). */
function firstBadRunId(runs: readonly PassRun[]): string | null {
  const isBad = (r: PassRun): boolean =>
    r.outcome === 'FAILED' ||
    r.outcome === 'CANCELLED' ||
    (r.received === 0 && r.lastHttpStatus !== 304)
  let bad: string | null = null
  for (const r of runs) {
    if (!isBad(r)) break
    bad = r.runId
  }
  return bad
}
