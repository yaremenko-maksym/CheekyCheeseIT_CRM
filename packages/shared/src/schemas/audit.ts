import { z } from 'zod'

/**
 * Phase 6 polish PR3 — compliance audit trail schemas.
 *
 * Covers two compliance data sources:
 *   - `signed_contracts` — immutable MSA signing record per user
 *   - `tos_acceptances` — ToS acceptance record per user
 *
 * Two endpoints:
 *   GET /api/me/audit-trail  — self-service (any authenticated user, last 50)
 *   GET /api/audit/all       — ACCOUNTANT + ADMIN only, with filters + pagination
 */

// ---------------------------------------------------------------------------
// Item schemas
// ---------------------------------------------------------------------------

export const signedContractItemSchema = z.object({
  type: z.literal('contract'),
  id: z.string().uuid(),
  contractNumber: z.string(),
  signedAt: z.string(),
  signedTypedName: z.string(),
  signedIp: z.string().nullable(),
  templateRole: z.enum(['HR', 'SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT']),
  templateVersion: z.number().int().positive(),
  bodyMarkdownSnapshot: z.string(),
})

export const tosAcceptanceItemSchema = z.object({
  type: z.literal('tos'),
  id: z.string().uuid(),
  acceptedAt: z.string(),
  acceptedIp: z.string().nullable(),
  tosVersion: z.number().int().positive(),
  tosBodyMarkdown: z.string(),
})

// Discriminated union for the "all" endpoint
export const auditEventSchema = z.discriminatedUnion('type', [
  signedContractItemSchema,
  tosAcceptanceItemSchema,
])

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const auditTrailResponseSchema = z.object({
  signedContracts: z.array(signedContractItemSchema),
  tosAcceptances: z.array(tosAcceptanceItemSchema),
})

// ---------------------------------------------------------------------------
// Query params for GET /api/audit/all
// ---------------------------------------------------------------------------

export const auditAllQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  from: z.string().optional(), // ISO date string
  to: z.string().optional(),   // ISO date string
  type: z.enum(['contract', 'tos']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const auditAllResponseSchema = z.object({
  items: z.array(auditEventSchema),
  total: z.number().int().nonnegative(),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignedContractItem = z.infer<typeof signedContractItemSchema>
export type TosAcceptanceItem = z.infer<typeof tosAcceptanceItemSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type AuditTrailResponse = z.infer<typeof auditTrailResponseSchema>
export type AuditAllQuery = z.infer<typeof auditAllQuerySchema>
export type AuditAllResponse = z.infer<typeof auditAllResponseSchema>
