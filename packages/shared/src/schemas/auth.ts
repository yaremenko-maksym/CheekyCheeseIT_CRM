import { z } from 'zod'

export const googleCallbackSchema = z.object({
  email: z.string().email(),
  googleId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().url().optional(),
})

export const sessionUserSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
  email: z.string().email(),
  displayName: z.string(),
  /** Google / dicebear fallback URL. Renamed from `avatar` in migration 0013. */
  avatarUrl: z.string().url().nullable(),
  /**
   * FK → documents.id for AVATAR-category uploads. When set, takes priority
   * over `avatarUrl` everywhere on the front-end (UI fetches a presigned
   * download URL via the documents hooks).
   */
  avatarDocumentId: z.string().uuid().nullable().optional(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  /**
   * Global default SENIOR share % (0-100). Used by the UI to render
   * "default X%" hints in finance widgets without an extra request.
   * For non-SENIOR roles the value is still set (DB default is 26) but
   * has no financial meaning.
   */
  seniorSharePercent: z.number().int().min(0).max(100),
  /**
   * Legal full name (Cyrillic, Surname First Patronymic). Set by ADMIN.
   * Used in MSA contract instead of displayName. Null when not yet set.
   * Surfaced in the session so SignContractStep can display the signature
   * block and gate the sign button without an extra round-trip.
   */
  legalFullName: z.string().nullable().optional(),
  /**
   * True when the current session is an admin impersonating another user.
   * Derived from `jwtPayloadSchema.impersonatorId` being present.
   * Used by the frontend to render the impersonation banner.
   */
  impersonating: z.boolean().optional(),
  /**
   * Security-review round 2 (authz-hardening): the REAL admin's userId when
   * the current session is an impersonated one — same value as
   * `jwtPayloadSchema.impersonatorId`. Optional so it is absent from the
   * actual `/me` HTTP response (that handler builds its return value
   * field-by-field via `sessionUserSchema.parse()` and does not set this
   * key — the frontend only ever sees the derived `impersonating` boolean
   * above, never the admin's raw id).
   *
   * Exists on this schema so backend code that receives `@CurrentUser()`
   * typed as `SessionUser` (the request-scoped object is actually the raw
   * JwtPayload for every controller except `/me` — see jwt.guard.ts) can
   * read `currentUser.impersonatorId ?? currentUser.id` to attribute audit
   * writes to the real operator instead of the impersonated target. Mirrors
   * `AuditInterceptor`'s fix — see that file's doc — extended here to the
   * handful of service methods that write audit rows directly from an
   * already-in-scope `SessionUser` (createDrop/archiveDrop in
   * UsersService; update/removeMember in TeamsService; several methods in
   * ProjectsService). NOT threaded into every audit-writing method in the
   * codebase (several take a plain `actorId: string` several layers deep in
   * transactional cascades) — that remains a documented, intentionally
   * deferred gap per the owner's earlier decision against heavier
   * per-action attribution machinery.
   */
  impersonatorId: z.string().uuid().optional(),
})

/**
 * MED #2 (security review #114) — minimal JWT cookie payload.
 *
 * The JWT cookie stores only identity + role for stateless auth.
 * PII fields (legalFullName, displayName, avatarUrl, etc.) are NOT
 * embedded in the cookie — they are re-hydrated from the DB on every
 * request to GET /api/auth/me.
 *
 * This eliminates the log-leak surface where access logs / JWT decode
 * middleware would expose legalFullName (Cyrillic legal name) in plaintext.
 *
 * `SessionUser` (full DTO returned by /me) retains legalFullName —
 * the frontend consumes it from the /me response, never from the cookie.
 *
 * `impersonatorId` — set when an ADMIN is impersonating another user.
 * Contains the ADMIN's own userId so `POST /auth/stop-impersonating` can
 * restore the original admin session. Also consumed by `AuditInterceptor`
 * and by service methods that read it off `SessionUser` (mirrored onto
 * `sessionUserSchema` below — see that field's doc for the exact scope of
 * which audit writers do/don't correct for impersonation).
 */
export const jwtPayloadSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
  email: z.string().email(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  /**
   * Present only during impersonation. Holds the original ADMIN's userId
   * so the return-to-self endpoint can restore the admin session.
   */
  impersonatorId: z.string().uuid().optional(),
})

/**
 * Body schema for POST /api/auth/impersonate.
 */
export const impersonateSchema = z.object({
  userId: z.string().uuid(),
})

export type ImpersonateDto = z.infer<typeof impersonateSchema>
export type JwtPayload = z.infer<typeof jwtPayloadSchema>

export type GoogleCallbackDto = z.infer<typeof googleCallbackSchema>
export type SessionUser = z.infer<typeof sessionUserSchema>
