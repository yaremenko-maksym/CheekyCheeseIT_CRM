import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { isUniqueViolation } from '../database/pg-errors'
import { lowerEmail, userEmails } from '../database/schema'
import type { DrizzleTx } from '../database/types'

/**
 * Runs a `user_emails` write and maps a Postgres unique violation (23505) to
 * the API's `EMAIL_ALREADY_IN_USE` 409 conflict; any other error is rethrown
 * untouched. The write is supplied by the caller as a callback — this helper
 * never touches a table itself.
 */
export async function writeUserEmailOrConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw apiError('EMAIL_ALREADY_IN_USE', HttpStatus.CONFLICT)
    }
    throw err
  }
}

/**
 * §4.4 structural guarantee, application-side half. The DB unique index
 * on `user_emails.email` (schema.ts) is what actually makes "one address,
 * two accounts" impossible — this is only the friendly half: turns the
 * would-be raw 23505 constraint violation into a clean 409 that names the
 * problem, checked BEFORE the row that would collide is even inserted.
 * `excludeUserId` lets an update re-save a user's own unchanged address
 * without tripping over itself — it does NOT excuse a collision with a
 * DIFFERENT row belonging to the same user (own WORK vs own PERSONAL);
 * that one is real and still throws (see `isOwnRow` below), just later —
 * `writeUserEmailOrConflict` catches it at the DB write (SR-M-2).
 *
 * security-review PR #623 (SR-H-1): compares case-folded, matching the
 * unique index in schema.ts (`idx_user_emails_email_lower`) — mail is
 * case-insensitive, `varchar` equality is not, and a mismatch here is a
 * direct one-address-two-accounts hole (see schema.ts's migration file
 * header for the proof-by-experiment that found it).
 *
 * COPY-H-5 (security-review PR #623 round 5): Russian message — this used
 * to read `'User with this email already exists'`, which the admin sees
 * verbatim as a toast (`getUserFacingErrorMessage` forwards backend
 * exception messages unchanged) in an otherwise all-Russian interface.
 * `changePersonalEmail` is the first caller where this is a routine,
 * expected 409 (a collision is the everyday failure mode of "type an
 * address, see if it's taken"), not a rare edge case — see that method's
 * own doc. Deliberately does not name WHICH row (own WORK vs a stranger's)
 * collided or which kind it was — the admin does not need that.
 *
 * COPY-H-6 (security-review PR #623 closing round): the previous version
 * of this paragraph claimed `writeUserEmailOrConflict`'s catch-branch
 * message (below) was "identical Russian text" to this one — it was not:
 * that message was STILL the raw English string this fix replaced here.
 * The two messages are deliberately DIFFERENT wording, not a copy-paste
 * omission: "занят другим пользователем" is only true for THIS function's
 * collision (a stranger's row) — `writeUserEmailOrConflict`'s catch fires
 * on the SAME-user, different-`kind` collision this function's own
 * `isOwnRow` branch above lets through (own WORK address set equal to
 * own PERSONAL address) — see its own doc for the reachable path. Naming
 * a caller as "другой пользователь" there would be factually wrong.
 */
export async function assertEmailAvailable(
  db: DatabaseService['db'] | DrizzleTx,
  email: string,
  excludeUserId?: string,
): Promise<void> {
  const existing = await db.query.userEmails.findFirst({
    where: eq(lowerEmail(userEmails.email), email.toLowerCase()),
  })
  if (!existing) return
  const isOwnRow = existing.userId === excludeUserId
  if (isOwnRow) return
  throw apiError('EMAIL_TAKEN_BY_ANOTHER_USER', HttpStatus.CONFLICT)
}
