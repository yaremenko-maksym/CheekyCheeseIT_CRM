import { Injectable } from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type { TeamAuditAction } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { teamAuditLog } from '../database/schema'

const IGNORE_FIELDS = new Set(['updatedAt', 'createdAt', 'id'])

export interface AuditChange {
  before: unknown
  after: unknown
}

/**
 * Mirrors `apps/api/src/users/audit-log.service.ts` for teams.
 * Internal — no controller endpoints; used from TeamsService and UsersService.
 */
@Injectable()
export class TeamAuditLogService {
  constructor(private db: DatabaseService) {}

  diff(before: Record<string, unknown>, after: Record<string, unknown>, excluded?: ReadonlySet<string>): Record<string, AuditChange> {
    const ignore = excluded ?? IGNORE_FIELDS
    const result: Record<string, AuditChange> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (ignore.has(key)) continue
      const b = before[key]
      const a = after[key]
      if (!this.deepEqual(b, a)) {
        result[key] = { before: b ?? null, after: a ?? null }
      }
    }
    return result
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null) return a === b
    if (typeof a !== typeof b) return false
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false
      return a.every((v, i) => this.deepEqual(v, b[i]))
    }
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b)
    }
    return false
  }

  async record(params: {
    actorId: string | null
    targetId: string
    action: TeamAuditAction
    changes: Record<string, AuditChange>
  }): Promise<void> {
    if (Object.keys(params.changes).length === 0) return
    await this.db.db.insert(teamAuditLog).values({
      actorId: params.actorId,
      targetId: params.targetId,
      action: params.action,
      changes: params.changes,
    })
  }

  async list(
    targetId: string,
    page: number,
    limit: number,
  ): Promise<{ entries: (typeof teamAuditLog.$inferSelect)[]; total: number }> {
    const offset = (page - 1) * limit
    const entries = await this.db.db
      .select()
      .from(teamAuditLog)
      .where(eq(teamAuditLog.targetId, targetId))
      .orderBy(desc(teamAuditLog.createdAt))
      .limit(limit)
      .offset(offset)
    const countResult = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(teamAuditLog)
      .where(eq(teamAuditLog.targetId, targetId))
    const count = countResult[0]?.count ?? 0
    return { entries, total: count }
  }
}
