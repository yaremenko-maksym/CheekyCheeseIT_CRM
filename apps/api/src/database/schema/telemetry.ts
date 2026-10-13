/**
 * Client / API telemetry and CSP reports.
 */
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  cspDispositionEnum,
  telemetryErrorStatusEnum,
  telemetryEventTypeEnum,
  telemetrySourceEnum,
} from './enums'
import { users } from './users'

// ---------------------------------------------------------------------------
// Telemetry (task-telemetry-api) — prod-error tracking + UX-analytics.
// ---------------------------------------------------------------------------
//
// Two tables, deliberately separate lifecycles:
//   - `telemetry_errors` — one row PER DISTINCT ERROR (grouped by
//     `fingerprint`), upserted (count++/last_seen bump on repeat; RESOLVED +
//     repeat = regression → back to NEW). Retention: 180 days since last_seen.
//   - `telemetry_events` — one row PER RAW UX EVENT (route_enter/leave,
//     feature_click, form_abandon/submit). High volume, short retention
//     (90 days) + a 1M-row safety cap — see TelemetryRetentionCronService.
//
// Privacy: telemetry_events NEVER stores a raw userId — only a daily-salted
// `session_hash` (see apps/api/src/telemetry/session-hash.ts) + role.

export const telemetryErrors = pgTable(
  'telemetry_errors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // sha256(source + normalized message + top-3 stack frames) — see
    // apps/api/src/telemetry/fingerprint.ts. Groups repeats of the same error.
    fingerprint: text('fingerprint').notNull().unique(),
    source: telemetrySourceEnum('source').notNull(),
    // Sanitized (secrets redacted) + truncated to 500/4000 chars BEFORE
    // insert — see apps/api/src/telemetry/sanitize.ts.
    message: text('message').notNull(),
    stack: text('stack'),
    route: text('route'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userRole: text('user_role'),
    // ua / viewport / appVersion ONLY — never request bodies.
    meta: jsonb('meta').notNull().default({}),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
    status: telemetryErrorStatusEnum('status').notNull().default('NEW'),
    githubIssueNumber: integer('github_issue_number'),
  },
  (t) => [index('idx_telemetry_errors_status_last_seen').on(t.status, t.lastSeen)],
)

export const telemetryEvents = pgTable(
  'telemetry_events',
  {
    // bigserial (not uuid) — this table is high-volume and short-lived
    // (90-day retention), same rationale as an activity/analytics log.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionHash: text('session_hash').notNull(),
    userRole: text('user_role').notNull(),
    event: telemetryEventTypeEnum('event').notNull(),
    route: text('route').notNull(),
    // [data-track] feature identifier for feature_click — never free text.
    target: text('target'),
    // Time-on-screen for route_leave, in milliseconds.
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_telemetry_events_event_created').on(t.event, t.createdAt),
    index('idx_telemetry_events_route_created').on(t.route, t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// CSP violation reports (task-csp-reports-and-flip, Часть A) — aggregated
// PUBLIC browser CSP violation reports (POST /api/public/csp-report).
// ---------------------------------------------------------------------------
//
// ONE row per DISTINCT (effectiveDirective, blockedUri, documentPath) tuple —
// same upsert shape as telemetry_errors (count++/last_seen bump on repeat).
// Deliberately NOT a raw event stream: this is UNTRUSTED PUBLIC input (any
// browser on the internet can POST here) — see CspReportsService.recordViolation
// (apps/api/src/csp-reports/csp-reports.service.ts) for the normalize +
// sanitize + upsert pipeline. Retention: 90 days since last_seen, via
// TelemetryRetentionCronService (reuses the existing retention cron, per task
// §Часть A item 5).

export const cspReports = pgTable(
  'csp_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // CSP directive that was violated (e.g. 'script-src') — resolved from
    // effective-directive, falling back to the first token of
    // violated-directive. See apps/api/src/csp-reports/normalize.ts.
    effectiveDirective: text('effective_directive').notNull(),
    // Normalized to origin+pathname (query/fragment stripped) — or a CSP
    // special keyword ('inline', 'eval', ...) passed through as-is.
    blockedUri: text('blocked_uri').notNull(),
    // document-uri/documentURL, pathname ONLY (origin + query/fragment stripped).
    documentPath: text('document_path').notNull(),
    // Latest occurrence's disposition — 'report' (Report-Only) or 'enforce'.
    disposition: cspDispositionEnum('disposition').notNull().default('report'),
    // Latest occurrence's User-Agent header, sanitized + truncated.
    userAgent: text('user_agent'),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Aggregation key (task §3) — CspReportsService.recordViolation upserts
    // against this exact composite index.
    uniqueIndex('uq_csp_reports_aggregate_key').on(
      t.effectiveDirective,
      t.blockedUri,
      t.documentPath,
    ),
    // Digest (`last_seen >= since`) + retention cron (`last_seen < cutoff`)
    // both filter on this column.
    index('idx_csp_reports_last_seen').on(t.lastSeen),
  ],
)
