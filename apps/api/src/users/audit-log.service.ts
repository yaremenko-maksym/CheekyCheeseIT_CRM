import { Injectable } from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type { AuditAction, AuditChange } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { userAuditLog } from '../database/schema'
import type { DrizzleTx } from '../database/types'

// Avatar changes are non-business events; exclude both the fallback URL and
// the documents FK from audit diffs. (Pre-0013 we also ignored the legacy
// `avatarOverride` base64 column.)
const IGNORE_FIELDS = new Set(['updatedAt', 'createdAt', 'id', 'avatarUrl', 'avatarDocumentId'])

/**
 * Drizzle transaction handle passed by `db.transaction(async (tx) => …)`.
 * Resolves to the same `PgTransaction<…>` generic used by Drizzle's
 * `db.transaction()` callback — see `apps/api/src/database/types.ts`.
 */
export type AuditLogTransaction = DrizzleTx

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

  /**
   * Records a user audit log entry. When called inside a `db.transaction(async (tx) => …)`
   * block, pass the `tx` handle so the insert is part of the same transaction —
   * rollback then atomically discards the audit row together with the entity
   * mutations. Calls outside a transaction may omit `tx`.
   */
  async record(
    params: {
      actorId: string | null
      targetId: string
      action: AuditAction
      changes: Record<string, AuditChange>
    },
    tx?: AuditLogTransaction,
  ): Promise<void> {
    if (Object.keys(params.changes).length === 0) return
    const conn = tx ?? this.db.db
    await conn.insert(userAuditLog).values({
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
