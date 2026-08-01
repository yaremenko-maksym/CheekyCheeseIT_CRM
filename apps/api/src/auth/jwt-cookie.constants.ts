/**
 * LOW (security-review round 3, follow-up to #436): single source of truth
 * for the JWT session cookie names.
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
 * `JWT_COOKIE_HARDENED` is issued/read in production only — the `__Host-`
 * prefix requires the `Secure` attribute, which requires HTTPS (see
 * `auth.controller.ts`'s constructor doc for the full sibling-subdomain
 * rationale). `JWT_COOKIE_LEGACY` is the permanent name in every other
 * environment (dev/test/CI) and the bounded fallback name accepted in
 * production alongside the hardened cookie — see
 * `jwt.guard.ts`'s `LEGACY_JWT_COOKIE_FALLBACK_CUTOFF` for that window.
 */
export const JWT_COOKIE_HARDENED = '__Host-jwt'
export const JWT_COOKIE_LEGACY = 'jwt'
