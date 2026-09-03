/**
 * SR-M-10 (security-review PR #623 round 4): the invite-accept link
 * (`GET /api/auth/invite/:token`) carries the ONE-TIME raw invite token in
 * the URL PATH. Fastify's request logger (main.ts, enabled whenever
 * NODE_ENV !== 'test') otherwise logs `req.url` verbatim on every incoming
 * request — meaning the raw token, which `invite-token.util.ts`'s own doc
 * says a DB read alone must never be enough to reconstruct, ends up in
 * plaintext in prod stdout/access logs (and anything downstream that
 * ingests them: nginx, Cloudflare, log aggregators) regardless of that
 * guarantee. This redacts ONLY that one path shape — every other route's
 * URL is logged unchanged.
 */
import type { FastifyRequest } from 'fastify'

const INVITE_TOKEN_PATH = /(\/api\/auth\/invite\/)[0-9a-f]{64}/

export function redactInviteTokenFromUrl(url: string): string {
  return url.replace(INVITE_TOKEN_PATH, '$1[redacted]')
}

/**
 * Fastify's own default `req` serializer shape (method/url/hostname/
 * remoteAddress/remotePort) with `url` routed through the redaction above —
 * everything else is untouched so log consumers built against the default
 * shape keep working. Typed against the REAL `FastifyRequest` (not a
 * hand-rolled subset) so this stays a drop-in `serializers.req` replacement.
 */
export function createRedactingReqSerializer() {
  return (req: FastifyRequest) => ({
    method: req.method,
    url: redactInviteTokenFromUrl(req.url),
    hostname: req.hostname,
    remoteAddress: req.ip,
    // Fastify's own logger-option types declare this field non-optional;
    // the only real-world case it can be missing is a socket that already
    // closed by the time this serializer runs — 0 is a harmless log-only
    // placeholder, never a real port.
    remotePort: req.socket?.remotePort ?? 0,
  })
}
