import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Global throttle guard — tracks by the AUTHENTICATED USER when one is known,
 * falling back to the request's IP address otherwise (backlog #52).
 *
 * WHY THIS EXISTS
 * ----------------
 * The stock `ThrottlerGuard.getTracker()` always returns `req.ip` (see
 * `@nestjs/throttler`'s own `throttler.guard.js`: `async getTracker(req) {
 * return req.ip }`). The real defence against over-collection is the request
 * BUDGET in the database (`source-budget.ts` / `chargeBudget`); this global
 * guard is the second perimeter, not the first — but a second perimeter that
 * counts the wrong thing is still worth fixing:
 *
 *   - a SHARED address (office NAT, company VPN) divides one bucket between
 *     every user behind it — two people each doing normal work can throttle
 *     each other well below any individual's fair share;
 *   - a SINGLE user who happens to change address (phone data vs office
 *     wifi, a VPN reconnect) gets a brand-new bucket for free, i.e. no limit
 *     followed them at all.
 *
 * Both are the same root cause: IP is a proxy for "who is asking", and once
 * an authenticated identity exists, it is the more precise signal.
 *
 * WHY THIS IS SAFE TO KEY OFF `req.user`
 * ---------------------------------------
 * `JwtAuthGuard` is registered BEFORE this guard in `AppModule`'s `APP_GUARD`
 * list (see the ordering comment there) and populates `req.user` from the
 * verified JWT cookie whenever the route is not `@Public()`. For a
 * `@Public()` route `JwtAuthGuard` returns `true` immediately, BEFORE it even
 * looks at the cookie — so `req.user` is never set there, authenticated
 * cookie or not. That means every public, unauthenticated endpoint (contact
 * form, CSP report ingestion, health check, OAuth callback, dev-login, the
 * public vacancy board) keeps EXACTLY the stock IP-based behaviour: nothing
 * about their existing limits changes.
 *
 * FALLBACK IS DELIBERATE, NOT AN OVERSIGHT
 * -----------------------------------------
 * A genuinely anonymous caller has no user id to key on, and IP is the only
 * signal left. Keying on SOMETHING (address) is still strictly better than
 * keying on NOTHING (one shared bucket for the entire anonymous internet), so
 * the fallback preserves rather than weakens the existing protection on every
 * public route.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as { id?: unknown } | undefined
    if (user && typeof user.id === 'string' && user.id.length > 0) {
      return `user:${user.id}`
    }
    // `ip:` prefix keeps this bucket in a namespace disjoint from `user:` —
    // a UUID and a dotted/colon IP literal cannot collide anyway, but the
    // prefix also makes a storage key self-describing when read out of Redis
    // during an investigation.
    return `ip:${String(req['ip'] ?? '')}`
  }
}
