import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, sql } from 'drizzle-orm'
import type { CspDisposition } from '@crm/shared'
import type { Env } from '../config/env'
import { parseCorsOrigins } from '../config/cors'
import { DatabaseService } from '../database/database.service'
import { cspReports } from '../database/schema'
import { sanitizeText, stripControlChars } from '../telemetry/sanitize'
import {
  normalizeBlockedUri,
  normalizeDocumentPath,
  resolveDirective,
  truncateBytes,
} from './normalize'
import { isAllowedDocumentOrigin } from './origin-check'
import { sanitizeUrlFieldNullable } from './sanitize-url-field'

/** Truncation cap for the stored User-Agent header, in BYTES (see `normalize.ts#truncateBytes`) — mirrors telemetry's `meta.ua` cap (500) but tighter (300). */
export const USER_AGENT_MAX_LENGTH = 300

/**
 * Aggregation-key row cap — task-csp-reports-and-flip security round 1
 * (HIGH-1a/b). All three columns in `uq_csp_reports_aggregate_key` are
 * attacker-controlled, so aggregation collapses REPEATS but not DIVERSITY:
 * every new distinct (directive, blockedUri, documentPath) tuple is a new
 * row, and unlike `telemetry_events` (`EVENTS_ROW_CAP` in
 * `telemetry-retention.cron.ts`) this table previously had no cap at all —
 * for a PUBLIC, unauthenticated endpoint. `recordViolation` enforces this
 * at INSERT time (refusing a NEW key once the cap is reached — count++ on
 * an EXISTING key always succeeds, that's the safe, bounded case);
 * `TelemetryRetentionCronService.enforceCspReportsCap` (same file/pattern
 * as `enforceEventsCap`) is the daily backstop on top of it. 10 000 is
 * generous for legitimate diversity (a handful of directives × a handful
 * of blocked resources × a handful of pages) while still bounding worst-
 * case table size to roughly 10 000 × ~1.4 KB/row ≈ 14 MB.
 */
export const CSP_REPORTS_ROW_CAP = 10_000

/** How long the cached approximate row count (used for the cap check above) is trusted before a fresh `COUNT(*)`. */
const ROW_COUNT_CACHE_TTL_MS = 30_000

export interface RecordCspViolationInput {
  effectiveDirective?: string | undefined
  violatedDirective?: string | undefined
  blockedUri?: string | undefined
  documentUri?: string | undefined
  disposition?: CspDisposition | undefined
  userAgent?: string | null | undefined
}

/**
 * CspReportsService — task-csp-reports-and-flip §Часть A. The ONE place that
 * writes to `csp_reports`. Storage is AGGREGATED, not a raw event stream
 * (task §3: "недоверенный публичный ввод — хранение агрегированное") — every
 * write is an upsert keyed on (effectiveDirective, blockedUri, documentPath):
 * a repeat bumps count/lastSeen instead of inserting a new row.
 *
 * Security round 1 hardening, in the ORDER `recordViolation` applies it
 * (cheapest/most-decisive rejects first):
 *   1. Origin check (HIGH-1d, THE primary fix) — `document-uri` must be
 *      OUR origin. Kills the reflected mass-vector (any site can put our
 *      `report-uri` in ITS OWN CSP and have every visitor's browser report
 *      that page — per-IP rate-limiting cannot see this, since every
 *      visitor is a distinct IP) before a single DB round-trip.
 *   2. Directive allow-list (HIGH-1c, via `resolveDirective`) — rejects
 *      anything that is not one of ~29 real CSP directive names, closing
 *      an entire dimension of aggregation-key cardinality.
 *   3. Row-cap budget (HIGH-1a/b) — a NEW aggregation key is refused once
 *      the table is at `CSP_REPORTS_ROW_CAP`; an EXISTING key always still
 *      accepts a `count++`.
 *   4. Field sanitization: `sanitize-url-field.ts` (control chars +
 *      Bearer/password, NOT the telemetry `cookie` pattern — MED-4, that
 *      pattern mangles cookie-CONSENT urls, the most common real source of
 *      CSP violations) for blockedUri/documentPath; full
 *      `telemetry/sanitize.ts` `sanitizeText` (kept, unrelated to URLs) for
 *      the User-Agent header.
 *
 * MED-2 (data-poisoning of the very dataset the 03.08 enforcing decision
 * reads): `onConflictDoUpdate` deliberately does NOT touch
 * `disposition`/`userAgent` — only `count`/`lastSeen`. Whichever occurrence
 * hits a fresh aggregation key FIRST sets those fields for good; a later
 * submission landing on the SAME key (genuine repeat OR an attacker probing
 * for a collision) can only bump the counter, never overwrite metadata.
 */
@Injectable()
export class CspReportsService {
  private readonly logger = new Logger(CspReportsService.name)
  private readonly allowedOrigins: readonly (string | RegExp)[]
  private cachedRowCount = 0
  private cachedRowCountAt = 0

  constructor(
    private readonly db: DatabaseService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    // Reuses the SAME allowlist CORS already trusts (FRONTEND_URL /
    // CORS_ORIGINS) — a genuine CSP report can only ever originate from a
    // page our own frontend served, i.e. an origin we already list there.
    // No second, drifting origin config.
    this.allowedOrigins = parseCorsOrigins({
      corsOrigins: config.get('CORS_ORIGINS', { infer: true }),
      frontendUrl: config.get('FRONTEND_URL', { infer: true }),
      isProduction: config.get('NODE_ENV', { infer: true }) === 'production',
    })
  }

  async recordViolation(input: RecordCspViolationInput): Promise<void> {
    if (!isAllowedDocumentOrigin(input.documentUri, this.allowedOrigins)) {
      this.logger.debug('csp report dropped — document-uri origin is not ours')
      return
    }

    const directive = resolveDirective(input.effectiveDirective, input.violatedDirective)
    if (!directive) {
      this.logger.debug(
        'csp report dropped — no allow-listed directive resolved from effective-directive/violated-directive',
      )
      return
    }

    const blockedUri = normalizeBlockedUri(sanitizeUrlFieldNullable(input.blockedUri))
    const documentPath = normalizeDocumentPath(sanitizeUrlFieldNullable(input.documentUri))
    const disposition: CspDisposition = input.disposition ?? 'report'
    const userAgent = input.userAgent
      ? truncateBytes(sanitizeText(stripControlChars(input.userAgent)), USER_AGENT_MAX_LENGTH)
      : null

    const isNewKey = await this.isNewAggregationKey(directive, blockedUri, documentPath)
    if (isNewKey && (await this.getApproxRowCount()) >= CSP_REPORTS_ROW_CAP) {
      this.logger.warn(
        `csp report dropped — row cap (${CSP_REPORTS_ROW_CAP}) reached, refusing new aggregation key (directive=${directive})`,
      )
      return
    }

    const now = new Date()
    await this.db.db
      .insert(cspReports)
      .values({
        effectiveDirective: directive,
        blockedUri,
        documentPath,
        disposition,
        userAgent,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [cspReports.effectiveDirective, cspReports.blockedUri, cspReports.documentPath],
        // MED-2: disposition/userAgent deliberately NOT in `set` — see the
        // class doc comment. Only count/lastSeen ever change on conflict.
        set: {
          count: sql`${cspReports.count} + 1`,
          lastSeen: now,
        },
      })

    if (isNewKey) this.cachedRowCount += 1
    this.logger.debug(`csp report recorded (directive=${directive})`)
  }

  private async isNewAggregationKey(
    directive: string,
    blockedUri: string,
    documentPath: string,
  ): Promise<boolean> {
    const existing = await this.db.db
      .select({ id: cspReports.id })
      .from(cspReports)
      .where(
        and(
          eq(cspReports.effectiveDirective, directive),
          eq(cspReports.blockedUri, blockedUri),
          eq(cspReports.documentPath, documentPath),
        ),
      )
      .limit(1)
    return existing.length === 0
  }

  /**
   * Cached `COUNT(*)` — refreshed at most every `ROW_COUNT_CACHE_TTL_MS`,
   * and bumped optimistically by 1 on every confirmed new-key insert
   * (`recordViolation`), so it stays accurate between refreshes without a
   * `COUNT(*)` on every single request under legitimate (low-volume) load.
   */
  private async getApproxRowCount(): Promise<number> {
    const now = Date.now()
    if (now - this.cachedRowCountAt < ROW_COUNT_CACHE_TTL_MS) return this.cachedRowCount
    const [row] = await this.db.db.select({ count: sql<number>`count(*)::int` }).from(cspReports)
    this.cachedRowCount = row?.count ?? 0
    this.cachedRowCountAt = now
    return this.cachedRowCount
  }
}
