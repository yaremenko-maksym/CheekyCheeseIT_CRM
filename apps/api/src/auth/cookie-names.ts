/**
 * LOW (security-review round 3, follow-up to #436): single source of truth
 * for all auth-flow cookie names (JWT session + OAuth state).
 *
 * Before this file, `'__Host-jwt'` was hardcoded independently in
 * `auth.controller.ts` (where the cookie is SET on login and CLEARED on
 * logout) AND `jwt.guard.ts` (where it is READ on every request). Nothing
 * tied the two literals together — a future rename of one site without the
 * other would silently break the flow: the guard would keep reading a name
 * the controller no longer sets (locks everyone out), or the controller
 * would clear a name the guard never checked (logout becomes cosmetic).
 * Importing both from here makes that class of drift a compile error
 * instead of a runtime surprise.
 *
 * `*_HARDENED` names are issued/read in production only — the `__Host-`
 * prefix requires the `Secure` attribute, which requires HTTPS (see
 * `auth.controller.ts`'s constructor doc for the full sibling-subdomain
 * rationale). `*_LEGACY` names are the permanent name in every other
 * environment (dev/test/CI). For the JWT cookie specifically, the legacy
 * name is ALSO a bounded fallback accepted in production alongside the
 * hardened cookie — see `jwt.guard.ts`'s `LEGACY_JWT_COOKIE_FALLBACK_CUTOFF`
 * for that window (the OAuth state cookie has no such fallback — it is
 * short-lived, single-use, and cleared immediately after the callback).
 *
 * The OAuth-state pair is only ever read/written within `auth.controller.ts`
 * itself (no second file to drift against today), but is defined here
 * anyway for uniformity with the JWT pair — one file, one shape, for every
 * cookie name this module hands out.
 */
export const JWT_COOKIE_HARDENED = '__Host-jwt'
export const JWT_COOKIE_LEGACY = 'jwt'

export const STATE_COOKIE_HARDENED = '__Host-oauth_state'
export const STATE_COOKIE_LEGACY = 'oauth_state'

/**
 * task-user-emails-invite: carries the RAW invite token across the Google
 * OAuth round trip, alongside the (unchanged) OAuth-state cookie above —
 * same short-lived (600s), single-use, cleared-after-callback lifecycle,
 * httpOnly (never readable by page JS). Storing the raw token here adds no
 * exposure beyond what the invite EMAIL link itself already carries in
 * plaintext (over HTTPS, same as this cookie) — `UsersService.
 * acceptPersonalEmailInvite` hashes it before ever comparing against the
 * DB, which only ever stores the hash (schema.ts's `userEmailInvites`).
 *
 * Why a cookie and not a second `redirect_uri`: Google OAuth clients have
 * ONE registered `redirect_uri` (`GOOGLE_CALLBACK_URL`, a fixed value in
 * Google Cloud Console — see `AuthService.buildGoogleAuthUrl`). A second,
 * unregistered callback path would be rejected by Google outright. The
 * invite-accept flow therefore reuses the EXISTING
 * `GET /auth/google/callback` endpoint — `AuthController.googleCallback`
 * branches on whether this cookie is present — rather than adding a route
 * this app has no way to actually register with Google.
 */
export const INVITE_COOKIE_HARDENED = '__Host-invite_token'
export const INVITE_COOKIE_LEGACY = 'invite_token'
