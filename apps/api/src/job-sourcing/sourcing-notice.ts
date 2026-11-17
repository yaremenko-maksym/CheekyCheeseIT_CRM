import { Logger } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { SourcingNotice } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { jobModelHealthFlags } from '../database/schema'

// Stryker disable next-line StringLiteral: the logger context is a cosmetic label in log output only; no behaviour depends on it, so there is nothing to assert
const logger = new Logger('SourcingNotice')

/**
 * ADR 2026-11-03 §H.8: the one read model behind every `sourcingNotice` field. `MODEL_LIMITS_EXHAUSTED`
 * raised and not cleared (`cleared_at` null, the store's own "raised" test) is `AI_LIMITS_EXHAUSTED`.
 * The flag store has write paths only, so this is its read. A failed read is "no notice", logged with a
 * fixed code: a banner must never take the HR queue down with it.
 */
export async function readSourcingNotice(db: DatabaseService['db']): Promise<SourcingNotice> {
  const flags = jobModelHealthFlags
  try {
    const rows = await db
      .select({ flag: flags.flag })
      .from(flags)
      .where(and(eq(flags.flag, 'MODEL_LIMITS_EXHAUSTED'), isNull(flags.clearedAt)))
      .limit(1)
    return rows.length > 0 ? 'AI_LIMITS_EXHAUSTED' : null
  } catch {
    logger.error('SOURCING_NOTICE_READ_FAILED')
    return null
  }
}
