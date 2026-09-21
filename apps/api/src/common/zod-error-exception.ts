import { BadRequestException } from '@nestjs/common'
import { zodErrorFallbackText, type ZodErrorCode } from '@crm/shared'

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
 * `{ statusCode, code, message }` where `message` is the SAME text
 * `zodErrorFallbackText` (`packages/shared/src/schemas/zod-errors.ts`) would
 * resolve for a migrated Zod issue through the Zod-boundary path — so a test
 * asserting `code`/`statusCode` sees the identical shape regardless of which
 * of the two paths produced the 400 (task-i18n-stage4-lessons-701, lesson 2:
 * assert `code` AND `statusCode`, never the translated text — text is a
 * copy-reviewer concern, not a behavioral contract). An ordinary (non-coded)
 * message — a plain-English literal a caller passes explicitly instead of a
 * registered `zod.<CODE>` — falls back to a plain string body, exactly as
 * `new BadRequestException(message)` behaved before this function existed
 * (fix-round 2, COPY-M-12: no live call site does this any more — every
 * `selfPayError` caller now goes through its coded default — but the
 * fallback stays, both as a safety net and because a future caller may have
 * a genuine reason to pass a one-off literal).
 *
 * fix-round 2 (CR-M-2/SR-L-1): delegates the `zod.<CODE>` → English-fallback
 * resolution to `zodErrorFallbackText` — the ONE place that owns the
 * `code → EN fallback` mapping — instead of re-implementing the same
 * `startsWith('zod.')` / `slice` / registry-lookup logic here a second time.
 * `zodErrorFallbackText` returns `message` UNCHANGED both for a non-coded
 * message and for an unknown `zod.<CODE>`-shaped one (no registry entry) —
 * so `translated === message` covers both "fall back to a plain string body"
 * cases in one comparison, with no need to re-check the prefix or re-index
 * the registry here.
 */
export function zodErrorBadRequest(message: string): BadRequestException {
  const translated = zodErrorFallbackText(message)
  if (translated === message) {
    return new BadRequestException(message)
  }
  const code = message.slice('zod.'.length) as ZodErrorCode
  return new BadRequestException({ statusCode: 400, code, message: translated })
}
