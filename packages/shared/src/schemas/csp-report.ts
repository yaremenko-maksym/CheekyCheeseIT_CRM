import { z } from 'zod'

/**
 * task-csp-reports-and-flip — Часть A. Contract source of truth for:
 *   POST /api/public/csp-report (`@crm/api` CspReportsController)
 *
 * A PUBLIC, unauthenticated endpoint accepting browser-native CSP violation
 * reports. КОНТРАКТ: the response is ALWAYS 204 (even on garbage), so every
 * ingest schema below is DELIBERATELY loose — every field is `.optional()`,
 * and a plain `z.object()` silently STRIPS unrecognized keys rather than
 * rejecting the payload. This is untrusted public input; a malformed/
 * partial/garbage body must fail validation gracefully — the controller
 * treats a `.parse()` throw as "nothing usable" and still returns 204, never
 * a 4xx to the reporting browser.
 *
 * Also carries the digest-response item shape consumed by
 * `GET /api/telemetry/digest`'s `cspViolations` section (see ./telemetry.ts).
 */

export const cspDispositionSchema = z.enum(['report', 'enforce'])
export type CspDisposition = z.infer<typeof cspDispositionSchema>

// ---------------------------------------------------------------------------
// CSP Level 2 `report-uri` — POST body: `{ "csp-report": {...} }`
// (Content-Type: application/csp-report)
// ---------------------------------------------------------------------------

export const cspReportUriBodySchema = z.object({
  'csp-report': z
    .object({
      'document-uri': z.string().max(2000).optional(),
      'blocked-uri': z.string().max(2000).optional(),
      'effective-directive': z.string().max(200).optional(),
      'violated-directive': z.string().max(200).optional(),
      disposition: cspDispositionSchema.optional(),
    })
    .optional(),
})
export type CspReportUriBody = z.infer<typeof cspReportUriBodySchema>

// ---------------------------------------------------------------------------
// Reporting API `report-to` — POST body: an ARRAY of generic reports.
// (Content-Type: application/reports+json)
// ---------------------------------------------------------------------------

/**
 * A `Reporting-Endpoints` header can in principle be reused for non-CSP
 * report types too — `type` is checked by the controller (only
 * `'csp-violation'` entries are recorded); every other field stays loose/
 * optional for the same "untrusted public input" reason as above.
 */
export const cspReportToItemSchema = z.object({
  type: z.string().max(100).optional(),
  body: z
    .object({
      documentURL: z.string().max(2000).optional(),
      blockedURL: z.string().max(2000).optional(),
      effectiveDirective: z.string().max(200).optional(),
      disposition: cspDispositionSchema.optional(),
    })
    .optional(),
})
export type CspReportToItem = z.infer<typeof cspReportToItemSchema>

/** Capped at 50 — mirrors `telemetryEventsBatchSchema`'s batch cap (a single navigation cannot generate more). */
export const cspReportToBodySchema = z.array(cspReportToItemSchema).max(50)
export type CspReportToBody = z.infer<typeof cspReportToBodySchema>

// ---------------------------------------------------------------------------
// Digest item — GET /api/telemetry/digest `cspViolations[]` (see ./telemetry.ts)
// ---------------------------------------------------------------------------

export const cspViolationItemSchema = z.object({
  id: z.uuid(),
  effectiveDirective: z.string(),
  blockedUri: z.string(),
  documentPath: z.string(),
  disposition: cspDispositionSchema,
  userAgent: z.string().nullable(),
  count: z.number().int(),
  firstSeen: z.string(), // ISO
  lastSeen: z.string(), // ISO
})
export type CspViolationItem = z.infer<typeof cspViolationItemSchema>
