import { z } from 'zod'

/**
 * task-telemetry-api — CRM Telemetry (prod-errors + UX-analytics).
 *
 * Contract source of truth for:
 *   - error ingest (`POST /api/telemetry/errors`)
 *   - UX-event batch ingest (`POST /api/telemetry/events`)
 *   - the digest endpoint consumed by `.github/workflows/telemetry-digest.yml`
 *     (`GET /api/telemetry/digest`)
 *
 * Full design spec: `docs/superpowers/specs/2026-07-24-crm-telemetry-design.md`.
 *
 * Privacy contract (spec §"Решения владельца" + §5): errors carry userId/role
 * (needed for repro); UX events carry ONLY role + a daily-salted session hash
 * — never a raw userId, never form field values, never financial amounts.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const telemetryErrorSourceSchema = z.enum(['WEB', 'API'])
export type TelemetryErrorSource = z.infer<typeof telemetryErrorSourceSchema>

export const telemetryErrorStatusSchema = z.enum(['NEW', 'NOTIFIED', 'RESOLVED'])
export type TelemetryErrorStatus = z.infer<typeof telemetryErrorStatusSchema>

export const telemetryEventTypeSchema = z.enum([
  'route_enter',
  'route_leave',
  'feature_click',
  'form_abandon',
  'form_submit',
])
export type TelemetryEventType = z.infer<typeof telemetryEventTypeSchema>

// ---------------------------------------------------------------------------
// Error ingest — POST /api/telemetry/errors
// ---------------------------------------------------------------------------

/**
 * `stack` accepts up to 8000 chars from the client (a raw, un-sanitized
 * browser/Node stack can be long) — the API sanitizes secrets out of it and
 * truncates the STORED value to 4000 chars (see `apps/api/src/telemetry/
 * sanitize.ts`); the wider client-side cap here just rejects egregiously
 * oversized payloads before they hit the sanitizer.
 */
export const reportErrorSchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(8000).optional(),
  route: z.string().max(500).optional(),
  meta: z
    .object({
      ua: z.string().max(500).optional(),
      viewport: z.string().max(50).optional(),
      appVersion: z.string().max(50).optional(),
    })
    .optional(),
})
export type ReportErrorDto = z.infer<typeof reportErrorSchema>

// ---------------------------------------------------------------------------
// UX-event ingest — POST /api/telemetry/events
// ---------------------------------------------------------------------------

/**
 * `route`/`target` deliberately carry NO form field values or free text the
 * user typed — `target` is a `[data-track]` identifier (a fixed feature
 * name), never user input. `userId`/`sessionHash` are NOT part of the client
 * payload — the server derives `session_hash` from `req.user.id` (JWT) +
 * a daily env-secret salt (see `apps/api/src/telemetry/session-hash.ts`).
 */
export const telemetryEventSchema = z.object({
  event: telemetryEventTypeSchema,
  route: z.string().min(1).max(500),
  target: z.string().max(200).optional(),
  durationMs: z.number().int().min(0).optional(),
})
export type TelemetryEventDto = z.infer<typeof telemetryEventSchema>

export const telemetryEventsBatchSchema = z.object({
  events: z.array(telemetryEventSchema).min(1).max(50),
})
export type TelemetryEventsBatchDto = z.infer<typeof telemetryEventsBatchSchema>

// ---------------------------------------------------------------------------
// Digest — GET /api/telemetry/digest (consumed by the GH Actions workflow)
// ---------------------------------------------------------------------------

export const telemetryErrorItemSchema = z.object({
  id: z.uuid(),
  fingerprint: z.string(),
  source: telemetryErrorSourceSchema,
  message: z.string(),
  stack: z.string().nullable(),
  route: z.string().nullable(),
  userId: z.uuid().nullable(),
  userRole: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  count: z.number().int(),
  firstSeen: z.string(), // ISO
  lastSeen: z.string(), // ISO
  status: telemetryErrorStatusSchema,
  githubIssueNumber: z.number().int().nullable(),
})
export type TelemetryErrorItem = z.infer<typeof telemetryErrorItemSchema>

export const telemetryTopRouteSchema = z.object({
  role: z.string(),
  route: z.string(),
  visits: z.number().int(),
  medianDurationMs: z.number().int().nullable(),
})

export type TelemetryTopRoute = z.infer<typeof telemetryTopRouteSchema>

export const telemetryFeatureClickSchema = z.object({
  target: z.string(),
  count: z.number().int(),
})
export type TelemetryFeatureClick = z.infer<typeof telemetryFeatureClickSchema>

export const telemetryFormAbandonRateSchema = z.object({
  route: z.string(),
  abandonCount: z.number().int(),
  submitCount: z.number().int(),
  abandonRate: z.number().min(0).max(1),
})
export type TelemetryFormAbandonRate = z.infer<typeof telemetryFormAbandonRateSchema>

export const telemetryMedianDurationSchema = z.object({
  route: z.string(),
  medianDurationMs: z.number().int(),
})
export type TelemetryMedianDuration = z.infer<typeof telemetryMedianDurationSchema>

/** 7-day rolling window UX aggregates — see `TelemetryDigestService.getUxAggregates`. */
export const telemetryUxAggregatesSchema = z.object({
  topRoutesByRole: z.array(telemetryTopRouteSchema),
  featureClicks: z.array(telemetryFeatureClickSchema),
  formAbandonRates: z.array(telemetryFormAbandonRateSchema),
  medianDurations: z.array(telemetryMedianDurationSchema),
})
export type TelemetryUxAggregates = z.infer<typeof telemetryUxAggregatesSchema>

export const telemetryDigestResponseSchema = z.object({
  errors: z.array(telemetryErrorItemSchema),
  ux: telemetryUxAggregatesSchema.optional(),
})
export type TelemetryDigestResponse = z.infer<typeof telemetryDigestResponseSchema>
