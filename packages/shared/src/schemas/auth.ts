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
 *
 * `userEmailId` — SR-H-6 (security-review PR #623 round 5). Before this
 * field existed, a session's ONLY link to `user_emails` was resolved once,
 * at login, and never re-checked: `JwtAuthGuard.resolveCurrentUser`
 * re-hydrated `role`/`archivedAt` from `users` on every cache miss, but
 * nothing re-checked the SPECIFIC row (WORK or PERSONAL) that unlocked the
 * login in the first place. `changePersonalEmail` (`UsersService`) DELETES
 * a PERSONAL row outright the instant an admin replaces or removes it — an
 * already-open session minted through that row survived unaffected for the
 * rest of its 7-day cookie lifetime, which is exactly backwards from the
 * owner's stated reason for the feature ("we can quickly change the email
 * ... and it will no longer be possible to log in from the old one" — a
 * promise about someone who is ALREADY inside, not merely about future
 * logins). Set by every login path that resolves a `user_emails` row
 * (`AuthController.googleCallback`'s ordinary branch, `googleOneTap`,
 * `devLogin`) to that row's id, REGARDLESS of whether the row is WORK or
 * PERSONAL. The guard re-checks the row on every DB re-hydration (same
 * `CACHE_TTL_MS` cache and the same accepted ≤60s revocation lag already
 * documented for `archivedAt` there) and rejects the session the moment
 * `canLogin` on that exact row goes false or the row stops existing.
 *
 * `userEmailId` is `undefined` on exactly THREE kinds of token — this
 * enumeration was INCOMPLETE before security-review PR #623 round 6
 * (SR-M-15): an earlier version of this doc named only the first case
 * below, which let the guard's "no field → skip the check" branch read as
 * safe-by-declared-invariant when it was actually safe by an unstated one
 * (case 3):
 *
 *   1. An impersonation-TARGET session (`AuthController.impersonate`).
 *      This is PERMANENT, by construction, not a transient gap: the
 *      impersonated user never went through a `user_emails` lookup to get
 *      this session, so there is no row to bind to. See
 *      `impersonatorUserEmailId` below for the admin's OWN binding, which
 *      is preserved separately across the round trip.
 *   2. The RESTORED admin session from `AuthController.stopImpersonating`,
 *      but ONLY when the admin's own session — at the moment they called
 *      `impersonate` — was itself already in case 3 below (i.e. it had no
 *      `userEmailId` of its own to carry across via
 *      `impersonatorUserEmailId`). SR-M-13 (round 6): before that field
 *      existed, EVERY restored session landed here unconditionally,
 *      silently dropping the admin's own row binding on every round trip.
 *   3. A token issued BEFORE this field existed in the payload (i.e.
 *      before this PR deployed). This is transient, not permanent: EVERY
 *      token — this one included — is signed with `expiresIn: '7d'`
 *      (`auth.module.ts`), so `jwt.verify()` (`jwt.guard.ts`) rejects it
 *      outright, on its OWN `exp` claim, at most `COOKIE_MAX_AGE` (7 days)
 *      after the deploy that introduced this field — no separate cutoff
 *      constant is needed the way `LEGACY_JWT_COOKIE_FALLBACK_CUTOFF` is
 *      needed for the cookie NAME (that mechanism exists because a cookie
 *      NAME's acceptance is a guard-side policy independent of the token's
 *      own expiry; a payload SHAPE has no such independent channel — the
 *      token's `exp` is the only clock that matters here, and it already
 *      bounds this case tightly). A PERSONAL-row login cannot appear in
 *      this case at all: the bootstrap backfill
 *      (`drizzle/manual/2026-09-01_user_emails.sql`) creates ONLY `WORK`
 *      rows, so no session opened through a PERSONAL row can predate this
 *      field.
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
  /** SR-H-6 — see this schema's own doc above for the full rationale. */
  userEmailId: z.string().uuid().optional(),
  /**
   * SR-M-13 (security-review PR #623 round 6). Present ONLY on an
   * impersonation-TARGET token (alongside `impersonatorId`) — carries the
   * calling ADMIN's OWN `userEmailId` (their real login row, if their
   * session had one) across the impersonate → stop-impersonating round
   * trip, purely as a mint-time relay: `AuthController.impersonate` copies
   * `currentUser.userEmailId` in here, and
   * `AuthController.stopImpersonating` copies THIS field back onto the
   * restored session's own `userEmailId`.
   *
   * Before this field existed, `stopImpersonating` always minted a
   * restored session with `userEmailId: undefined`, regardless of what the
   * admin's session carried before they impersonated anyone — so revoking
   * the admin's own address (`changePersonalEmail`) stopped working the
   * instant they did one impersonate → stop-impersonating round trip,
   * silently and permanently, for the rest of that session's 7-day cookie
   * lifetime. Reviewer's controlled reproduction: same admin, same
   * address, same revocation call — 401 without a round trip in between,
   * 200 (revocation had no effect) with one.
   *
   * NOT re-checked by `JwtAuthGuard` itself while impersonation is active —
   * it is consulted only by `stopImpersonating` at mint time. A revocation
   * of the admin's own address that happens WHILE they are actively
   * impersonating someone does not end that impersonation session; closing
   * that gap is a separate, broader question (does ANY admin-security
   * event need to reach an in-progress impersonation session — see
   * SR-M-16, filed as a follow-up, not fixed here) and is out of scope for
   * this narrowly-targeted round-trip fix.
   */
  impersonatorUserEmailId: z.string().uuid().optional(),
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
