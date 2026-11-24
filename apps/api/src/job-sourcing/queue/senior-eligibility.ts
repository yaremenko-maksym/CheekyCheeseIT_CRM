import { HttpStatus, type HttpException } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import { findMatchingExclusion } from '../filtering'
import { exclusionPosting } from '../funnel/evaluate'
import { loadOpportunity, loadSeniorExclusions } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import type { WriteScope } from './queue-actions'
import { scopedTeamRowPredicate } from './queue-scope'
import type { JobQueueScopeService } from './queue-scope.service'

/** The queue's one uniform miss: "does not exist", "not yours" and "not eligible" read alike. */
export const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)

/**
 * An active, non-archived SENIOR member of the scope's team, a SENIOR or a DROP team alike (ADMIN
 * in STUDIO: of any live team),
 * with membership, user and team locked `FOR SHARE`, so a leave or an archival of any of them
 * cannot pass this check and commit under the write; and who has not stop-listed the opportunity.
 * Their own entries, matched on the funnel's posting (so the DOU slug alias counts) and through its
 * row mapping; a studio-wide exclusion is the opportunity's verdict, and triage may be submitted.
 */
export async function assertSeniorEligible(
  scopes: JobQueueScopeService,
  tx: SqlExecutor,
  scope: WriteScope,
  seniorId: string,
  opportunity: string,
  refuse: () => HttpException = notFound,
): Promise<void> {
  const member = await scopes.policy(() =>
    tx.execute(
      sql`SELECT tm.team_id FROM team_members tm
            JOIN users u ON u.id = tm.user_id
            JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = ${seniorId}::uuid AND tm.left_at IS NULL
             AND u.role = 'SENIOR' AND u.archived_at IS NULL
             AND t.archived_at IS NULL
             AND ${scopedTeamRowPredicate(scope, sql`tm.team_id`)}
           ORDER BY tm.team_id
             FOR SHARE OF tm, u, t`,
    ),
  )
  if (member.rows.length === 0) throw refuse()
  const loaded = await scopes.policy(() => loadOpportunity(tx, opportunity))
  if (loaded === null) throw refuse()
  const own = await scopes.policy(() => loadSeniorExclusions(tx, seniorId))
  const stopListed = findMatchingExclusion(exclusionPosting(loaded.canonical), own)
  if (stopListed !== null) throw refuse()
}
