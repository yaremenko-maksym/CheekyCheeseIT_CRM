import { SetMetadata } from '@nestjs/common'

/**
 * Metadata key for marking handlers / controllers as public — i.e. they
 * should NOT require an authenticated JWT cookie.
 *
 * Consumed by `JwtAuthGuard` via `Reflector.getAllAndOverride`. Order of
 * lookup is handler-level first, then controller-level (NestJS default).
 *
 * See `apps/api/src/auth/onboarding.guard.integration.spec.ts` for the
 * integration test that pins the bypass behaviour against the real Fastify
 * request lifecycle.
 */
export const IS_PUBLIC_KEY = 'isPublic'

/**
 * `@Public()` — opt-out of the globally registered `JwtAuthGuard` for an
 * endpoint that must remain reachable without authentication (e.g. health,
 * OAuth callback). Pair with controllers that do not need RBAC.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
