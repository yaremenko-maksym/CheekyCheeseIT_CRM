import { z } from 'zod'

/**
 * Onboarding Phase 6A — Terms of Service schemas.
 *
 * ToS is global (not per role) and versioned. At most one row in `tos_versions`
 * is active at any time (partial unique index `WHERE is_active = true`).
 * Publishing a new version atomically deactivates the previous one and inserts
 * a new row with `version = max + 1`, `isActive = true`.
 *
 * Acceptances live in `tos_acceptances` with `UNIQUE (user_id, tos_version_id)`
 * — re-accepting the same version is a no-op (service-level idempotency,
 * returns existing row).
 *
 * Soft-notify banner shows when a user accepted an older active version and a
 * newer one is now active (`tosUpdateAvailable=true` in onboarding status).
 */

export const tosVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  bodyMarkdown: z.string(),
  isActive: z.boolean(),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().or(z.date()),
})

/** ADMIN publishes a new ToS version. Service atomically deactivates prev active. */
export const createTosVersionSchema = z.object({
  bodyMarkdown: z.string().min(1, 'Тело ToS не может быть пустым').max(100_000), // BIZ-14
})

/**
 * ADMIN live-previews the ToS body as a PDF.
 * Endpoint: POST /api/tos/preview-pdf
 * ADMIN-only (preview page is an admin route).
 */
export const tosPdfPreviewSchema = z.object({
  bodyMarkdown: z.string().min(1).max(100_000),
})

export const tosAcceptanceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  tosVersionId: z.string().uuid(),
  acceptedAt: z.string().or(z.date()),
  acceptedIp: z.string().nullable(),
  acceptedUserAgent: z.string().nullable(),
})

export type TosVersionDto = z.infer<typeof tosVersionSchema>
export type CreateTosVersionDto = z.infer<typeof createTosVersionSchema>
export type TosAcceptanceDto = z.infer<typeof tosAcceptanceSchema>
