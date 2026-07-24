import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Env } from '../config/env'

/**
 * TelemetryDigestTokenGuard — task-telemetry-api contract for `GET
 * /api/telemetry/digest`: "БЕЗ JwtGuard; header `X-Telemetry-Token` === env
 * `TELEMETRY_DIGEST_TOKEN` ... сравнение constant-time
 * (crypto.timingSafeEqual)".
 *
 * The digest endpoint is called by `.github/workflows/telemetry-digest.yml`
 * (a scheduled GitHub Action, no browser session) — it CANNOT carry a JWT
 * cookie, so it is marked `@Public()` (opts out of the global `JwtAuthGuard`)
 * and gated by this guard instead.
 *
 * `timingSafeEqual` requires both buffers to be the SAME length, or it
 * throws — the length check below runs FIRST so a length mismatch (the most
 * common case: wrong/no token) is rejected without ever calling it, while
 * still not leaking timing information for the "same length, wrong content"
 * case (the one timingSafeEqual actually defends against).
 */
@Injectable()
export class TelemetryDigestTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>()
    const provided = request.headers['x-telemetry-token']
    const expected = this.config.get('TELEMETRY_DIGEST_TOKEN', { infer: true })

    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException()
    }

    const providedBuf = Buffer.from(provided)
    const expectedBuf = Buffer.from(expected)

    if (providedBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException()
    }
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      throw new UnauthorizedException()
    }

    return true
  }
}
