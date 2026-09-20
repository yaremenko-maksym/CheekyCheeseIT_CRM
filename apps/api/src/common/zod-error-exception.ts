import { BadRequestException } from '@nestjs/common'
import { ZOD_ERROR_FALLBACK_EN, type ZodErrorCode } from '@crm/shared'

/**
 * fix-round 1 (PR #699, CI-1 / COPY-H-2). Builds a 400 for a
 * `receiptMandatoryError` / `selfPayError`-style return value from a
 * server-side caller that throws DIRECTLY — never through Zod's own
 * `.parse()` — so `ZodExceptionFilter`
 * (`apps/api/src/zod-exception.filter.ts`) never gets a chance to build its
 * own envelope for this issue (these functions are shared, pure, framework-
 * agnostic — the client, the Zod `superRefine` boundary, AND these direct
 * service-method re-checks all call the SAME one, per each function's own
 * doc comment in `packages/shared/src/schemas/finance.ts`).
 *
 * Mirrors that filter's per-issue shape exactly for a coded value —
 * `{ statusCode, code, message }` where `message` is the SAME
 * `ZOD_ERROR_FALLBACK_EN` English text a migrated Zod issue gets through the
 * Zod-boundary path — so a test asserting `code`/`statusCode` sees the
 * identical shape regardless of which of the two paths produced the 400
 * (task-i18n-stage4-lessons-701, lesson 2: assert `code` AND `statusCode`,
 * never the translated text — text is a copy-reviewer concern, not a
 * behavioral contract). An ordinary (non-coded) message — a literal a caller
 * passed explicitly, e.g.
 * `selfPayError(a, b, 'Cannot transfer to yourself')` — falls back to a
 * plain string body, exactly as `new BadRequestException(message)` behaved
 * before this function existed.
 */
export function zodErrorBadRequest(message: string): BadRequestException {
  if (!message.startsWith('zod.')) {
    return new BadRequestException(message)
  }
  const code = message.slice('zod.'.length) as ZodErrorCode
  const fallback = ZOD_ERROR_FALLBACK_EN[code]
  if (fallback === undefined) return new BadRequestException(message)
  return new BadRequestException({ statusCode: 400, code, message: fallback })
}
