/**
 * The recipients of every source-health message (ADR 2026-10-25 section 11): users whose role is
 * ADMIN and who are not archived. One query, shared by the immediate alert and the Monday report,
 * so "who receives operational data" has a single definition (and a single place to review).
 */
import { and, eq, isNull } from 'drizzle-orm'
import { users } from '../../database/schema'
import type { DrizzleTx } from '../../database/types'

export async function activeAdminIds(q: Pick<DrizzleTx, 'select'>): Promise<string[]> {
  const rows = await q
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), isNull(users.archivedAt)))
  return rows.map((r) => r.id)
}
