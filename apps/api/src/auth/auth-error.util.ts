import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common'
import {
  GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE,
  INVITE_TARGET_ARCHIVED_MESSAGE,
} from '../users/users.service'

/**
 * LOW-1/LOW-2 (security-review PR #623 round 4): `acceptPersonalEmailInvite`
 * throws two DIFFERENT situations under the SAME exception type
 * (`ForbiddenException` for "wrong Google account" vs "target archived";
 * `ConflictException` for "token already used" vs "Google account bound
 * elsewhere") — `instanceof` alone cannot tell them apart, only the
 * message can. Extracts the plain string from the `{ statusCode, message,
 * error }` shape every `new XException('msg')` call in this codebase
 * produces.
 */
function exceptionMessage(err: ForbiddenException | ConflictException): string {
  const response = err.getResponse()
  // Stryker disable next-line ConditionalExpression,StringLiteral: verified empirically (node -e against @nestjs/common) — `new ForbiddenException('str')`/`new ConflictException('str')`, the ONLY construction shape `acceptPersonalEmailInvite` ever uses, always returns an OBJECT `{message, error, statusCode}` from `getResponse()`, never a raw string. This branch guards a Nest exception-body shape this codebase never actually produces.
  if (typeof response === 'string') return response
  const message = (response as { message?: unknown }).message
  // Stryker disable next-line ConditionalExpression,StringLiteral: the ONLY caller (mapInviteAcceptError below) does strict equality against a known sentinel string — any non-matching value, whether `''` or `undefined` (what this ternary's `true`-mutant would leak through instead), compares unequal to that sentinel the same way. A test asserting on the mapped `?error=` code (the only thing this function's result is ever used for) cannot distinguish the two — verified by hand: mutating this line to `return message` still passes every test in this file, because `mapInviteAcceptError` never reads this value on its own.
  return typeof message === 'string' ? message : ''
}

/**
 * SR-H-1 (security-review PR #701 round 1): `apiError()` returns a plain
 * `HttpException` — never a `ForbiddenException`/`ConflictException`/
 * `BadRequestException` subclass — so `mapInviteAcceptError` below MUST
 * dispatch on the envelope's `code`, not on exception class. Extracts the
 * `{ code }` field `apiError()` puts on the envelope body
 * (`apps/api/src/common/api-error.ts`); returns `undefined` for anything
 * that is not an `HttpException` with an object body carrying `code` — the
 * two remaining sentinel throws (`INVITE_TARGET_ARCHIVED_MESSAGE`/
 * `GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE`, both plain
 * `ForbiddenException`/`ConflictException`, see `mapInviteAcceptError`)
 * fall into this `undefined` case by construction.
 */
function envelopeCode(err: unknown): string | undefined {
  if (!(err instanceof HttpException)) return undefined
  const response = err.getResponse()
  return typeof response === 'object' && response !== null
    ? (response as { code?: string }).code
    : undefined
}

/**
 * task-user-emails-invite: maps `UsersService.acceptPersonalEmailInvite`'s
 * exceptions to the `?error=` code `googleCallback`'s invite branch
 * redirects with — the login page (`login.tsx`) owns the Russian copy
 * shown for each. Kept as a free function (not a private method) since it
 * has no dependency on controller state — a pure exception → string map.
 */
export function mapInviteAcceptError(err: unknown): string {
  switch (envelopeCode(err)) {
    case 'INVITE_ALREADY_USED':
      return 'invite_used'
    case 'INVITE_EXPIRED':
      return 'invite_expired'
    case 'INVITE_GOOGLE_ACCOUNT_MISMATCH':
      return 'invite_email_mismatch'
  }
  // No `case 'INVITE_INVALID':` above — the final `return 'invite_invalid'`
  // below already covers it (mutation-gate finding, PR #701 round 1): a
  // dedicated case here was a mutant Stryker could never kill, since
  // removing it still falls through, past the two `instanceof` checks
  // (neither matches a plain `apiError()`-built exception), to the SAME
  // string. Anything unrecognised — a garbage/superseded token, a genuinely
  // unexpected error shape — belongs in the same "nothing more specific to
  // tell the visitor" bucket `INVITE_INVALID` itself would have mapped to.
  //
  // The two throw sites `acceptPersonalEmailInvite` deliberately kept as
  // plain (non-`apiError()`) exceptions — `envelopeCode` above returns
  // `undefined` for both, so they fall through to here.
  if (err instanceof ForbiddenException) {
    // LOW-2: target account was archived (fired) after the invite was
    // issued — reuse the SAME code the ordinary login path already emits
    // for a fired user, rather than the generic mismatch message.
    return exceptionMessage(err) === INVITE_TARGET_ARCHIVED_MESSAGE
      ? 'account_disabled'
      : 'invite_email_mismatch'
  }
  if (err instanceof ConflictException) {
    // LOW-1: the confirming Google account is already bound to a DIFFERENT
    // user_emails row — this token was NOT used (used_at stays NULL, the
    // whole transaction rolled back), so calling it "used" would be false.
    return exceptionMessage(err) === GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE
      ? 'invite_account_taken'
      : 'invite_used'
  }
  // Anything unexpected — same bucket as "garbage link": nothing more
  // specific to tell the visitor.
  return 'invite_invalid'
}
