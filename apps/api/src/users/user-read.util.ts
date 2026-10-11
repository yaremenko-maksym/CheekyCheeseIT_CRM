import { eq } from 'drizzle-orm'
import { users, type User } from '../database/schema'
import type { DatabaseService } from '../database/database.service'

/**
 * Read a single user row by id; resolves `undefined` when no row matches.
 * A free function so collaborators can read a user without depending on
 * `UsersService`.
 *
 * Extracted from `UsersService.findById`; the only code change is
 * `this.db.db` -> the `db` parameter.
 */
export function loadUserById(db: DatabaseService['db'], id: string): Promise<User | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .then((rows) => rows[0])
}
