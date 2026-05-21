import { Injectable } from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type { AuditAction, AuditChange } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { userAuditLog } from '../database/schema'

// avatarOverride can contain large base64 strings — exclude from audit diffs (avatar URL change is a non-business event anyway)
const IGNORE_FIELDS = new Set(['updatedAt', 'createdAt', 'id', 'avatarOverride'])

@Injectable()
export class AuditLogService {
  constructor(private db: DatabaseService) {}

  diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, AuditChange> {
    const result: Record<string, AuditChange> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (IGNORE_FIELDS.has(key)) continue
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
    action: AuditAction
    changes: Record<string, AuditChange>
  }): Promise<void> {
    if (Object.keys(params.changes).length === 0) return
    await this.db.db.insert(userAuditLog).values({
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
  ): Promise<{ entries: (typeof userAuditLog.$inferSelect)[]; total: number }> {
    const offset = (page - 1) * limit
    const entries = await this.db.db
      .select()
      .from(userAuditLog)
      .where(eq(userAuditLog.targetId, targetId))
      .orderBy(desc(userAuditLog.createdAt))
      .limit(limit)
      .offset(offset)
    const countResult = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(userAuditLog)
      .where(eq(userAuditLog.targetId, targetId))
    const count = countResult[0]?.count ?? 0
    return { entries, total: count }
  }
}
