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
 * PII/sensitive fields that must never be stored as plaintext in the audit log.
 *
 * Key names match the camelCase shape returned by Drizzle `select() from users`
 * (i.e. what `UsersService.findById()` returns and what `diff()` receives).
 *
 * Coverage:
 *   - Direct identifiers: email, googleId
 *   - Contact details: phone, telegram
 *   - Legal identity: legalFullName (passport name used in MSA contracts)
 *   - Payment requisites (USDT ERC-20):  walletUsdtErc20, walletUsdtLabel
 *   - Payment requisites (Bank UAH FOP): bankUahRecipient, bankUahIban,
 *                                        bankUahRnokpp, bankUahBankName
 *   - Internal notes (admin-only free text about a person): adminNote
 *   - Financial terms (salary amount, financially sensitive): monthlySalary
 *
 * For sensitive fields the audit log records *that* the field changed (the key
 * is present in `changes`) but replaces actual before/after values with the
 * redaction token so no PII is persisted at-rest in `user_audit_log.changes`.
 */
export const SENSITIVE_FIELDS = new Set([
  'email',
  'googleId',
  'phone',
  'telegram',
  'legalFullName',
  'walletUsdtErc20',
  'walletUsdtLabel',
  'bankUahRecipient',
  'bankUahIban',
  'bankUahRnokpp',
  'bankUahBankName',
  // HIGH-1: adminNote — free-text PII written by admin about a person
  'adminNote',
  // MED-2: monthlySalary — financially-sensitive compensation data
  'monthlySalary',
  // SEC-08: FOP PII fields — legal business address and government tax record
  'registrationAddress',
  'usrRecord',
])

export const REDACTED_TOKEN = '[redacted]' as const

/**
 * Drizzle transaction handle passed by `db.transaction(async (tx) => …)`.
 * Resolves to the same `PgTransaction<…>` generic used by Drizzle's
 * `db.transaction()` callback — see `apps/api/src/database/types.ts`.
 */
export type AuditLogTransaction = DrizzleTx

@Injectable()
export class AuditLogService {
  constructor(private db: DatabaseService) {}

  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, AuditChange> {
    const result: Record<string, AuditChange> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (IGNORE_FIELDS.has(key)) continue
      const b = before[key]
      const a = after[key]
      if (!this.deepEqual(b, a)) {
        if (SENSITIVE_FIELDS.has(key)) {
          // Record that the field changed but redact the actual values so no
          // PII is persisted at-rest in user_audit_log.changes (JSON column).
          result[key] = { before: REDACTED_TOKEN, after: REDACTED_TOKEN }
        } else {
          result[key] = { before: b ?? null, after: a ?? null }
        }
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
