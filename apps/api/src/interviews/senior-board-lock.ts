import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../job-sourcing/scheduling/host-state'

export interface LockedBoardCard {
  readonly id: string
  readonly stage: string
}

/**
 * Lock every card on one senior's interview board for the rest of the caller's transaction.
 *
 * Every writer that computes or renumbers a card `position` on the board takes this lock first,
 * in the same order and strength: `InterviewsService.move`, `InterviewsService.create` and the
 * sourcing queue's `createSubmittedInterviewCard`. Two of them on one board therefore run one
 * after the other, and the second reads the first one's committed positions.
 *
 * Why the whole board and not only the target column: an empty target column has no rows to
 * lock, and the card being moved is not in the target column yet, so a column-scoped lock lets
 * two writers into one column at once. A move changes only `stage`, never the set of cards, so
 * the senior's whole set is a lock both writers are guaranteed to share.
 *
 * `id` order keeps two lockers from deadlocking. `FOR NO KEY UPDATE` (the strength
 * `meeting-recorder.service.ts` uses), not `FOR UPDATE`: it still conflicts with itself, but not
 * with the `FOR KEY SHARE` lock a foreign-key insert in another table takes on the referenced card.
 *
 * shortcut: a board with no cards at all has no rows to lock, so two first-ever creates on one
 * board can still share position 0; lock the senior's `users` row if that ever matters.
 */
export async function lockSeniorBoard(
  tx: SqlExecutor,
  seniorId: string,
): Promise<LockedBoardCard[]> {
  const { rows } = await tx.execute(
    sql`SELECT id, stage FROM interviews
         WHERE senior_id = ${seniorId}::uuid
         ORDER BY id
           FOR NO KEY UPDATE`,
  )
  return rows.map((row) => ({ id: String(row['id']), stage: String(row['stage']) }))
}
