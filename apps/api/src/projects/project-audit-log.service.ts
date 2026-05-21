import { Injectable } from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type { ProjectAuditAction } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projectAuditLog } from '../database/schema'

const IGNORE_FIELDS = new Set(['updatedAt', 'createdAt', 'id'])

export interface AuditChange {
  before: unknown
  after: unknown
}

/** See AuditLogService for rationale — Drizzle's tx generic surface differs
 *  from top-level db so we keep this loose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProjectAuditLogTransaction = any

/**
 * Mirrors `apps/api/src/users/audit-log.service.ts` for projects.
 * Internal — no controller endpoints; used from ProjectsService and UsersService.
 */
@Injectable()
export class ProjectAuditLogService {
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

  /**
   * Records a project audit log entry. Pass `tx` when called inside a
   * `db.transaction()` block to keep the insert atomic with entity changes.
   */
  async record(
    params: {
      actorId: string | null
      targetId: string
      action: ProjectAuditAction
      changes: Record<string, AuditChange>
    },
    tx?: ProjectAuditLogTransaction,
  ): Promise<void> {
    if (Object.keys(params.changes).length === 0) return
    const conn = tx ?? this.db.db
    await conn.insert(projectAuditLog).values({
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
  ): Promise<{ entries: (typeof projectAuditLog.$inferSelect)[]; total: number }> {
    const offset = (page - 1) * limit
    const entries = await this.db.db
      .select()
      .from(projectAuditLog)
      .where(eq(projectAuditLog.targetId, targetId))
      .orderBy(desc(projectAuditLog.createdAt))
      .limit(limit)
      .offset(offset)
    const countResult = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectAuditLog)
      .where(eq(projectAuditLog.targetId, targetId))
    const count = countResult[0]?.count ?? 0
    return { entries, total: count }
  }
}
