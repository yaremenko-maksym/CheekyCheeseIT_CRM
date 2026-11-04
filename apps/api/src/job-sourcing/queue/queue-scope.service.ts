import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import { DatabaseService } from '../../database/database.service'
import {
  isJobQueueRole,
  type JobQueueScope,
  NONE_SCOPE,
  selectScopeTeam,
  STUDIO_SCOPE,
  visibleOpportunityPredicate,
} from './queue-scope'

/**
 * r5 Task 6.1 — resolves the viewer's queue scope and answers "may this scope see this
 * opportunity". RBAC lives HERE, not only on the controller decorator (the #157/#158 lesson):
 * Task 6.4's controller calls `resolve` on every request, and Task 6.2 / 6.3 read through
 * `visibleOpportunityPredicate` / `assertVisible` for the same scope.
 *
 * FAIL CLOSED: if the roster or visibility query fails, the answer is
 * `JOB_QUEUE_POLICY_UNAVAILABLE` (503) — never a default scope and never "visible".
 */
@Injectable()
export class JobQueueScopeService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(user: SessionUser, requestedTeamId?: string): Promise<JobQueueScope> {
    if (!isJobQueueRole(user.role)) throw new ForbiddenException()
    if (user.role === 'ADMIN' && requestedTeamId === undefined) return STUDIO_SCOPE
    return this.failClosed(async () => {
      const allowed =
        user.role === 'ADMIN'
          ? await this.liveTeamIds(requestedTeamId as string)
          : await this.activeTeamIdsOf(user.id)
      const teamId = selectScopeTeam(requestedTeamId, allowed)
      if (teamId === null) return NONE_SCOPE
      return { kind: 'TEAM', teamId, seniorIds: await this.teamSeniorIds(teamId) }
    })
  }

  /**
   * 404 `JOB_OPPORTUNITY_NOT_FOUND` unless the opportunity exists AND is visible in `scope` —
   * one answer for "does not exist" and "not yours", so a viewer cannot probe another team's
   * queue. NONE answers without a query.
   */
  async assertVisible(scope: JobQueueScope, opportunityId: string): Promise<void> {
    if (scope.kind === 'NONE') throw notFound()
    const rows = await this.failClosed(async () => {
      const id = sql`${opportunityId}::uuid`
      const result = await this.database.db.execute(
        sql`SELECT 1 AS visible FROM job_opportunities o
             WHERE o.id = ${id} AND ${visibleOpportunityPredicate(scope, id)}`,
      )
      return result.rows
    })
    if (rows.length === 0) throw notFound()
  }

  /** An HR's active teams: membership not left, team not archived, SENIOR-type, stable order. */
  private async activeTeamIdsOf(userId: string): Promise<string[]> {
    const { rows } = await this.database.db.execute(
      sql`SELECT t.id, t.created_at FROM team_members tm
            JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = ${userId}::uuid AND tm.left_at IS NULL
             AND t.archived_at IS NULL AND t.type = 'SENIOR'
           GROUP BY t.id, t.created_at
           ORDER BY t.created_at, t.id`,
    )
    return rows.map((r) => String(r['id']))
  }

  /** The team an ADMIN named, if it is live (not archived, SENIOR-type); else nothing. */
  private async liveTeamIds(teamId: string): Promise<string[]> {
    const { rows } = await this.database.db.execute(
      sql`SELECT t.id FROM teams t
           WHERE t.id = ${teamId}::uuid AND t.archived_at IS NULL AND t.type = 'SENIOR'`,
    )
    return rows.map((r) => String(r['id']))
  }

  /** The team's active, non-archived SENIOR members, sorted by id. */
  private async teamSeniorIds(teamId: string): Promise<string[]> {
    const { rows } = await this.database.db.execute(
      sql`SELECT DISTINCT u.id FROM team_members tm
            JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = ${teamId}::uuid AND tm.left_at IS NULL
             AND u.role = 'SENIOR' AND u.archived_at IS NULL
           ORDER BY u.id`,
    )
    return rows.map((r) => String(r['id']))
  }

  private async failClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch {
      throw apiError('JOB_QUEUE_POLICY_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
    }
  }
}

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
