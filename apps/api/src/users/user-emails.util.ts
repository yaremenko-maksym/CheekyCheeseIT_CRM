import { HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'
import { isUniqueViolation } from '../database/pg-errors'

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
