import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import { isDeadlock } from '../../database/pg-errors'
import { loadRoster, opportunityInputsVersion } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  canonicalUuid,
  isJobQueueRole,
  type JobQueueScope,
  type LiveSeniorVersion,
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
 * A malformed id never reaches a `::uuid` cast: it is a plain miss (404 / NONE) decided before
 * any query, so it cannot surface as a 503.
 *
 * POLICY UNAVAILABLE: if the roster or visibility query fails, the answer is
 * `JOB_QUEUE_POLICY_UNAVAILABLE` (503) — never a default scope and never "visible" — and the
 * failure is logged as error classes and the SQLSTATE code only (`describeFailure`), never a
 * message: a query error's message carries the SQL and its parameters.
 *
 * THE EXECUTOR IS A REQUIRED PARAMETER: a write passes its transaction (r5 Task 6.3), so a scope and
 * a visibility answer are read inside the write they authorize; a forgotten argument cannot silently
 * read outside it.
 */
@Injectable()
export class JobQueueScopeService {
  private readonly logger = new Logger(JobQueueScopeService.name)

  async resolve(
    user: SessionUser,
    requestedTeamId: string | undefined,
    db: SqlExecutor,
  ): Promise<JobQueueScope> {
    if (!isJobQueueRole(user.role)) throw new ForbiddenException()
    if (requestedTeamId === undefined && user.role === 'ADMIN') return STUDIO_SCOPE
    const requested = requestedTeamId === undefined ? undefined : canonicalUuid(requestedTeamId)
    if (requested === null) return NONE_SCOPE
    return this.policy(async () => {
      const allowed =
        user.role === 'ADMIN'
          ? await this.liveTeamIds(db, requested as string)
          : await this.activeTeamIdsOf(db, user.id)
      const teamId = selectScopeTeam(requested, allowed)
      if (teamId === null) return NONE_SCOPE
      const { versions, inputsVersion } = await this.liveInputs(db, teamId)
      return {
        kind: 'TEAM',
        teamId,
        seniorIds: versions.map((v) => v.seniorId),
        versions,
        inputsVersion,
      }
    })
  }

  /**
   * 404 `JOB_OPPORTUNITY_NOT_FOUND` unless the opportunity exists AND is visible in `scope` —
   * one answer for "does not exist", "not yours" and "not an id", so a viewer cannot probe
   * another team's queue. NONE and a malformed id answer without a query.
   */
  async assertVisible(scope: JobQueueScope, opportunityId: string, db: SqlExecutor): Promise<void> {
    const canonical = canonicalUuid(opportunityId)
    if (scope.kind === 'NONE' || canonical === null) throw notFound()
    const rows = await this.policy(async () => {
      const id = sql`${canonical}::uuid`
      const result = await db.execute(
        sql`SELECT 1 AS visible FROM job_opportunities o
             WHERE o.id = ${id} AND ${visibleOpportunityPredicate(scope, id)}`,
      )
      return result.rows
    })
    if (rows.length === 0) throw notFound()
  }

  /** An HR's active teams: membership not left, team not archived, SENIOR-type, stable order. */
  private async activeTeamIdsOf(db: SqlExecutor, userId: string): Promise<string[]> {
    const { rows } = await db.execute(
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
  private async liveTeamIds(db: SqlExecutor, teamId: string): Promise<string[]> {
    const { rows } = await db.execute(
      sql`SELECT t.id FROM teams t
           WHERE t.id = ${teamId}::uuid AND t.archived_at IS NULL AND t.type = 'SENIOR'`,
    )
    return rows.map((r) => String(r['id']))
  }

  /**
   * The team's matchable seniors (active, non-archived SENIOR, in the team) with their LIVE input
   * versions, from the same `loadRoster` / `rosterVersions` the recompute worker stamps match rows
   * with — so a row is visible only while it still describes the live roster (SR-M-2) — and the
   * live opportunity inputs version from the same load, for the grant branch (SR-M-1).
   */
  private async liveInputs(
    db: SqlExecutor,
    teamId: string,
  ): Promise<{ versions: LiveSeniorVersion[]; inputsVersion: string }> {
    const roster = await loadRoster(db)
    const inTeam = new Set(
      roster.profiles.filter((p) => p.teamIds.includes(teamId)).map((p) => p.seniorId),
    )
    // `versions` follows the roster order (by senior id); a senior without a row grants nothing.
    const versions = [...roster.versions]
      .filter(([seniorId]) => inTeam.has(seniorId))
      .map(([seniorId, v]) => ({ seniorId, profile: v.profile, exclusion: v.exclusion }))
    return { versions, inputsVersion: opportunityInputsVersion(roster.exclusions) }
  }

  /**
   * Runs a policy read; a failure is `JOB_QUEUE_POLICY_UNAVAILABLE`, never a default answer. A
   * deadlock is not an answer about the policy: it passes through, for the writer's one rerun.
   */
  async policy<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      if (isDeadlock(err)) throw err
      this.logger.error(`queue policy evaluation failed: ${describeFailure(err)}`)
      throw apiError('JOB_QUEUE_POLICY_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
    }
  }
}

/**
 * The error's class and SQLSTATE/errno-shaped `code` (a raw pg `DatabaseError` carries it on itself,
 * SR-L-5), plus its cause's class and `code` when present (drizzle's wrapper) — NEVER a message
 * (SR-L-3): drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <params>`, and
 * those params are team, senior and user ids and version hashes.
 */
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return typeof err
  const cause: unknown = err.cause
  const parts = [err.constructor.name]
  const own = sqlState(err)
  if (own !== null) parts.push(`code ${own}`)
  if (cause instanceof Error) parts.push(`cause ${cause.constructor.name}`)
  const inner = sqlState(cause)
  if (inner !== null) parts.push(`cause code ${inner}`)
  return parts.join(', ')
}

/** A SQLSTATE or an errno name (`ECONNRESET`), never free text that could carry data (SR-L-6). */
const SQLSTATE_OR_ERRNO = /^[0-9A-Z_]{1,32}$/

const sqlState = (value: unknown): string | null => {
  const code = (value as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && SQLSTATE_OR_ERRNO.test(code) ? code : null
}

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
