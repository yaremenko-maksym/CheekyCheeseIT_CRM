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

function acceptLanguageCandidates(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
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
