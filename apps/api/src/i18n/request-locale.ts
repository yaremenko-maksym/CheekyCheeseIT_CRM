import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import { LOCALE_COOKIE_NAME, resolveLocale, type Locale } from '@crm/shared'

/**
 * task-i18n-stage2 (Task 4, spec §4.1) — request locale resolution.
 *
 * Precedence: authenticated user's stored `locale` (Task 3) → `pref_locale`
 * cookie → first supported `Accept-Language` candidate → `uk`
 * (`resolveLocale`'s own `DEFAULT_LOCALE`).
 *
 * `cookies` on this interface is a plain object, not Fastify's own request
 * type — `@fastify/cookie` IS registered globally in this app (see
 * `apps/api/src/main.ts`), so `request.cookies` is always populated on a
 * real request. This interface stays a narrow structural type (rather than
 * `FastifyRequest`) so the resolver is trivially unit-testable without
 * booting Fastify, and so a caller whose `cookies` came back `undefined`
 * (the defensive case this shape allows) falls through cleanly instead of
 * throwing.
 */
export interface LocaleSource {
  user?: { locale?: string | null }
  cookies?: Record<string, string | undefined>
  headers: { 'accept-language'?: string }
}

/**
 * Exported (not just used internally by `resolveRequestLocale`) specifically
 * so it has its own unit-testable seam: `resolveLocale`'s tolerant fallback
 * (any candidate it does not recognize is silently skipped) means a mutant
 * that corrupts this function's OUTPUT ARRAY is invisible when observed only
 * through `resolveRequestLocale`'s final `Locale` — garbage candidates and
 * an empty array produce the identical 'uk' default. Direct assertions on
 * the array itself are the only way to pin the parsing (splitting on `,`,
 * stripping `;q=…` weight suffixes, trimming, dropping empties).
 */
export function acceptLanguageCandidates(header: string | undefined): string[] {
  if (!header) return []
  // `String.prototype.split` always returns an array with at least one
  // element (even for ''), so `part.split(';')[0]` can never be undefined —
  // the `?.` below cannot observably differ from `.` under any input; the
  // `?? ''` right after it is the actual defensive fallback.
  return header
    .split(',')
    .map((part) => {
      // Stryker disable next-line OptionalChaining: see the function's own comment above.
      return part.split(';')[0]?.trim() ?? ''
    })
    .filter(Boolean)
}

export function resolveRequestLocale(req: LocaleSource): Locale {
  return resolveLocale([
    req.user?.locale ?? null,
    req.cookies?.[LOCALE_COOKIE_NAME] ?? null,
    ...acceptLanguageCandidates(req.headers['accept-language']),
  ])
}

/**
 * `@RequestLocale()` — param decorator mirroring `@CurrentUser()`'s shape.
 * Reads the request straight off the execution context, so any controller
 * handler can request the resolved locale without threading it through
 * every call site manually.
 */
export const RequestLocale = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Locale => {
    return resolveRequestLocale(ctx.switchToHttp().getRequest<LocaleSource>())
  },
)
